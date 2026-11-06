import { afterEach, expect, test, vi } from "vitest";
import { CartesiaSonicTtsAdapter } from "./cartesia-sonic-tts";

class Socket {
  readyState = 1;
  listeners = new Map<string, Array<(value: unknown) => void>>();
  addEventListener(type: string, listener: (value: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (value: unknown) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((value) => value !== listener),
    );
  }
  send() {}
  close() {
    this.readyState = 2;
  }
  emit(type: string, value: unknown) {
    if (type === "close") this.readyState = 3;
    for (const fn of this.listeners.get(type) ?? []) fn(value);
  }
}
function setup() {
  const sockets: Socket[] = [];
  const adapter = new CartesiaSonicTtsAdapter({
    apiKey: "synthetic",
    voiceId: "00000000-0000-4000-8000-000000000001",
    websocketFactory: (() => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    }) as never,
  });
  return { adapter, sockets };
}
afterEach(() => vi.useRealTimers());
test("no socket and no dispatch is not-dispatched", async () =>
  expect(await setup().adapter.closeAndConfirm()).toBe("not_dispatched"));
test("actual clean close from captured generation is confirmed", async () => {
  const { adapter, sockets } = setup();
  adapter.createStream({ contextId: "a" }, {});
  const done = adapter.closeAndConfirm();
  sockets[0].emit("close", { code: 1000, wasClean: true });
  expect(await done).toBe("transport_closed");
});
test("context completion is not transport closure", async () => {
  vi.useFakeTimers();
  const { adapter, sockets } = setup();
  const stream = adapter.createStream({ contextId: "a" }, {});
  sockets[0].emit("message", {
    data: JSON.stringify({ type: "done", done: true, context_id: "a" }),
  });
  await stream.closed;
  const done = adapter.closeAndConfirm(5);
  await vi.advanceTimersByTimeAsync(5);
  expect(await done).toBe("unknown");
});
test("clean close before waiter is remembered", async () => {
  const { adapter, sockets } = setup();
  adapter.createStream({ contextId: "a" }, {});
  sockets[0].emit("close", { code: 1000, wasClean: true });
  expect(await adapter.closeAndConfirm()).toBe("transport_closed");
});
test("old generation cannot confirm current socket", async () => {
  vi.useFakeTimers();
  const { adapter, sockets } = setup();
  adapter.createStream({ contextId: "a" }, {});
  sockets[0].emit("close", { code: 1000, wasClean: true });
  adapter.createStream({ contextId: "b" }, {});
  const done = adapter.closeAndConfirm(5);
  sockets[0].emit("close", { code: 1000, wasClean: true });
  await vi.advanceTimersByTimeAsync(5);
  expect(await done).toBe("unknown");
});
test.each([
  { code: 1006, wasClean: false },
  { code: 1000, wasClean: false },
  { code: 1000 },
])("unclean or unverified close remains unknown: %j", async (event) => {
  vi.useFakeTimers();
  const { adapter, sockets } = setup();
  adapter.createStream({ contextId: "a" }, {});
  const done = adapter.closeAndConfirm(5);
  sockets[0].emit("close", event);
  await vi.advanceTimersByTimeAsync(5);
  expect(await done).toBe("unknown");
});
test("late actual close can confirm a previously timed-out generation", async () => {
  vi.useFakeTimers();
  const { adapter, sockets } = setup();
  adapter.createStream({ contextId: "a" }, {});
  const done = adapter.closeAndConfirm(5);
  await vi.advanceTimersByTimeAsync(5);
  expect(await done).toBe("unknown");
  sockets[0].emit("close", { code: 1000, wasClean: true });
  expect(await adapter.closeAndConfirm(5)).toBe("transport_closed");
});

test("an error event is not closure and does not suppress a later real close", async () => {
  vi.useFakeTimers();
  const { adapter, sockets } = setup();
  adapter.createStream({ contextId: "a" }, {});
  sockets[0].emit("error", {});
  const first = adapter.closeAndConfirm(5);
  await vi.advanceTimersByTimeAsync(5);
  expect(await first).toBe("unknown");
  sockets[0].emit("close", { code: 1000, wasClean: true });
  expect(await adapter.closeAndConfirm(5)).toBe("transport_closed");
});
