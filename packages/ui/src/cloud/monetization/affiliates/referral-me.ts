/**
 * `GET /api/v1/referrals` response shape + parser, and the typed fetch helper.
 *
 * Ported from `@elizaos/cloud-shared` (`lib/types/referral-me` +
 * `lib/utils/referral-me-fetch`). Re-declared locally rather than imported
 * because `@elizaos/ui` deliberately does not depend on the cloud-shared server
 * bundle (same convention as `../organization/data/cloud-org-types.ts`). The
 * shape is the canonical API contract — keep it in sync with
 * `packages/cloud/shared/src/lib/types/referral-me.ts`.
 *
 * The raw `fetch` of the original was swapped for the cloud {@link api} client so
 * the Steward Bearer token is injected on native targets (same-origin cookie
 * auth keeps working on web).
 */

import { api } from "../../lib/api-client";

export interface ReferralMeResponse {
  code: string;
  total_referrals: number;
  is_active: boolean;
}

export const REFERRALS_ME_API_PATH = "/api/v1/referrals";

/** Coerce a non-negative integer count from untrusted JSON. */
function coerceNonNegativeIntegerCount(val: unknown): number | null {
  if (typeof val === "number") {
    if (!Number.isFinite(val) || !Number.isInteger(val) || val < 0) return null;
    return val;
  }
  if (typeof val === "string") {
    const s = val.trim();
    if (!/^(0|[1-9]\d*)$/.test(s)) return null;
    const n = Number.parseInt(s, 10);
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

export function parseReferralMeResponse(
  data: unknown,
): ReferralMeResponse | null {
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

/**
 * Authenticated GET `/api/v1/referrals`. Throws on network / HTTP / parse
 * errors (the {@link api} client throws `ApiError` on non-2xx).
 */
export async function fetchReferralMe(): Promise<ReferralMeResponse> {
  const json = await api<unknown>(REFERRALS_ME_API_PATH);
  const parsed = parseReferralMeResponse(json);
  if (!parsed) {
    throw new Error("Invalid response from server");
  }
  return parsed;
}
