/**
 * Unit tests for the generative provider health breaker: real module, no
 * mocks, deterministic clocks passed explicitly. Covers threshold opening,
 * failure classification, config-error immunity, cooldown expiry (half-open),
 * immediate reopen on a post-cooldown failure, and success closing the gate.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  checkGenerativeProviderHealth,
  classifyGenerativeFailure,
  recordGenerativeFailure,
  recordGenerativeSuccess,
  resetGenerativeProviderHealthForTests,
} from "./generative-provider-health";

const KEY = "music:fal:fal-ai/minimax-music/v2.6";
const T0 = 1_700_000_000_000;

beforeEach(() => {
  resetGenerativeProviderHealthForTests();
});

describe("classifyGenerativeFailure", () => {
  test("timeouts, 5xx, 4xx, and config errors classify distinctly", () => {
    expect(
      classifyGenerativeFailure(new Error("fal queue job timed out after 300000ms (request r1)")),
    ).toBe("timeout");
    expect(classifyGenerativeFailure(new Error("fal queue submit failed (503)"))).toBe(
      "upstream_error",
    );
    expect(classifyGenerativeFailure(new Error("fal queue submit failed (401): bad key"))).toBe(
      "config_error",
    );
    expect(
      classifyGenerativeFailure(new Error("fal is not configured: missing FAL_KEY / FAL_API_KEY")),
    ).toBe("config_error");
    expect(classifyGenerativeFailure(new Error("socket hang up"))).toBe("upstream_error");
  });
});

describe("breaker lifecycle", () => {
  test("opens only at the consecutive-failure threshold", () => {
    expect(recordGenerativeFailure(KEY, "timeout", T0).degraded).toBe(false);
    expect(recordGenerativeFailure(KEY, "timeout", T0).degraded).toBe(false);
    const opened = recordGenerativeFailure(KEY, "timeout", T0);
    expect(opened.degraded).toBe(true);
    expect(opened.retryAfterSeconds).toBeGreaterThan(0);
    expect(opened.lastFailureKind).toBe("timeout");
    expect(checkGenerativeProviderHealth(KEY, T0).degraded).toBe(true);
  });

  test("config errors never advance or reset the breaker", () => {
    recordGenerativeFailure(KEY, "timeout", T0);
    recordGenerativeFailure(KEY, "timeout", T0);
    // A bad-key 401 between timeouts must not trip the gate...
    expect(recordGenerativeFailure(KEY, "config_error", T0).degraded).toBe(false);
    // ...and must not have consumed the third strike either.
    expect(checkGenerativeProviderHealth(KEY, T0).degraded).toBe(false);
    expect(recordGenerativeFailure(KEY, "upstream_error", T0).degraded).toBe(true);
  });

  test("cooldown expiry half-opens; one more failure reopens immediately", () => {
    for (let i = 0; i < 3; i++) recordGenerativeFailure(KEY, "timeout", T0);
    const later = T0 + 121_000;
    expect(checkGenerativeProviderHealth(KEY, later).degraded).toBe(false);
    // Half-open: a single further eligible failure reopens without needing
    // three fresh strikes.
    expect(recordGenerativeFailure(KEY, "upstream_error", later).degraded).toBe(true);
  });

  test("success fully closes the gate and resets the strike count", () => {
    for (let i = 0; i < 3; i++) recordGenerativeFailure(KEY, "timeout", T0);
    recordGenerativeSuccess(KEY);
    expect(checkGenerativeProviderHealth(KEY, T0).degraded).toBe(false);
    expect(recordGenerativeFailure(KEY, "timeout", T0).degraded).toBe(false);
    expect(recordGenerativeFailure(KEY, "timeout", T0).degraded).toBe(false);
  });

  test("keys are independent per provider+model", () => {
    for (let i = 0; i < 3; i++) recordGenerativeFailure(KEY, "timeout", T0);
    expect(checkGenerativeProviderHealth("music:elevenlabs/music_v1", T0).degraded).toBe(false);
  });
});
