import { afterEach, expect, test, vi } from "vitest";
import { createWorkerCartesiaFactory } from "./provider-socket-factory";
afterEach(() => vi.unstubAllGlobals());
test("pre-bind cancellation aborts fetch, drops queued sends, and still observes late real close", async () => {
  let resolve!: (value: unknown) => void; let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch", (_url: unknown, init: any) => { signal = init.signal; return new Promise(yes => { resolve = yes; }); });
  const listeners = new Map<string, Array<(value: unknown) => void>>(); const sent: unknown[] = [];
  const real = { accept() {}, addEventListener(type: string, fn: (value: unknown) => void) { listeners.set(type, [...listeners.get(type) ?? [], fn]); }, removeEventListener() {}, send(value: unknown) { sent.push(value); }, close() { for (const fn of listeners.get("close") ?? []) fn({ code: 1000, wasClean: true }); } };
  const proxy = createWorkerCartesiaFactory()("wss://provider.invalid", { headers: {} }); let closed = 0;
  proxy.addEventListener("close", () => { closed++; }); proxy.send("queued"); proxy.close(1000, "stop");
  expect(signal?.aborted).toBe(true); resolve({ webSocket: real });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(closed).toBe(1); expect(sent).toHaveLength(0);
});
