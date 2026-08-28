/**
 * Unit coverage for effort-based form-session TTL management: retention
 * clamping, nudge cadence, expiration windows, and the human-readable
 * remaining-time/effort formatters. These functions decide when a user's
 * in-progress form data is deleted and when reminders are sent — under- or
 * over-retention both have real user-visible consequences.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculateTTL,
  formatEffort,
  formatTimeRemaining,
  isExpired,
  isExpiringSoon,
  shouldConfirmCancel,
  shouldNudge,
} from "./ttl";
import { FORM_DEFINITION_DEFAULTS } from "./types";

const NOW = 1_800_000_000_000;

function makeSession(
  overrides: Partial<Parameters<typeof calculateTTL>[0]> = {},
) {
  return {
    effort: { timeSpentMs: 0, lastInteractionAt: NOW },
    expiresAt: NOW + 14 * 24 * 60 * 60 * 1000,
    ...overrides,
  } as Parameters<typeof calculateTTL>[0];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("calculateTTL", () => {
  it("clamps to the 14-day minimum for zero effort", () => {
    const expiry = calculateTTL(makeSession());
    expect(expiry).toBe(NOW + 14 * 24 * 60 * 60 * 1000);
  });

  it("scales retention with effort minutes and the default multiplier", () => {
    // 2 hours * 0.5 = 60 extra days
    const expiry = calculateTTL(
      makeSession({
        effort: { timeSpentMs: 2 * 60 * 60 * 1000, lastInteractionAt: NOW },
      }),
    );
    expect(expiry).toBe(NOW + 60 * 24 * 60 * 60 * 1000);
  });

  it("clamps to the 90-day maximum for very high effort", () => {
    const expiry = calculateTTL(
      makeSession({
        effort: { timeSpentMs: 24 * 60 * 60 * 1000, lastInteractionAt: NOW },
      }),
    );
    expect(expiry).toBe(NOW + 90 * 24 * 60 * 60 * 1000);
  });

  it("honors per-form ttl overrides", () => {
    const expiry = calculateTTL(
      makeSession({
        effort: { timeSpentMs: 30 * 60 * 1000, lastInteractionAt: NOW },
      }),
      { ttl: { minDays: 1, maxDays: 7, effortMultiplier: 1 } },
    );
    // 30 min * 1 = 30 days, clamped to 7
    expect(expiry).toBe(NOW + 7 * 24 * 60 * 60 * 1000);
  });

  it("uses defaults when form ttl config is absent", () => {
    const expiry = calculateTTL(makeSession(), {});
    expect(expiry).toBe(
      NOW + FORM_DEFINITION_DEFAULTS.ttl.minDays * 24 * 60 * 60 * 1000,
    );
  });

  it("fails closed to the minimum retention when effort data is missing", () => {
    // Sessions restored from storage may lack effort tracking (schema drift /
    // partial writes). Previously this produced NaN → expiresAt = NaN → the
    // session NEVER expired (abandoned form data retained forever).
    const expiry = calculateTTL(
      makeSession({
        effort: { lastInteractionAt: NOW } as Parameters<
          typeof calculateTTL
        >[0]["effort"],
      }),
    );
    expect(expiry).toBe(NOW + 14 * 24 * 60 * 60 * 1000);
    expect(Number.isNaN(expiry)).toBe(false);
  });

  it("fails closed to the minimum retention on NaN effort", () => {
    const expiry = calculateTTL(
      makeSession({
        effort: {
          timeSpentMs: Number.NaN,
          lastInteractionAt: NOW,
        } as Parameters<typeof calculateTTL>[0]["effort"],
      }),
    );
    expect(expiry).toBe(NOW + 14 * 24 * 60 * 60 * 1000);
  });

  it("fails closed to the minimum retention on non-finite effort", () => {
    const expiry = calculateTTL(
      makeSession({
        effort: {
          timeSpentMs: Number.POSITIVE_INFINITY,
          lastInteractionAt: NOW,
        } as Parameters<typeof calculateTTL>[0]["effort"],
      }),
    );
    expect(expiry).toBe(NOW + 14 * 24 * 60 * 60 * 1000);
  });
});

describe("shouldNudge", () => {
  it("returns false when nudging is disabled", () => {
    expect(shouldNudge(makeSession(), { nudge: { enabled: false } })).toBe(
      false,
    );
  });

  it("returns false when at the max nudge count", () => {
    const session = makeSession({ nudgeCount: 3 });
    expect(shouldNudge(session)).toBe(false);
  });

  it("returns false when the session was interacted with recently", () => {
    const session = makeSession({
      effort: { timeSpentMs: 60_000, lastInteractionAt: NOW - 60 * 60 * 1000 },
    });
    expect(shouldNudge(session)).toBe(false);
  });

  it("returns true when inactive long enough and no recent nudge", () => {
    const session = makeSession({
      effort: {
        timeSpentMs: 60_000,
        lastInteractionAt: NOW - 3 * 24 * 60 * 60 * 1000,
      },
    });
    expect(shouldNudge(session)).toBe(true);
  });

  it("returns false when a nudge was sent less than 24h ago", () => {
    const session = makeSession({
      effort: {
        timeSpentMs: 60_000,
        lastInteractionAt: NOW - 3 * 24 * 60 * 60 * 1000,
      },
      lastNudgeAt: NOW - 12 * 60 * 60 * 1000,
    });
    expect(shouldNudge(session)).toBe(false);
  });

  it("returns true when the last nudge was more than 24h ago", () => {
    const session = makeSession({
      effort: {
        timeSpentMs: 60_000,
        lastInteractionAt: NOW - 4 * 24 * 60 * 60 * 1000,
      },
      lastNudgeAt: NOW - 2 * 24 * 60 * 60 * 1000,
    });
    expect(shouldNudge(session)).toBe(true);
  });

  it("honors a custom afterInactiveHours", () => {
    const session = makeSession({
      effort: {
        timeSpentMs: 60_000,
        lastInteractionAt: NOW - 3 * 60 * 60 * 1000,
      },
    });
    expect(shouldNudge(session, { nudge: { afterInactiveHours: 2 } })).toBe(
      true,
    );
    expect(shouldNudge(session, { nudge: { afterInactiveHours: 4 } })).toBe(
      false,
    );
  });
});

describe("isExpiringSoon / isExpired", () => {
  it("flags a session expiring within the window", () => {
    const session = makeSession({ expiresAt: NOW + 12 * 60 * 60 * 1000 });
    expect(isExpiringSoon(session, 24 * 60 * 60 * 1000)).toBe(true);
  });

  it("does not flag a session expiring outside the window", () => {
    const session = makeSession({ expiresAt: NOW + 3 * 24 * 60 * 60 * 1000 });
    expect(isExpiringSoon(session, 24 * 60 * 60 * 1000)).toBe(false);
  });

  it("flags an expired session", () => {
    expect(isExpired(makeSession({ expiresAt: NOW - 1000 }))).toBe(true);
    expect(isExpired(makeSession({ expiresAt: NOW + 1000 }))).toBe(false);
  });
});

describe("shouldConfirmCancel", () => {
  it("requires confirmation above the 5-minute effort threshold", () => {
    expect(
      shouldConfirmCancel(
        makeSession({
          effort: { timeSpentMs: 6 * 60 * 1000, lastInteractionAt: NOW },
        }),
      ),
    ).toBe(true);
    expect(
      shouldConfirmCancel(
        makeSession({
          effort: { timeSpentMs: 4 * 60 * 1000, lastInteractionAt: NOW },
        }),
      ),
    ).toBe(false);
  });
});

describe("formatTimeRemaining", () => {
  it("returns expired for non-positive remaining time", () => {
    expect(formatTimeRemaining(makeSession({ expiresAt: NOW }))).toBe(
      "expired",
    );
  });

  it("formats days", () => {
    expect(
      formatTimeRemaining(
        makeSession({ expiresAt: NOW + 14 * 24 * 60 * 60 * 1000 }),
      ),
    ).toBe("14 days");
    expect(
      formatTimeRemaining(
        makeSession({ expiresAt: NOW + 1 * 24 * 60 * 60 * 1000 }),
      ),
    ).toBe("1 day");
  });

  it("formats hours", () => {
    expect(
      formatTimeRemaining(makeSession({ expiresAt: NOW + 3 * 60 * 60 * 1000 })),
    ).toBe("3 hours");
    expect(
      formatTimeRemaining(makeSession({ expiresAt: NOW + 1 * 60 * 60 * 1000 })),
    ).toBe("1 hour");
  });

  it("formats minutes", () => {
    expect(
      formatTimeRemaining(makeSession({ expiresAt: NOW + 45 * 60 * 1000 })),
    ).toBe("45 minutes");
  });
});

describe("formatEffort", () => {
  it("returns just started for sub-minute effort", () => {
    expect(
      formatEffort(
        makeSession({
          effort: { timeSpentMs: 30_000, lastInteractionAt: NOW },
        }),
      ),
    ).toBe("just started");
  });

  it("formats minutes", () => {
    expect(
      formatEffort(
        makeSession({
          effort: { timeSpentMs: 5 * 60 * 1000, lastInteractionAt: NOW },
        }),
      ),
    ).toBe("5 minutes");
  });

  it("formats whole hours", () => {
    expect(
      formatEffort(
        makeSession({
          effort: { timeSpentMs: 2 * 60 * 60 * 1000, lastInteractionAt: NOW },
        }),
      ),
    ).toBe("2 hours");
  });

  it("formats hours and minutes", () => {
    expect(
      formatEffort(
        makeSession({
          effort: { timeSpentMs: 90 * 60 * 1000, lastInteractionAt: NOW },
        }),
      ),
    ).toBe("1h 30m");
  });
});
