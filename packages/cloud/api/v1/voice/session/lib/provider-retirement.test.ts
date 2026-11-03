import { afterEach, expect, test } from "bun:test";
import { createWorkerCartesiaFactory } from "./provider-socket-factory";
const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
function fetchFixture(handler: () => Promise<Response>): typeof fetch {
  return Object.assign(handler, { preconnect: (..._args: Parameters<typeof fetch.preconnect>) => {} });
}
afterEach(() => {
  if (originalFetchDescriptor) Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
  else Reflect.deleteProperty(globalThis, "fetch");
});
test("pre-bind cancellation aborts fetch, drops queued sends, and still observes late real close", async () => {
  let resolve!: (value: unknown) => void; let signal: AbortSignal | undefined;
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, enumerable: originalFetchDescriptor?.enumerable ?? true, value: (_url: unknown, init: any) => { signal = init.signal; return new Promise(yes => { resolve = yes; }); } });
  const listeners = new Map<string, Array<(value: unknown) => void>>(); const sent: unknown[] = [];
  const real = { accept() {}, addEventListener(type: string, fn: (value: unknown) => void) { listeners.set(type, [...listeners.get(type) ?? [], fn]); }, removeEventListener() {}, send(value: unknown) { sent.push(value); }, close() { for (const fn of listeners.get("close") ?? []) fn({ code: 1000, wasClean: true }); } };
  const proxy = createWorkerCartesiaFactory()("wss://provider.invalid", { headers: {} }); let closed = 0;
  proxy.addEventListener("close", () => { closed++; }); proxy.send("queued"); proxy.close(1000, "stop");
  expect(signal?.aborted).toBe(true); resolve({ webSocket: real });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(closed).toBe(1); expect(sent).toHaveLength(0);
});

test("local abort stays unknown after the issued upgrade settles", async () => {
  let reject!: (error: unknown) => void;
  globalThis.fetch = fetchFixture(() => new Promise<Response>((_resolve, no) => { reject = no; }));
  const socket = createWorkerCartesiaFactory()("wss://provider.invalid", { headers: {} }) as any;
  socket.close(1000, "stop"); expect(socket.retirementState()).toBe("pending");
  reject(new DOMException("cancelled", "AbortError"));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(socket.retirementState()).toBe("unknown");
});
test("a generic failed upgrade never fabricates no-dispatch proof", async () => {
  let reject!: (error: unknown) => void;
  globalThis.fetch = fetchFixture(() => new Promise<Response>((_resolve, no) => { reject = no; }));
  const socket = createWorkerCartesiaFactory()("wss://provider.invalid", { headers: {} }) as any;
  socket.close(1000, "stop"); reject(Error("unknown transport failure"));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(socket.retirementState()).toBe("unknown");
});

for (const event of [{ code: 1006, wasClean: false }, { code: 1000, wasClean: false }, { code: 1000 }]) {
  test(`bound provider close needs a verified normal handshake: ${JSON.stringify(event)}`, async () => {
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const real = { accept() {}, send() {}, close() {}, addEventListener(type: string, fn: (event: unknown) => void) { listeners.set(type, [...listeners.get(type) ?? [], fn]); }, removeEventListener() {} };
    globalThis.fetch = fetchFixture(async () => Object.assign(new Response(null), { webSocket: real }));
    const socket = createWorkerCartesiaFactory()("wss://provider.invalid", { headers: {} }) as any;
    for (let i = 0; i < 20; i++) await Promise.resolve();
    socket.send("payload");
    for (const fn of listeners.get("close") ?? []) fn(event);
    expect(socket.retirementState()).toBe("unknown");
  });
}

for (const status of [401, 403, 429, 500]) {
  test(`HTTP ${status} without a provider allocation contract remains unknown`, async () => {
    globalThis.fetch = fetchFixture(async () => new Response(null, { status }));
    const socket = createWorkerCartesiaFactory()("wss://provider.invalid", { headers: {} }) as any;
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(socket.retirementState()).toBe("unknown");
  });
}
