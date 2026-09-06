/** Persists exact purchase intents before dispatch so reloads and transport failures reuse their idempotency keys. */
import type {
  AppBillingClient,
  AppBillingCommandRequest,
  AppBillingOperation,
  CancelAppBillingSubscriptionRequest,
  CreateAppBillingCheckoutRequest,
  StartAppBillingTrialRequest,
  UpdateAppBillingSubscriptionRequest,
} from "@elizaos/cloud-sdk/app-billing";

export type BillingIntent =
  | { kind: "trial"; request: StartAppBillingTrialRequest }
  | { kind: "checkout"; request: CreateAppBillingCheckoutRequest }
  | { kind: "update"; request: UpdateAppBillingSubscriptionRequest }
  | { kind: "cancel"; request: CancelAppBillingSubscriptionRequest }
  | { kind: "portal"; request: AppBillingCommandRequest }
  | {
      kind: "expire";
      request: AppBillingCommandRequest & { operationId: string };
    };
export interface PendingBillingIntent {
  intent: BillingIntent | null;
  operationId: string | null;
}
export interface BillingIntentScope {
  userId: string;
  appId: string;
  clientId: string | null;
  accountId: string;
  environment: "test" | "live";
  productFamilyKey: string;
}

function storageKey(scope: BillingIntentScope): string {
  return `app-billing-intent:${JSON.stringify(scope)}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validIntent(value: unknown): value is BillingIntent {
  if (!isRecord(value) || !isRecord(value.request)) return false;
  const request = value.request;
  if (
    typeof request.idempotencyKey !== "string" ||
    request.idempotencyKey.length === 0 ||
    !(
      request.expectedSubscriptionRevision === null ||
      typeof request.expectedSubscriptionRevision === "string"
    )
  )
    return false;
  if (value.kind === "portal") return true;
  if (value.kind === "expire") return typeof request.operationId === "string";
  if (value.kind === "cancel")
    return request.timing === "period_end" || request.timing === "immediate";
  if (
    typeof request.planRevisionId !== "string" ||
    typeof request.quantity !== "number" ||
    !Number.isSafeInteger(request.quantity) ||
    request.quantity < 1
  )
    return false;
  if (value.kind === "trial") return true;
  if (request.billingConsent !== "accepted") return false;
  return (
    value.kind === "checkout" ||
    (value.kind === "update" && typeof request.quoteId === "string")
  );
}
export function readBillingIntent(
  storage: Storage,
  scope: BillingIntentScope,
): PendingBillingIntent | null {
  const saved = storage.getItem(storageKey(scope));
  if (saved === null) return null;
  const parsed: unknown = JSON.parse(saved);
  if (
    !isRecord(parsed) ||
    !(
      validIntent(parsed.intent) ||
      (parsed.intent === null && typeof parsed.operationId === "string")
    ) ||
    !(parsed.operationId === null || typeof parsed.operationId === "string")
  ) {
    throw new Error(
      "Saved billing request is unreadable. Refresh your subscription before continuing.",
    );
  }
  return { intent: parsed.intent, operationId: parsed.operationId };
}
export function writeBillingIntent(
  storage: Storage,
  scope: BillingIntentScope,
  pending: PendingBillingIntent | null,
) {
  if (pending === null) storage.removeItem(storageKey(scope));
  else storage.setItem(storageKey(scope), JSON.stringify(pending));
}
export async function dispatchBillingIntent(
  client: AppBillingClient,
  scope: BillingIntentScope,
  intent: BillingIntent,
): Promise<AppBillingOperation> {
  const { accountId, productFamilyKey } = scope;
  switch (intent.kind) {
    case "trial":
      return (
        await client.startTrial(accountId, productFamilyKey, intent.request)
      ).data;
    case "checkout":
      return (
        await client.createCheckout(accountId, productFamilyKey, intent.request)
      ).data;
    case "update":
      return (
        await client.updateSubscription(
          accountId,
          productFamilyKey,
          intent.request,
        )
      ).data;
    case "cancel":
      return (
        await client.cancelSubscription(
          accountId,
          productFamilyKey,
          intent.request,
        )
      ).data;
    case "portal":
      return (
        await client.createPortal(accountId, productFamilyKey, intent.request)
      ).data;
    case "expire":
      return (
        await client.expireCheckout(
          accountId,
          productFamilyKey,
          intent.request.operationId,
          intent.request,
        )
      ).data;
  }
}

/** Provider links are displayed only after an authenticated SDK response. */
export function billingHostedUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Billing returned an invalid payment destination");
  return url.href;
}
