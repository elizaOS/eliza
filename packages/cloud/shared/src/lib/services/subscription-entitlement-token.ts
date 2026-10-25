/**
 * Issues the short-lived signed subscription entitlement read by native
 * clients (the Alpha Phone contract): a compact ES256 JWS of the caller's
 * current plan state. The token only presents plan state; Cloud still
 * authorizes every inference request from its own policy.
 *
 * Signing keys come from Worker secrets and fail closed when absent:
 *   ELIZA_ENTITLEMENT_SIGNING_KEY            base64 PKCS#8 P-256 private key (PEM body or full PEM)
 *   ELIZA_ENTITLEMENT_SIGNING_KEY_ID         kid of that key
 *   ELIZA_ENTITLEMENT_PREVIOUS_PUBLIC_KEY    optional base64 SPKI public key kept published after rotation
 *   ELIZA_ENTITLEMENT_PREVIOUS_KEY_ID        kid of the previous key (set together with the key)
 *   ELIZA_ENTITLEMENT_NEXT_PUBLIC_KEY        optional base64 SPKI public key published before it signs
 *   ELIZA_ENTITLEMENT_NEXT_KEY_ID            kid of the next key (set together with the key)
 *   ELIZA_ENTITLEMENT_ISSUER                 exact API origin clients expect as `iss`
 *
 * Rotation: (1) publish the new public key as NEXT and wait longer than the
 * key-set cache (ENTITLEMENT_KEYS_MAX_AGE_SECONDS); (2) make it the signing key
 * and move the old public key to PREVIOUS, clearing NEXT; (3) clear PREVIOUS
 * after the old tokens expire (ENTITLEMENT_LIFETIME_SECONDS).
 *
 * Format versions (`ver` claim; the `typ` header stays the same, so changes
 * are additive and a client ignores claims it does not know):
 *   v1 (no `ver`)  plan, services
 *   v2             adds `plan_allowance` when the plan has a current
 *                  allowance period. Cloud keeps allowance in US dollars, so
 *                  the claim states its unit (`usd_micros`, integer millionths
 *                  of a dollar). It is a new claim name because v1 clients
 *                  reject an `allowance` claim whose unit is not requests or
 *                  tokens.
 * A breaking change needs a new `typ`, which old clients refuse explicitly.
 */

import { eq } from "drizzle-orm";
import { exportJWK, importPKCS8, importSPKI, type JWK, SignJWT } from "jose";
import { dbWrite } from "../../db/client";
import {
  observeSubscriptionAllowanceEligibility,
  readEligibleSubscriptionAllowance,
} from "../../db/repositories/subscription-allowance-eligibility";
import { moneyToMicros } from "../../db/repositories/subscription-funding-reservations";
import {
  type BillingSubscriptionStatus,
  billingSubscriptions,
} from "../../db/schemas/billing-subscriptions";
import { subscriptionGrants } from "../../db/schemas/subscription-grants";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { readOrganizationQuotaPolicyInTransaction } from "./organization-quota-policy";
import { resolveSubscriptionPlanDefinition } from "./subscription-catalog";

export const ENTITLEMENT_TYPE = "eliza-entitlement+jwt";
export const ENTITLEMENT_AUDIENCE = "eliza-alpha-phone";
/** Current claim-set version (see the format note above). */
export const ENTITLEMENT_FORMAT_VERSION = 2;
/** Client ceiling is 60 minutes; Cloud issues well inside it. */
export const ENTITLEMENT_LIFETIME_SECONDS = 30 * 60;
/** Cache lifetime of the published key set (GET /entitlement-keys). */
export const ENTITLEMENT_KEYS_MAX_AGE_SECONDS = 60;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export type EntitlementPlanStatus = "active" | "trialing" | "past_due" | "canceled" | "none";

export interface EntitlementPlanSummary {
  plan: { id: string; name: string; status: EntitlementPlanStatus };
  /** What currently serves the plan: a paid subscription, a grant code, or nothing. */
  source: "subscription" | "grant" | "none";
  /** End of the current effective window, when one is known. */
  effectiveUntil: Date | null;
  /** Current allowance period; null or absent when there is none or it was not read. */
  allowance?: EntitlementPlanAllowance | null;
  /** Rate tier of the policy that admits inference; keys the plan request buckets. */
  rateTier?: string | null;
}

/**
 * The current allowance period in Cloud's own unit. Amounts are integer
 * millionths of a US dollar (the allowance columns are numeric(16,6) USD).
 */
export interface EntitlementPlanAllowance {
  unit: "usd_micros";
  /** Granted for the period, adjustments included. */
  granted: number;
  /** Not yet spent or reserved: amounts Cloud holds for requests in flight are excluded. */
  remaining: number;
  periodStart: Date;
  /** Period end. Unused allowance does not roll over. */
  resetsAt: Date;
}

export class EntitlementSigningUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntitlementSigningUnavailableError";
  }
}

interface SigningConfig {
  issuer: string;
  kid: string;
  privateKey: CryptoKey;
  keys: JWK[];
}

let cachedConfig: { source: string; config: SigningConfig } | null = null;

function decodePem(value: string, type: "PRIVATE" | "PUBLIC"): string {
  const trimmed = value.trim();
  if (trimmed.includes("-----BEGIN")) return trimmed;
  const decoded = Buffer.from(trimmed, "base64").toString("utf8");
  if (decoded.includes("-----BEGIN")) return decoded;
  const label = type === "PRIVATE" ? "PRIVATE KEY" : "PUBLIC KEY";
  return `-----BEGIN ${label}-----\n${trimmed}\n-----END ${label}-----`;
}

function publicJwk(jwk: JWK, kid: string): JWK {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y)
    throw new EntitlementSigningUnavailableError("Entitlement keys must be EC P-256");
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, kid, alg: "ES256", use: "sig" };
}

function requiredIssuer(value: string | undefined): string {
  if (!value)
    throw new EntitlementSigningUnavailableError("ELIZA_ENTITLEMENT_ISSUER is not configured");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EntitlementSigningUnavailableError("ELIZA_ENTITLEMENT_ISSUER is not a URL");
  }
  if (url.origin !== value || (url.protocol !== "https:" && url.hostname !== "localhost"))
    throw new EntitlementSigningUnavailableError(
      "ELIZA_ENTITLEMENT_ISSUER must be an exact origin",
    );
  return value;
}

/** Loads the signing configuration, or throws EntitlementSigningUnavailableError. */
export async function loadEntitlementSigningConfig(
  env: NodeJS.ProcessEnv = getCloudAwareEnv(),
): Promise<SigningConfig> {
  const privateKey = env.ELIZA_ENTITLEMENT_SIGNING_KEY;
  const kid = env.ELIZA_ENTITLEMENT_SIGNING_KEY_ID;
  const previousKey = env.ELIZA_ENTITLEMENT_PREVIOUS_PUBLIC_KEY;
  const previousKid = env.ELIZA_ENTITLEMENT_PREVIOUS_KEY_ID;
  const nextKey = env.ELIZA_ENTITLEMENT_NEXT_PUBLIC_KEY;
  const nextKid = env.ELIZA_ENTITLEMENT_NEXT_KEY_ID;
  const issuer = requiredIssuer(env.ELIZA_ENTITLEMENT_ISSUER);
  if (!privateKey || !kid)
    throw new EntitlementSigningUnavailableError("Entitlement signing key is not configured");
  if (!KEY_ID_PATTERN.test(kid))
    throw new EntitlementSigningUnavailableError("ELIZA_ENTITLEMENT_SIGNING_KEY_ID is invalid");
  if (Boolean(previousKey) !== Boolean(previousKid))
    throw new EntitlementSigningUnavailableError(
      "Previous entitlement key and key id must be set together",
    );
  if (previousKid && (!KEY_ID_PATTERN.test(previousKid) || previousKid === kid))
    throw new EntitlementSigningUnavailableError("ELIZA_ENTITLEMENT_PREVIOUS_KEY_ID is invalid");
  if (Boolean(nextKey) !== Boolean(nextKid))
    throw new EntitlementSigningUnavailableError(
      "Next entitlement key and key id must be set together",
    );
  if (nextKid && (!KEY_ID_PATTERN.test(nextKid) || nextKid === kid || nextKid === previousKid))
    throw new EntitlementSigningUnavailableError("ELIZA_ENTITLEMENT_NEXT_KEY_ID is invalid");
  const source = [
    issuer,
    kid,
    privateKey,
    previousKid ?? "",
    previousKey ?? "",
    nextKid ?? "",
    nextKey ?? "",
  ].join("\0");
  if (cachedConfig?.source === source) return cachedConfig.config;
  let config: SigningConfig;
  try {
    const signing = await importPKCS8(decodePem(privateKey, "PRIVATE"), "ES256", {
      extractable: true,
    });
    const keys = [publicJwk(await exportJWK(signing), kid)];
    if (previousKey && previousKid) {
      const previous = await importSPKI(decodePem(previousKey, "PUBLIC"), "ES256", {
        extractable: true,
      });
      keys.push(publicJwk(await exportJWK(previous), previousKid));
    }
    // Published ahead of its first signature, so cached key sets already hold it.
    if (nextKey && nextKid) {
      const next = await importSPKI(decodePem(nextKey, "PUBLIC"), "ES256", {
        extractable: true,
      });
      keys.push(publicJwk(await exportJWK(next), nextKid));
    }
    config = { issuer, kid, privateKey: signing, keys };
  } catch (error) {
    if (error instanceof EntitlementSigningUnavailableError) throw error;
    // error-policy:J2 malformed key material is a configuration outage, never a token.
    throw new EntitlementSigningUnavailableError("Entitlement signing key could not be loaded");
  }
  cachedConfig = { source, config };
  return config;
}

/** Public verification keys: the current key first, then the previous and next keys during rotation. */
export async function publishedEntitlementKeys(
  env: NodeJS.ProcessEnv = getCloudAwareEnv(),
): Promise<{ keys: JWK[] }> {
  return { keys: (await loadEntitlementSigningConfig(env)).keys };
}

const PLAN_NAMES: Record<string, string> = { free: "Free" };
function planName(planKey: string, catalogVersion: string | null): string {
  if (planKey === "plus_monthly" || planKey === "pro_monthly")
    return resolveSubscriptionPlanDefinition(planKey, catalogVersion ?? "v1").name;
  return PLAN_NAMES[planKey] ?? planKey;
}

/**
 * Client plan status for a paid subscription. `funded` is false when the
 * policy already serves the organization as free (a lapsed period).
 */
export function entitlementStatusForSubscription(
  status: BillingSubscriptionStatus,
  funded: boolean,
): EntitlementPlanStatus {
  switch (status) {
    case "active":
      return funded ? "active" : "past_due";
    case "trialing":
      return funded ? "trialing" : "past_due";
    case "grace":
    case "past_due":
      return "past_due";
    case "unpaid":
    case "canceled":
    case "incomplete_expired":
    case "paused":
      return "canceled";
    case "incomplete":
    case "pending":
      return "none";
  }
}

/**
 * Reads the organization's current plan state from the same policy that admits
 * inference. With `allowance`, it also reads the current allowance period.
 */
export async function readOrganizationEntitlementSummary(
  organizationId: string,
  options: { allowance?: boolean } = {},
): Promise<EntitlementPlanSummary> {
  return dbWrite.transaction(
    async (tx) => {
      const policy = await readOrganizationQuotaPolicyInTransaction(tx, organizationId);
      const until = policy.authority.effectiveUntil
        ? new Date(policy.authority.effectiveUntil)
        : null;
      const rateTier = policy.tier.status === "available" ? policy.tier.value.tierName : null;
      let summary: EntitlementPlanSummary | null = null;
      if (policy.authority.source === "promo_grant" && policy.authority.sourceGrantId) {
        const [grant] = await tx
          .select({
            plan_key: subscriptionGrants.plan_key,
            catalog_version: subscriptionGrants.catalog_version,
          })
          .from(subscriptionGrants)
          .where(eq(subscriptionGrants.id, policy.authority.sourceGrantId));
        if (grant)
          summary = {
            plan: {
              id: grant.plan_key,
              name: planName(grant.plan_key, grant.catalog_version),
              status: "active",
            },
            source: "grant",
            effectiveUntil: until,
          };
      }
      if (
        !summary &&
        policy.authority.source === "subscription" &&
        policy.authority.sourceSubscriptionId
      ) {
        const [subscription] = await tx
          .select({
            status: billingSubscriptions.status,
            plan_key: billingSubscriptions.plan_key,
            catalog_version: billingSubscriptions.catalog_version,
          })
          .from(billingSubscriptions)
          .where(eq(billingSubscriptions.id, policy.authority.sourceSubscriptionId));
        if (subscription)
          summary = {
            plan: {
              id: subscription.plan_key,
              name: planName(subscription.plan_key, subscription.catalog_version),
              status: entitlementStatusForSubscription(
                subscription.status,
                policy.subscriptionFunded,
              ),
            },
            source: "subscription",
            effectiveUntil: until,
          };
      }
      if (!summary)
        return {
          plan: { id: "free", name: planName("free", null), status: "none" },
          source: "none",
          effectiveUntil: null,
          rateTier,
        };
      if (!options.allowance || !policy.subscriptionFunded) return { ...summary, rateTier };
      const eligibility = await observeSubscriptionAllowanceEligibility(
        tx,
        organizationId,
        new Date(policy.observedAt),
        policy,
      );
      if (eligibility.status === "unavailable") {
        // An allowance that needs reconciliation is not shown; the plan state
        // is still reported and Cloud still decides each request.
        logger.warn("[SubscriptionEntitlement] Allowance not reported", {
          organizationId,
          code: eligibility.code,
        });
        return { ...summary, rateTier, allowance: null };
      }
      const period = eligibility.period;
      return { ...summary, rateTier, allowance: period ? allowanceFromPeriod(period) : null };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

function allowanceFromPeriod(period: {
  granted_amount: string;
  adjustment_amount: string;
  available_amount: string;
  period_start: Date;
  expires_at: Date;
}): EntitlementPlanAllowance | null {
  const granted =
    moneyToMicros(period.granted_amount, "granted_amount") +
    moneyToMicros(period.adjustment_amount, "adjustment_amount");
  const remaining = moneyToMicros(period.available_amount, "available_amount");
  // numeric(16,6) can exceed a JSON-safe integer; such an allowance is not reported.
  if (granted > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return {
    unit: "usd_micros",
    granted: Number(granted),
    remaining: Number(remaining),
    periodStart: period.period_start,
    resetsAt: period.expires_at,
  };
}

/**
 * For a refused subscriber request: null when the organization is not served
 * by a plan (subscription or grant); otherwise when its current allowance
 * period ends, if known.
 */
export async function readAllowanceExhaustion(
  organizationId: string,
): Promise<{ resetsAt: Date | null } | null> {
  return dbWrite.transaction(
    async (tx) => {
      const policy = await readOrganizationQuotaPolicyInTransaction(tx, organizationId);
      if (!policy.subscriptionFunded) return null;
      const period = await readEligibleSubscriptionAllowance(
        tx,
        organizationId,
        new Date(policy.observedAt),
        false,
        policy,
      );
      // A bucket that still has allowance did not cause the refusal: the
      // request estimate exceeded allowance plus credits.
      if (period && Number(period.available_amount) > 0) return null;
      const until = policy.authority.effectiveUntil;
      return { resetsAt: period?.expires_at ?? (until ? new Date(until) : null) };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export interface SignEntitlementInput {
  userId: string;
  organizationId: string | null;
  summary: EntitlementPlanSummary;
  now?: number;
  jti?: string;
}

/** Signs one compact JWS for the client contract. Throws EntitlementSigningUnavailableError. */
export async function signSubscriptionEntitlement(
  input: SignEntitlementInput,
  env: NodeJS.ProcessEnv = getCloudAwareEnv(),
): Promise<string> {
  const config = await loadEntitlementSigningConfig(env);
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  let exp = iat + ENTITLEMENT_LIFETIME_SECONDS;
  // Expire with the plan window so a client sees a plan change promptly. The
  // token never outlives the window it reports (one second is the floor, so
  // exp stays after iat).
  // The same holds for the allowance period, whose figures are void after it resets.
  const allowance = input.summary.allowance ?? null;
  for (const end of [input.summary.effectiveUntil, allowance?.resetsAt]) {
    const until = end ? Math.floor(end.getTime() / 1000) : null;
    if (until !== null && until < exp) exp = Math.max(until, iat + 1);
  }
  const rfa = iat + Math.floor((exp - iat) / 2);
  const claims: Record<string, unknown> = {
    ver: ENTITLEMENT_FORMAT_VERSION,
    org: input.organizationId ?? undefined,
    rfa,
    plan: input.summary.plan,
    services: ["inference"],
  };
  if (allowance)
    claims.plan_allowance = {
      unit: allowance.unit,
      granted: allowance.granted,
      remaining: allowance.remaining,
      periodStart: Math.floor(allowance.periodStart.getTime() / 1000),
      resetsAt: Math.floor(allowance.resetsAt.getTime() / 1000),
    };
  if (input.organizationId === null) delete claims.org;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", typ: ENTITLEMENT_TYPE, kid: config.kid })
    .setIssuer(config.issuer)
    .setAudience(ENTITLEMENT_AUDIENCE)
    .setSubject(input.userId)
    .setJti(input.jti ?? crypto.randomUUID())
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(config.privateKey);
}

/** Test hook: forget the parsed key material. */
export function __resetEntitlementSigningCacheForTests(): void {
  cachedConfig = null;
}
