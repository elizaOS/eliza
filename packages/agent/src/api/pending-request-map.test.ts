/**
 * Exercises the in-memory pending-request rendezvous with deterministic timers.
 * The unit harness covers resolution, timeout cleanup, and duplicate-id
 * supersession without a WebSocket server or agent runtime.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingRequestMap } from "./pending-request-map.ts";

describe("PendingRequestMap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves a matching waiter and clears its timeout", async () => {
    const pending = new PendingRequestMap();
    const waited = pending.waitFor("request-1", 1_000);
    const result = { requestId: "request-1", success: true, result: "done" };

    expect(pending.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    pending.resolve("request-1", result);

    await expect(waited).resolves.toEqual(result);
    expect(pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects and removes a waiter when its timeout expires", async () => {
    const pending = new PendingRequestMap();
    const waited = pending.waitFor("request-timeout", 1_000);
    const rejected = expect(waited).rejects.toMatchObject({
      code: "PENDING_REQUEST_TIMEOUT",
      context: { requestId: "request-timeout", timeoutMs: 1_000 },
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await rejected;
    expect(pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles a displaced waiter without letting its timer remove the replacement", async () => {
    const pending = new PendingRequestMap();
    const first = pending.waitFor("duplicate", 1_000);
    const firstRejected = expect(first).rejects.toMatchObject({
      code: "PENDING_REQUEST_SUPERSEDED",
      context: { requestId: "duplicate" },
    });

    const replacement = pending.waitFor("duplicate", 2_000);

    await firstRejected;
    expect(pending.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(pending.size).toBe(1);

    const result = { requestId: "duplicate", success: true };
    pending.resolve("duplicate", result);

    await expect(replacement).resolves.toEqual(result);
    expect(pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores an unknown result without disturbing another waiter", async () => {
    const pending = new PendingRequestMap();
    const waited = pending.waitFor("known", 1_000);

    pending.resolve("unknown", { requestId: "unknown", success: true });

    expect(pending.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    const result = { requestId: "known", success: true };
    pending.resolve("known", result);
    await expect(waited).resolves.toEqual(result);
  });
});
