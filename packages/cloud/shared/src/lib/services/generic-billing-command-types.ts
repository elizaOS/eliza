/**
 * Stores complete, immutable app billing intent before provider I/O. Result
 * records carry recoverable provider handles and actions; none grant access
 * without the subscription finalizer's current authority revision.
 */

import type { CreateAppBillingPlanRequest } from "@elizaos/cloud-sdk/app-billing-admin";

interface BuyerIntent {
  version: 1;
  domain: "buyer";
}

export type BuyerBillingCommandPayload = BuyerIntent &
  (
    | { action: "trial"; planRevisionId: string; quantity: number }
    | {
        action: "checkout";
        planRevisionId: string;
        quantity: number;
        billingConsent: "accepted";
        successUrl: string;
        cancelUrl: string;
      }
    | {
        action: "update";
        planRevisionId: string;
        quantity: number;
        quoteId: string;
        billingConsent: "accepted";
      }
    | { action: "cancel"; timing: "period_end" | "immediate" }
    | { action: "portal"; returnUrl: string }
    | { action: "expire_checkout"; checkoutCommandId: string }
  );

export interface BuyerBillingPaymentAction {
  kind: "payment";
  invoiceId: string;
  customerId: string;
  subscriptionId: string;
  url: string;
  expiresAt: string;
}

export interface BuyerBillingCheckoutResume {
  notBefore: string;
  previousInvoiceId: string | null;
  invoiceId: string | null;
  action: BuyerBillingPaymentAction | null;
  /** Retained only after the exact invoice passes provider settlement validation. */
  invoicePaid?: true;
}

export type BuyerBillingCommandResult =
  | {
      kind: "checkout";
      checkoutSessionId: string;
      customerId: string;
      subscriptionId: string | null;
      mode: "setup" | "subscription";
      url: string | null;
      expiresAt: string;
      resume?: BuyerBillingCheckoutResume;
    }
  | { kind: "portal"; url: string; expiresAt: string | null }
  | BuyerBillingPaymentAction
  | { kind: "completed"; subscriptionId: string | null; subscriptionRevision: number | null }
  | { kind: "expired_checkout"; checkoutSessionId: string }
  | {
      kind: "completed_checkout";
      checkoutSessionId: string;
      subscriptionId: string;
      subscriptionRevision: number;
    };

export type AdminBillingCommandPayload = {
  version: 1;
  domain: "admin";
  clientRegistrationId: string;
} & (
  | { action: "merchant_create"; country: string }
  | { action: "merchant_adopt"; creatorConnectionId: string; providerAccountId: string }
  | { action: "merchant_platform" }
  | {
      action: "refund";
      source: import("../../db/repositories/app-billing-refund-source").AppBillingRefundSource;
      amountCents: number;
      accessPolicy: "preserve";
    }
  | { action: "merchant_onboarding"; merchantId: string; refreshUrl: string; returnUrl: string }
  | { action: "plan_create"; planRevisionId: string; plan: CreateAppBillingPlanRequest }
  | {
      action: "plan_adopt";
      planRevisionId: string;
      plan: CreateAppBillingPlanRequest;
      priceReference: string;
      productReference: string;
    }
);
export type OperatorBillingCommandPayload = {
  version: 1;
  domain: "operator";
  action: "import";
  manifestDigest: string;
  manifest: import("./generic-billing-import-manifest").AppBillingImportManifest;
};
/** Internal cleanup intent; purchaser endpoints never accept this domain. */
export interface DeletionCheckoutCommandPayload {
  version: 1;
  domain: "account_deletion";
  action: "expire_checkout";
  sourceCommandId: string;
  requestId: string;
  requestDigest: string;
  lifecycleRevision: number;
  phaseReceiptId: string;
  initiatingPhaseGeneration: number;
  checkoutSessionId: string;
  customerId: string;
  subscriptionId: string | null;
  mode: "setup" | "subscription";
  planRevisionId: string | null;
}

/** Server-selected immediate cancellation of one subscription in a canonically closed scope. */
export interface DeletionCancellationCommandPayload {
  version: 1;
  domain: "account_deletion";
  action: "cancel";
  requestId: string;
  requestDigest: string;
  lifecycleRevision: number;
  phaseReceiptId: string;
  initiatingPhaseGeneration: number;
  customerId: string;
  subscriptionId: string;
  localSubscriptionId: string;
  planRevisionId: string;
  providerAccountId: string;
  timing: "immediate";
}

export type GenericBillingCommandPayload =
  | BuyerBillingCommandPayload
  | AdminBillingCommandPayload
  | OperatorBillingCommandPayload
  | DeletionCheckoutCommandPayload
  | DeletionCancellationCommandPayload
  | DeletionCustomerCommandPayload;

/** Freezes one customer-wide deletion intent; current execution authority is validated separately on every dispatch. */
export interface DeletionCustomerCommandPayload {
  version: 1;
  domain: "account_deletion";
  action: "delete_customer";
  customerBindingId: string;
  requestId: string;
  requestDigest: string;
  lifecycleRevision: number;
  phaseReceiptId: string;
  initiatingPhaseGeneration: number;
  closureRequestId: string;
  closureRequestDigest: string;
  billingAccountId: string;
  customerId: string;
  providerAccountId: string;
}
export type AdminBillingCommandResult =
  | { kind: "merchant"; merchantId: string }
  | { kind: "merchant_onboarding"; url: string; expiresAt: string }
  | { kind: "plan"; planRevisionId: string }
  | { kind: "refund"; refundId: string; chargeId: string; amountCents: number; currency: string };
export type OperatorBillingCommandResult = {
  kind: "import";
  subscriptionId: string | null;
  trialClaimId: string | null;
};
/** Retains exact provider tombstone evidence and the canonical phase that accepted it. */
export interface DeletionCustomerCommandResult {
  kind: "deleted_customer";
  customerBindingId: string;
  observation: import("./generic-billing-provider-types").BillingProviderObservation<{
    customerId: string;
    status: "deleted";
  }>;
  completionAuthority: {
    requestId: string;
    requestDigest: string;
    lifecycleRevision: number;
    phaseReceiptId: string;
    phaseGeneration: number;
  };
}
export type GenericBillingCommandResult =
  | BuyerBillingCommandResult
  | AdminBillingCommandResult
  | OperatorBillingCommandResult
  | DeletionCustomerCommandResult;
