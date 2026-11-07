/** Real HTTP publication and WebSocket reconnect exercise multi-page recovery. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startApiServer } from "../src/api/server.ts";

const token = randomUUID();
const sockets = new Set<WebSocket>();
let directory: string;
let server: Awaited<ReturnType<typeof startApiServer>>;
interface EventFrame {
  type: string;
  eventId?: string;
  payload?: { index: number };
}
function connect(cursor?: string) {
  const frames: EventFrame[] = [];
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.port}/ws${cursor ? `?lastEventId=${cursor}` : ""}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: `http://127.0.0.1:${server.port}`,
      },
    },
  );
  sockets.add(ws);
  ws.on("message", (bytes) => frames.push(JSON.parse(String(bytes))));
  return { ws, frames };
}
async function publish(index: number) {
  const response = await fetch(
    `http://127.0.0.1:${server.port}/api/agent/event`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Origin: `http://127.0.0.1:${server.port}`,
      },
      body: JSON.stringify({ stream: "system", data: { index } }),
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ws-replay-"));
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  vi.stubEnv("ELIZA_API_TOKEN", token);
  vi.stubEnv("ELIZA_REQUIRE_LOCAL_AUTH", "1");
  server = await startApiServer({ port: 0, skipDeferredStartupWork: true });
});
afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  if (server) await server.close();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});
it("recovers all missed events before live delivery and preserves cursorless tail replay", async () => {
  const first = connect();
  await expect
    .poll(() => first.frames.some((frame) => frame.type === "status"))
    .toBe(true);
  await publish(0);
  await expect
    .poll(() => first.frames.find((frame) => frame.type === "agent_event"))
    .toBeDefined();
  const cursor = first.frames.find(
    (frame) => frame.type === "agent_event",
  )?.eventId;
  expect(cursor).toMatch(/^evt-\d+$/);
  await new Promise<void>((resolve) => {
    first.ws.once("close", () => resolve());
    first.ws.close();
  });
  for (let index = 1; index <= 300; index++) await publish(index);
  const resumed = connect(cursor);
  await expect
    .poll(() => resumed.frames.some((frame) => frame.type === "agent_event"))
    .toBe(true);
  await publish(301);
  await expect
    .poll(
      () =>
        resumed.frames.filter((frame) => frame.type === "agent_event").length,
    )
    .toBe(301);
  resumed.ws.send(JSON.stringify({ type: "ping" }));
  await expect
    .poll(() => resumed.frames.some((frame) => frame.type === "pong"))
    .toBe(true);
  const replay = resumed.frames.filter((frame) => frame.type === "agent_event");
  expect(replay.map((frame) => frame.payload?.index)).toEqual(
    Array.from({ length: 301 }, (_, index) => index + 1),
  );
  expect(new Set(replay.map((frame) => frame.eventId)).size).toBe(301);
  const fresh = connect();
  await expect
    .poll(() => fresh.frames.some((frame) => frame.type === "status"))
    .toBe(true);
  fresh.ws.send(JSON.stringify({ type: "ping" }));
  await expect
    .poll(() => fresh.frames.some((frame) => frame.type === "pong"))
    .toBe(true);
  expect(
    fresh.frames
      .filter((frame) => frame.type === "agent_event")
      .map((frame) => frame.payload?.index),
  ).toEqual(Array.from({ length: 120 }, (_, index) => index + 182));
});
