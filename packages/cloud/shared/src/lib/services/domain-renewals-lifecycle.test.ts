/** Proves domain renewal rechecks lifecycle revision at the final registrar boundary. */

import { describe, expect, mock, test } from "bun:test";

class FencedError extends Error {}
const lifecycle = mock()
  .mockResolvedValueOnce({ revision: 7 })
  .mockRejectedValueOnce(new FencedError("fenced"));
const refundCredits = mock(async () => ({ success: true }));
const renewDomain = mock(async () => ({ expiresAt: new Date().toISOString() }));

mock.module("./account-lifecycle-authority", () => ({
  AccountLifecycleFencedError: FencedError,
  requireActiveOrganizationLifecycle: lifecycle,
}));
mock.module("../../db/repositories/credit-transactions", () => ({
  creditTransactionsRepository: { hasUnrefundedDomainRenewal: mock(async () => false) },
}));
mock.module("./credits", () => ({
  creditsService: {
    deductCredits: mock(async () => ({ success: true })),
    refundCredits,
  },
}));
mock.module("./managed-domains", () => ({
  managedDomainsService: {
    listCloudflareRenewalsDue: mock(async () => [
      {
        id: "10000000-0000-4000-8000-000000000001",
        organizationId: "20000000-0000-4000-8000-000000000001",
        domain: "example.test",
        expiresAt: new Date("2026-08-29T00:00:00Z"),
        renewalPrice: "1099",
      },
    ]),
    setAutoRenew: mock(async () => undefined),
    recordRenewal: mock(async () => undefined),
  },
}));
mock.module("./cloudflare-registrar", () => ({
  cloudflareRegistrarService: {
    renewDomain,
    setDomainAutoRenew: mock(async () => undefined),
  },
}));
mock.module("../utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { processDomainRenewals } = await import("./domain-renewals");

describe("domain renewal lifecycle fencing", () => {
  test("refunds the debit and never calls the registrar after a revision change", async () => {
    const summary = await processDomainRenewals(new Date("2026-08-22T00:00:00Z"));
    expect(summary.fenced).toBe(1);
    expect(summary.renewed).toBe(0);
    expect(refundCredits).toHaveBeenCalledTimes(1);
    expect(renewDomain).not.toHaveBeenCalled();
  });
});
