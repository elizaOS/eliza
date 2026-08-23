/**
 * Behavioral regression for fetch timeout — calls real fetchWithDeadline and createTimeoutSignal
 */
import { describe, it, expect } from "vitest";
import { fetchWithDeadline } from "../utils/fetch-with-deadline";
import { createTimeoutSignal, isTimeoutAbortError } from "../api/timeout-signal";

describe("fetch timeout — real functions", () => {
  it("createTimeoutSignal timeout aborts with TimeoutError", async () => {
    const { signal, dispose } = createTimeoutSignal(10);
    await expect(new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })).rejects.toMatchObject({ name: "TimeoutError" });
    dispose();
  });
  it("fetchWithDeadline aborts stalled fetch via TimeoutError through consume", async () => {
    const stall: typeof fetch = (_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject((init.signal as AbortSignal).reason), { once: true });
    }) as any;
    await expect(fetchWithDeadline("https://example.test", {}, async (r) => r.text(), { fetchImpl: stall, timeoutMs: 5 })).rejects.toMatchObject({ name: "TimeoutError" });
  });
  it("fetchWithDeadline preserves caller AbortError (not TimeoutError)", async () => {
    const caller = new AbortController();
    const stall: typeof fetch = (_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject((init.signal as AbortSignal).reason), { once: true });
    }) as any;
    const p = fetchWithDeadline("https://example.test", {}, async (r) => r.text(), { fetchImpl: stall, signal: caller.signal, timeoutMs: 1000 });
    caller.abort(new DOMException("superseded", "AbortError"));
    await expect(p).rejects.toMatchObject({ name: "AbortError", message: "superseded" });
  });
  it("isTimeoutAbortError distinguishes TimeoutError/AbortError", () => {
    expect(isTimeoutAbortError(new DOMException("x", "TimeoutError"))).toBe(true);
    expect(isTimeoutAbortError(new DOMException("x", "AbortError"))).toBe(true);
    expect(isTimeoutAbortError(new Error("x"))).toBe(false);
  });
});
