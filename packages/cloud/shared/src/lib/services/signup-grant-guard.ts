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
 *
 * CONCURRENCY: the cap is enforced under a per-IP advisory transaction lock so
 * N concurrent same-IP signups cannot each read `count < cap` before any of
 * them commit (a TOCTOU that would let every racer mint the bonus). The COUNT
 * and the grant run inside ONE transaction that holds
 * `pg_advisory_xact_lock(hashtext('free_grant:' + ip))` for its whole duration,
 * the same per-key advisory-lock serialization the redeemable-earnings promo
 * guard (`redeemable-earnings.ts`) uses for double-spend prevention. A second
 * racer for the same IP blocks on the lock until the first commits its grant
 * row, then re-counts and sees it — so the cap holds across concurrency.
 */

import { sql } from "drizzle-orm";
import { dbWrite } from "../../db/client";
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
 * Run `grant` iff this IP is under the per-IP daily free-grant cap, serialized
 * against concurrent same-IP attempts by a per-IP advisory transaction lock.
 *
 * The COUNT and `grant` execute inside a single write transaction that holds
 * `pg_advisory_xact_lock(hashtext('free_grant:' + ip))` until it commits, so a
 * concurrent racer for the same IP blocks until this transaction's grant row is
 * committed and then counts it — the cap cannot be raced past.
 *
 * Returns `true` if `grant` ran (the bonus was granted), `false` if it was
 * withheld because the cap is already reached. Falls open (always grants) when
 * `ip` is undefined, since an unattributable signup cannot be capped. Errors
 * from `grant` propagate (and roll back the lock) — the guard never swallows.
 */
export async function runWithSignupGrantIpCap(
  ip: string | undefined,
  grant: () => Promise<void>,
): Promise<boolean> {
  if (!ip) {
    await grant();
    return true;
  }

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  return await dbWrite.transaction(async (tx) => {
    // Serialize same-IP grant attempts: the lock is held for the whole
    // transaction, so a concurrent racer blocks here until we commit our grant
    // row (released on commit), then re-reads the count below and sees it.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`free_grant:${ip}`}))`);

    const result = await tx.execute(sql`
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

    await grant();
    return true;
  });
}
