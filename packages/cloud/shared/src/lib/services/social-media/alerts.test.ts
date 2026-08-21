// Pins the bounded-delivery contract of the cloud alert senders: every
// webhook / API hop fails closed at the alert timeout instead of pinning the
// alert worker forever, and a caller-provided signal is composed with that
// deadline rather than replacing it.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { alertFetch } from "./alerts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("alertFetch — bounded hops fail closed and keep caller signals", () => {
  test("aborts a hung webhook hop at the timeout", async () => {
    // A webhook that never settles on its own: the only way out is the
    // caller's AbortSignal firing (the 15s default bounds every sender).
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ) as typeof fetch;

    const start = Date.now();
    await expect(alertFetch("https://hooks.example/alert", undefined, 100)).rejects.toThrow(
      /aborted/i,
    );
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("composes a caller-provided abort signal with the deadline", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const controller = new AbortController();
    await alertFetch("https://hooks.example/alert", {
      signal: controller.signal,
    });
    // The wrapper owns the deadline, so the transport receives a composition of
    // the caller signal and that deadline, never the caller object itself.
    expect(seen).not.toBe(controller.signal);
    expect(seen?.aborted).toBe(false);
  });

  test("still aborts at the deadline when the caller signal never fires", async () => {
    // Regression: the wrapper used to read `init?.signal ?? AbortSignal.timeout(ms)`,
    // so any caller signal REPLACED the deadline. A request-scoped controller
    // that outlives this hop and is never aborted then left the hop unbounded —
    // it stayed hung well past 10x the declared deadline against a real
    // non-responding socket.
    // Mirrors real fetch: the only way out is the signal firing, and the
    // rejection carries the signal's own reason, so the assertion below can
    // tell the wrapper's deadline (TimeoutError) from any other abort.
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              init.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        }),
    ) as typeof fetch;

    const caller = new AbortController();
    // Raced against a watchdog rather than awaited directly: an unbounded hop
    // never settles, so a regression has to surface as a failed assertion here
    // and not as a hung test file.
    const outcome = await Promise.race([
      alertFetch("https://hooks.example/alert", { signal: caller.signal }, 100).then(
        () => "resolved",
        (error: Error) => `aborted:${error.name}`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("STILL-HUNG"), 1_000)),
    ]);
    expect(outcome).toBe("aborted:TimeoutError");
    expect(caller.signal.aborted).toBe(false);
  });

  test("still lets the caller abort early, ahead of the deadline", async () => {
    // No over-rejection: composing must not cost the caller its own cancellation.
    // Mirrors real fetch: the only way out is the signal firing, and the
    // rejection carries the signal's own reason, so the assertion below can
    // tell the wrapper's deadline (TimeoutError) from any other abort.
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              init.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        }),
    ) as typeof fetch;

    const caller = new AbortController();
    const pending = alertFetch("https://hooks.example/alert", { signal: caller.signal }, 60_000);
    caller.abort();
    await expect(pending).rejects.toThrow(/aborted/i);
  });
});
