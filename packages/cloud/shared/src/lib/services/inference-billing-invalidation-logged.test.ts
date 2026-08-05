/**
 * #12268 regression: a post-commit cache-invalidation failure on the settle path
 * must degrade (the debit already committed to Postgres, the source of truth) but
 * must NOT be swallowed silently — it is logged at warn so a stale balance view is
 * observable. The DB transaction and the three cache clients are mocked at their
 * boundary; the settle + logging code under test (`createLedgerDebitSettler` →
 * `settleLedgerCharge` post-commit block) runs for real. Before the fix these were
 * `.catch(() => {})` and a failed invalidation produced zero output.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";

afterAll(() => {
  mock.restore();
});

const warn = mock((_msg: string, _ctx?: unknown) => {});
mock.module("../utils/logger", () => ({
  logger: { info: () => {}, warn, error: () => {}, debug: () => {} },
}));

// The transaction "commits" a debited outcome without touching a real DB, so the
// post-commit side-effect block (the code under test) runs.
mock.module("../../db/helpers", () => ({
  dbWrite: {},
  writeTransaction: async () => ({
    claimed: true,
    debited: true,
    uncollected: false,
    newBalance: 5,
  }),
}));

// The induced failure: every cache invalidation rejects.
const invalidationErr = new Error("redis unavailable");
mock.module("../cache/invalidation", () => ({
  CacheInvalidation: {
    onCreditMutation: async () => {
      throw invalidationErr;
    },
  },
}));
mock.module("../cache/organizations-cache", () => ({
  invalidateOrganizationCache: async () => {
    throw invalidationErr;
  },
}));
mock.module("./inference-auth-cache", () => ({
  invalidateOrgBalanceHint: async () => {
    throw invalidationErr;
  },
  // The settler now REPUBLISHES the gate hint after a committed debit instead
  // of leaving it absent (the 200/503 flap fix). This is the same cache target
  // (`balance-hint`) reached through a different call, so the induced failure
  // moves here — the assertion that a failing balance-hint repair still warns
  // rather than vanishing is unchanged.
  republishOrgBalanceHint: async () => {
    throw invalidationErr;
  },
}));
mock.module("./credits", () => ({
  creditsService: {
    notifyBalanceDecrease: () => {},
    // The authoritative read the republish performs before writing. It must
    // SUCCEED here so the induced failure under test is unambiguously the cache
    // write, not the database read.
    getOrganizationBalanceSnapshot: async () => ({ balanceUsd: 5, revision: "2" }),
  },
}));

const { createLedgerDebitSettler } = await import("./inference-billing-ledger");

const CTX = {
  requestId: "req-inv-1",
  organizationId: "org-inv-1",
  userId: "user-inv-1",
  apiKeyId: null,
  model: "gpt-oss-120b",
  provider: "cerebras",
  billingSource: "platform",
};

describe("settle post-commit cache invalidation failure is logged, not swallowed", () => {
  test("a debited settle whose invalidations all reject still resolves AND warns per target", async () => {
    warn.mockClear();
    const settle = createLedgerDebitSettler(CTX);

    // The invalidation failures must not fail the (already-committed) settle.
    await expect(settle(0.01)).resolves.toEqual({
      reservedAmount: 0.01,
      actualCost: 0.01,
      adjustmentType: "none",
      settlementTransactionIds: [],
    });

    // Flush the two fire-and-forget `.catch` microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const staleWarnings = warn.mock.calls.filter(
      ([msg]) => typeof msg === "string" && msg.includes("cache invalidation failed"),
    );
    // All three invalidation failures surfaced (credit-mutation, organization-cache,
    // balance-hint) instead of vanishing into `.catch(() => {})`.
    expect(staleWarnings.length).toBe(3);

    const targets = staleWarnings
      .map(([, ctx]) => (ctx as { target?: string })?.target)
      .filter(Boolean);
    expect(new Set(targets)).toEqual(
      new Set(["credit-mutation", "organization-cache", "balance-hint"]),
    );

    // The failure carries the org id and the underlying error message for diagnosis.
    for (const [, ctx] of staleWarnings) {
      const c = ctx as { organizationId?: string; error?: string };
      expect(c.organizationId).toBe("org-inv-1");
      expect(c.error).toBe("redis unavailable");
    }
  });
});
