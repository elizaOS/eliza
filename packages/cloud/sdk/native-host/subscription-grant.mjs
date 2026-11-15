/**
 * Subscription grant codes and the grant they give, read from Cloud answers.
 *
 * This file is the one implementation. It has no dependencies, so a device
 * host that stages only `.mjs` files can import it. `src/subscription-entitlement.ts`
 * re-exports it, and `subscription-grant.d.mts` holds its types; each export
 * below is annotated with its declared type so `tsc -p native-host` checks
 * this file against them.
 *
 * Nothing here decides that a plan exists. Every value comes from Cloud's
 * redemption answer (`POST /api/v1/subscription/redeem`) or the account
 * billing snapshot (`GET /api/v1/billing/limits`, `data.v2.grant`). A missing
 * or unreadable grant is `unknown`, never "no grant". The device clock can
 * only end a grant early, never extend it.
 */

/** @import * as Types from "./subscription-grant.mjs" */

/** @type {(value: unknown) => Record<string, unknown> | null} */
const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;

/** An exact UTC instant as Cloud writes it, normalized to milliseconds. */
/** @type {(value: unknown) => string | null} */
const instant = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;

/** A six-decimal USD amount from the Cloud ledger. */
/** @type {(value: unknown) => string | null} */
const usd = (value) =>
  typeof value === "string" && /^(0|[1-9][0-9]{0,9})\.[0-9]{6}$/.test(value)
    ? value
    : null;

/**
 * @param {unknown} value
 * @param {readonly string[] | undefined} planKeys
 * @returns {value is string}
 */
function planKeyOf(value, planKeys) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    (!planKeys || planKeys.includes(value))
  );
}

/**
 * Subscription grant codes are 16 Crockford base32 characters (Cloud
 * normalizes the same way): case, spaces and hyphens are ignored, O reads as
 * 0 and I/L as 1. Returns null for text that cannot be a code, which is
 * refused with the same generic copy as an unknown code.
 * @type {typeof Types.normalizeSubscriptionCode}
 */
export function normalizeSubscriptionCode(input) {
  if (typeof input !== "string" || input.length > 128) return null;
  const normalized = input
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return /^[A-Z0-9]{16,64}$/.test(normalized) ? normalized : null;
}

/**
 * The redemption failure for an HTTP refusal of
 * `POST /api/v1/subscription/redeem`. Null for 401: the caller treats it as
 * a rejected sign-in. A 409 that is not a known grant refusal (for example an
 * idempotency conflict) is `invalid`.
 * @type {typeof Types.redeemFailureCode}
 */
export function redeemFailureCode(status, body) {
  if (status === 401) return null;
  if (status === 400) return "invalid";
  if (status === 409) {
    const code = record(body)?.code;
    if (code === "subscription_grant_already_redeemed")
      return "already-redeemed";
    if (code === "subscription_grant_paid_plan_active")
      return "paid-plan-active";
    return "invalid";
  }
  if (status === 429) return "rate-limited";
  if (status === 403) return "account";
  return "unavailable";
}

/**
 * Reads a successful redemption body strictly. A replay reports the original
 * grant even after it was revoked or its window ended: that is `ended`, never
 * a new redemption. Null when the body is not a complete grant (a plan key
 * outside `planKeys`, a missing or unordered window). `endsAt` null is a
 * lifetime grant.
 * @type {typeof Types.redeemedSubscriptionGrant}
 */
export function redeemedSubscriptionGrant(data, options = {}) {
  const now = options.now ?? Date.now();
  const body = record(data),
    grant = record(body?.grant);
  if (body?.success !== true || !grant || typeof body.replayed !== "boolean")
    return null;
  const startsAt = instant(grant.startsAt),
    endsAt = grant.endsAt === null ? null : instant(grant.endsAt);
  if (
    !planKeyOf(grant.planKey, options.planKeys) ||
    !startsAt ||
    (endsAt === null && grant.endsAt !== null) ||
    (endsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt)) ||
    (grant.revoked !== undefined && typeof grant.revoked !== "boolean")
  )
    return null;
  if (grant.revoked === true || (endsAt !== null && Date.parse(endsAt) <= now))
    return { status: "ended" };
  return {
    status: "redeemed",
    replayed: body.replayed,
    grant: {
      planKey: grant.planKey,
      startsAt,
      endsAt,
      paidPlanTakesPrecedence: grant.paidPlanTakesPrecedence === true,
    },
  };
}

/**
 * The account's active subscription grant from a `GET /api/v1/billing/limits`
 * body (`data.v2.grant`). `active` only while the grant's end is after both
 * Cloud's snapshot clock and `now`. `none` when Cloud says there is no active
 * grant, or the grant has ended. `unknown` when the observation is absent (a
 * Cloud that predates grant readback), unavailable or not readable. An
 * unreadable allowance is null; the grant itself stays readable.
 * @type {typeof Types.subscriptionGrantFromSnapshot}
 */
export function subscriptionGrantFromSnapshot(snapshot, options = {}) {
  const now = options.now ?? Date.now();
  const v2 = record(record(record(snapshot)?.data)?.v2);
  const observation = record(v2?.grant);
  if (!v2 || !observation) return { status: "unknown" };
  if (
    observation.status === "not_applicable" &&
    observation.reason === "no_active_subscription_grant"
  )
    return { status: "none" };
  if (observation.status !== "available") return { status: "unknown" };
  const grant = record(observation.value);
  const observed = instant(v2.snapshotCompletedAt),
    startsAt = instant(grant?.startsAt),
    endsAt = grant?.endsAt === null ? null : instant(grant?.endsAt);
  if (
    !grant ||
    !observed ||
    !startsAt ||
    typeof grant.grantId !== "string" ||
    !grant.grantId ||
    !planKeyOf(grant.planKey, options.planKeys) ||
    typeof grant.paidPlanTakesPrecedence !== "boolean" ||
    (endsAt === null && grant.endsAt !== null) ||
    (endsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt))
  )
    return { status: "unknown" };
  if (
    endsAt !== null &&
    Date.parse(endsAt) <= Math.max(Date.parse(observed), now)
  )
    return { status: "none" };
  let allowance = null;
  const bucket = record(grant.allowance);
  const value = bucket?.status === "available" ? record(bucket.value) : null;
  if (value) {
    const periodStart = instant(value.periodStart),
      periodEnd = instant(value.periodEnd),
      granted = usd(value.granted),
      unreserved = usd(value.unreserved);
    if (
      periodStart &&
      periodEnd &&
      granted &&
      unreserved &&
      value.currency === "USD" &&
      Date.parse(periodStart) < Date.parse(periodEnd)
    )
      allowance = {
        periodStart,
        periodEnd,
        granted,
        unreserved,
        currency: /** @type {const} */ ("USD"),
      };
  }
  return {
    status: "active",
    planKey: grant.planKey,
    startsAt,
    endsAt,
    paidPlanTakesPrecedence: grant.paidPlanTakesPrecedence,
    allowance,
  };
}
