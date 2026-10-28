/**
 * Native client side of the Eliza Cloud subscription entitlement.
 *
 * Cloud signs a short-lived ES256 entitlement of the caller's plan state
 * (`GET /api/v1/subscription/entitlement`, keys at
 * `/api/v1/subscription/entitlement-keys`). A client reads it when its agent
 * is admitted and refreshes it in the background. It never reads billing
 * before an assistant turn: Cloud authorizes each inference or Maps request
 * from its own cached quota and token buckets.
 *
 * This module verifies the signature and claims, binds the entitlement to the
 * signed-in account, schedules the background refresh with explicit expiry and
 * outage states, reads Cloud limit refusals (rate limits, period allowance,
 * no plan) with their retry times, and produces the owner-facing copy. It
 * never chooses a price, quota, allowance or limit: every number shown comes
 * from a verified entitlement or a Cloud refusal. Nothing here buys,
 * upgrades or retries anything.
 *
 * The module has no imports and touches no storage or network by itself.
 * Hosts supply the transport (`EntitlementSource`) and the product name used
 * in copy (`SubscriptionCopy`).
 */

/** Cloud routes, relative to the Cloud API origin. */
export const ENTITLEMENT_PATH = "/api/v1/subscription/entitlement";
export const ENTITLEMENT_KEYS_PATH = "/api/v1/subscription/entitlement-keys";
export const REDEEM_PATH = "/api/v1/subscription/redeem";
/** Read-only organization billing snapshot; it also names credit billing when there is no subscription. */
export const BILLING_LIMITS_PATH = "/api/v1/billing/limits";
export const ENTITLEMENT_TYPE = "eliza-entitlement+jwt";
export const ENTITLEMENT_AUDIENCE = "cloud-subscription";
/** Client ceiling for "short-lived": an engineering bound, not a billing value. */
export const MAX_ENTITLEMENT_LIFETIME_MS = 60 * 60 * 1000;
export const CLOCK_SKEW_MS = 60 * 1000;
/** Background refresh after a failure: first retry, then doubling up to the cap. */
export const REFRESH_RETRY_MIN_MS = 30 * 1000;
export const REFRESH_RETRY_MAX_MS = 5 * 60 * 1000;
/** Refresh an admitted billing snapshot off the turn path until a signed entitlement is available. */
export const FALLBACK_REFRESH_MS = 5 * 60 * 1000;
/** Published verification keys are cached per issuer for this long. */
export const KEY_CACHE_MS = 60 * 60 * 1000;
export const MAX_ENTITLEMENT_KEYS = 16;
export const MAX_ENTITLEMENT_LENGTH = 8192;
/** Entitlement claim-set versions this client reads. Tokens without `ver` are v1; later versions only add claims. */
export const ENTITLEMENT_FORMAT_VERSION = 2;

export type PlanStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "none";
export type AllowanceUnit = "requests" | "tokens";
export type AllowancePeriod = "day" | "week" | "month";
/** Format v1 `allowance` claim. Cloud does not issue it today; it stays accepted. */
export interface CountAllowance {
  unit: AllowanceUnit;
  period: AllowancePeriod;
  /** Null when Cloud does not publish the number; the client never fills one in. */
  limit: number | null;
  used: number | null;
  resetsAt: number | null;
}
/**
 * Format v2 `plan_allowance` claim: Cloud's allowance for the current billing
 * period in its own unit, integer millionths of a US dollar. Clients show the
 * share that is left, not a money meter. `remaining` excludes requests still
 * in flight.
 */
export interface PeriodAllowance {
  unit: "usd_micros";
  granted: number;
  remaining: number;
  periodStart: number;
  resetsAt: number;
}
export type PlanAllowance = CountAllowance | PeriodAllowance;
export interface SubscriptionEntitlement {
  id: string;
  keyId: string;
  issuer: string;
  userId: string;
  organizationId: string | null;
  plan: { id: string; name: string; status: PlanStatus };
  /** v2 `plan_allowance` when present and readable, else the v1 `allowance` claim. */
  allowance: PlanAllowance | null;
  /** `ver` claim; 1 when absent. */
  formatVersion: number;
  /** Cloud-managed services this entitlement covers, e.g. "inference", "maps". */
  services: string[];
  issuedAt: number;
  expiresAt: number;
  refreshAt: number;
  /** Signed membership window; distinct from this short-lived token expiry. */
  planEndsAt?: number | null;
}

export type EntitlementErrorCode =
  | "malformed"
  | "unsupported"
  | "unknown-key"
  | "signature"
  | "account-mismatch"
  | "audience"
  | "expired"
  | "not-yet-valid"
  | "lifetime";
export class EntitlementError extends Error {
  readonly code: EntitlementErrorCode;
  constructor(code: EntitlementErrorCode) {
    super(`Subscription entitlement ${code}`);
    this.name = "EntitlementError";
    this.code = code;
  }
}

type Bag = Record<string, unknown>;
const bag = (value: unknown): Bag | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Bag)
    : null;
function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1)
    throw new EntitlementError("malformed");
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function base64UrlJson(value: string): Bag {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(base64UrlBytes(value)),
    );
  } catch (error) {
    if (error instanceof EntitlementError) throw error;
    throw new EntitlementError("malformed");
  }
  const result = bag(parsed);
  if (!result) throw new EntitlementError("malformed");
  return result;
}
/** Display text from Cloud: bounded, trimmed and free of control characters. */
function displayText(value: unknown, max: number): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: display text from Cloud must not carry control characters.
  if (/[\x00-\x1f\x7f]/.test(value)) return null;
  return value.trim();
}
const text = (value: unknown, max = 200): string => {
  const result = displayText(value, max);
  if (result === null) throw new EntitlementError("malformed");
  return result;
};
const seconds = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new EntitlementError("malformed");
  return value * 1000;
};
const count = (value: unknown): number | null => {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new EntitlementError("malformed");
  return value;
};
const PLAN_STATUSES: readonly PlanStatus[] = [
  "active",
  "trialing",
  "past_due",
  "canceled",
  "none",
];
/**
 * Reads the v2 `plan_allowance` claim. It only adds detail to the plan state,
 * so an unknown unit or an inconsistent row is not shown (null) instead of
 * making the whole entitlement invalid.
 */
function periodAllowance(value: unknown): PeriodAllowance | null {
  const row = bag(value);
  if (row?.unit !== "usd_micros") return null;
  const amount = (item: unknown) =>
    typeof item === "number" && Number.isSafeInteger(item) && item >= 0
      ? item
      : null;
  const instant = (item: unknown) =>
    typeof item === "number" && Number.isSafeInteger(item) && item > 0
      ? item * 1000
      : null;
  const granted = amount(row.granted),
    remaining = amount(row.remaining),
    periodStart = instant(row.periodStart),
    resetsAt = instant(row.resetsAt);
  if (
    granted === null ||
    remaining === null ||
    periodStart === null ||
    resetsAt === null ||
    granted === 0 ||
    remaining > granted ||
    resetsAt <= periodStart
  )
    return null;
  return { unit: "usd_micros", granted, remaining, periodStart, resetsAt };
}

/** Splits a compact JWS. The signature is checked separately by verifyEntitlement. */
export function decodeEntitlement(token: string): {
  header: Bag;
  claims: Bag;
  signingInput: string;
  signature: Uint8Array<ArrayBuffer>;
} {
  if (typeof token !== "string" || token.length > MAX_ENTITLEMENT_LENGTH)
    throw new EntitlementError("malformed");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part))
    throw new EntitlementError("malformed");
  return {
    header: base64UrlJson(parts[0]),
    claims: base64UrlJson(parts[1]),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: base64UrlBytes(parts[2]),
  };
}

export interface EntitlementExpectation {
  userId: string;
  organizationId?: string | null;
  issuer: string;
  audience?: string;
}
/** Pure claim validation; signature verification happens before this is trusted. */
export function entitlementClaims(
  header: Bag,
  claims: Bag,
  expected: EntitlementExpectation,
  now: number,
): SubscriptionEntitlement {
  if (
    header.alg !== "ES256" ||
    header.typ !== ENTITLEMENT_TYPE ||
    header.crit !== undefined
  )
    throw new EntitlementError("unsupported");
  const keyId = text(header.kid, 128);
  if (claims.iss !== expected.issuer) throw new EntitlementError("audience");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(expected.audience ?? ENTITLEMENT_AUDIENCE))
    throw new EntitlementError("audience");
  const userId = text(claims.sub, 128);
  const organizationId = claims.org == null ? null : text(claims.org, 128);
  // Cloud ids are UUIDs; a difference in letter case alone is the same account.
  const same = (a: string | null, b: string | null) =>
    a === null || b === null ? a === b : a.toLowerCase() === b.toLowerCase();
  if (
    !same(userId, expected.userId) ||
    !same(expected.organizationId ?? null, organizationId)
  )
    throw new EntitlementError("account-mismatch");
  const issuedAt = seconds(claims.iat),
    expiresAt = seconds(claims.exp);
  const notBefore = claims.nbf === undefined ? issuedAt : seconds(claims.nbf);
  if (
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_ENTITLEMENT_LIFETIME_MS
  )
    throw new EntitlementError("lifetime");
  if (notBefore - CLOCK_SKEW_MS > now || issuedAt - CLOCK_SKEW_MS > now)
    throw new EntitlementError("not-yet-valid");
  if (expiresAt <= now) throw new EntitlementError("expired");
  const plan = bag(claims.plan);
  if (!plan || !PLAN_STATUSES.includes(plan.status as PlanStatus))
    throw new EntitlementError("malformed");
  // `ver` only adds claims (a breaking change uses a new `typ`), so an
  // unreadable value is v1 and never blocks the plan state.
  const formatVersion =
    typeof claims.ver === "number" &&
    Number.isSafeInteger(claims.ver) &&
    claims.ver >= 1
      ? claims.ver
      : 1;
  let allowance: PlanAllowance | null = null;
  if (claims.allowance != null) {
    const row = bag(claims.allowance);
    if (
      !row ||
      !["requests", "tokens"].includes(row.unit as string) ||
      !["day", "week", "month"].includes(row.period as string)
    )
      throw new EntitlementError("malformed");
    const limit = count(row.limit),
      used = count(row.used);
    allowance = {
      unit: row.unit as AllowanceUnit,
      period: row.period as AllowancePeriod,
      limit,
      used,
      resetsAt: row.resetsAt == null ? null : seconds(row.resetsAt),
    };
  }
  if (formatVersion >= 2)
    allowance = periodAllowance(claims.plan_allowance) ?? allowance;
  if (
    claims.services !== undefined &&
    (!Array.isArray(claims.services) || claims.services.length > 16)
  )
    throw new EntitlementError("malformed");
  const services = ((claims.services as unknown[] | undefined) ?? []).map(
    (value) => text(value, 64),
  );
  // Refresh before expiry: Cloud may ask for an earlier refresh; otherwise at
  // three quarters of the lifetime.
  const suggested = claims.rfa === undefined ? null : seconds(claims.rfa);
  const fallback = issuedAt + Math.floor((expiresAt - issuedAt) * 0.75);
  const refreshAt =
    suggested !== null && suggested > issuedAt && suggested < expiresAt
      ? suggested
      : fallback;
  return {
    id: text(claims.jti, 128),
    keyId,
    issuer: expected.issuer,
    userId,
    organizationId,
    plan: {
      id: text(plan.id, 128),
      name: text(plan.name, 80),
      status: plan.status as PlanStatus,
    },
    allowance,
    formatVersion,
    services,
    issuedAt,
    expiresAt,
    refreshAt,
    ...(claims.plan_ends_at === undefined
      ? {}
      : {
          planEndsAt:
            claims.plan_ends_at === null ? null : seconds(claims.plan_ends_at),
        }),
  };
}

/** Full verification: ES256 signature against Cloud's published P-256 keys, then claims. */
export async function verifyEntitlement(
  token: string,
  keys: readonly JsonWebKey[],
  expected: EntitlementExpectation,
  now: number,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<SubscriptionEntitlement> {
  const { header, claims, signingInput, signature } = decodeEntitlement(token);
  if (header.alg !== "ES256") throw new EntitlementError("unsupported");
  const key = keys.find(
    (row) => (row as JsonWebKey & { kid?: string }).kid === header.kid,
  );
  if (!key) throw new EntitlementError("unknown-key");
  if (
    key.kty !== "EC" ||
    key.crv !== "P-256" ||
    key.d !== undefined ||
    signature.length !== 64
  )
    throw new EntitlementError("signature");
  let valid = false;
  try {
    const imported = await subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: key.x, y: key.y, ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    valid = await subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      imported,
      signature,
      new TextEncoder().encode(signingInput),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new EntitlementError("signature");
  return entitlementClaims(header, claims, expected, now);
}

/** What the owner sees. Built from verified Cloud data only. */
export type SubscriptionView =
  | { kind: "checking" }
  /** `source` 'billing-limits' is the unsigned billing snapshot used while the entitlement route is absent. */
  | {
      kind: "active";
      planName: string;
      status: "active" | "trialing" | "past_due";
      allowance: PlanAllowance | null;
      expiresAt: number;
      refreshFailed: boolean;
      planEndsAt?: number | null;
      source?: "billing-limits";
    }
  /** Cloud's explicit organization-credit billing mode: no subscription, every request still checked by Cloud. */
  | { kind: "credits"; source: "billing-limits" }
  | {
      kind: "inactive";
      planName: string | null;
      status: "canceled" | "none";
      source: "entitlement" | "billing-limits";
    }
  /** Billing status could not be read: an outage, no published plan source, or an invalid answer. */
  | { kind: "unavailable"; reason: "outage" | "not-published" | "invalid" }
  /** A previously verified entitlement lapsed while refresh kept failing. */
  | { kind: "expired"; planName: string };

export function subscriptionView(
  entitlement: SubscriptionEntitlement,
  refreshFailed = false,
): SubscriptionView {
  const { status, name } = entitlement.plan;
  if (status === "canceled" || status === "none")
    return {
      kind: "inactive",
      planName: status === "none" ? null : name,
      status,
      source: "entitlement",
    };
  return {
    kind: "active",
    planName: name,
    status,
    allowance: entitlement.allowance,
    expiresAt: entitlement.expiresAt,
    refreshFailed,
    ...(entitlement.planEndsAt === undefined
      ? {}
      : { planEndsAt: entitlement.planEndsAt }),
  };
}

/**
 * Names used in owner-facing copy. `serviceName` is the deployment's public
 * name (for example "Eliza Cloud"); `productName` is the application the
 * owner is using; `deviceNoun` names the device that keeps local data
 * ("phone"). None of them changes any decision.
 */
export interface SubscriptionCopy {
  serviceName?: string;
  productName?: string;
  deviceNoun?: string;
}
const serviceNameOf = (copy: SubscriptionCopy | undefined) =>
  copy?.serviceName ?? "Cloud";
const productNameOf = (copy: SubscriptionCopy | undefined) =>
  copy?.productName ?? "This app";
const deviceNounOf = (copy: SubscriptionCopy | undefined) =>
  copy?.deviceNoun ?? "device";

function clock(at: number): string {
  try {
    return new Date(at).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return new Date(at).toISOString();
  }
}
export function allowanceText(
  allowance: PlanAllowance | null,
  now: number = Date.now(),
  copy?: SubscriptionCopy,
): string {
  const serviceName = serviceNameOf(copy);
  if (!allowance) return `Plan allowance details are in ${serviceName}.`;
  if (allowance.unit === "usd_micros") {
    // Rounded down, so the client never shows more than Cloud reports.
    const reset =
      allowance.resetsAt > now ? ` Resets ${clock(allowance.resetsAt)}.` : "";
    if (allowance.remaining === 0)
      return `This billing period's plan allowance is used up.${reset}`;
    const percent = Math.floor((allowance.remaining * 100) / allowance.granted);
    return `${percent < 1 ? "Less than 1%" : `${percent}%`} of this billing period's plan allowance is left.${reset}`;
  }
  const per = `this ${allowance.period}`;
  const reset =
    allowance.resetsAt === null ? "" : ` Resets ${clock(allowance.resetsAt)}.`;
  if (allowance.limit !== null && allowance.used !== null)
    return `${Math.min(allowance.used, allowance.limit).toLocaleString()} of ${allowance.limit.toLocaleString()} ${allowance.unit} used ${per}.${reset}`;
  if (allowance.limit !== null)
    return `Allowance: ${allowance.limit.toLocaleString()} ${allowance.unit} per ${allowance.period}.${reset}`;
  if (allowance.used !== null)
    return `${allowance.used.toLocaleString()} ${allowance.unit} used ${per}.${reset}`;
  return `Plan allowance details are in ${serviceName}.${reset}`;
}
const LOCAL_KEEPS_WORKING = "Local apps keep working.";
export const MANAGE_PLAN_LABEL = "Manage plan";
export const CHOOSE_PLAN_LABEL = "Choose a plan";
/** What a plan gate does with a view. Only the gate decides; turns never read billing. */
export type PlanAdmission =
  | "admit"
  | "admit-with-warning"
  | "needs-plan"
  | "unknown";
export function planAdmission(
  view: SubscriptionView | null | undefined,
): PlanAdmission {
  if (!view || view.kind === "checking") return "unknown";
  if (view.kind === "credits") return "admit";
  if (view.kind === "active")
    return view.status === "past_due" ? "admit-with-warning" : "admit";
  if (view.kind === "inactive") return "needs-plan";
  return "unknown";
}
export interface SubscriptionDescription {
  headline: string;
  detail: string;
  manage: boolean;
  manageLabel: string;
}
export function describeSubscription(
  view: SubscriptionView | null | undefined,
  copy?: SubscriptionCopy,
): SubscriptionDescription {
  const serviceName = serviceNameOf(copy);
  const manageLabel = `Manage plan in ${serviceName}`;
  if (!view || view.kind === "checking")
    return {
      headline: "Checking your plan…",
      detail: "",
      manage: false,
      manageLabel,
    };
  switch (view.kind) {
    case "credits":
      return {
        headline: `${serviceName} credits`,
        detail: `Uses your ${serviceName} account balance.`,
        manage: true,
        manageLabel: `Manage billing in ${serviceName}`,
      };
    case "active":
      return {
        headline:
          view.status === "past_due"
            ? `${view.planName} · payment due`
            : view.status === "trialing"
              ? `${view.planName} · trial`
              : view.planName,
        detail: [
          view.source === "billing-limits"
            ? ""
            : allowanceText(view.allowance, Date.now(), copy),
          view.status === "past_due"
            ? `Payment is past due. Update payment in ${serviceName} to keep AI available.`
            : "",
          view.refreshFailed
            ? `Plan status could not be refreshed; ${serviceName} still decides each AI request.`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
        manage: view.status === "past_due",
        manageLabel,
      };
    case "inactive":
      return {
        headline:
          view.status === "canceled"
            ? `${view.planName ?? "Your plan"} has ended`
            : "No active plan",
        detail: `${productNameOf(copy)} needs an active ${serviceName} plan. Redeem a subscription code or choose a plan in ${serviceName}. Nothing is purchased automatically, and your data on this ${deviceNounOf(copy)} is kept.`,
        manage: true,
        manageLabel: CHOOSE_PLAN_LABEL,
      };
    case "expired":
      return {
        headline: view.planName,
        detail: `Plan status is out of date and could not be refreshed. ${serviceName} still decides each AI request. ${LOCAL_KEEPS_WORKING}`,
        manage: false,
        manageLabel,
      };
    case "unavailable":
      return {
        headline: "Plan status unavailable",
        detail:
          view.reason === "not-published"
            ? `${serviceName} did not report a plan for this account. Check again, redeem a subscription code or choose a plan. Your data on this ${deviceNounOf(copy)} is kept.`
            : `Plan status could not be checked right now. ${serviceName} still decides each AI request. ${LOCAL_KEEPS_WORKING}`,
        manage: false,
        manageLabel,
      };
  }
}

/** Ports the admission check uses; a host implements them over its authenticated transport. */
export interface EntitlementSource {
  /** `null` when Cloud has not deployed the entitlement route (404/405/501). */
  entitlement(signal: AbortSignal): Promise<string | null>;
  entitlementKeys(signal: AbortSignal): Promise<JsonWebKey[]>;
  /**
   * The billing snapshot's subscription section, read when the route is
   * absent or verifies no subscription. `null` when that snapshot is
   * unavailable or does not say.
   */
  fallbackPlan?(signal: AbortSignal): Promise<FallbackPlan | null>;
  readonly issuer: string;
  readonly audience?: string;
}
export type EntitlementCheck = {
  view: SubscriptionView;
  entitlement: SubscriptionEntitlement | null;
};
/** Plan state from the unsigned billing snapshot. Only known states are reported. */
export interface FallbackPlan {
  status: PlanStatus;
  planName: string | null;
  periodEnd: number | null;
  billingMode?: "organization-credits";
}
/** Cloud billing subscription states mapped to the entitlement's plan status. */
const BILLING_STATES: Readonly<Record<string, PlanStatus>> = {
  trialing: "trialing",
  active: "active",
  grace: "past_due",
  past_due: "past_due",
  unpaid: "past_due",
  canceled: "canceled",
  incomplete_expired: "canceled",
};
/** Public names of Cloud's catalog plan keys, for the unsigned snapshot (signed entitlements carry their own name). */
export const CLOUD_PLAN_NAMES: Readonly<Record<string, string>> = {
  plus_monthly: "Plus",
  pro_monthly: "Pro",
};
/**
 * Reads `data.v2.subscription` of GET /api/v1/billing/limits.
 * `not_applicable` means the organization has no subscription. Its explicit
 * no_organization_subscription reason selects organization-credit billing,
 * not an active plan. Pending, incomplete, paused, unavailable or malformed
 * answers return null: plan state is unknown and the gate asks to check
 * again.
 */
export function fallbackPlanFromLimits(value: unknown): FallbackPlan | null {
  const subscription = bag(bag(bag(bag(value)?.data)?.v2)?.subscription);
  if (!subscription) return null;
  if (subscription.status === "not_applicable")
    return {
      status: "none",
      planName: null,
      periodEnd: null,
      ...(subscription.reason === "no_organization_subscription"
        ? { billingMode: "organization-credits" as const }
        : {}),
    };
  const row =
    subscription.status === "available" ? bag(subscription.value) : null;
  if (
    !row ||
    typeof row.state !== "string" ||
    !Object.hasOwn(BILLING_STATES, row.state)
  )
    return null;
  const key = typeof row.planKey === "string" ? row.planKey : "";
  const end =
    typeof row.currentPeriodEnd === "string"
      ? Date.parse(row.currentPeriodEnd)
      : Number.NaN;
  return {
    status: BILLING_STATES[row.state],
    planName: Object.hasOwn(CLOUD_PLAN_NAMES, key)
      ? CLOUD_PLAN_NAMES[key]
      : null,
    periodEnd: Number.isFinite(end) ? end : null,
  };
}
/**
 * The organization credit balance from `data.v2.balance` of GET
 * /api/v1/billing/limits, for Cloud's explicit organization-credit billing
 * mode. It is a read-only account fact: never a top-up meter and never used
 * to admit AI. A balance that is missing, unavailable, observed more than
 * five minutes ago (or more than the clock skew in the future), from another
 * authority, negative, inexact or malformed is `unavailable`.
 */
export interface OrganizationCreditBalance {
  state: "zero" | "funded" | "unavailable";
  /** Exact base-10 USD amount as Cloud reported it; never a JavaScript number. */
  usd: string | null;
  observedAt: number | null;
}
/** How old a balance observation may be before it is no longer shown. */
export const CREDIT_BALANCE_MAX_AGE_MS = 5 * 60 * 1000;
export function organizationCreditFromLimits(
  payload: unknown,
  now: number = Date.now(),
): OrganizationCreditBalance {
  const unavailable: OrganizationCreditBalance = {
    state: "unavailable",
    usd: null,
    observedAt: null,
  };
  const root = bag(payload);
  const data = bag(root?.data);
  const observation = bag(bag(data?.v2)?.balance);
  const row = bag(observation?.value);
  const amount = bag(row?.balance);
  if (
    root?.success !== true ||
    data?.schemaVersion !== 2 ||
    observation?.status !== "available" ||
    observation.source !== "organizations" ||
    typeof observation.observedAt !== "string"
  )
    return unavailable;
  const at = Date.parse(observation.observedAt);
  if (
    !Number.isFinite(at) ||
    at > now + CLOCK_SKEW_MS ||
    now - at > CREDIT_BALANCE_MAX_AGE_MS ||
    typeof row?.revision !== "string" ||
    !/^\d+$/.test(row.revision)
  )
    return unavailable;
  if (
    amount?.unit !== "usd" ||
    amount.currency !== "USD" ||
    typeof amount.value !== "string" ||
    !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(amount.value)
  )
    return unavailable;
  return {
    state: /^0(?:\.0+)?$/.test(amount.value) ? "zero" : "funded",
    usd: amount.value,
    observedAt: at,
  };
}
const keyCache = new Map<string, { keys: JsonWebKey[]; fetchedAt: number }>();
/** Forgets cached public signing keys. Call it when the Cloud account is detached. */
export function clearEntitlementKeyCache(): void {
  keyCache.clear();
}
async function keysFor(
  source: EntitlementSource,
  kid: unknown,
  signal: AbortSignal,
  now: number,
): Promise<JsonWebKey[]> {
  const cached = keyCache.get(source.issuer);
  const known =
    cached &&
    now - cached.fetchedAt < KEY_CACHE_MS &&
    cached.keys.some(
      (key) => (key as JsonWebKey & { kid?: string }).kid === kid,
    );
  if (known) return cached.keys;
  const keys = (await source.entitlementKeys(signal)).slice(
    0,
    MAX_ENTITLEMENT_KEYS,
  );
  keyCache.set(source.issuer, { keys, fetchedAt: now });
  return keys;
}

/**
 * One entitlement read, used at admission and by the background refresher,
 * never per turn. Signals, authentication failures and account changes
 * propagate; every other failure becomes an explicit view.
 */
export async function checkEntitlement(
  source: EntitlementSource,
  expected: Omit<EntitlementExpectation, "issuer">,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<EntitlementCheck> {
  let token: string | null;
  try {
    token = await source.entitlement(signal);
  } catch (error) {
    signal.throwIfAborted();
    if (isAuthFailure(error)) throw error;
    return {
      view: { kind: "unavailable", reason: "outage" },
      entitlement: null,
    };
  }
  signal.throwIfAborted();
  let signed: EntitlementCheck | null = null;
  if (token !== null) {
    try {
      const { header } = decodeEntitlement(token);
      const keys = await keysFor(source, header.kid, signal, now());
      signal.throwIfAborted();
      const entitlement = await verifyEntitlement(
        token,
        keys,
        {
          ...expected,
          issuer: source.issuer,
          audience: source.audience ?? expected.audience,
        },
        now(),
      );
      signal.throwIfAborted();
      signed = { view: subscriptionView(entitlement), entitlement };
      // No subscription is distinct from canceled access. Cloud can still
      // bill this same authenticated organization through its existing
      // credit-funded mode.
      if (entitlement.plan.status !== "none") return signed;
    } catch (error) {
      signal.throwIfAborted();
      if (isAuthFailure(error)) throw error;
      if (
        error instanceof EntitlementError &&
        error.code === "account-mismatch"
      )
        throw error;
      return {
        view: {
          kind: "unavailable",
          reason: error instanceof EntitlementError ? "invalid" : "outage",
        },
        entitlement: null,
      };
    }
  }
  if (!source.fallbackPlan)
    return (
      signed ?? {
        view: { kind: "unavailable", reason: "not-published" },
        entitlement: null,
      }
    );
  let plan: FallbackPlan | null;
  try {
    plan = await source.fallbackPlan(signal);
    signal.throwIfAborted();
  } catch (error) {
    signal.throwIfAborted();
    if (isAuthFailure(error)) throw error;
    return (
      signed ?? {
        view: { kind: "unavailable", reason: "outage" },
        entitlement: null,
      }
    );
  }
  // Never turn a signed refusal into an unsigned active plan. Only the
  // canonical organization-credit mode can supplement a verified absence of
  // a subscription. The null entitlement keeps periodic billing refresh active.
  if (plan?.status === "none" && plan.billingMode === "organization-credits")
    return {
      view: { kind: "credits", source: "billing-limits" },
      entitlement: null,
    };
  if (signed) return signed;
  if (!plan)
    return {
      view: { kind: "unavailable", reason: "not-published" },
      entitlement: null,
    };
  if (plan.status === "canceled" || plan.status === "none")
    return {
      view: {
        kind: "inactive",
        planName: plan.status === "none" ? null : plan.planName,
        status: plan.status,
        source: "billing-limits",
      },
      entitlement: null,
    };
  return {
    view: {
      kind: "active",
      planName: plan.planName ?? "Cloud plan",
      status: plan.status,
      allowance: null,
      expiresAt: plan.periodEnd ?? 0,
      refreshFailed: false,
      source: "billing-limits",
    },
    entitlement: null,
  };
}
/** A refusal that means the signed-in account is no longer the one this client admitted. */
export function isEntitlementSignInFailure(error: unknown): boolean {
  return (
    isAuthFailure(error) ||
    (error instanceof EntitlementError && error.code === "account-mismatch")
  );
}
function isAuthFailure(error: unknown): boolean {
  // A signed entitlement expiring is billing freshness, not expired authentication.
  if (error instanceof EntitlementError) return false;
  const record = bag(error);
  return (
    !!record &&
    (record.status === 401 ||
      record.code === "credentials-missing" ||
      record.code === "expired" ||
      record.code === "account-changed")
  );
}

/** Delay until the next background refresh. Pure, so expiry/outage scheduling is testable. */
export function nextRefreshDelay(
  entitlement: SubscriptionEntitlement | null,
  now: number,
  failures: number,
): number | null {
  if (failures > 0)
    return Math.min(
      REFRESH_RETRY_MAX_MS,
      REFRESH_RETRY_MIN_MS * 2 ** Math.min(failures - 1, 10),
    );
  if (
    !entitlement ||
    entitlement.plan.status === "none" ||
    entitlement.plan.status === "canceled"
  )
    return null;
  // Cloud may return the same cached token after its refresh hint. Never spin at zero delay.
  return entitlement.refreshAt > now
    ? entitlement.refreshAt - now
    : REFRESH_RETRY_MIN_MS;
}

export interface RefresherTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}
export interface EntitlementRefresherOptions {
  check: (signal: AbortSignal) => Promise<EntitlementCheck>;
  onView: (view: SubscriptionView) => void;
  onAuthFailure?: (error: unknown) => void;
  timers?: RefresherTimers;
  /** The entitlement verified at admission, if any. */
  entitlement?: SubscriptionEntitlement | null;
  /** Admission used an active billing snapshot, which has no signed refresh hint. */
  fallbackActive?: boolean;
  /** The admission check failed transiently: retry in the background with backoff. */
  retry?: boolean;
}
/**
 * Background refresh. It runs off the chat path: a turn never waits for it,
 * and a failure only changes what the owner sees. Revocation reaches the
 * client on the next refresh; Cloud enforces it on the server immediately.
 */
export class EntitlementRefresher {
  private timer: unknown = null;
  private controller: AbortController | null = null;
  private failures = 0;
  private stopped = false;
  private readonly check: (signal: AbortSignal) => Promise<EntitlementCheck>;
  private readonly onView: (view: SubscriptionView) => void;
  private readonly onAuthFailure: (error: unknown) => void;
  private readonly timers: RefresherTimers;
  private entitlement: SubscriptionEntitlement | null;
  private fallbackActive = false;
  /** Plan name of a verified entitlement that lapsed while refresh kept failing. */
  private lapsedPlanName: string | null = null;
  constructor(options: EntitlementRefresherOptions) {
    this.check = options.check;
    this.onView = options.onView;
    this.onAuthFailure = options.onAuthFailure ?? (() => {});
    this.timers = options.timers ?? {
      setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
      clearTimeout: (handle) =>
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
    };
    this.entitlement = options.entitlement ?? null;
    this.fallbackActive = !this.entitlement && options.fallbackActive === true;
    if (options.retry && !this.entitlement) this.failures = 1;
    this.schedule();
  }
  get current(): SubscriptionEntitlement | null {
    return this.entitlement;
  }
  /** Checks again now (the owner returned to the app). Ignored while a check is in flight or after stop. */
  refreshNow(): void {
    if (this.stopped || this.controller) return;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    void this.run();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort(
      new DOMException("Entitlement refresh stopped", "AbortError"),
    );
    this.controller = null;
  }
  private schedule(): void {
    if (this.stopped) return;
    const now = this.timers.now();
    // A verified entitlement that lapses while refresh is failing is reported, not silently kept.
    if (
      this.entitlement &&
      this.failures > 0 &&
      this.entitlement.expiresAt <= now
    ) {
      this.lapsedPlanName = this.entitlement.plan.name;
      this.onView({ kind: "expired", planName: this.lapsedPlanName });
      this.entitlement = null;
    }
    let delay = nextRefreshDelay(this.entitlement, now, this.failures);
    if (delay === null && this.fallbackActive) delay = FALLBACK_REFRESH_MS;
    if (delay === null) return;
    if (this.entitlement && this.failures > 0)
      delay = Math.min(delay, Math.max(0, this.entitlement.expiresAt - now));
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
  }
  private async run(): Promise<void> {
    if (this.stopped) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const result = await this.check(controller.signal);
      if (this.stopped || controller.signal.aborted) return;
      if (result.entitlement) {
        this.fallbackActive = false;
        this.entitlement = result.entitlement;
        this.lapsedPlanName = null;
        this.failures = 0;
        this.onView(result.view);
      }
      // An active billing snapshot needs periodic refresh too: the owner can
      // cancel a plan while the app stays foregrounded, or Cloud can deploy
      // the signed entitlement route.
      else if (
        result.view.kind === "active" ||
        result.view.kind === "credits"
      ) {
        this.fallbackActive = true;
        this.entitlement = null;
        this.lapsedPlanName = null;
        this.failures = 0;
        this.onView(result.view);
      }
      // No plan or no published source remains terminal until the next explicit check.
      else if (
        result.view.kind === "inactive" ||
        (result.view.kind === "unavailable" &&
          result.view.reason === "not-published")
      ) {
        this.fallbackActive = false;
        this.entitlement = null;
        this.lapsedPlanName = null;
        this.failures = 0;
        this.onView(result.view);
        return;
      } else {
        this.failures++;
        if (this.entitlement && this.entitlement.expiresAt > this.timers.now())
          this.onView(subscriptionView(this.entitlement, true));
        // A lapsed plan stays reported as out of date until a check succeeds, never as a plain outage.
        else if (this.lapsedPlanName !== null)
          this.onView({ kind: "expired", planName: this.lapsedPlanName });
        else if (!this.entitlement) this.onView(result.view);
      }
    } catch (error) {
      if (this.stopped || controller.signal.aborted) return;
      this.onAuthFailure(error);
      this.stop();
      return;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
    this.schedule();
  }
}

/** A Cloud refusal the owner can act on. */
export interface ServiceLimit {
  kind:
    | "rate-limited"
    | "allowance-exhausted"
    | "subscription-required"
    | "billing-refused";
  retryAfterMs: number | null;
  resetsAt: number | null;
}
/** `rate_limit_error` is the Anthropic-style refusal type (wait only in `Retry-After`). */
const RATE_KINDS = new Set([
  "rate_limited",
  "rate-limited",
  "rate_limit_exceeded",
  "too_many_requests",
  "rate_limit_error",
]);
const ALLOWANCE_KINDS = new Set([
  "allowance_exhausted",
  "quota_exceeded",
  "usage_limit_reached",
]);
const SUBSCRIPTION_KINDS = new Set([
  "subscription_required",
  "subscription_inactive",
]);
/**
 * Billing refusals that do not say whether the plan is missing or its usage
 * is spent. The agent reports a Cloud 402 as ChatFailureKind
 * `insufficient_credits` (packages/contracts chat.ts); the name predates
 * subscriptions. A client never offers a purchase for it.
 */
const BILLING_KINDS = new Set([
  "insufficient_credits",
  "insufficient_quota",
  "payment_required",
]);
/** Longest period-allowance reset a relative wait may describe (a billing period plus slack). */
const MAX_PERIOD_RESET_MS = 400 * 86_400_000;
const DAY_MS = 86_400_000;
/**
 * Retry timing on one refusal row. `period` is true for allowance and billing
 * refusals, whose structured reset (`resetAt`/`resetsAt` as ISO 8601 or epoch,
 * or a `retryAfterSeconds` wait) is the billing-period allowance reset: a wait
 * longer than a day is kept as that reset instant instead of a countdown.
 * Rate limits keep the one-day countdown ceiling.
 */
function retryFields(
  row: Bag,
  now: number,
  period = false,
): { retryAfterMs: number | null; resetsAt: number | null } {
  const finite = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())
        ? Number(value)
        : null;
  const instant = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0)
      return value < 1e12 ? value * 1000 : value;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };
  let retryAfterMs: number | null = null;
  const ms = finite(row.retryAfterMs),
    secs = finite(row.retryAfterSeconds ?? row.retry_after ?? row.retryAfter);
  if (ms !== null) retryAfterMs = ms;
  else if (secs !== null) retryAfterMs = secs * 1000;
  // `retryAfter` may be the raw Retry-After header: seconds, or an HTTP date
  // (IMF-fixdate only; Date.parse accepts too much to trust any other form).
  const headerDate =
    typeof row.retryAfter === "string" &&
    /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      row.retryAfter.trim(),
    )
      ? row.retryAfter
      : undefined;
  const at = instant(row.retryAt ?? row.retry_at ?? headerDate);
  if (retryAfterMs === null && at !== null)
    retryAfterMs = Math.max(0, at - now);
  let resetsAt = instant(row.resetsAt ?? row.resetAt ?? row.reset_at);
  // `resetAfterSeconds` (chat terminalFailure.rateLimit) is the relative form
  // of the reset; an explicit reset instant wins. It is a reset, not a
  // countdown, so it is not day-capped.
  const resetSecs = finite(row.resetAfterSeconds);
  if (
    resetsAt === null &&
    resetSecs !== null &&
    resetSecs * 1000 <= MAX_PERIOD_RESET_MS
  )
    resetsAt = now + resetSecs * 1000;
  // A retry hint longer than a day is not presented as a countdown; for a
  // period allowance it is the reset instant when Cloud gave no explicit one.
  if (retryAfterMs !== null && retryAfterMs > DAY_MS) {
    if (period && resetsAt === null && retryAfterMs <= MAX_PERIOD_RESET_MS)
      resetsAt = now + retryAfterMs;
    retryAfterMs = null;
  }
  return { retryAfterMs, resetsAt };
}
/**
 * Reads a Cloud limit refusal from an HTTP error ({status,data,retryAfter}),
 * an agent reply's failureKind/terminalFailure, or a nested error body.
 * Returns null for anything else. Retry times in the body win; `retryAfter`
 * (the Retry-After header a transport returns) fills in when the body has
 * none.
 *
 * Agent replies carry the provider wait in terminalFailure.rateLimit
 * ({kind, retryAfterMs, planId?, scope?: burst|sustained|period, resetAt?,
 * resetAfterSeconds?}). Scope `period` is the plan allowance for the billing
 * period and reads as allowance-exhausted with its reset date; burst and
 * sustained stay rate limits with a countdown. Idempotent replays and history
 * omit the relative wait; absent timing stays absent.
 */
export function readServiceLimit(
  source: unknown,
  now: number = Date.now(),
): ServiceLimit | null {
  const visit = (
    value: unknown,
    depth: number,
    status: number | null,
  ): ServiceLimit | null => {
    const row = bag(value);
    if (!row || depth > 3) return null;
    const ownStatus = typeof row.status === "number" ? row.status : status;
    // A specific code (e.g. terminalFailure.code) wins over a generic kind on the same row.
    const kinds = [row.kind, row.failureKind, row.code, row.error, row.type]
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.toLowerCase());
    const has = (set: Set<string>) => kinds.some((item) => set.has(item));
    for (const key of [
      "terminalFailure",
      "rateLimit",
      "data",
      "error",
      "details",
    ]) {
      const nested = visit(row[key], depth + 1, ownStatus);
      if (nested) {
        const own = retryFields(row, now, nested.kind !== "rate-limited");
        // An exhausted period allowance with a known reset date is never refilled with an outer countdown.
        return {
          ...nested,
          retryAfterMs:
            nested.kind === "allowance-exhausted" && nested.resetsAt != null
              ? nested.retryAfterMs
              : (nested.retryAfterMs ?? own.retryAfterMs),
          resetsAt: nested.resetsAt ?? own.resetsAt,
        };
      }
    }
    let limit: ServiceLimit["kind"] | null = null;
    // An exhausted billing-period allowance arrives as terminalFailure.rateLimit
    // {kind:'rate_limited', scope:'period'}. Its retryAfterMs is capped at an
    // hour and is not the reset, so only resetAt/resetAfterSeconds describe
    // when the allowance returns.
    if (has(RATE_KINDS) && row.scope === "period")
      return {
        kind: "allowance-exhausted",
        retryAfterMs: null,
        resetsAt: retryFields(row, now, true).resetsAt,
      };
    if (has(ALLOWANCE_KINDS)) limit = "allowance-exhausted";
    else if (has(SUBSCRIPTION_KINDS)) limit = "subscription-required";
    else if (has(RATE_KINDS)) limit = "rate-limited";
    else if (has(BILLING_KINDS)) limit = "billing-refused";
    else if (ownStatus === 429 && depth === 0) limit = "rate-limited";
    else if (ownStatus === 402 && depth === 0) limit = "billing-refused";
    return limit
      ? { kind: limit, ...retryFields(row, now, limit !== "rate-limited") }
      : null;
  };
  return visit(source, 0, null);
}
export function retryDuration(ms: number): string {
  const secs = Math.max(1, Math.ceil(ms / 1000));
  if (secs < 90) return `about ${secs} second${secs === 1 ? "" : "s"}`;
  const minutes = Math.ceil(secs / 60);
  if (minutes < 90) return `about ${minutes} minutes`;
  return `about ${Math.ceil(minutes / 60)} hours`;
}
/** Owner-facing copy for a refusal. Nothing is retried, purchased or upgraded automatically. */
export function serviceLimitMessage(
  limit: ServiceLimit | null,
  now: number = Date.now(),
  copy?: SubscriptionCopy,
): string {
  const serviceName = serviceNameOf(copy),
    productName = productNameOf(copy);
  if (!limit || limit.kind === "rate-limited") {
    const wait =
      limit?.retryAfterMs != null
        ? `Try again in ${retryDuration(limit.retryAfterMs)}.`
        : limit?.resetsAt != null && limit.resetsAt > now
          ? `Try again in ${retryDuration(limit.resetsAt - now)}.`
          : "Wait a moment before sending again.";
    return `The AI request rate limit was reached. ${wait} ${productName} did not retry your message.`;
  }
  if (limit.kind === "allowance-exhausted") {
    const reset =
      limit.resetsAt != null && limit.resetsAt > now
        ? ` It resets ${clock(limit.resetsAt)}.`
        : limit.retryAfterMs != null
          ? ` It resets in ${retryDuration(limit.retryAfterMs)}.`
          : "";
    return `Your plan's AI allowance for this period is used up.${reset} Nothing is purchased automatically. ${LOCAL_KEEPS_WORKING}`;
  }
  // A structured period reset from the agent or Cloud is shown; without one the copy is unchanged.
  if (limit.kind === "billing-refused")
    return `${serviceName} declined this AI request for your account's billing.${limit.resetsAt != null && limit.resetsAt > now ? ` ${serviceName} reports your plan allowance resets ${clock(limit.resetsAt)}.` : ""} Check your account in Settings. ${productName} did not retry your message, and nothing is purchased automatically. ${LOCAL_KEEPS_WORKING}`;
  return `AI needs an active ${serviceName} plan. Manage your plan in ${serviceName}. Nothing is purchased automatically. ${LOCAL_KEEPS_WORKING}`;
}

/**
 * Subscription grant codes are 16 Crockford base32 characters (Cloud
 * normalizes the same way): case, spaces and hyphens are ignored, O reads as
 * 0 and I/L as 1. Returns null for text that cannot be a code, which is
 * refused with the same generic copy as an unknown code.
 */
export function normalizeSubscriptionCode(input: string): string | null {
  if (typeof input !== "string" || input.length > 128) return null;
  const normalized = input
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return /^[A-Z0-9]{16,64}$/.test(normalized) ? normalized : null;
}
export type RedeemFailureCode =
  | "invalid"
  | "already-redeemed"
  | "rate-limited"
  | "unavailable"
  | "account";
/** A refused or failed redemption. Never carries the code. */
export class SubscriptionRedeemError extends Error {
  readonly code: RedeemFailureCode;
  readonly retryAfterMs: number | null;
  constructor(code: RedeemFailureCode, retryAfterMs: number | null = null) {
    super(`Subscription code ${code}`);
    this.name = "SubscriptionRedeemError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
export interface RedeemResult {
  planEndsAt: number | null;
  replayed: boolean;
  grantEndsAt: number | null;
  paidPlanTakesPrecedence: boolean;
  planName: string | null;
}
/** Owner-facing redemption copy. Unknown, expired, disabled and used-up codes share one answer. */
export function redeemFailureMessage(
  error: unknown,
  copy?: SubscriptionCopy,
): string {
  const serviceName = serviceNameOf(copy);
  if (error instanceof SubscriptionRedeemError) {
    if (error.code === "invalid")
      return "This code could not be redeemed. Check the code and try again.";
    if (error.code === "already-redeemed")
      return "This account has already received this subscription. Check your plan again.";
    if (error.code === "rate-limited")
      return `Too many attempts. Try again in ${retryDuration(error.retryAfterMs ?? 60_000)}.`;
    if (error.code === "account")
      return `${serviceName} could not apply a code to this account. Check the account in ${serviceName}.`;
  }
  return "The code could not be redeemed right now. Try again.";
}
export function redeemSuccessMessage(result: RedeemResult): string {
  const until =
    result.grantEndsAt === null
      ? ""
      : ` It runs until ${new Date(result.grantEndsAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}.`;
  if (result.paidPlanTakesPrecedence)
    return `Code redeemed. Your current paid plan stays in effect; the code applies if that plan ends.${until}`;
  return `Code redeemed${result.planName ? ` for ${result.planName}` : ""}.${until}`;
}

/**
 * The compact JWS from a `GET /api/v1/subscription/entitlement` 200 body, or
 * null when the body is not a bounded entitlement.
 */
export function entitlementFromResponse(data: unknown): string | null {
  const entitlement = bag(data)?.entitlement;
  return typeof entitlement === "string" &&
    entitlement.length > 0 &&
    entitlement.length <= MAX_ENTITLEMENT_LENGTH
    ? entitlement
    : null;
}
/**
 * Public EC P-256 verification keys from a
 * `GET /api/v1/subscription/entitlement-keys` body. Private material and
 * other key types are dropped. Null when the body is not a bounded key set.
 */
export function entitlementKeysFromResponse(
  data: unknown,
): JsonWebKey[] | null {
  const keys = bag(data)?.keys;
  if (!Array.isArray(keys) || keys.length > MAX_ENTITLEMENT_KEYS) return null;
  return keys.filter((key): key is JsonWebKey => {
    const row = bag(key);
    return (
      !!row &&
      row.kty === "EC" &&
      row.crv === "P-256" &&
      row.d === undefined &&
      typeof row.kid === "string" &&
      typeof row.x === "string" &&
      typeof row.y === "string"
    );
  });
}
/**
 * Maps an HTTP refusal of `POST /api/v1/subscription/redeem` to the owner's
 * error. Returns null for 401: the caller treats it as a rejected sign-in.
 */
export function redeemFailureForStatus(
  status: number,
  body: unknown,
  retryAfter?: string | null,
): SubscriptionRedeemError | null {
  if (status === 401) return null;
  if (status === 400) return new SubscriptionRedeemError("invalid");
  if (status === 409)
    return new SubscriptionRedeemError(
      bag(body)?.code === "subscription_grant_already_redeemed"
        ? "already-redeemed"
        : "invalid",
    );
  if (status === 429)
    return new SubscriptionRedeemError(
      "rate-limited",
      readServiceLimit({ status, data: body, retryAfter })?.retryAfterMs ??
        null,
    );
  if (status === 403) return new SubscriptionRedeemError("account");
  return new SubscriptionRedeemError("unavailable");
}
/**
 * Reads a successful redemption body. The account window uses Cloud's
 * `effectiveUntil`; a grant end is used only when no paid plan takes
 * precedence and Cloud supplies no effective end. A revoked replay is
 * refused, never reported as redeemed.
 */
export function redeemResultFromResponse(data: unknown): RedeemResult {
  const body = bag(data);
  const grant = bag(body?.grant);
  if (body?.success !== true || !grant || typeof body.replayed !== "boolean")
    throw new SubscriptionRedeemError("unavailable");
  if (grant.revoked === true) throw new SubscriptionRedeemError("invalid");
  const endsAt =
    typeof grant.endsAt === "string" ? Date.parse(grant.endsAt) : Number.NaN;
  const summary = bag(body.entitlement);
  const planName = displayText(bag(summary?.plan)?.name, 80);
  const until =
    typeof summary?.effectiveUntil === "string"
      ? Date.parse(summary.effectiveUntil)
      : Number.NaN;
  const paidPlanTakesPrecedence = grant.paidPlanTakesPrecedence === true;
  return {
    planEndsAt: Number.isFinite(until)
      ? until
      : paidPlanTakesPrecedence || !Number.isFinite(endsAt)
        ? null
        : endsAt,
    replayed: body.replayed,
    grantEndsAt: Number.isFinite(endsAt) ? endsAt : null,
    paidPlanTakesPrecedence,
    planName,
  };
}

/**
 * One account panel's plan facts, for the shared settings/account surface.
 * Every value comes from the view, a verified entitlement or a Cloud refusal.
 */
export interface SubscriptionSummary extends SubscriptionDescription {
  /** The plan's allowance line, when Cloud reported one for an active signed plan. */
  allowance: string | null;
  /** End of the plan window when Cloud reported it. */
  planEndsAt: number | null;
  /** Copy for the most recent Cloud refusal that still applies, with its retry time. */
  limit: string | null;
  /** The admission decision for this view. */
  admission: PlanAdmission;
}
export function subscriptionSummary(
  view: SubscriptionView | null | undefined,
  options: {
    planEndsAt?: number | null;
    lastLimit?: ServiceLimit | null;
    /** When the last limit was observed; a countdown that has passed is not shown. */
    lastLimitAt?: number | null;
    now?: number;
    copy?: SubscriptionCopy;
  } = {},
): SubscriptionSummary {
  const now = options.now ?? Date.now();
  const description = describeSubscription(view, options.copy);
  const allowance =
    view?.kind === "active" &&
    view.source !== "billing-limits" &&
    view.allowance
      ? allowanceText(view.allowance, now, options.copy)
      : null;
  const planEndsAt =
    options.planEndsAt ??
    (view?.kind === "active"
      ? (view.planEndsAt ??
        (view.source === "billing-limits" && view.expiresAt > 0
          ? view.expiresAt
          : null))
      : null);
  const limit = options.lastLimit ?? null;
  const observedAt = options.lastLimitAt ?? now;
  const elapsed = Math.max(0, now - observedAt);
  // A rate-limit wait that has passed no longer applies; a reset still in the future does.
  const current =
    limit &&
    ((limit.retryAfterMs !== null && limit.retryAfterMs > elapsed) ||
      (limit.resetsAt !== null && limit.resetsAt > now) ||
      (limit.retryAfterMs === null &&
        limit.resetsAt === null &&
        elapsed < 60_000))
      ? {
          ...limit,
          // Only the part of the wait still ahead is shown. A countdown that
          // has run out leaves the reset (when one is still ahead) to say when.
          retryAfterMs:
            limit.retryAfterMs === null || limit.retryAfterMs <= elapsed
              ? null
              : limit.retryAfterMs - elapsed,
        }
      : null;
  return {
    ...description,
    allowance,
    planEndsAt,
    limit: current ? serviceLimitMessage(current, now, options.copy) : null,
    admission: planAdmission(view),
  };
}

/**
 * Milliseconds until the summary line for a shown Cloud limit changes or
 * lapses: its wait ends, its reset passes, or (with neither) the one-minute
 * notice window closes. Bounded to between one second and one hour so a
 * surface re-renders at those moments only, never as a per-second countdown.
 * Null when nothing about the limit is still ahead.
 */
export function serviceLimitNextChange(
  limit: ServiceLimit,
  observedAt: number,
  now: number = Date.now(),
): number | null {
  const points = [
    limit.retryAfterMs !== null ? observedAt + limit.retryAfterMs : null,
    limit.resetsAt,
    limit.retryAfterMs === null && limit.resetsAt === null
      ? observedAt + 60_000
      : null,
  ].filter((at): at is number => at !== null && at > now);
  return points.length
    ? Math.min(3_600_000, Math.max(1000, Math.min(...points) - now))
    : null;
}
