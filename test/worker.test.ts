import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const origin = "https://example.com";

function post(path: string, body: Record<string, unknown> = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${origin}${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("pairing API", () => {
  it("serves a multi-file picker and a visible queue target", async () => {
    const response = await exports.default.fetch(new Request(`${origin}/`));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('id="fileInput" type="file" multiple');
    expect(html).toContain('id="queueList"');
    expect(html).toContain('id="openReceiveFolder"');
    expect(html).not.toContain('id="receiveFolderCard"');
  });

  it("creates a six-digit room and joins it once", async () => {
    const created = await post("/api/rooms", { deviceName: "Sender" });
    expect(created.status).toBe(201);
    const room = await created.json<{ code: string; token: string; expiresAt: number }>();
    expect(room.code).toMatch(/^\d{6}$/);
    expect(room.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(room.expiresAt).toBeGreaterThan(Date.now());

    const joined = await post(`/api/rooms/${room.code}/join`, { deviceName: "Receiver" });
    expect(joined.status).toBe(200);
    const peer = await joined.json<{ token: string }>();
    expect(peer.token).not.toBe(room.token);

    const reused = await post(`/api/rooms/${room.code}/join`, { deviceName: "Third" });
    expect(reused.status).toBe(409);
  });

  it("rejects invalid room codes and cross-origin writes", async () => {
    const invalid = await post("/api/rooms/123/join");
    expect(invalid.status).toBe(404);

    const crossOrigin = await exports.default.fetch(new Request(`${origin}/api/rooms`, {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: "{}",
    }));
    expect(crossOrigin.status).toBe(403);
  });

  it("does not expose any file upload route", async () => {
    const response = await post("/api/upload", { content: "not accepted" });
    expect(response.status).toBe(404);
  });
});
