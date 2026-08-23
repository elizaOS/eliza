/**
 * Verifies safe sorting in account table model and reset-time helpers when timestamps, priority, or usage contains NaN.
 */

import { describe, expect, it } from "vitest";
import {
  type AccountWithCredentialFlag,
  sortAccounts,
} from "./account-table-model.js";
import { bySoonestReset } from "./reset-time.js";

function makeAccount(
  id: string,
  overrides: Partial<AccountWithCredentialFlag> = {},
): AccountWithCredentialFlag {
  return {
    id,
    providerId: "anthropic-api",
    label: id,
    source: "api-key",
    enabled: true,
    health: "ok",
    priority: 1,
    createdAt: 1000,
    hasCredential: true,
    ...overrides,
  };
}

describe("account-table-model safe sort", () => {
  it("safely sorts accounts by priority when priority is NaN or Infinity", () => {
    const a1 = makeAccount("a1", { priority: 10 });
    const aNan = makeAccount("aNan", { priority: NaN });
    const aInf = makeAccount("aInf", { priority: Infinity });
    const a2 = makeAccount("a2", { priority: 20 });

    const sorted = sortAccounts([a2, aNan, a1, aInf], {
      key: "priority",
      direction: "asc",
    });

    expect(sorted).toHaveLength(4);
    // Non-finite priority falls back to 0, so aNan/aInf come before 10 and 20
    expect(sorted.map((a) => a.id)).toContain("a1");
    expect(sorted.map((a) => a.id)).toContain("a2");
    expect(sorted.map((a) => a.id)).toContain("aNan");
    expect(sorted.map((a) => a.id)).toContain("aInf");
  });

  it("safely sorts accounts by lastUsed when lastUsedAt contains NaN", () => {
    const a1 = makeAccount("a1", { lastUsedAt: 1000 });
    const aNan = makeAccount("aNan", { lastUsedAt: NaN });
    const a2 = makeAccount("a2", { lastUsedAt: 2000 });

    const sortedAsc = sortAccounts([a2, aNan, a1], {
      key: "lastUsed",
      direction: "asc",
    });
    expect(sortedAsc).toHaveLength(3);
    // NaN treated as 0 in ascending order
    expect(sortedAsc[0].id).toBe("aNan");
    expect(sortedAsc[1].id).toBe("a1");
    expect(sortedAsc[2].id).toBe("a2");

    const sortedDesc = sortAccounts([a2, aNan, a1], {
      key: "lastUsed",
      direction: "desc",
    });
    expect(sortedDesc).toHaveLength(3);
    expect(sortedDesc[0].id).toBe("a2");
    expect(sortedDesc[1].id).toBe("a1");
    expect(sortedDesc[2].id).toBe("aNan");
  });

  it("safely resolves bySoonestReset when reset timestamps contain NaN", () => {
    const acc1 = makeAccount("acc1", {
      usage: {
        sessionPct: 50,
        weeklyPct: 50,
        sessionResetAt: NaN,
        weeklyResetAt: 1000,
      } as unknown as AccountWithCredentialFlag["usage"],
    });

    const acc2 = makeAccount("acc2", {
      usage: {
        sessionPct: 50,
        weeklyPct: 50,
        sessionResetAt: 2000,
        weeklyResetAt: 3000,
      } as unknown as AccountWithCredentialFlag["usage"],
    });

    const result = bySoonestReset(acc1, acc2);
    expect(Number.isFinite(result)).toBe(true);
  });
});
