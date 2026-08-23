/** Provides deterministic sensitive rows and independent DTO expectations for payment-request route tests. */
import type { PaymentRequestRow } from "@/lib/services/payment-requests";
import type { PaymentRequestDto } from "@/types/cloud-api";

/** Internal-only values that must never appear in an authenticated response. */
export const INTERNAL_PAYMENT_REQUEST_CANARIES = [
  "internal-org-canary",
  "payment-context-canary",
  "payer-identity-canary",
  "payer-user-canary",
  "payer-org-canary",
  "callback-url-canary",
  "callback-secret-canary",
  "provider-intent-canary",
  "settlement-tx-canary",
  "settlement-proof-canary",
  "metadata-canary",
  "success-url-canary",
  "cancel-url-canary",
] as const;

/** Creates a complete internal row with sensitive fields populated. */
export function paymentRequestRow(
  overrides: Partial<PaymentRequestRow> = {},
): PaymentRequestRow {
  return {
    id: "pr-1",
    organizationId: "internal-org-canary",
    agentId: "agent-1",
    appId: "app-1",
    provider: "stripe",
    amountCents: 2500,
    currency: "USD",
    reason: "Premium plan",
    paymentContext: {
      kind: "specific_payer",
      payerIdentityId: "payment-context-canary",
    },
    payerIdentityId: "payer-identity-canary",
    payerUserId: "payer-user-canary",
    payerOrganizationId: "payer-org-canary",
    status: "pending",
    hostedUrl: "https://checkout.example.test/session",
    callbackUrl: "https://callback-url-canary.example.test/hook",
    callbackSecret: "callback-secret-canary",
    providerIntent: { sessionId: "provider-intent-canary" },
    settledAt: null,
    settlementTxRef: "settlement-tx-canary",
    settlementProof: { signature: "settlement-proof-canary" },
    expiresAt: new Date("2030-01-02T03:04:05.000Z"),
    createdAt: new Date("2026-08-20T10:00:00.000Z"),
    updatedAt: new Date("2026-08-20T10:05:00.000Z"),
    metadata: { internal: "metadata-canary" },
    successUrl: "https://success-url-canary.example.test/complete",
    cancelUrl: "https://cancel-url-canary.example.test/cancel",
    ...overrides,
  };
}

/** Builds the independently specified JSON shape expected from route responses. */
export function expectedPaymentRequestDto(
  row: PaymentRequestRow,
): PaymentRequestDto {
  return {
    id: row.id,
    agentId: row.agentId,
    appId: row.appId,
    provider: row.provider,
    amountCents: row.amountCents,
    currency: row.currency,
    reason: row.reason,
    status: row.status,
    hostedUrl: row.hostedUrl,
    settledAt: row.settledAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
