/**
 * Tests reset-window formatting + "reset soonest first" ordering — the UI
 * mirror of the backend reset-soonest rotation policy.
 */

import { describe, expect, it } from "vitest";
import type { AccountWithCredentialFlag } from "../../api/client-agent";
import {
  accountResetAt,
  bySoonestReset,
  formatResetIn,
  weeklyResetAt,
} from "./reset-time";

const NOW = Date.now();

function acct(
  over: Partial<AccountWithCredentialFlag>,
): AccountWithCredentialFlag {
  return {
    id: "x",
    providerId: "anthropic-subscription",
    label: "x",
    source: "oauth",
    enabled: true,
    priority: 1,
    createdAt: NOW,
    health: "ok",
    hasCredential: true,
    ...over,
  };
}

describe("formatResetIn", () => {
  it("returns null for past or absent instants", () => {
    expect(formatResetIn(undefined)).toBeNull();
    expect(formatResetIn(NOW - 1000)).toBeNull();
  });

  it("formats days and hours compactly", () => {
    const twoDaysFourHours = Date.now() + (2 * 24 + 4) * 3_600_000 + 5_000;
    expect(formatResetIn(twoDaysFourHours)).toBe("2d 4h");
  });

  it("formats sub-day windows in hours and minutes", () => {
    // Add a small cushion so the elapsed ms between capture and the internal
    // Date.now() can't round the minute boundary down (89m59s vs 90m).
    expect(formatResetIn(Date.now() + 90 * 60_000 + 5_000)).toBe("1h 30m");
  });
});

describe("accountResetAt", () => {
  it("prefers usage.resetsAt", () => {
    const at = NOW + 10_000;
    expect(
      accountResetAt(
        acct({
          usage: {
            resetsAt: at,
            refreshedAt: NOW,
            weeklyModelBuckets: {},
          } as AccountWithCredentialFlag["usage"],
        }),
      ),
    ).toBe(at);
  });

  it("keeps the neutral healthDetail.until fallback for legacy drain order", () => {
    const at = NOW + 20_000;
    expect(accountResetAt(acct({ healthDetail: { until: at } }))).toBe(at);
  });
});

describe("weeklyResetAt", () => {
  it("does not treat an unmarked legacy resetsAt as weekly", () => {
    const at = NOW + 15_000;
    expect(
      weeklyResetAt(acct({ usage: { resetsAt: at, refreshedAt: NOW } })),
    ).toBeUndefined();
  });

  it("does not mislabel healthDetail.until as a weekly reset", () => {
    const at = NOW + 20_000;
    expect(
      weeklyResetAt(acct({ healthDetail: { until: at } })),
    ).toBeUndefined();
  });

  it("accepts resetsAt when corrected parser model buckets mark weekly semantics", () => {
    const at = NOW + 30_000;
    expect(
      weeklyResetAt(
        acct({
          usage: {
            resetsAt: at,
            refreshedAt: NOW,
            weeklyModelBuckets: {},
          } as AccountWithCredentialFlag["usage"],
        }),
      ),
    ).toBe(at);
  });
});

describe("bySoonestReset", () => {
  it("orders the sooner reset first", () => {
    const soon = acct({
      id: "soon",
      usage: {
        resetsAt: NOW + 3_600_000,
        refreshedAt: NOW,
        weeklyModelBuckets: {},
      } as AccountWithCredentialFlag["usage"],
    });
    const later = acct({
      id: "later",
      usage: {
        resetsAt: NOW + 10 * 3_600_000,
        refreshedAt: NOW,
        weeklyModelBuckets: {},
      } as AccountWithCredentialFlag["usage"],
    });
    expect([later, soon].sort(bySoonestReset)[0]?.id).toBe("soon");
  });

  it("sorts known-reset accounts ahead of unknown-reset ones", () => {
    const known = acct({
      id: "known",
      usage: {
        resetsAt: NOW + 5 * 3_600_000,
        refreshedAt: NOW,
        weeklyModelBuckets: {},
      } as AccountWithCredentialFlag["usage"],
    });
    const unknown = acct({ id: "unknown" });
    expect([unknown, known].sort(bySoonestReset)[0]?.id).toBe("known");
  });

  it("falls back to least-recently-used when both resets are unknown", () => {
    const stale = acct({ id: "stale", lastUsedAt: NOW - 100_000 });
    const recent = acct({ id: "recent", lastUsedAt: NOW - 1_000 });
    expect([recent, stale].sort(bySoonestReset)[0]?.id).toBe("stale");
  });
});
