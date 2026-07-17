/**
 * account-table-model — health mapping, usage extraction, sorting, and the
 * observability feature-detection that lets the table degrade gracefully
 * before #16355 merges.
 */

import { describe, expect, it } from "vitest";
import type { AccountWithCredentialFlag } from "../../api/client-agent";
import {
  DEFAULT_ACCOUNT_SORT,
  describeHealth,
  fableWeeklyBucket,
  hasLeaseObservability,
  needsCredentialRepair,
  peakUsagePct,
  rowResetAt,
  sortAccounts,
} from "./account-table-model";

function account(
  overrides: Partial<AccountWithCredentialFlag> = {},
): AccountWithCredentialFlag {
  return {
    id: overrides.id ?? "acc-1",
    providerId: "anthropic-subscription",
    label: overrides.label ?? "Account 1",
    source: "oauth",
    enabled: true,
    priority: 1,
    createdAt: 0,
    health: "ok",
    hasCredential: true,
    ...overrides,
  } as AccountWithCredentialFlag;
}

describe("describeHealth", () => {
  it("maps each health state to a stable tone", () => {
    expect(describeHealth(account({ health: "ok" })).tone).toBe("success");
    expect(describeHealth(account({ health: "rate-limited" })).tone).toBe(
      "warning",
    );
    expect(describeHealth(account({ health: "needs-reauth" })).tone).toBe(
      "danger",
    );
    expect(describeHealth(account({ health: "invalid" })).tone).toBe("danger");
    expect(describeHealth(account({ health: "expired" })).tone).toBe("danger");
    expect(describeHealth(account({ health: "expired" })).fallback).toBe(
      "Expired",
    );
    expect(describeHealth(account({ health: "unknown" })).tone).toBe("muted");
  });

  it("degrades an unrecognized health value to the muted fallback", () => {
    const desc = describeHealth(
      account({ health: "surprise" as AccountWithCredentialFlag["health"] }),
    );
    expect(desc.tone).toBe("muted");
    expect(desc.fallback).toBe("Unknown");
  });

  it("surfaces the rate-limit reset instant and last error detail", () => {
    const until = Date.now() + 60_000;
    const desc = describeHealth(
      account({
        health: "rate-limited",
        healthDetail: { until, lastError: "  429 slow down  " },
      }),
    );
    expect(desc.until).toBe(until);
    expect(desc.detail).toBe("429 slow down");
  });
});

describe("needsCredentialRepair", () => {
  it("is true only for needs-reauth / invalid", () => {
    expect(needsCredentialRepair(account({ health: "needs-reauth" }))).toBe(
      true,
    );
    expect(needsCredentialRepair(account({ health: "invalid" }))).toBe(true);
    expect(needsCredentialRepair(account({ health: "expired" }))).toBe(true);
    expect(needsCredentialRepair(account({ health: "ok" }))).toBe(false);
    expect(needsCredentialRepair(account({ health: "rate-limited" }))).toBe(
      false,
    );
  });
});

describe("peakUsagePct", () => {
  it("returns the higher of session/weekly", () => {
    expect(
      peakUsagePct(
        account({ usage: { sessionPct: 40, weeklyPct: 88, refreshedAt: 0 } }),
      ),
    ).toBe(88);
  });

  it("returns null when no usage snapshot exists", () => {
    expect(peakUsagePct(account())).toBeNull();
  });

  it("ignores NaN and returns null when both windows are unusable", () => {
    expect(
      peakUsagePct(
        account({
          usage: {
            sessionPct: Number.NaN,
            weeklyPct: Number.NaN,
            refreshedAt: 0,
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("sortAccounts", () => {
  const invalid = account({ id: "a", health: "invalid", priority: 3 });
  const reauth = account({ id: "b", health: "needs-reauth", priority: 2 });
  const ok = account({ id: "c", health: "ok", priority: 1 });

  it("default sort surfaces the most urgent health first", () => {
    const rows = sortAccounts([ok, reauth, invalid], DEFAULT_ACCOUNT_SORT);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("respects direction on the usage column", () => {
    const low = account({
      id: "low",
      usage: { sessionPct: 10, refreshedAt: 0 },
    });
    const high = account({
      id: "high",
      usage: { sessionPct: 95, refreshedAt: 0 },
    });
    const asc = sortAccounts([high, low], { key: "usage", direction: "asc" });
    expect(asc.map((r) => r.id)).toEqual(["low", "high"]);
    const desc = sortAccounts([low, high], {
      key: "usage",
      direction: "desc",
    });
    expect(desc.map((r) => r.id)).toEqual(["high", "low"]);
  });

  it("sinks unknown usage to the bottom in BOTH sort directions", () => {
    const known = account({
      id: "known",
      usage: { sessionPct: 20, refreshedAt: 0 },
    });
    const unknown = account({ id: "unknown" });
    const desc = sortAccounts([unknown, known], {
      key: "usage",
      direction: "desc",
    });
    expect(desc.map((r) => r.id)).toEqual(["known", "unknown"]);
    // Ascending must ALSO keep the unknown-usage row last, not float it up.
    const asc = sortAccounts([unknown, known], {
      key: "usage",
      direction: "asc",
    });
    expect(asc.map((r) => r.id)).toEqual(["known", "unknown"]);
  });

  it("sorts by lastUsed and breaks ties stably on priority then id", () => {
    const older = account({ id: "older", lastUsedAt: 1_000 });
    const newer = account({ id: "newer", lastUsedAt: 5_000 });
    const desc = sortAccounts([older, newer], {
      key: "lastUsed",
      direction: "desc",
    });
    expect(desc.map((r) => r.id)).toEqual(["newer", "older"]);

    const tieA = account({ id: "z", priority: 1, health: "ok" });
    const tieB = account({ id: "a", priority: 1, health: "ok" });
    const tied = sortAccounts([tieA, tieB], {
      key: "health",
      direction: "asc",
    });
    expect(tied.map((r) => r.id)).toEqual(["a", "z"]);
  });

  it("does not mutate the input array", () => {
    const input = [invalid, ok];
    const snapshot = input.map((r) => r.id);
    sortAccounts(input, DEFAULT_ACCOUNT_SORT);
    expect(input.map((r) => r.id)).toEqual(snapshot);
  });
});

describe("hasLeaseObservability (feature-detection)", () => {
  it("is false when no account carries observability (pre-#16355 host)", () => {
    expect(hasLeaseObservability([account(), account({ id: "x" })])).toBe(
      false,
    );
  });

  it("is true as soon as any account carries observability", () => {
    expect(
      hasLeaseObservability([
        account(),
        account({
          id: "y",
          observability: {
            activeLeaseCount: 2,
            lastLeaseAt: 1,
            lastSelectedAt: 1,
            servedLastRequest: true,
          },
        }),
      ]),
    ).toBe(true);
  });
});

describe("weekly usage semantics", () => {
  it("never presents a session cooldown as the weekly reset", () => {
    const until = Date.now() + 10_000;
    expect(rowResetAt(account({ healthDetail: { until } }))).toBeUndefined();
  });

  it("uses the all-model weekly reset when supplied", () => {
    const resetsAt = Date.now() + 20_000;
    expect(
      rowResetAt(
        account({
          usage: {
            sessionPct: 1,
            resetsAt,
            refreshedAt: 0,
            weeklyModelBuckets: {},
          } as AccountWithCredentialFlag["usage"],
        }),
      ),
    ).toBe(resetsAt);
  });

  it("finds the Fable model bucket case-insensitively", () => {
    const withBuckets = account({
      usage: {
        sessionPct: 1,
        refreshedAt: 0,
        weeklyModelBuckets: { FABLE: { pct: 7, resetsAt: 123 } },
      } as AccountWithCredentialFlag["usage"],
    });
    expect(fableWeeklyBucket(withBuckets)).toEqual({ pct: 7, resetsAt: 123 });
  });
});
