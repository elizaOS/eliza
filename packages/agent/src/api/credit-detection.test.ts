/**
 * Unit coverage for the credit/rate-limit error detectors re-exported from
 * `credit-detection.ts`. Deterministic: asserts against plain objects and
 * `Error` instances carrying a duck-typed `.status`, with no live provider or
 * network in play.
 */
import { describe, expect, it } from "vitest";
import {
  isInsufficientCreditsError,
  isRateLimitError,
} from "./credit-detection.ts";

/** Provider errors are Error instances, often with a `.status` attached. */
function providerError(
  message: string,
  status?: number,
): Error & { status?: number } {
  const e = new Error(message) as Error & { status?: number };
  if (status !== undefined) e.status = status;
  return e;
}

/**
 * `isRateLimitError` is the canonical `@elizaos/core` detector, re-exported
 * here. It distinguishes a transient 429 ("try again in a few seconds") from
 * credit exhaustion ("top up"). Callers check `isInsufficientCreditsError`
 * FIRST, so a 429-with-billing is credits and a bare 429 is a rate limit.
 */
describe("isRateLimitError", () => {
  it("treats a bare HTTP 429 as a rate limit (legacy .status duck-type)", () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError(providerError("boom", 429))).toBe(true);
  });

  it("matches rate-limit messages on Error instances (status-less fallback)", () => {
    expect(isRateLimitError(providerError("Rate limit exceeded"))).toBe(true);
    expect(isRateLimitError(providerError("Too Many Requests"))).toBe(true);
    expect(isRateLimitError(providerError("5 requests per minute"))).toBe(true);
  });

  it("does NOT match unrelated errors", () => {
    expect(isRateLimitError({ status: 500 })).toBe(false);
    expect(isRateLimitError(providerError("connection reset"))).toBe(false);
    expect(isRateLimitError({ status: 402 })).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });

  it("credit exhaustion is detected first (a 429 with billing is credits, not rate-limit)", () => {
    // The chat route checks isInsufficientCreditsError before isRateLimitError.
    const billing429 = providerError("Quota exceeded — billing", 429);
    expect(isInsufficientCreditsError(billing429)).toBe(true);

    const bare429 = providerError("rate limit", 429);
    expect(isInsufficientCreditsError(bare429)).toBe(false);
    expect(isRateLimitError(bare429)).toBe(true);
  });
});
