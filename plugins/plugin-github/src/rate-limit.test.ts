/**
 * A GitHub 429 always means "too many requests", and GitHub's secondary
 * (abuse) limit arrives as 403 with a `retry-after` header while the primary
 * quota still has requests left. Both must reach the rate-limit message, not
 * the generic failure message.
 */
import { describe, expect, it } from "vitest";
import { formatRateLimitMessage, inspectRateLimit } from "./rate-limit.js";

const NOW_MS = 1_700_000_000_000;

describe("inspectRateLimit", () => {
  it("treats a 429 without rate-limit headers as a rate limit", () => {
    const details = inspectRateLimit(
      { status: 429, response: { headers: {} } },
      NOW_MS,
    );

    expect(details.isRateLimited).toBe(true);
    expect(formatRateLimitMessage(details)).toContain("rate limit");
  });

  it("treats a secondary limit (403 with retry-after) as a rate limit", () => {
    const details = inspectRateLimit(
      { status: 403, response: { headers: { "retry-after": "60" } } },
      NOW_MS,
    );

    expect(details.isRateLimited).toBe(true);
    expect(details.resetAtMs).toBe(NOW_MS + 60_000);
  });

  it("keeps a permission error (403, quota left, no retry-after) generic", () => {
    const details = inspectRateLimit(
      {
        status: 403,
        response: { headers: { "x-ratelimit-remaining": "4999" } },
      },
      NOW_MS,
    );

    expect(details.isRateLimited).toBe(false);
    expect(formatRateLimitMessage(details)).toBe("GitHub request failed");
  });

  it("reports the primary limit reset from x-ratelimit-reset", () => {
    const details = inspectRateLimit(
      {
        status: 403,
        response: {
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1700003600",
          },
        },
      },
      NOW_MS,
    );

    expect(details.isRateLimited).toBe(true);
    expect(details.resetAtMs).toBe(1_700_003_600_000);
  });
});
