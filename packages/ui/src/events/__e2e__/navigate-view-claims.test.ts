import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigateViewEvent } from "../index";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

let events: typeof import("../index");
let removers: Array<() => void>;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("window", new EventTarget());
  events = await import("../index");
  removers = [];
});
afterEach(() => {
  for (const remove of removers) remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function listen(
  listener: Parameters<typeof events.listenForNavigateViewRequests>[0],
) {
  const remove = events.listenForNavigateViewRequests(listener);
  removers.push(remove);
  return remove;
}

// These source-protocol checks intentionally preserve the observed retirement
// failures. Their matching Quint formulas are expected counterexamples, not
// claims that a retired partial effect is safe to retry.
describe("navigation request claims", () => {
  it("retains distinct cold requests and applies them in FIFO order", async () => {
    const first = events.dispatchNavigateViewRequest({ viewId: "notes" });
    const second = events.dispatchNavigateViewRequest({ viewId: "files" });
    const seen: Array<string | undefined> = [];
    listen((event) => {
      seen.push(event.detail.viewId);
      return true;
    });
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(seen).toEqual(["notes", "files"]);
  });

  it("does not let a later request overtake an applying request", async () => {
    const pending = deferred<boolean>();
    const seen: Array<string | undefined> = [];
    listen((event) => {
      seen.push(event.detail.viewId);
      return event.detail.viewId === "notes" ? pending.promise : true;
    });
    const first = events.dispatchNavigateViewRequest({ viewId: "notes" });
    const second = events.dispatchNavigateViewRequest({ viewId: "files" });
    expect(seen).toEqual(["notes"]);
    pending.resolve(true);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(seen).toEqual(["notes", "files"]);
  });

  it("keeps identical payloads as distinct request identities", async () => {
    const seen: object[] = [];
    listen((event) => {
      seen.push(event.detail);
      return true;
    });
    const detail = { viewId: "notes" };
    expect(await events.dispatchNavigateViewRequest(detail)).toBe(true);
    expect(await events.dispatchNavigateViewRequest(detail)).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]).not.toBe(detail);
  });

  it("allows another listener to claim after a synchronous refusal or throw", async () => {
    listen(() => false);
    listen(() => {
      throw new Error("destination unavailable");
    });
    let applied = 0;
    listen(() => {
      applied++;
      return true;
    });
    expect(await events.dispatchNavigateViewRequest({ viewId: "notes" })).toBe(
      true,
    );
    expect(applied).toBe(1);
  });

  it("retries a declined head after a new dispatch resets the decline epoch", async () => {
    let available = false;
    let calls = 0;
    listen(() => {
      calls++;
      return Promise.resolve(available);
    });
    const first = events.dispatchNavigateViewRequest({ viewId: "notes" });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    available = true;
    const second = events.dispatchNavigateViewRequest({ viewId: "files" });
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(calls).toBe(3);
  });

  it("rejects only an applying live request and resolves it once", async () => {
    const pending = deferred<boolean>();
    let captured!: NavigateViewEvent;
    let rejected = 0;
    listen((event) => {
      captured = event;
      return pending.promise;
    });
    const result = events.dispatchNavigateViewRequest(
      { viewId: "notes" },
      { onRejected: () => rejected++ },
    );
    expect(events.rejectNavigateViewRequest(captured)).toBe(true);
    expect(events.rejectNavigateViewRequest(captured)).toBe(false);
    expect(await result).toBe(false);
    pending.resolve(true);
    await Promise.resolve();
    expect(rejected).toBe(1);
    expect(events.isNavigateViewRequestPending(captured)).toBe(false);
  });

  it("drops the oldest request at the exact sixteen-item bound", async () => {
    const results = Array.from({ length: 17 }, (_, index) =>
      events.dispatchNavigateViewRequest({
        viewId: "notes",
        viewPath: String(index),
      }),
    );
    expect(await results[0]).toBe(false);
    const seen: Array<string | undefined> = [];
    listen((event) => {
      seen.push(event.detail.viewPath ?? "");
      return true;
    });
    expect(await Promise.all(results.slice(1))).toEqual(Array(16).fill(true));
    expect(seen).toEqual(
      Array.from({ length: 16 }, (_, index) => String(index + 1)),
    );
  });

  it("keeps a replacement blocked until the retired promise settles", async () => {
    const pending = deferred<boolean>();
    const remove = listen(() => pending.promise);
    const result = events.dispatchNavigateViewRequest({ viewId: "notes" });
    remove();
    let calls = 0;
    listen(() => {
      calls++;
      return true;
    });
    await Promise.resolve();
    expect(calls).toBe(0);
    pending.resolve(false);
    expect(await result).toBe(true);
    expect(calls).toBe(1);
  });

  it("repeats a pre-completion effect after its retired promise resolves true", async () => {
    const pending = deferred<boolean>();
    let effects = 0;
    const remove = listen(() => {
      effects++;
      return pending.promise;
    });
    const result = events.dispatchNavigateViewRequest({ viewId: "notes" });
    remove();
    listen(() => {
      effects++;
      return true;
    });
    expect(effects).toBe(1);
    pending.resolve(true);
    expect(await result).toBe(true);
    expect(effects).toBe(2);
  });

  it("allows reentrant delivery before the first callback publishes applying", async () => {
    const first = deferred<boolean>();
    let entered = false;
    let calls = 0;
    listen((event) => {
      calls++;
      if (!entered) {
        entered = true;
        window.dispatchEvent(events.createNavigateViewEvent(event.detail));
        return first.promise;
      }
      return true;
    });
    expect(await events.dispatchNavigateViewRequest({ viewId: "notes" })).toBe(
      true,
    );
    expect(calls).toBe(2);
    first.resolve(true);
    await Promise.resolve();
  });
});
