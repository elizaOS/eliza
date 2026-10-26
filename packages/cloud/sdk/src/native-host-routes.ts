/**
 * Local request and response bodies of the `@elizaos/cloud-sdk/native-host`
 * billing routes. The native host projects Cloud DTOs to these shapes; it
 * drops every other field. All routes are `POST`.
 */

import type {
  OrganizationSubscriptionDowngradeCommandDto,
  OrganizationSubscriptionDowngradeQuoteDto,
  OrganizationSubscriptionRenewalReviewDto,
  OrganizationSubscriptionUpgradeCommandDto,
  OrganizationSubscriptionUpgradePaymentDto,
  OrganizationSubscriptionUpgradeQuoteDto,
  PendingOrganizationPlanChangeCommandsDto,
  SubscriptionPlanKey,
} from "./types.cloud-api.js";

export type NativePlanChangeKind = "upgrade" | "downgrade";

/** A plan-change command. `kind` is the action the host asked about. */
export type NativePlanChangeCommand =
  | (OrganizationSubscriptionUpgradeCommandDto & { kind: "upgrade" })
  | (OrganizationSubscriptionDowngradeCommandDto & { kind: "downgrade" });

export interface NativeUpgradePayment
  extends Omit<OrganizationSubscriptionUpgradePaymentDto, "command"> {
  command: OrganizationSubscriptionUpgradeCommandDto & { kind: "upgrade" };
}

export type NativeSubscriptionLifecycleAction = "cancel" | "undo";

/** A cancellation or undo command, with revisions renamed for the host. */
export interface NativeSubscriptionCommand {
  commandId: string;
  subscriptionId: string;
  status: OrganizationSubscriptionUpgradeCommandDto["status"];
  revision: string;
  resultRevision: string | null;
}

/** Unfinished cancellation and undo commands, for status recovery. */
export interface NativeSubscriptionRecoveryPage {
  observedAt: string;
  items: Array<
    NativeSubscriptionCommand & {
      status: "PREPARED" | "OUTCOME_UNKNOWN";
      resultRevision: null;
      action: NativeSubscriptionLifecycleAction;
    }
  >;
  nextCursor: string | null;
}

interface SubscriptionRevisionInput {
  subscriptionId: string;
  revision: number;
}

/** Request and response body for each native billing route path. */
export interface NativeBillingRoutes {
  "/cloud/account/plan-change/review": {
    request: SubscriptionRevisionInput & {
      kind: NativePlanChangeKind;
      targetPlanKey: SubscriptionPlanKey;
    };
    response:
      | OrganizationSubscriptionUpgradeQuoteDto
      | OrganizationSubscriptionDowngradeQuoteDto;
  };
  "/cloud/account/plan-change/confirm": {
    request: { kind: NativePlanChangeKind; quoteId: string };
    response: NativePlanChangeCommand;
  };
  "/cloud/account/plan-change/status": {
    request: { kind: NativePlanChangeKind; commandId: string };
    response: NativePlanChangeCommand;
  };
  "/cloud/account/plan-change/pending": {
    request: { cursor?: string };
    response: PendingOrganizationPlanChangeCommandsDto;
  };
  "/cloud/account/plan-change/payment": {
    request: { commandId: string };
    response: NativeUpgradePayment;
  };
  "/cloud/account/subscription/renewal-review": {
    request: SubscriptionRevisionInput;
    response: OrganizationSubscriptionRenewalReviewDto;
  };
  "/cloud/account/subscription/cancel": {
    request: SubscriptionRevisionInput & { retryOf?: string };
    response: NativeSubscriptionCommand;
  };
  "/cloud/account/subscription/undo": {
    request: SubscriptionRevisionInput & {
      expectedRenewalTermsDigest: string;
      retryOf?: string;
    };
    response: NativeSubscriptionCommand;
  };
  "/cloud/account/subscription/status": {
    request: { action: NativeSubscriptionLifecycleAction; commandId: string };
    response: NativeSubscriptionCommand;
  };
  "/cloud/account/subscription/pending": {
    request: { cursor?: string };
    response: NativeSubscriptionRecoveryPage;
  };
}
