/**
 * Money-leak guard test for the domain-buy credit gate.
 *
 * `creditsService.deductCredits` RETURNS `{ success: false }` on an
 * insufficient balance — it does not throw. Before the gate, an org with no
 * credit sailed past the zero-effect debit straight into a real, paid
 * Cloudflare `registerDomain` (a free domain on our account). This drives the
 * real `executeDomainPurchase` with mocked service seams and proves:
 *   1. insufficient debit → 402 and `registerDomain` is NEVER called;
 *   2. a successful debit DOES pass the gate (registerDomain runs).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const APP = "00000000-0000-4000-8000-0000000000bb";

// Side-effectful module imports pulled in when route.ts loads — neutralize so
// importing the route does not touch a real DB / runtime binding (or drag in
// the drizzle/plugin-sql chain, which executeDomainPurchase never exercises).
mock.module("drizzle-orm", () => ({ eq: () => ({}) }));
mock.module("@/db/schemas/domain-purchase-idempotency", () => ({
  domainPurchaseIdempotency: {},
}));
mock.module("@/db/client", () => ({ dbRead: {}, dbWrite: {} }));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: () => ({}),
}));
mock.module("@/lib/services/apps", () => ({ appsService: {} }));
mock.module("@/lib/services/app-domains-compat", () => ({
  appDomainsCompat: {},
}));
mock.module("@/lib/utils/error-handling", () => ({
  extractErrorMessage: (e: unknown) =>
    e instanceof Error ? e.message : String(e),
}));
mock.module("@/lib/runtime/cloud-bindings", () => ({
  getCloudAwareEnv: () => ({}),
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: mock(),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), info: mock(), warn: mock(), debug: mock() },
}));

const getDomainByName = mock(async () => null);
mock.module("@/lib/services/managed-domains", () => ({
  managedDomainsService: { getDomainByName },
}));

const registerDomain = mock(async () => ({ registrationId: "reg_test" }));
const checkAvailability = mock(async () => ({
  available: true,
  priceUsdCents: 1200,
  renewalUsdCents: 1200,
}));
mock.module("@/lib/services/cloudflare-registrar", () => ({
  cloudflareRegistrarService: { checkAvailability, registerDomain },
}));

let deductResult: { success: boolean; reason?: string } = { success: true };
const deductCredits = mock(async () => deductResult);
const refundCredits = mock(async () => {});
mock.module("@/lib/services/credits", () => ({
  creditsService: { deductCredits, refundCredits },
}));

const { executeDomainPurchase } = await import("./route");

const ctx = { organizationId: ORG, appId: APP, appUrl: null, domain: "x.com" };

beforeEach(() => {
  for (const m of [
    getDomainByName,
    registerDomain,
    checkAvailability,
    deductCredits,
    refundCredits,
  ]) {
    m.mockClear();
  }
});

afterEach(() => {
  deductResult = { success: true };
});

describe("domain-buy credit gate", () => {
  test("insufficient balance → 402 and registerDomain is never called", async () => {
    deductResult = { success: false, reason: "insufficient_balance" };

    const outcome = await executeDomainPurchase(ctx);

    expect(outcome.status).toBe(402);
    expect(outcome.body.success).toBe(false);
    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(registerDomain).not.toHaveBeenCalled();
    // No money moved → nothing to refund.
    expect(refundCredits).not.toHaveBeenCalled();
  });

  test("non-insufficient debit failure → 402, still no registration", async () => {
    deductResult = { success: false, reason: "org_not_found" };

    const outcome = await executeDomainPurchase(ctx);

    expect(outcome.status).toBe(402);
    expect(registerDomain).not.toHaveBeenCalled();
  });

  test("successful debit passes the gate and reaches registerDomain", async () => {
    deductResult = { success: true };
    // Short-circuit before DB persistence: a register failure routes through
    // the existing refund path and returns 502 — enough to prove the gate let
    // a valid debit through.
    registerDomain.mockImplementationOnce(async () => {
      throw new Error("register boom");
    });

    const outcome = await executeDomainPurchase(ctx);

    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(registerDomain).toHaveBeenCalledTimes(1);
    expect(refundCredits).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe(502);
  });
});
