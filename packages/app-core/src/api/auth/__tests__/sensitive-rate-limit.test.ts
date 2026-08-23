import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetSensitiveLimiters,
  getSensitiveLimiter,
  SENSITIVE_RATE_LIMIT_MAX,
  SENSITIVE_RATE_LIMIT_WINDOW_MS,
} from "./sensitive-rate-limit.ts";

describe("getSensitiveLimiter", () => {
  it("returns the same limiter per name (registry)", () => {
    expect(getSensitiveLimiter("a.x")).toBe(getSensitiveLimiter("a.x"));
    expect(getSensitiveLimiter("a.x")).not.toBe(getSensitiveLimiter("b.y"));
  });

  it("rejects empty names", () => {
    expect(() => getSensitiveLimiter("")).toThrow(
      "Sensitive limiter name is required",
    );
    expect(() => getSensitiveLimiter("  ")).toThrow();
  });
});

describe("SensitiveRateLimiter.consume", () => {
  beforeEach(() => _resetSensitiveLimiters());

  it("allows up to the max per window then blocks", () => {
    const limiter = getSensitiveLimiter("test.limit");
    const now = 1_000_000;
    for (let i = 0; i < SENSITIVE_RATE_LIMIT_MAX; i++) {
      expect(limiter.consume("1.2.3.4", now)).toBe(true);
    }
    expect(limiter.consume("1.2.3.4", now)).toBe(false);
  });

  it("resets the window after the window elapses", () => {
    const limiter = getSensitiveLimiter("test.reset");
    const start = 2_000_000;
    for (let i = 0; i < SENSITIVE_RATE_LIMIT_MAX; i++) {
      limiter.consume("9.9.9.9", start);
    }
    expect(limiter.consume("9.9.9.9", start)).toBe(false);
    // 窗口过期后重置
    expect(
      limiter.consume("9.9.9.9", start + SENSITIVE_RATE_LIMIT_WINDOW_MS + 1),
    ).toBe(true);
  });

  it("keeps buckets isolated per ip", () => {
    const limiter = getSensitiveLimiter("test.isolated");
    const now = 3_000_000;
    for (let i = 0; i < SENSITIVE_RATE_LIMIT_MAX; i++) {
      limiter.consume("10.0.0.1", now);
    }
    expect(limiter.consume("10.0.0.1", now)).toBe(false);
    expect(limiter.consume("10.0.0.2", now)).toBe(true);
  });

  it("treats null ip as a shared unknown bucket", () => {
    const limiter = getSensitiveLimiter("test.unknown");
    const now = 4_000_000;
    for (let i = 0; i < SENSITIVE_RATE_LIMIT_MAX; i++) {
      limiter.consume(null, now);
    }
    expect(limiter.consume(null, now)).toBe(false);
    expect(limiter.consume(undefined, now)).toBe(false);
  });
});
