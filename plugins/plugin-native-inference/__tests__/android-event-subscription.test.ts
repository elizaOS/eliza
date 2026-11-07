/**
 * `events_subscribe` over the real private Android IPC socket: live-only,
 * filtered, bounded, authenticated agent-event delivery (voice-transcript).
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import {
  type AgentEventBusEvent,
  serveAgentEventSubscription,
} from "../src/android/event-subscription.ts";
import { startLocalAgentServer } from "../src/android/private-dispatch.ts";
import {
  type PrivateConnection,
  parseSubscriptionStreams,
} from "../src/android/private-ipc.ts";

const TOKEN = "t".repeat(32);

function fixture() {
  const home = fs.realpathSync(
    fs.mkdtempSync(path.join(tmpdir(), "ipc-ev-test-")),
  );
  fs.chmodSync(home, 0o700);
  fs.mkdirSync(path.join(home, "ipc"), { mode: 0o700 });
  const file = path.join(home, "ipc", "a.sock");
  return {
    home,
    file,
    env: {
      HOME: home,
      ELIZA_LOCAL_AGENT_TRANSPORT: "filesystem-v1",
      ELIZA_LOCAL_AGENT_SOCKET_PATH: file,
      ELIZA_API_TOKEN: TOKEN,
    } as NodeJS.ProcessEnv,
  };
}

class FakeBus {
  listeners = new Set<(event: AgentEventBusEvent) => void>();
  seq = 0;
  subscribe(listener: (event: AgentEventBusEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(stream: string, data: Record<string, unknown>) {
    const event = {
      runId: `${stream}:s1`,
      seq: ++this.seq,
      stream,
      ts: 1_000 + this.seq,
      data,
      agentId: "agent-1",
    };
    for (const listener of [...this.listeners]) listener(event);
  }
}

function runtimeWith(bus: FakeBus | null): IAgentRuntime {
  return {
    getService: (type: string) => (type === "AGENT_EVENT" ? bus : null),
  } as unknown as IAgentRuntime;
}

/** Bounded wait; no sleep is used as evidence. */
async function until(check: () => boolean, label: string, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw Error(label);
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

interface Peer {
  socket: Socket;
  frames: Record<string, unknown>[];
  closed: () => boolean;
}

function subscribeFrame(streams: unknown, token: string | null = TOKEN) {
  return `${JSON.stringify({
    id: "sub-1",
    method: "events_subscribe",
    payload: {
      streams,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    },
  })}\n`;
}

async function open(file: string, line: string): Promise<Peer> {
  const socket = connect(file);
  const frames: Record<string, unknown>[] = [];
  let closed = false;
  let pending = "";
  socket.on("data", (chunk) => {
    pending += chunk;
    let at = pending.indexOf("\n");
    while (at >= 0) {
      frames.push(JSON.parse(pending.slice(0, at)));
      pending = pending.slice(at + 1);
      at = pending.indexOf("\n");
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    closed = true;
  });
  await new Promise<void>((r) => socket.once("connect", () => r()));
  socket.write(line);
  return { socket, frames, closed: () => closed };
}

async function withServer(
  bus: FakeBus | null,
  body: (f: ReturnType<typeof fixture>) => Promise<void>,
  dispatchRoute: Parameters<typeof startLocalAgentServer>[1] = async () => ({
    status: 200,
    body: "ok",
  }),
) {
  const f = fixture();
  const server = await startLocalAgentServer(
    runtimeWith(bus),
    dispatchRoute,
    {
      configFileExists: () => true,
      loadElizaConfig: () => ({}),
      saveElizaConfig: () => {},
      hasPersistedFirstRunState: () => true,
      fullApiKernel: true,
      ephemeralAgentEventStreams: new Set(["voice-transcript"]),
    },
    f.env,
  );
  try {
    await body(f);
  } finally {
    await server.stop();
    fs.rmSync(f.home, { recursive: true, force: true });
  }
}

test("delivers only filtered live events; ephemeral voice-transcript keeps WS envelope semantics", async () => {
  const bus = new FakeBus();
  await withServer(bus, async (f) => {
    // Emitted before anyone subscribed: never replayed.
    bus.emit("voice-transcript", { phase: "partial", text: "early", seq: 1 });
    const peer = await open(
      f.file,
      subscribeFrame(["voice-transcript", "assistant"]),
    );
    await until(() => peer.frames.length >= 1, "no subscribed ack");
    expect(peer.frames[0]).toEqual({
      id: "sub-1",
      event: "subscribed",
      streams: ["voice-transcript", "assistant"],
    });
    expect(bus.listeners.size).toBe(1);
    bus.emit("voice-transcript", {
      type: "voice-transcript",
      phase: "speech-start",
      sessionId: "s1",
      turnId: "vt-1",
    });
    bus.emit("tool", { name: "filtered-out" });
    bus.emit("voice-transcript", {
      type: "voice-transcript",
      phase: "partial",
      sessionId: "s1",
      turnId: "vt-1",
      text: "hello",
      seq: 1,
    });
    bus.emit("assistant", { text: "durable stream" });
    await until(() => peer.frames.length >= 4, "events not delivered");
    const events = peer.frames.slice(1);
    expect(events.map((e) => e.event)).toEqual([
      "agent_event",
      "agent_event",
      "agent_event",
    ]);
    const [start, partial, assistant] = events.map(
      (e) => e.data as Record<string, unknown>,
    );
    expect(start).toMatchObject({
      type: "agent_event",
      version: 1,
      ephemeral: true,
      stream: "voice-transcript",
      agentId: "agent-1",
      payload: { phase: "speech-start", turnId: "vt-1" },
    });
    expect(partial).toMatchObject({
      ephemeral: true,
      payload: { phase: "partial", text: "hello" },
    });
    expect(String(partial?.eventId)).toMatch(/^eph-\d+$/);
    expect(partial?.bufferSeq).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain("early");
    expect(JSON.stringify(events)).not.toContain("filtered-out");
    // Non-ephemeral streams are still live-only over IPC: no replay cursor.
    expect(assistant?.ephemeral).toBeUndefined();
    expect(String(assistant?.eventId)).toMatch(/^ipc-\d+$/);
    expect(assistant?.bufferSeq).toBeUndefined();
    // Peer close detaches the bus listener.
    peer.socket.destroy();
    await until(() => bus.listeners.size === 0, "listener leaked");
  });
});

test("refuses unauthenticated, unfiltered and invalid subscriptions; no bus attach", async () => {
  const bus = new FakeBus();
  await withServer(bus, async (f) => {
    const anon = await open(f.file, subscribeFrame(["voice-transcript"], null));
    await until(anon.closed, "unauthenticated peer stayed open");
    expect(anon.frames).toEqual([
      { id: "sub-1", event: "error", error: "Unauthorized" },
    ]);
    const wrong = await open(
      f.file,
      subscribeFrame(["voice-transcript"], "x".repeat(32)),
    );
    await until(wrong.closed, "wrong-token peer stayed open");
    expect(wrong.frames[0]?.error).toBe("Unauthorized");
    for (const streams of [undefined, [], ["*"], ["Bad Name"], [1]]) {
      const bad = await open(f.file, subscribeFrame(streams));
      await until(bad.closed, `invalid filter ${JSON.stringify(streams)}`);
      expect(bad.frames).toEqual([]);
    }
    expect(bus.listeners.size).toBe(0);
  });
  await withServer(null, async (f) => {
    const peer = await open(f.file, subscribeFrame(["voice-transcript"]));
    await until(peer.closed, "missing bus did not close");
    expect(peer.frames[0]?.error).toBe("Agent event service unavailable");
  });
});

test("subscriptions hold their own bounded slots and never starve requests", async () => {
  const bus = new FakeBus();
  await withServer(bus, async (f) => {
    const a = await open(f.file, subscribeFrame(["voice-transcript"]));
    const b = await open(f.file, subscribeFrame(["voice-transcript"]));
    await until(
      () => a.frames.length === 1 && b.frames.length === 1,
      "two subscriptions not acknowledged",
    );
    const c = await open(f.file, subscribeFrame(["voice-transcript"]));
    await until(c.closed, "third subscription admitted");
    expect(c.frames).toEqual([]);
    // All four request slots remain usable while two feeds are held open.
    const requests = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const peer = await open(
          f.file,
          `${JSON.stringify({ id: 9, method: "http_request", payload: { method: "GET", path: "/api/x" } })}\n`,
        );
        await until(peer.closed, "request did not complete");
        return peer.frames[0];
      }),
    );
    for (const response of requests) expect(response?.ok).toBe(true);
    bus.emit("voice-transcript", { phase: "final", text: "done" });
    await until(
      () => a.frames.length === 2 && b.frames.length === 2,
      "fan-out to both feeds",
    );
    a.socket.destroy();
    await until(() => bus.listeners.size === 1, "first feed not released");
    const d = await open(f.file, subscribeFrame(["voice-transcript"]));
    await until(() => d.frames.length === 1, "slot not reusable");
    b.socket.destroy();
    d.socket.destroy();
    await until(() => bus.listeners.size === 0, "listeners leaked");
  });
});

function fakeConnection(buffered = 0) {
  const lines: string[] = [];
  const abort = new AbortController();
  let destroyed = false;
  const connection: PrivateConnection = {
    aborted: abort.signal,
    write: (frame) => lines.push(JSON.stringify(frame)),
    writeLine: (line) => lines.push(line),
    close: () => abort.abort(),
    destroy: () => {
      destroyed = true;
      abort.abort();
    },
    get bufferedBytes() {
      return buffered;
    },
  };
  return {
    connection,
    lines,
    abort,
    destroyed: () => destroyed,
    setBuffered: (n: number) => {
      buffered = n;
    },
  };
}

const frameFor = (streams: string[]) => ({
  id: 7,
  method: "events_subscribe" as const,
  payload: { streams, headers: { authorization: `Bearer ${TOKEN}` } },
});

test("oversized or unserializable events explicitly terminate the real socket feed", async () => {
  for (const data of [{ text: "x".repeat(256 * 1024) }, { big: 1n }]) {
    const bus = new FakeBus();
    await withServer(bus, async (f) => {
      const peer = await open(f.file, subscribeFrame(["voice-transcript"]));
      await until(() => peer.frames.length === 1, "no subscription ack");
      bus.emit("voice-transcript", data);
      await until(peer.closed, "incomplete feed remained open");
      expect(peer.frames).toHaveLength(2);
      expect(peer.frames[1]?.event).toBe("error");
      expect(peer.frames[1]?.error).toContain("feed incomplete");
      expect(bus.listeners.size).toBe(0);
    });
  }
});

test("a stalled reader is disconnected instead of buffering more events", async () => {
  const bus = new FakeBus();
  const fake = fakeConnection();
  const served = serveAgentEventSubscription({
    frame: frameFor(["voice-transcript"]),
    connection: fake.connection,
    bus,
    expectedToken: TOKEN,
    frameByteLimit: 512,
    queueByteLimit: 4096,
  });
  fake.setBuffered(4000);
  bus.emit("voice-transcript", { phase: "final", text: "y".repeat(200) });
  await served;
  expect(fake.destroyed()).toBe(true);
  expect(bus.listeners.size).toBe(0);
  expect(fake.lines).toHaveLength(1);
});

test("keepalives flow while idle and stop with the subscription", async () => {
  const bus = new FakeBus();
  const fake = fakeConnection();
  const served = serveAgentEventSubscription({
    frame: frameFor(["voice-transcript"]),
    connection: fake.connection,
    bus,
    expectedToken: TOKEN,
    keepaliveMs: 10,
  });
  await until(
    () => fake.lines.filter((l) => l.includes("keepalive")).length >= 2,
    "no keepalive",
  );
  fake.abort.abort();
  await served;
  const count = fake.lines.length;
  await new Promise<void>((r) => setTimeout(r, 40));
  expect(fake.lines.length).toBe(count);
  expect(bus.listeners.size).toBe(0);
});

test("unset agent token refuses every subscription", async () => {
  const fake = fakeConnection();
  await serveAgentEventSubscription({
    frame: frameFor(["voice-transcript"]),
    connection: fake.connection,
    bus: new FakeBus(),
    expectedToken: undefined,
  });
  expect(JSON.parse(fake.lines[0] ?? "{}").error).toBe("Unauthorized");
});

test("stream filter parser dedupes and bounds", () => {
  expect(
    parseSubscriptionStreams(["voice-transcript", "voice-transcript"]),
  ).toEqual(["voice-transcript"]);
  expect(() =>
    parseSubscriptionStreams(Array.from({ length: 17 }, (_, i) => `s${i}`)),
  ).toThrow();
  expect(() => parseSubscriptionStreams(["a".repeat(65)])).toThrow();
});
