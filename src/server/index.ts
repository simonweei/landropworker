import { PairingRoom } from "./pairing-room";

export { PairingRoom };

const ROOM_TTL_MS = 5 * 60 * 1000;
const API_BODY_LIMIT = 2048;

type DeviceRequest = { deviceName?: string };

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function secureHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set(
    "content-security-policy",
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function randomRoomCode(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return String((random[0] ?? 0) % 1_000_000).padStart(6, "0");
}

function isRoomCode(value: string): boolean {
  return /^\d{6}$/.test(value);
}

function validSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  return origin === new URL(request.url).origin;
}

async function readDeviceName(request: Request): Promise<string> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > API_BODY_LIMIT) throw new Error("请求内容过大");
  if (!request.body) return "浏览器设备";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > API_BODY_LIMIT) {
      await reader.cancel("请求内容过大");
      throw new Error("请求内容过大");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.byteLength === 0) return "浏览器设备";
  const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof body !== "object" || body === null) return "浏览器设备";
  const deviceName = (body as DeviceRequest).deviceName;
  if (typeof deviceName !== "string") return "浏览器设备";
  const normalized = deviceName.trim().slice(0, 64);
  return normalized || "浏览器设备";
}

async function createRoom(env: Env, deviceName: string): Promise<Response> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const code = randomRoomCode();
    const room = env.PAIRING_ROOMS.getByName(code);
    const result = await room.createRoom(code, deviceName, Date.now() + ROOM_TTL_MS);
    if (result !== null) {
      return json({ code, token: result.token, expiresAt: result.expiresAt }, { status: 201 });
    }
  }
  return json({ error: "暂时无法创建配对码，请稍后重试" }, { status: 503 });
}

async function routeApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "POST") return json({ error: "方法不允许" }, { status: 405 });
  if (!validSameOrigin(request)) return json({ error: "来源验证失败" }, { status: 403 });

  if (url.pathname === "/api/rooms") {
    return createRoom(env, await readDeviceName(request));
  }

  const match = /^\/api\/rooms\/(\d{6})\/join$/.exec(url.pathname);
  if (match) {
    const code = match[1];
    if (!code || !isRoomCode(code)) return json({ error: "配对码格式错误" }, { status: 400 });
    const room = env.PAIRING_ROOMS.getByName(code);
    const result = await room.joinRoom(await readDeviceName(request));
    if (!result.ok) return json({ error: result.error }, { status: result.status });
    return json({ code, token: result.token, expiresAt: result.expiresAt });
  }

  return json({ error: "接口不存在" }, { status: 404 });
}

async function routeWebSocket(request: Request, env: Env, url: URL): Promise<Response> {
  const match = /^\/ws\/(\d{6})$/.exec(url.pathname);
  const code = match?.[1];
  if (!code || !isRoomCode(code)) return json({ error: "配对码格式错误" }, { status: 400 });
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "需要 WebSocket 升级" }, { status: 426 });
  }
  if (!validSameOrigin(request)) return json({ error: "来源验证失败" }, { status: 403 });
  return env.PAIRING_ROOMS.getByName(code).fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await routeApi(request, env, url);
      if (url.pathname.startsWith("/ws/")) return await routeWebSocket(request, env, url);
      return secureHeaders(await env.ASSETS.fetch(request));
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        message: "request_failed",
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return json({ error: "服务暂时不可用" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
