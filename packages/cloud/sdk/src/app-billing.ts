/**
 * Carries app-scoped subscription contracts between Cloud, hosted apps, and
 * their billing screens. Purchaser allowances remain separate from developer
 * infrastructure funding; provider identifiers never establish buyer authority.
 */

import type {
  AppBillingAdministratorsSnapshot,
  AppBillingMembershipChange,
  AppBillingMembershipSnapshot,
  ChangeAppBillingAdministratorRequest,
  SynchronizeAppBillingMemberRequest,
} from "./app-billing-membership.js";
import type { CloudApiClient } from "./http.js";
import type { CloudRequestOptions } from "./types.js";

export interface AppBillingResult<T> {
  success: true;
  data: T;
}

export interface AppBillingPage<T> {
  items: T[];
  nextCursor: string | null;
}

/** Runtime-selected funding product; unavailable means selection could not be established. */
export type NativeApplicationBillingSelection =
  | { kind: "configured"; slotKey: string }
  | { kind: "unconfigured" }
  | { kind: "unavailable"; reason: string };

/** Identifies a configured native product before a purchaser account or subscription exists. */
export interface AppBillingApplicationProduct {
  slotKey: string;
  appId: string;
  appName: string;
  productFamilyKey: string;
  environment: "test" | "live";
}

export interface AppBillingPlan {
  id: string;
  appId: string;
  productFamilyKey: string;
  planKey: string;
  name: string;
  revision: string;
  amountCents: number;
  currency: string;
  interval: "day" | "week" | "month" | "year";
  intervalCount: number;
  seats: { minimum: number; maximum: number };
  trial: {
    days: 7;
    paymentMethodRequired: false;
    allowanceUsd: string;
  };
  allowanceUsd: string;
  featureKeys: string[];
  expiredAccess: "read_only" | "denied";
}

export interface AppBillingCatalog {
  appId: string;
  appName: string;
  environment: "test" | "live";
  plans: AppBillingPlan[];
}

export interface AppBillingAccount {
  id: string;
  appId: string;
  displayName: string;
  externalReference: string | null;
  role: "administrator" | "member";
}

export interface ResolveAppBillingAccountRequest {
  /** Only an authorized app backend may resolve an external workspace. */
  externalReference: string | null;
  displayName: string;
}

export type AppSubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

export interface AppBillingSubscription {
  id: string;
  appId: string;
  environment: "test" | "live";
  billingAccountId: string;
  productFamilyKey: string;
  planRevisionId: string;
  planKey: string;
  revision: string;
  status: AppSubscriptionStatus;
  quantity: number;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trial: { startedAt: string; endsAt: string } | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
}

export interface AppBillingEntitlement {
  sourceSubscriptionRevision: string;
  access: "granted" | "read_only" | "denied";
  featureKeys: string[];
  seatCapacity: number;
  assignedSeats: number;
  /** Access must be revalidated after this instant even if a webhook is late. */
  validUntil: string;
}

export interface AppBillingAllowance {
  source: "trial" | "paid_invoice";
  amountUsd: string;
  usedUsd: string;
  reservedUsd: string;
  remainingUsd: string;
  expiresAt: string;
}

export interface AppBillingSnapshot {
  /** Compare-and-set revision for mutations; historical canceled records do not block a new purchase. */
  mutationRevision: string | null;
  pendingOperation: AppBillingOperation | null;
  account: AppBillingAccount;
  environment: "test" | "live";
  productFamilyKey: string;
  observedAt: string;
  /** Null is an authoritative absence, never a provider or database failure. */
  subscription: AppBillingSubscription | null;
  entitlement: AppBillingEntitlement | null;
  allowances: AppBillingAllowance[];
  trialEligibility:
    | { status: "eligible" }
    | { status: "claimed"; startedAt: string; endsAt: string };
}

export interface AppBillingCommandRequest {
  /** Persist and reuse for retries of the same intent, including timeouts. */
  idempotencyKey: string;
  /** Null is the expected absence of a live subscription; revisions are decimal text. */
  expectedSubscriptionRevision: string | null;
}

export interface StartAppBillingTrialRequest extends AppBillingCommandRequest {
  planRevisionId: string;
  quantity: number;
}

export interface CreateAppBillingCheckoutRequest
  extends StartAppBillingTrialRequest {
  /** Records explicit consent to the selected recurring plan and seat quantity. */
  billingConsent: "accepted";
}

export interface UpdateAppBillingSubscriptionRequest
  extends AppBillingCommandRequest {
  quoteId: string;
  planRevisionId: string;
  quantity: number;
  billingConsent: "accepted";
}

export interface AppBillingUpdateQuote {
  id: string;
  appId: string;
  billingAccountId: string;
  productFamilyKey: string;
  planRevisionId: string;
  quantity: number;
  subscriptionRevision: string;
  dueNowCents: number;
  currency: string;
  nextInvoiceAmountCents: number;
  recurringAmountCents: number;
  trialEndsAt: string | null;
  expiresAt: string;
}

export interface CancelAppBillingSubscriptionRequest
  extends AppBillingCommandRequest {
  timing: "period_end" | "immediate";
}

interface AppBillingOperationIdentity {
  id: string;
  appId: string;
  environment: "test" | "live";
  billingAccountId: string;
  productFamilyKey: string;
}

export type AppBillingOperation = AppBillingOperationIdentity &
  (
    | { status: "pending" | "outcome_unknown"; retryAfterSeconds: number }
    | {
        status: "requires_action";
        action: {
          kind: "checkout" | "portal" | "payment";
          url: string;
          expiresAt: string | null;
        };
      }
    | { status: "succeeded"; subscriptionRevision: string | null }
    | {
        status: "failed";
        error: { code: string; message: string; retryable: boolean };
      }
  );

export interface AppBillingSeat {
  id: string;
  subject: string;
  assignedAt: string;
}

export interface AssignAppBillingSeatRequest {
  subject: string;
  idempotencyKey: string;
}

export interface AppBillingInvoice {
  id: string;
  status: "draft" | "open" | "paid" | "uncollectible" | "void";
  amountPaidCents: number;
  amountDueCents: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  hostedInvoiceUrl: string | null;
}

export interface AppBillingUsage {
  operationId: string;
  fundingSource: "trial" | "paid_invoice";
  amountUsd: string;
  occurredAt: string;
}

function segment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value)) {
    throw new TypeError(
      "App billing resource identifiers must be nonempty path segments",
    );
  }
  return encodeURIComponent(value);
}

export interface AppBillingClientOptions {
  /** Public registration reference; its stored mode selects every billing request. */
  clientId?: string;
}

/** Uses the parent client's authentication and the app's registered return destinations. */
export class AppBillingClient {
  private readonly path: string;

  constructor(
    private readonly api: CloudApiClient,
    appId: string,
    private readonly options: AppBillingClientOptions = {},
  ) {
    this.path = `/apps/${segment(appId)}/billing`;
  }

  getCatalog(): Promise<AppBillingResult<AppBillingCatalog>> {
    return this.get(`${this.path}/catalog`, {
      skipAuth: true,
    });
  }

  resolveAccount(
    request: ResolveAppBillingAccountRequest,
  ): Promise<AppBillingResult<AppBillingAccount>> {
    return this.post(`${this.path}/accounts/resolve`, request);
  }

  getSubscription(
    accountId: string,
    productFamilyKey: string,
  ): Promise<AppBillingResult<AppBillingSnapshot>> {
    return this.get(this.subscriptionPath(accountId, productFamilyKey));
  }

  startTrial(
    accountId: string,
    productFamilyKey: string,
    request: StartAppBillingTrialRequest,
  ): Promise<AppBillingResult<AppBillingOperation>> {
    return this.post(
      `${this.subscriptionPath(accountId, productFamilyKey)}/trial`,
      request,
    );
  }

  createCheckout(
    accountId: string,
    productFamilyKey: string,
    request: CreateAppBillingCheckoutRequest,
  ): Promise<AppBillingResult<AppBillingOperation>> {
    return this.post(
      `${this.subscriptionPath(accountId, productFamilyKey)}/checkout`,
      request,
    );
  }

  expireCheckout(
    accountId: string,
    productFamilyKey: string,
    operationId: string,
    request: AppBillingCommandRequest,
  ): Promise<AppBillingResult<AppBillingOperation>> {
    return this.post(
      `${this.subscriptionPath(accountId, productFamilyKey)}/checkout/expire`,
      { ...request, operationId },
    );
  }

  updateSubscription(
    accountId: string,
    productFamilyKey: string,
    request: UpdateAppBillingSubscriptionRequest,
  ): Promise<AppBillingResult<AppBillingOperation>> {
    return this.post(
      `${this.subscriptionPath(accountId, productFamilyKey)}/update`,
      request,
    );
  }

  quoteSubscriptionUpdate(
    accountId: string,
    productFamilyKey: string,
    request: StartAppBillingTrialRequest,
  ): Promise<AppBillingResult<AppBillingUpdateQuote>> {
    return this.post(
      `${this.subscriptionPath(accountId, productFamilyKey)}/quote`,
      request,
    );
  }

  cancelSubscription(
    accountId: string,
    productFamilyKey: string,
    request: CancelAppBillingSubscriptionRequest,
  ): Promise<AppBillingResult<AppBillingOperation>> {
    return this.post(
      `${this.subscriptionPath(accountId, productFamilyKey)}/cancel`,
      request,
    );
  }

  createPortal(
    accountId: string,
    productFamilyKey: string,
    request: AppBillingCommandRequest,
  ): Promise<AppBillingResult<AppBillingOperation>> {
    return this.post(
      `${this.subscriptionPath(accountId, productFamilyKey)}/portal`,
      request,
    );
  }

  getOperation(
    accountId: string,
    operationId: string,
  ): Promise<AppBillingResult<AppBillingOperation>> {
    return this.get(
      `${this.path}/accounts/${segment(accountId)}/operations/${segment(operationId)}`,
    );
  }

  listSeats(
    accountId: string,
    productFamilyKey: string,
    cursor?: string,
  ): Promise<AppBillingResult<AppBillingPage<AppBillingSeat>>> {
    return this.get(
      `${this.subscriptionPath(accountId, productFamilyKey)}/seats`,
      { query: { cursor } },
    );
  }

  /** Current purchaser membership is required; the revision is shared with backend member synchronization. */
  listAdministrators(
    accountId: string,
  ): Promise<AppBillingResult<AppBillingAdministratorsSnapshot>> {
    return this.get(
      `${this.path}/accounts/${segment(accountId)}/administrators`,
    );
  }

  /** Purchaser administrator only; persist the exact request before sending and recover it unchanged after ambiguous failures. */
  changeAdministrator(
    accountId: string,
    request: ChangeAppBillingAdministratorRequest,
  ): Promise<AppBillingResult<AppBillingAdministratorsSnapshot>> {
    return this.post(
      `${this.path}/accounts/${segment(accountId)}/administrators`,
      request,
    );
  }

  /** Registered app backend only; purchases still require purchaser delegation and administrator authority. */
  listMembers(
    accountId: string,
  ): Promise<AppBillingResult<AppBillingMembershipSnapshot>> {
    return this.get(`${this.path}/accounts/${segment(accountId)}/members`);
  }

  synchronizeMember(
    accountId: string,
    request: SynchronizeAppBillingMemberRequest,
  ): Promise<AppBillingResult<AppBillingMembershipChange>> {
    return this.post(
      `${this.path}/accounts/${segment(accountId)}/members/sync`,
      request,
    );
  }

  assignSeat(
    accountId: string,
    productFamilyKey: string,
    request: AssignAppBillingSeatRequest,
  ): Promise<AppBillingResult<AppBillingSeat>> {
    return this.post(
      `${this.subscriptionPath(accountId, productFamilyKey)}/seats`,
      request,
    );
  }

  revokeSeat(
    accountId: string,
    productFamilyKey: string,
    seatId: string,
    idempotencyKey: string,
  ): Promise<AppBillingResult<{ revoked: boolean }>> {
    return this.post(
      `${this.subscriptionPath(accountId, productFamilyKey)}/seats/${segment(seatId)}/revoke`,
      { idempotencyKey },
    );
  }

  listInvoices(
    accountId: string,
    productFamilyKey: string,
    cursor?: string,
  ): Promise<AppBillingResult<AppBillingPage<AppBillingInvoice>>> {
    return this.get(
      `${this.subscriptionPath(accountId, productFamilyKey)}/invoices`,
      { query: { cursor } },
    );
  }

  listUsage(
    accountId: string,
    productFamilyKey: string,
    cursor?: string,
  ): Promise<AppBillingResult<AppBillingPage<AppBillingUsage>>> {
    return this.get(
      `${this.subscriptionPath(accountId, productFamilyKey)}/usage`,
      { query: { cursor } },
    );
  }

  private get<T>(path: string, options: CloudRequestOptions = {}): Promise<T> {
    return this.api.requestData<T>("GET", path, {
      ...options,
      query: { ...options.query, clientId: this.options.clientId },
    });
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.api.requestData<T>("POST", path, {
      json: body,
      query: { clientId: this.options.clientId },
    });
  }

  private subscriptionPath(
    accountId: string,
    productFamilyKey: string,
  ): string {
    return `${this.path}/accounts/${segment(accountId)}/subscriptions/${segment(productFamilyKey)}`;
  }
}
