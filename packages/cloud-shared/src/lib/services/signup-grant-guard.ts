/**
 * Anti-sybil guard for free welcome-bonus grants.
 *
 * New orgs receive INITIAL_FREE_CREDITS on signup (steward-sync + wallet-signup).
 * Without a per-IP cap this is a free metered-inference faucet: an attacker can
 * mint unlimited orgs from one host and farm the bonus. This caps the number of
 * free grants per source IP per day, mirroring the IP_RATE_LIMITS anti-sybil
 * pattern in `token-redemption-secure.ts` (which guards the redemption side).
 *
 * The grant sites record `metadata.ip_address` on each grant so this count is
 * meaningful; when no IP is known the check falls open (cannot attribute).
 */

import { sql } from "drizzle-orm";
import { dbRead } from "../../db/client";
import { logger } from "../utils/logger";

export const FREE_GRANT_IP_LIMITS = {
  /** Max free welcome-bonus grants per source IP per rolling 24h. */
  MAX_FREE_GRANTS_PER_IP_DAILY: 3,
} as const;

function maskIp(ip: string): string {
  // IPv4: keep the first two octets; otherwise just the prefix.
  const parts = ip.split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : `${ip.slice(0, 4)}***`;
}

/**
 * Returns `true` if a new-org welcome bonus may be granted for this IP, `false`
 * if the per-IP daily cap is already reached. Falls open when `ip` is undefined.
 */
export async function signupGrantAllowedForIp(ip: string | undefined): Promise<boolean> {
  if (!ip) return true;

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await dbRead.execute(sql`
    SELECT COUNT(*) AS count
    FROM credit_transactions
    WHERE metadata->>'ip_address' = ${ip}
      AND metadata->>'type' IN ('initial_free_credits', 'wallet_signup')
      AND created_at >= ${dayAgo}
  `);

  const granted = Number((result.rows[0] as { count: string } | undefined)?.count ?? 0);
  if (granted >= FREE_GRANT_IP_LIMITS.MAX_FREE_GRANTS_PER_IP_DAILY) {
    logger.warn(
      "[SignupGrantGuard] Per-IP daily free-grant cap reached; withholding welcome bonus",
      {
        ip: maskIp(ip),
        granted,
        cap: FREE_GRANT_IP_LIMITS.MAX_FREE_GRANTS_PER_IP_DAILY,
      },
    );
    return false;
  }
  return true;
}
