import { expect, test } from "vitest";
import {
  type CartesiaInkWebSocket,
  createCartesiaInkRealtimeSession,
} from "./cartesia-ink";

function fixture() {
  const listeners = new Map<string, Set<(event: unknown) => void>>(),
    sent: unknown[] = [];
  let remoteClosed = false;
  const socket = {
    readyState: 1,
    binaryType: "arraybuffer",
    send: (value: unknown) => sent.push(value),
    close: () => {
      remoteClosed = true;
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.get(type)?.delete(listener),
  };
  const session = createCartesiaInkRealtimeSession({
    cartesiaApiKey: "synthetic-not-a-key",
    webSocketFactory: () => socket as unknown as CartesiaInkWebSocket,
    onEvent: () => {},
  });
  const drain = session.drain;
  if (!drain) throw Error("Canonical drain missing");
  return {
    session,
    drain,
    sent,
    emit: (type: string, event: unknown) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    get locallyClosed() {
      return remoteClosed;
    },
  };
}
test("drain waits for actual provider close after JSON close and settles exact server-sent PCM duration", async () => {
  const f = fixture();
  f.session.sendAudioChunk(new Uint8Array(3200));
  f.session.sendAudioChunk(new Uint8Array(3200));
  const first = f.drain(100),
    second = f.drain(100);
  expect(first).toBe(second);
  expect(f.sent.at(-1)).toBe('{"type":"close"}');
  let resolved = false;
  void first.then(() => (resolved = true));
  await Promise.resolve();
  expect(resolved).toBe(false);
  f.emit("close", { wasClean: true, code: 1000, reason: "" });
  expect(await first).toEqual({
    source: "provider-graceful-close",
    audioBytes: 6400,
    sampleRate: 16000,
    channels: 1,
    encoding: "pcm_s16le",
  });
  expect(f.locallyClosed).toBe(false);
});
test("synthetic clean local cancel is never a drain ACK", async () => {
  const f = fixture(),
    drain = f.drain(100);
  f.session.cancel("stop");
  await expect(drain).rejects.toThrow("cancelled");
  await expect(f.drain(100)).rejects.toThrow();
  expect(f.locallyClosed).toBe(true);
});
test("unexpected normal close without graceful request cannot prove buffer drain", async () => {
  const f = fixture();
  f.emit("close", { wasClean: true, code: 1000, reason: "" });
  await expect(f.drain(100)).rejects.toThrow("without graceful");
});
test("timeout or abnormal provider close stays unknown and cancels the transport", async () => {
  const f = fixture();
  await expect(f.drain(5)).rejects.toThrow("timed out");
  expect(f.locallyClosed).toBe(true);
  const g = fixture(),
    drain = g.drain(100);
  g.emit("close", { wasClean: false, code: 1006, reason: "" });
  await expect(drain).rejects.toThrow("without graceful");
});
test("a provider protocol error prevents a subsequent normal close from fabricating proof", async () => {
  const f = fixture(),
    drain = f.drain(100);
  f.emit("message", {
    data: JSON.stringify({ type: "error", message: "synthetic rejection" }),
  });
  await expect(drain).rejects.toThrow("rejected");
  f.emit("close", { wasClean: true, code: 1000, reason: "" });
  await expect(f.drain(100)).rejects.toThrow();
});

test("Bun remote normal-close fallback proves silence without inventing a final transcript", async () => {
  const f = fixture();
  f.session.sendAudioChunk(new Uint8Array(3200));
  const drain = f.drain(100);
  f.emit("close", { wasClean: false, code: 1000, reason: "Close message" });
  expect((await drain).audioBytes).toBe(3200);
  expect(f.locallyClosed).toBe(false);
});
test("Bun fallback requires an observed speech turn to end before remote closure", async () => {
  const f = fixture();
  f.emit("message", { data: JSON.stringify({ type: "turn.start" }) });
  const drain = f.drain(100);
  f.emit("message", {
    data: JSON.stringify({ type: "turn.end", transcript: "Hi." }),
  });
  f.emit("close", { wasClean: false, code: 1000, reason: "Close message" });
  expect((await drain).source).toBe("provider-graceful-close");
  const g = fixture();
  g.emit("message", { data: JSON.stringify({ type: "turn.start" }) });
  const incomplete = g.drain(100);
  g.emit("close", { wasClean: false, code: 1000, reason: "Close message" });
  await expect(incomplete).rejects.toThrow();
});
test("wrong remote reason and transport errors cannot qualify Bun close fallback", async () => {
  const f = fixture(),
    drain = f.drain(100);
  f.emit("close", { wasClean: false, code: 1000, reason: "unrelated" });
  await expect(drain).rejects.toThrow();
  const g = fixture(),
    failed = g.drain(100);
  g.emit("error", new Event("error"));
  await expect(failed).rejects.toThrow("transport failed");
  g.emit("close", { wasClean: false, code: 1000, reason: "Close message" });
  await expect(g.drain(100)).rejects.toThrow();
});
