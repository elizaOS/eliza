/**
 * JSON body for GET /api/v1/referrals.
 *
 * WHY a dedicated type + parser: Fetch JSON is untrusted at the type level; `parseReferralMeResponse`
 * fails closed on wrong shapes instead of using `any`. WHY flat top-level fields: matches the API
 * contract documented in docs/referrals.md—do not nest the string `code` under an object key also
 * named `code`.
 */
export interface ReferralMeResponse {
  code: string;
  total_referrals: number;
  is_active: boolean;
}

/**
 * Shared coercion for non-negative integer counts (DB row values and JSON `total_referrals`).
 * Rejects null, booleans, decimals, non-digit strings, and unsafe bigint magnitudes.
 */
export function coerceNonNegativeIntegerCount(val: unknown): number | null {
  if (typeof val === "number") {
    if (!Number.isFinite(val) || !Number.isInteger(val) || val < 0) return null;
    return val;
  }
  if (typeof val === "string") {
    const s = val.trim();
    if (!/^(0|[1-9]\d*)$/.test(s)) return null;
    const n = parseInt(s, 10);
    if (!Number.isSafeInteger(n)) return null;
    return n;
  }
  if (typeof val === "bigint") {
    const n = Number(val);
    if (!Number.isSafeInteger(n) || n < 0) return null;
    return n;
  }
  return null;
}

export function parseReferralMeResponse(data: unknown): ReferralMeResponse | null {
  if (typeof data !== "object" || data === null) return null;
  const o = data as Record<string, unknown>;
  if (typeof o.code !== "string" || o.code.length === 0) return null;
  const totalReferrals = coerceNonNegativeIntegerCount(o.total_referrals);
  if (totalReferrals === null) return null;
  if (typeof o.is_active !== "boolean") return null;
  return {
    code: o.code,
    total_referrals: totalReferrals,
    is_active: o.is_active,
  };
}
