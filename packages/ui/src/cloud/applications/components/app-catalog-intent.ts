/** Retains exact developer creation requests across uncertain transport outcomes, scoped to user, app, and registration. */
import type {
  AdoptAppBillingPlanRequest,
  AppBillingAdminClient,
  AppBillingMerchantRequest,
  AppBillingRefundRequest,
  CreateAppBillingPlanRequest,
  RegisterAppBillingMerchantRequest,
} from "@elizaos/cloud-sdk/app-billing-admin";

export type CatalogIntent =
  | { kind: "refund"; request: AppBillingRefundRequest }
  | { kind: "merchant"; request: RegisterAppBillingMerchantRequest }
  | { kind: "onboard"; request: AppBillingMerchantRequest }
  | { kind: "create"; request: CreateAppBillingPlanRequest }
  | { kind: "adopt"; request: AdoptAppBillingPlanRequest };
export interface PendingCatalogIntent {
  intent: CatalogIntent;
  operationId: string | null;
}
export interface CatalogScope {
  appId: string;
  userId: string;
  clientRegistrationId: string;
  environment: "test" | "live";
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function valid(value: unknown): value is CatalogIntent {
  if (!record(value) || !record(value.request)) return false;
  const r = value.request;
  if (
    typeof r.clientRegistrationId !== "string" ||
    typeof r.idempotencyKey !== "string" ||
    !r.idempotencyKey
  )
    return false;
  if (value.kind === "merchant")
    return (
      r.mode === "platform" ||
      (r.mode === "create_connected" && typeof r.country === "string") ||
      (r.mode === "adopt_creator" && typeof r.creatorConnectionId === "string")
    );
  if (value.kind === "refund")
    return (
      typeof r.paidPeriodId === "string" &&
      typeof r.amountCents === "number" &&
      Number.isSafeInteger(r.amountCents) &&
      r.amountCents > 0 &&
      r.accessPolicy === "preserve" &&
      r.confirmation === "refund_original_payment_preserve_access"
    );
  if (typeof r.merchantId !== "string") return false;
  if (value.kind === "onboard") return true;
  if (value.kind !== "create" && value.kind !== "adopt") return false;
  if (!record(r.seats) || !record(r.trial) || !record(r.rateLimits))
    return false;
  return (
    [
      r.productFamilyKey,
      r.planKey,
      r.name,
      r.currency,
      r.allowanceUsd,
      r.trial.allowanceUsd,
    ].every((v) => typeof v === "string") &&
    [
      r.amountCents,
      r.intervalCount,
      r.seats.minimum,
      r.seats.maximum,
      r.rateLimits.completionsRpm,
      r.rateLimits.embeddingsRpm,
      r.rateLimits.standardRpm,
      r.rateLimits.strictRpm,
    ].every((v) => typeof v === "number" && Number.isSafeInteger(v)) &&
    ["day", "week", "month", "year"].includes(String(r.interval)) &&
    r.trial.days === 7 &&
    (r.expiredAccess === "read_only" || r.expiredAccess === "denied") &&
    Array.isArray(r.featureKeys) &&
    r.featureKeys.every((v) => typeof v === "string") &&
    (value.kind !== "adopt" ||
      (typeof r.priceReference === "string" &&
        typeof r.productReference === "string"))
  );
}
function key(scope: CatalogScope) {
  return `app-catalog-intent:${JSON.stringify(scope)}`;
}
export function readCatalogIntent(
  storage: Storage,
  scope: CatalogScope,
): PendingCatalogIntent | null {
  const saved = storage.getItem(key(scope));
  if (saved === null) return null;
  const parsed: unknown = JSON.parse(saved);
  if (
    !record(parsed) ||
    !valid(parsed.intent) ||
    parsed.intent.request.clientRegistrationId !== scope.clientRegistrationId ||
    !(parsed.operationId === null || typeof parsed.operationId === "string")
  )
    throw new Error(
      "Saved catalog request is unreadable. Contact support before submitting another billing request.",
    );
  return { intent: parsed.intent, operationId: parsed.operationId };
}
export function writeCatalogIntent(
  storage: Storage,
  scope: CatalogScope,
  value: PendingCatalogIntent | null,
) {
  if (value === null) storage.removeItem(key(scope));
  else storage.setItem(key(scope), JSON.stringify(value));
}
export function dispatchCatalogIntent(
  client: AppBillingAdminClient,
  intent: CatalogIntent,
) {
  switch (intent.kind) {
    case "refund":
      return client.refund(intent.request);
    case "merchant":
      return client.registerMerchant(intent.request);
    case "onboard":
      return client.onboardMerchant(intent.request);
    case "create":
      return client.createPlan(intent.request);
    case "adopt":
      return client.adoptPlan(intent.request);
  }
}
