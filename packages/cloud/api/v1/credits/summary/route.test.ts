/**
 * Proves the credits summary advertises the canonical checkout bounds from the
 * shared organization-credit contract — never an independent restated value
 * (#22963). The summary is the advertisement surface clients render; before
 * this contract it hardcoded a $5 minimum while both checkout seams enforced $1.
 * Deterministic harness: all collaborators are mocked; only the route's own
 * derivation runs for real.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-a",
  email: "user@example.test",
  wallet_address: null,
  organization_id: "org-a",
  organization: { id: "org-a", name: "Org A" },
}));

const orgRow = {
  id: "org-a",
  name: "Org A",
  credit_balance: "12.5",
  auto_top_up_enabled: false,
  auto_top_up_threshold: null,
  auto_top_up_amount: null,
  stripe_default_payment_method: null,
};

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/services/agent-budgets", () => ({
  agentBudgetService: { getOrgBudgets: mock(async () => []) },
}));
mock.module("@/lib/services/credits", () => ({
  creditsService: {
    listTransactionsByOrganization: mock(async () => []),
  },
}));
mock.module("@/lib/services/organizations", () => ({
  organizationsService: { getById: mock(async () => orgRow) },
}));
mock.module("@/lib/services/redeemable-earnings", () => ({
  redeemableEarningsService: { getBalance: mock(async () => null) },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const dbChain = {
  select: () => ({ from: () => ({ where: async () => [{ value: 0 }] }) }),
  query: {
    userCharacters: { findMany: async () => [] },
    apps: { findMany: async () => [] },
  },
};
mock.module("@/db/client", () => ({ dbRead: dbChain }));

const { default: app } = await import("./route");
const { ORGANIZATION_CREDIT_CHECKOUT_LIMITS } = await import(
  "@elizaos/cloud-shared/billing"
);

describe("credits summary advertisement (#22963)", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
  });

  test("advertises exactly the canonical checkout bounds", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/"),
      {},
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      pricing?: { minimumTopUp?: number; maximumTopUp?: number };
    };
    expect(body.pricing?.minimumTopUp).toBe(
      ORGANIZATION_CREDIT_CHECKOUT_LIMITS.minAmountUsd,
    );
    expect(body.pricing?.maximumTopUp).toBe(
      ORGANIZATION_CREDIT_CHECKOUT_LIMITS.maxAmountUsd,
    );
  });
});
