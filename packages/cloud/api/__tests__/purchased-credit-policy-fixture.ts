/** Supplies fresh purchased-credit policy observations for isolated route billing tests; no database or module mocks are installed here. */
import type { OrganizationQuotaPolicy } from "@/lib/services/organization-quota-policy";

export function purchasedCreditPolicyFixture(): OrganizationQuotaPolicy {
  return {
    subscriptionFunded: false,
    authority: {
      source: "legacy",
      generation: "0",
      sourceSubscriptionId: null,
      sourceRevision: null,
      projectionRevision: null,
      catalogVersion: null,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: null,
    },
    observedAt: "2026-01-01T00:00:00.000Z",
    tierSourceCreditTotal: null,
    overrides: {
      completionsRpm: null,
      embeddingsRpm: null,
      standardRpm: null,
      strictRpm: null,
    },
    tier: { status: "unavailable", code: "NOT_EXERCISED_BY_BILLING_FIXTURE" },
    balance: {
      status: "unavailable",
      code: "RESERVATION_LEDGER_OWNS_TEST_BALANCE",
    },
    limits: {
      characters: {
        status: "unavailable",
        code: "NOT_EXERCISED_BY_BILLING_FIXTURE",
      },
      sandboxes: {
        status: "unavailable",
        code: "NOT_EXERCISED_BY_BILLING_FIXTURE",
      },
      nonEagerSandboxes: {
        status: "unavailable",
        code: "NOT_EXERCISED_BY_BILLING_FIXTURE",
      },
      containers: {
        status: "unavailable",
        code: "NOT_EXERCISED_BY_BILLING_FIXTURE",
      },
      apps: { status: "unavailable", code: "NOT_EXERCISED_BY_BILLING_FIXTURE" },
      storage: {
        status: "unavailable",
        code: "NOT_EXERCISED_BY_BILLING_FIXTURE",
      },
    },
  };
}
