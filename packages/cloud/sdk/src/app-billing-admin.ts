/** Carries owner-authorized merchant and immutable plan administration through the Cloud API. */
import type { AppBillingPlan, AppBillingResult } from "./app-billing.js";
import type {
  AppBillingNotificationConfig,
  AppBillingNotificationConfigIntent,
  AppBillingNotificationKeyPreparation,
  ConfigureAppBillingNotifications,
} from "./app-notifications.js";
import type { CloudApiClient } from "./http.js";

export interface AppBillingMerchant {
  id: string;
  environment: "test" | "live";
  kind: "platform" | "connected";
  connectionStatus: "pending" | "ready" | "restricted" | "disabled";
  enabled: boolean;
  capabilities: {
    charges: boolean;
    payouts: boolean;
    cardPayments: boolean;
  } | null;
  requirementsDue: string[] | null;
  verifiedAt: string | null;
  revision: string;
}
export interface AppBillingAdminPlan extends AppBillingPlan {
  merchantId: string;
  environment: "test" | "live";
  state: "draft" | "verified" | "published" | "retired";
  providerVerifiedAt: string | null;
  rateLimits: {
    completionsRpm: number;
    embeddingsRpm: number;
    standardRpm: number;
    strictRpm: number;
  };
}
export interface AppBillingAdministration {
  appId: string;
  registrations: Array<{
    id: string;
    environment: "test" | "live";
    active: boolean;
  }>;
  operations: Array<{
    id: string;
    environment: "test" | "live";
    clientRegistrationId: string;
    action:
      | "merchant_create"
      | "merchant_adopt"
      | "merchant_platform"
      | "merchant_onboarding"
      | "plan_create"
      | "plan_adopt"
      | "refund";
    status: "pending" | "outcome_unknown" | "requires_action";
    createdAt: string;
  }>;
  merchants: AppBillingMerchant[];
  plans: AppBillingAdminPlan[];
}
export interface AppBillingAdminIntent {
  /** Selects a persisted client registration; its environment is immutable authority. */
  clientRegistrationId: string;
  idempotencyKey: string;
}
export type RegisterAppBillingMerchantRequest = AppBillingAdminIntent &
  (
    | { mode: "create_connected"; country: string }
    | { mode: "adopt_creator"; creatorConnectionId: string }
    | { mode: "platform" }
  );
export interface AppBillingMerchantRequest extends AppBillingAdminIntent {
  merchantId: string;
}
export interface DisconnectAppBillingMerchantRequest
  extends AppBillingMerchantRequest {
  expectedRevision: string;
  confirmation: "disable_new_sales_for_merchant";
}
export interface CreateAppBillingPlanRequest extends AppBillingAdminIntent {
  merchantId: string;
  productFamilyKey: string;
  planKey: string;
  name: string;
  amountCents: number;
  currency: "usd";
  interval: "day" | "week" | "month" | "year";
  intervalCount: number;
  seats: { minimum: number; maximum: number };
  trial: { days: 7; allowanceUsd: string };
  allowanceUsd: string;
  featureKeys: string[];
  expiredAccess: "read_only" | "denied";
  rateLimits: AppBillingAdminPlan["rateLimits"];
}
export interface AdoptAppBillingPlanRequest
  extends CreateAppBillingPlanRequest {
  /** A selection to retrieve and verify inside the registered merchant account, never proof of ownership. */
  priceReference: string;
  productReference: string;
}
export interface AppBillingPlanRevisionRequest extends AppBillingAdminIntent {
  planRevisionId: string;
}
export interface AppBillingRefundOperationSummary {
  id: string;
  amountCents: number;
  state: "prepared" | "outcome_unknown" | "receipt_available" | "failed";
  createdAt: string;
}
export interface AppBillingPaidPeriod {
  id: string;
  accountName: string;
  planName: string;
  refundOperations: AppBillingRefundOperationSummary[];
  periodStart: string;
  periodEnd: string;
  quantity: number;
}
export interface AppBillingPaidPeriods {
  appId: string;
  clientRegistrationId: string;
  environment: "test" | "live";
  items: AppBillingPaidPeriod[];
  nextCursor: string | null;
}
export interface AppBillingRefundPreview {
  appId: string;
  clientRegistrationId: string;
  paidPeriodId: string;
  environment: "test" | "live";
  amountPaidCents: number;
  amountAvailableCents: number;
  currency: string;
  accessPolicy: "preserve";
}
export interface AppBillingRefundRequest extends AppBillingAdminIntent {
  paidPeriodId: string;
  amountCents: number;
  accessPolicy: "preserve";
  confirmation: "refund_original_payment_preserve_access";
}
export interface AppBillingRefundReceipt {
  refundId: string;
  paidPeriodId: string;
  amountCents: number;
  currency: string;
  environment: "test" | "live";
  accessPolicy: "preserve";
  providerStatus:
    | "pending"
    | "requires_action"
    | "succeeded"
    | "failed"
    | "canceled"
    | "unavailable";
}
export type AppBillingAdminOperation =
  | { id: string; status: "refund"; receipt: AppBillingRefundReceipt }
  | { id: string; status: "outcome_unknown"; retryAfterSeconds: number }
  | {
      id: string;
      status: "succeeded";
      merchant: AppBillingMerchant | null;
      plan: AppBillingAdminPlan | null;
    }
  | {
      id: string;
      status: "requires_action";
      action: { kind: "merchant_onboarding"; url: string; expiresAt: string };
    };
export interface AppBillingMerchantDisconnectResult {
  merchant: AppBillingMerchant;
  activeSubscriptionCount: number;
  /** Disabling new sales does not terminate historical provider subscriptions. */
  existingBillingContinues: true;
}

export class AppBillingAdminClient {
  constructor(
    private readonly api: CloudApiClient,
    private readonly appId: string,
  ) {}
  private post<T>(path: string, body: unknown): Promise<T> {
    return this.api.requestData<T>("POST", path, { json: body });
  }
  private path(suffix = ""): string {
    return `/apps/${encodeURIComponent(this.appId)}/billing/admin${suffix}`;
  }
  overview(): Promise<AppBillingResult<AppBillingAdministration>> {
    return this.api.requestData("GET", this.path());
  }
  paidPeriods(
    clientRegistrationId: string,
    cursor: string | null = null,
  ): Promise<AppBillingResult<AppBillingPaidPeriods>> {
    const query = new URLSearchParams({ clientRegistrationId });
    if (cursor !== null) query.set("cursor", cursor);
    return this.api.requestData("GET", this.path(`/paid-periods?${query}`));
  }
  previewRefund(input: {
    clientRegistrationId: string;
    paidPeriodId: string;
  }): Promise<AppBillingResult<AppBillingRefundPreview>> {
    return this.post(this.path("/refunds/preview"), input);
  }
  refund(
    input: AppBillingRefundRequest,
  ): Promise<AppBillingResult<AppBillingAdminOperation>> {
    return this.post(this.path("/refunds"), input);
  }
  notificationConfig(
    clientRegistrationId: string,
  ): Promise<AppBillingResult<AppBillingNotificationConfig>> {
    return this.api.requestData(
      "GET",
      this.path(
        `/notifications?clientRegistrationId=${encodeURIComponent(clientRegistrationId)}`,
      ),
    );
  }
  configureNotifications(
    input: ConfigureAppBillingNotifications,
  ): Promise<AppBillingResult<AppBillingNotificationConfig>> {
    return this.post(this.path("/notifications"), input);
  }
  prepareNotificationKey(
    input: AppBillingNotificationConfigIntent,
  ): Promise<AppBillingResult<AppBillingNotificationKeyPreparation>> {
    return this.post(this.path("/notifications/keys/prepare"), input);
  }
  activateNotificationKey(
    input: AppBillingNotificationConfigIntent & { pendingKeyId: string },
  ): Promise<AppBillingResult<AppBillingNotificationConfig>> {
    return this.post(this.path("/notifications/keys/activate"), input);
  }
  registerMerchant(
    input: RegisterAppBillingMerchantRequest,
  ): Promise<AppBillingResult<AppBillingAdminOperation>> {
    return this.post(this.path("/merchants"), input);
  }
  onboardMerchant(
    input: AppBillingMerchantRequest,
  ): Promise<AppBillingResult<AppBillingAdminOperation>> {
    return this.post(this.path("/merchants/onboarding"), input);
  }
  refreshMerchant(
    input: AppBillingMerchantRequest,
  ): Promise<AppBillingResult<AppBillingMerchant>> {
    return this.post(this.path("/merchants/refresh"), input);
  }
  disconnectMerchant(
    input: DisconnectAppBillingMerchantRequest,
  ): Promise<AppBillingResult<AppBillingMerchantDisconnectResult>> {
    return this.post(this.path("/merchants/disconnect"), input);
  }
  createPlan(
    input: CreateAppBillingPlanRequest,
  ): Promise<AppBillingResult<AppBillingAdminOperation>> {
    return this.post(this.path("/plans"), input);
  }
  adoptPlan(
    input: AdoptAppBillingPlanRequest,
  ): Promise<AppBillingResult<AppBillingAdminOperation>> {
    return this.post(this.path("/plans/adopt"), input);
  }
  verifyPlan(
    input: AppBillingPlanRevisionRequest,
  ): Promise<AppBillingResult<AppBillingAdminPlan>> {
    return this.post(this.path("/plans/verify"), input);
  }
  publishPlan(
    input: AppBillingPlanRevisionRequest,
  ): Promise<AppBillingResult<AppBillingAdminPlan>> {
    return this.post(this.path("/plans/publish"), input);
  }
  retirePlan(
    input: AppBillingPlanRevisionRequest,
  ): Promise<AppBillingResult<AppBillingAdminPlan>> {
    return this.post(this.path("/plans/retire"), input);
  }
  recoverOperation(
    commandId: string,
  ): Promise<AppBillingResult<AppBillingAdminOperation>> {
    return this.post(
      this.path(`/operations/${encodeURIComponent(commandId)}/recover`),
      {},
    );
  }
}
