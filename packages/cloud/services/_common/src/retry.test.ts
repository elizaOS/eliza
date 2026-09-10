/** Exercises deterministic Cloud retry timing, HTTP-date parsing, caps, and cancellation. */

import { describe, expect, test } from "bun:test";
import { computeBackoffMs, parseRetryAfterMs, sleepWithAbort } from "./retry";

describe("retry timing primitives", () => {
  test("parses delta-seconds and HTTP-date values with an explicit cap", () => {
    const nowMs = Date.parse("2026-08-31T00:00:00.000Z");
    expect(parseRetryAfterMs("2.5", { nowMs, capMs: 10_000 })).toBe(2_500);
    expect(
      parseRetryAfterMs("Sun, 31 Aug 2026 00:00:03 GMT", {
        nowMs,
        capMs: 10_000,
      }),
    ).toBe(3_000);
    expect(parseRetryAfterMs("999999999999", { nowMs, capMs: 8_000 })).toBe(
      8_000,
    );
  });

  test("rejects malformed values and clamps past dates to zero", () => {
    const nowMs = Date.parse("2026-08-31T00:00:00.000Z");
    expect(parseRetryAfterMs("later", { nowMs })).toBeNull();
    expect(parseRetryAfterMs("2seconds", { nowMs })).toBeNull();
    expect(parseRetryAfterMs("1e6", { nowMs })).toBeNull();
    expect(parseRetryAfterMs("Sat, 30 Aug 2026 23:59:59 GMT", { nowMs })).toBe(
      0,
    );
  });

  test("caps decimal overflow before multiplication can produce infinity", () => {
    expect(parseRetryAfterMs("9".repeat(400), { capMs: 8_000 })).toBe(8_000);
  });

  test("uses deterministic full jitter when Retry-After is absent", () => {
    expect(
      computeBackoffMs({
        attempt: 2,
        baseDelayMs: 100,
        capMs: 1_000,
        retryAfter: null,
        random: () => 0.25,
      }),
    ).toBe(100);
  });

  test("rejects a wait immediately when its signal is already aborted", async () => {
    const signal = AbortSignal.abort(
      new DOMException("cancelled", "AbortError"),
    );
    await expect(sleepWithAbort(100, signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  test("cancels an in-flight wait and preserves the abort reason", async () => {
    const controller = new AbortController();
    const reason = new DOMException("stop", "AbortError");
    const waiting = sleepWithAbort(60_000, controller.signal);
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
  });
});
