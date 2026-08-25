import { DurableObject } from "cloudflare:workers";

const MAX_SIGNAL_BYTES = 64 * 1024;
const CLOSE_EXPIRED = 4001;
const CLOSE_REPLACED = 4002;
const ALLOWED_SIGNALS = new Set(["offer", "answer", "ice-candidate", "renegotiate"]);

type PeerRole = "host" | "guest";

type SocketAttachment = {
  role: PeerRole;
  deviceName: string;
};

type RoomRow = {
  code: string;
  host_token: string;
  guest_token: string | null;
  host_name: string;
  guest_name: string | null;
  expires_at: number;
};

export type JoinResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; error: string; status: number };

function message(type: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...payload });
}

function isSignal(value: unknown): value is { type: string; payload: unknown } {
  if (typeof value !== "object" || value === null) return false;
  const object = value as Record<string, unknown>;
  return typeof object.type === "string" && ALLOWED_SIGNALS.has(object.type) && "payload" in object;
}

async function tokensEqual(provided: string | null, expected: string | null): Promise<boolean> {
  if (provided === null || expected === null) return false;
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
  };
  return subtle.timingSafeEqual(providedHash, expectedHash);
}

export class PairingRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          code TEXT NOT NULL,
          host_token TEXT NOT NULL,
          guest_token TEXT,
          host_name TEXT NOT NULL,
          guest_name TEXT,
          expires_at INTEGER NOT NULL
        );
      `);
    });
  }

  private getRoom(): RoomRow | null {
    return this.ctx.storage.sql.exec<RoomRow>(
      "SELECT code, host_token, guest_token, host_name, guest_name, expires_at FROM room WHERE id = 1",
    ).toArray()[0] ?? null;
  }

  private closeAll(code: number, reason: string): void {
    for (const socket of this.ctx.getWebSockets()) socket.close(code, reason);
  }

  async createRoom(code: string, deviceName: string, expiresAt: number): Promise<{ token: string; expiresAt: number } | null> {
    const existing = this.getRoom();
    if (existing && existing.expires_at > Date.now()) return null;
    if (existing) this.closeAll(CLOSE_EXPIRED, "房间已过期");

    const token = crypto.randomUUID();
    this.ctx.storage.sql.exec("DELETE FROM room");
    this.ctx.storage.sql.exec(
      "INSERT INTO room (id, code, host_token, host_name, expires_at) VALUES (1, ?, ?, ?, ?)",
      code,
      token,
      deviceName,
      expiresAt,
    );
    await this.ctx.storage.setAlarm(expiresAt);
    return { token, expiresAt };
  }

  async joinRoom(deviceName: string): Promise<JoinResult> {
    const room = this.getRoom();
    if (!room || room.expires_at <= Date.now()) {
      return { ok: false, error: "配对码不存在或已过期", status: 404 };
    }
    if (room.guest_token !== null) {
      return { ok: false, error: "该配对码已被使用", status: 409 };
    }

    const token = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "UPDATE room SET guest_token = ?, guest_name = ? WHERE id = 1",
      token,
      deviceName,
    );
    return { ok: true, token, expiresAt: room.expires_at };
  }

  override async fetch(request: Request): Promise<Response> {
    const room = this.getRoom();
    if (!room || room.expires_at <= Date.now()) return new Response("房间不存在或已过期", { status: 404 });

    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    let role: PeerRole | null = null;
    let deviceName = "浏览器设备";
    if (await tokensEqual(token, room.host_token)) {
      role = "host";
      deviceName = room.host_name;
    } else if (await tokensEqual(token, room.guest_token)) {
      role = "guest";
      deviceName = room.guest_name ?? deviceName;
    }
    if (role === null) return new Response("无效的连接凭据", { status: 401 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    for (const existing of this.ctx.getWebSockets(role)) existing.close(CLOSE_REPLACED, "连接已被新会话替换");
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, deviceName } satisfies SocketAttachment);

    const otherRole: PeerRole = role === "host" ? "guest" : "host";
    const other = this.ctx.getWebSockets(otherRole)[0];
    if (other) {
      const otherAttachment = other.deserializeAttachment() as SocketAttachment | null;
      server.send(message("peer-joined", { deviceName: otherAttachment?.deviceName ?? "对方设备" }));
      other.send(message("peer-joined", { deviceName }));
    } else {
      server.send(message("waiting"));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > MAX_SIGNAL_BYTES) {
      socket.send(message("signal-error", { error: "信令消息格式错误或过大" }));
      return;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isSignal(parsed)) throw new Error("不允许的消息类型");
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment) throw new Error("连接状态丢失");
      const otherRole: PeerRole = attachment.role === "host" ? "guest" : "host";
      const peer = this.ctx.getWebSockets(otherRole)[0];
      if (!peer) {
        socket.send(message("signal-error", { error: "对方尚未连接" }));
        return;
      }
      peer.send(JSON.stringify(parsed));
    } catch (error) {
      socket.send(message("signal-error", {
        error: error instanceof Error ? error.message : "信令解析失败",
      }));
    }
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) return;
    const otherRole: PeerRole = attachment.role === "host" ? "guest" : "host";
    for (const peer of this.ctx.getWebSockets(otherRole)) peer.send(message("peer-left"));
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket);
  }

  override async alarm(): Promise<void> {
    this.closeAll(CLOSE_EXPIRED, "配对码已过期");
    this.ctx.storage.sql.exec("DELETE FROM room");
  }
}
