/** Runs the API event hub over a real `ws` server and loopback clients: a peer that stops reading is terminated and unregistered with its send buffer bounded while a healthy peer receives every frame, and the liveness sweep terminates a peer that stops answering pings. */
import { once } from "node:events";
import type { Socket } from "node:net";
import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  createApiEventHub,
  createEventSocketLivenessSweep,
  EVENT_SOCKET_BACKPRESSURE_GRACE_MS,
  EVENT_SOCKET_BACKPRESSURE_HARD_LIMIT_BYTES,
  EVENT_SOCKET_BACKPRESSURE_SOFT_LIMIT_BYTES,
} from "../src/api/event-hub.ts";

const BROADCASTS = 2000;
const CHUNK_BYTES = 30 * 1024;
const CLOCK_STEP_MS = 100;
const FRAME_OVERHEAD_BYTES = 1024;
const GRACE_WINDOW_FRAMES =
  EVENT_SOCKET_BACKPRESSURE_GRACE_MS / CLOCK_STEP_MS + 2;

const openServers: WebSocketServer[] = [];
const openClients: WebSocket[] = [];

afterEach(async () => {
  for (const client of openClients.splice(0)) client.terminate();
  for (const server of openServers.splice(0)) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function listen(): Promise<{ server: WebSocketServer; port: number }> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  openServers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("WebSocket server is not bound to a TCP port");
  return { server, port: address.port };
}

async function connect(
  server: WebSocketServer,
  port: number,
): Promise<{ client: WebSocket; serverSide: WebSocket; raw: Socket }> {
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  openClients.push(client);
  let raw: Socket | null = null;
  client.on("upgrade", (response) => {
    raw = response.socket;
  });
  const [[serverSide]] = await Promise.all([
    once(server, "connection") as Promise<[WebSocket]>,
    once(client, "open"),
  ]);
  if (!raw) throw new Error("client never saw the upgrade response");
  return { client, serverSide, raw };
}

it("terminates a peer that stops reading with its buffer bounded and still delivers every frame to a healthy peer", async () => {
  const { server, port } = await listen();
  const clients = new Set<WebSocket>();
  const clientIds = new WeakMap<WebSocket, string>();
  server.on("connection", (socket) => {
    clients.add(socket);
    clientIds.set(socket, `client-${clients.size}`);
    socket.on("close", () => clients.delete(socket));
  });
  let clock = 0;
  const sendErrors: unknown[] = [];
  const hub = createApiEventHub({
    state: { eventBuffer: [], nextEventId: 1 },
    clients,
    clientIds,
    activeConversations: new WeakMap(),
    reportSendError: (error) => sendErrors.push(error),
    now: () => clock,
  });

  const stalled = await connect(server, port);
  stalled.raw.pause();
  const healthy = await connect(server, port);
  let healthyReceived = 0;
  healthy.client.on("message", () => {
    healthyReceived += 1;
  });

  const chunk = "x".repeat(CHUNK_BYTES);
  let maxStalledBuffered = 0;
  for (let seq = 0; seq < BROADCASTS; seq += 1) {
    hub.broadcast({ type: "stream-chunk", seq, chunk });
    maxStalledBuffered = Math.max(
      maxStalledBuffered,
      stalled.serverSide.bufferedAmount,
    );
    clock += CLOCK_STEP_MS;
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The fake clock charges CLOCK_STEP_MS per frame whether or not the
    // loopback drained. Give the healthy peer real time to drain before the
    // next frame, so only the paused peer can outlast the grace window.
    await waitFor(
      () =>
        healthy.serverSide.readyState !== WebSocket.OPEN ||
        healthy.serverSide.bufferedAmount <=
          EVENT_SOCKET_BACKPRESSURE_SOFT_LIMIT_BYTES,
      "the healthy peer to drain",
    );
  }

  expect(maxStalledBuffered).toBeGreaterThan(
    EVENT_SOCKET_BACKPRESSURE_SOFT_LIMIT_BYTES,
  );
  expect(maxStalledBuffered).toBeLessThan(
    Math.min(
      EVENT_SOCKET_BACKPRESSURE_HARD_LIMIT_BYTES,
      EVENT_SOCKET_BACKPRESSURE_SOFT_LIMIT_BYTES +
        GRACE_WINDOW_FRAMES * (CHUNK_BYTES + FRAME_OVERHEAD_BYTES),
    ),
  );
  expect(clients.has(stalled.serverSide)).toBe(false);
  await waitFor(
    () => stalled.serverSide.readyState === WebSocket.CLOSED,
    "the stalled socket to close",
  );
  await waitFor(
    () => healthyReceived === BROADCASTS,
    `every frame on the healthy peer (got ${healthyReceived})`,
  );
  expect(healthy.serverSide.readyState).toBe(WebSocket.OPEN);
  expect(sendErrors).toEqual([]);
}, 60_000);

it("terminates a peer that stops answering pings and keeps a responsive one", async () => {
  const { server, port } = await listen();
  const sweep = createEventSocketLivenessSweep<WebSocket>({
    clientIds: new WeakMap(),
    intervalMs: 250,
  });
  server.on("connection", (socket) => sweep.track(socket));
  try {
    const silent = await connect(server, port);
    const responsive = await connect(server, port);
    silent.raw.pause();

    await waitFor(
      () => silent.serverSide.readyState === WebSocket.CLOSED,
      "the silent peer to be terminated",
    );
    expect(responsive.serverSide.readyState).toBe(WebSocket.OPEN);
    expect(sweep.size).toBe(1);
  } finally {
    sweep.stop();
  }
}, 30_000);
