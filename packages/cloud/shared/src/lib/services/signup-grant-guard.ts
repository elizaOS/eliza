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

import { eq, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { dbWrite } from "../../db/client";
import { organizations } from "../../db/schemas/organizations";
import { logger } from "../utils/logger";

type SignupGrantIpLimitEnv = {
  [key: string]: string | undefined;
  MAX_FREE_GRANTS_PER_IP_DAILY?: string;
  FREE_GRANT_IP_WINDOW_HOURS?: string;
};

export function resolveSignupGrantIpLimits(env: SignupGrantIpLimitEnv = process.env): {
  MAX_FREE_GRANTS_PER_IP_DAILY: number;
  WINDOW_HOURS: number;
} {
  return {
    /** Max free welcome-bonus grants per source IP per rolling 24h. */
    MAX_FREE_GRANTS_PER_IP_DAILY: readPositiveIntEnv(env.MAX_FREE_GRANTS_PER_IP_DAILY, 3),
    /** Rolling cap window in hours. */
    WINDOW_HOURS: readPositiveIntEnv(env.FREE_GRANT_IP_WINDOW_HOURS, 24),
  };
}

export const FREE_GRANT_IP_LIMITS = resolveSignupGrantIpLimits();

export type SignupGrantWithheldReason = "ip_daily_cap" | "count_unavailable";

/**
 * `organizations.settings` key recording that this org's signup welcome bonus
 * was withheld by this guard. Persisted at signup time so the agent credit
 * gate (`agent-billing-gate.ts`) can later explain a $0-balance 402 with the
 * real reason ("this network hit the daily free-credit limit") instead of the
 * generic insufficient-credits copy — the auth response is the only other
 * carrier of this decision and the client has long discarded it by the time
 * /join provisioning 402s (a genuine CGNAT user reads that as a broken app).
 */
export const WELCOME_BONUS_WITHHELD_SETTINGS_KEY = "welcomeBonusWithheld";

export interface WelcomeBonusWithheldRecord {
  reason: SignupGrantWithheldReason;
  message?: string;
}

const WITHHELD_REASONS: ReadonlySet<string> = new Set(["ip_daily_cap", "count_unavailable"]);

/**
 * The `organizations.settings` patch recording a withheld welcome bonus, or
 * `null` when the decision granted the bonus. Callers write this onto the
 * just-created org (whose settings are still the `{}` default), so a plain
 * overwrite is safe — no merge needed at signup time.
 */
export function welcomeBonusWithheldSettingsPatch(
  decision: Pick<SignupGrantDecision, "withheldReason" | "withheldMessage">,
): Record<string, unknown> | null {
  if (!decision.withheldReason) return null;
  return {
    [WELCOME_BONUS_WITHHELD_SETTINGS_KEY]: {
      reason: decision.withheldReason,
      ...(decision.withheldMessage ? { message: decision.withheldMessage } : {}),
    },
  };
}

/**
 * Persist the withheld-bonus decision onto the just-created org's settings so
 * the agent credit gate can explain the resulting $0-balance 402 later. No-op
 * when the bonus was granted (or when the degrade path produced a message
 * without a reason). Runs on `tx` when the caller's signup transaction is
 * still open (wallet signup), else on the primary. A plain settings overwrite
 * is correct here: the org was created moments ago in this same signup with
 * the `{}` settings default.
 */
export async function recordWelcomeBonusWithheldOnOrg(
  organizationId: string,
  decision: Pick<SignupGrantDecision, "withheldReason" | "withheldMessage">,
  tx?: DbTransaction,
): Promise<void> {
  const patch = welcomeBonusWithheldSettingsPatch(decision);
  if (!patch) return;
  const db = tx ?? dbWrite;
  await db
    .update(organizations)
    .set({ settings: patch, updated_at: new Date() })
    .where(eq(organizations.id, organizationId));
}

/**
 * Fail-closed read of the withheld-bonus record from an org's settings jsonb.
 * Returns `null` for absent/malformed shapes — a messaging enhancement must
 * never throw out of the billing gate.
 */
export function readWelcomeBonusWithheldSettings(
  settings: unknown,
): WelcomeBonusWithheldRecord | null {
  if (typeof settings !== "object" || settings === null) return null;
  const raw = (settings as Record<string, unknown>)[WELCOME_BONUS_WITHHELD_SETTINGS_KEY];
  if (typeof raw !== "object" || raw === null) return null;
  const { reason, message } = raw as { reason?: unknown; message?: unknown };
  if (typeof reason !== "string" || !WITHHELD_REASONS.has(reason)) return null;
  return {
    reason: reason as SignupGrantWithheldReason,
    ...(typeof message === "string" && message.trim() ? { message } : {}),
  };
}

export interface SignupGrantDecision {
  granted: boolean;
  withheldReason?: SignupGrantWithheldReason;
  withheldMessage?: string;
  cap?: number;
  windowHours?: number;
}

function readPositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Signals that the per-IP grant COUNT could not be resolved to a finite,
 * non-negative integer. The anti-sybil cap is a security gate, so an
 * unreadable count must FAIL CLOSED (withhold the free bonus), never fall
 * open into an unbounded faucet.
 */
export class SignupGrantCountUnavailableError extends Error {
  readonly rawCount: unknown;
  constructor(rawCount: unknown) {
    super(
      `[SignupGrantGuard] per-IP free-grant count is not a finite integer: ${String(rawCount)}`,
    );
    this.name = "SignupGrantCountUnavailableError";
    this.rawCount = rawCount;
  }
}

/**
 * Fail-closed parse of the per-IP grant COUNT. Postgres `COUNT(*)` returns a
 * bigint as a decimal string, so the happy path is a plain non-negative
 * integer string. Anything else (missing row, non-numeric, NaN/Infinity,
 * fractional, negative) means the anti-sybil count is unverifiable — throw so
 * the caller withholds the grant instead of granting past an unread cap.
 *
 * Rationale: the old `Number(count ?? 0)` returned `NaN` on a malformed read,
 * and `NaN >= cap` is `false`, which silently GRANTED the bonus — a fail-open
 * on a sybil gate. This mirrors the fail-closed numeric-read boundaries used by
 * the redemption/billing money gates in the same service layer.
 */
export function parseGrantCount(rawCount: unknown): number {
  if (typeof rawCount === "number") {
    if (Number.isInteger(rawCount) && rawCount >= 0) return rawCount;
    throw new SignupGrantCountUnavailableError(rawCount);
  }
  if (typeof rawCount === "bigint") {
    if (rawCount < 0n) throw new SignupGrantCountUnavailableError(rawCount);
    return Number(rawCount);
  }
  if (typeof rawCount === "string") {
    const trimmed = rawCount.trim();
    // Plain non-negative integer only: rejects "", "NaN", "1.5", "1e3", "0x10", "-1".
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed)) return parsed;
    }
    throw new SignupGrantCountUnavailableError(rawCount);
  }
  throw new SignupGrantCountUnavailableError(rawCount);
}

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
  grant: (tx?: DbTransaction) => Promise<void>,
): Promise<boolean> {
  return (await runWithSignupGrantIpCapDetailed(ip, grant)).granted;
}

/**
 * Detailed variant of `runWithSignupGrantIpCap` for signup routes that must
 * tell the caller whether a $0 new org means "empty balance" or "welcome
 * bonus withheld by anti-sybil policy".
 *
 * With `existingTx` (the atomic wallet-signup transaction) the count + grant
 * run in a SAVEPOINT inside it, not directly on it: a failed grant statement
 * would otherwise abort the enclosing Postgres transaction, so the caller's
 * designed continue-without-bonus degrade (`grantWalletSignupCredits`'s J4
 * catch) could never work — the subsequent user insert would fail with
 * "current transaction is aborted" and the whole signup would break for an
 * optional bonus. An advisory xact lock acquired inside the savepoint is held
 * until the OUTER transaction commits, which still upholds (in fact
 * strengthens) the per-IP serialization this guard needs.
 */
export async function runWithSignupGrantIpCapDetailed(
  ip: string | undefined,
  grant: (tx?: DbTransaction) => Promise<void>,
  existingTx?: DbTransaction,
): Promise<SignupGrantDecision> {
  if (!ip) {
    if (existingTx) {
      // Savepoint even without a cap check so a failing grant stays containable.
      return await existingTx.transaction(async (tx) => {
        await grant(tx);
        return { granted: true };
      });
    }
    await grant();
    return { granted: true };
  }

  const windowHours = FREE_GRANT_IP_LIMITS.WINDOW_HOURS;
  const cap = FREE_GRANT_IP_LIMITS.MAX_FREE_GRANTS_PER_IP_DAILY;
  const dayAgo = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const run = async (tx: DbTransaction): Promise<SignupGrantDecision> => {
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

    const rawCount = (result.rows[0] as { count?: unknown } | undefined)?.count;
    let granted: number;
    try {
      granted = parseGrantCount(rawCount);
    } catch (error) {
      // Fail closed: an unreadable anti-sybil count must NOT grant the bonus.
      // (The old `Number(count ?? 0)` -> NaN, and `NaN >= cap` === false, which
      // silently granted — an unbounded free-credit faucet on a corrupt read.)
      logger.warn(
        "[SignupGrantGuard] Per-IP free-grant count unreadable; withholding welcome bonus (fail-closed)",
        {
          ip: maskIp(ip),
          rawCount,
          cap,
          windowHours,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return {
        granted: false,
        withheldReason: "count_unavailable",
        withheldMessage: "Welcome credit unavailable right now. Add funds to start an agent.",
        cap,
        windowHours,
      };
    }

    if (granted >= cap) {
      logger.warn(
        "[SignupGrantGuard] Per-IP daily free-grant cap reached; withholding welcome bonus",
        {
          ip: maskIp(ip),
          granted,
          cap,
          windowHours,
        },
      );
      return {
        granted: false,
        withheldReason: "ip_daily_cap",
        withheldMessage:
          "Welcome credit unavailable because this network reached the daily free-credit limit. Add funds to start an agent.",
        cap,
        windowHours,
      };
    }

    await grant(tx);
    return { granted: true };
  };

  // `existingTx.transaction(run)` opens a savepoint; `dbWrite.transaction(run)`
  // opens a top-level transaction. Either way `run` sees a rollback-able tx.
  return existingTx ? await existingTx.transaction(run) : await dbWrite.transaction(run);
}
