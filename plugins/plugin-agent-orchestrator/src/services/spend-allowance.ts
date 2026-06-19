/**
 * Capped self-spend allowance for the parent-agent Cloud command broker.
 *
 * By default every `mutating` / `paid` / `destructive` Eliza Cloud command run
 * through the broker requires an explicit human "yes" (see `runCloudCommand` in
 * `parent-agent-broker.ts`). That invariant is safe but it means a `/goal`
 * sub-agent can never *autonomously* drive the monetized-app loop — every app
 * create, container deploy, and domain buy stalls on a confirmation turn.
 *
 * When an operator configures a spend cap (`ELIZA_AGENT_SPEND_CAP_USD`), the
 * agent may self-authorize commands within a bounded per-session budget:
 *
 *   - `read` / `dry-run`            → never need authorization (unchanged);
 *   - `destructive`                 → ALWAYS require human confirmation;
 *   - self-spend commands           → auto-authorize only while the running
 *     (debit our own credits)         total + the command's estimated cost stays
 *                                     within the cap; otherwise fall back to
 *                                     confirmation;
 *   - other `mutating` / `paid`     → auto-authorize while the allowance is
 *     (state changes + revenue        active. These do not debit our balance
 *      ops the *payer* funds, e.g.    (e.g. `apps.charges.create` creates a
 *      `apps.charges.create`)         charge that someone else pays us).
 *
 * The cap is a SAFETY THROTTLE, not a durable accounting ledger: the running
 * total is tracked in-memory per child session and resets on process restart.
 * Real money is still ultimately gated server-side (credit balance, atomic
 * debit/refund in the buy/charge routes). Default cap of `0` preserves the
 * original "confirm everything" behavior exactly.
 *
 * @module services/spend-allowance
 */

import { readConfigEnvKey } from "./config-env.js";

/** Mirror of the broker's `CloudCommandRisk` union (kept local to avoid a
 * circular import; structurally identical so `definition.risk` is assignable). */
export type SpendRisk =
  | "read"
  | "dry-run"
  | "mutating"
  | "paid"
  | "destructive";

/** Default daily cost of a container at the base tier ($0.67/day — see the
 * `build-monetized-app` survival-economics docs and `cron/container-billing`).
 * Used as the spend estimate for container deploys when no explicit hint is
 * passed. */
export const CONTAINER_DAILY_COST_USD = 0.67;

/** Reserved param key the agent may pass to declare the expected USD cost of a
 * self-spend command (e.g. the quoted price returned by `domains.check` before
 * a `domains.buy`). It is read for the allowance decision and then STRIPPED by
 * the broker before the request is built, so it never leaks into the Cloud API
 * request body. */
export const SPEND_HINT_PARAM = "spendEstimateUsd";

/**
 * Cloud commands that debit the caller's OWN credits / wallet (true self-spend).
 * Only these are metered against the cap. Revenue/collection commands such as
 * `apps.charges.*` and `x402.requests.*` are `paid`-risk but funded by the
 * payer, so they are intentionally excluded.
 */
export const SELF_SPEND_COMMANDS: ReadonlySet<string> = new Set([
  "domains.buy",
  "containers.create",
  "containers.update",
  "media.image.generate",
  "media.video.generate",
  "media.music.generate",
  "media.tts.generate",
  "promote.assets.generate",
  "promote.execute",
  "advertising.campaigns.create",
  "advertising.campaigns.start",
  "advertising.creatives.create",
]);

/** Coerce an unknown value to a finite, non-negative number, or `null`. */
function toNonNegativeNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/** Read the per-session spend cap (USD). `0` (the default) disables the
 * allowance and preserves the original confirm-everything behavior. */
export function readSpendCapUsd(): number {
  const raw = readConfigEnvKey("ELIZA_AGENT_SPEND_CAP_USD");
  const parsed = toNonNegativeNumber(raw);
  return parsed ?? 0;
}

/**
 * Estimate the USD a self-spend command will debit. Returns `null` when the
 * cost cannot be determined — the caller treats `null` as "ask a human", so an
 * unknown cost is never silently auto-spent.
 */
export function estimateSelfSpendCostUsd(
  command: string,
  params?: Record<string, unknown>,
): number | null {
  const hint = toNonNegativeNumber(params?.[SPEND_HINT_PARAM]);
  if (command === "containers.create" || command === "containers.update") {
    // Containers have a known base daily cost even without a hint.
    return hint ?? CONTAINER_DAILY_COST_USD;
  }
  // domains.buy, media.*, promote.*, advertising.* — require an explicit hint
  // (e.g. the quoted price from domains.check). Unknown → confirm.
  return hint;
}

export interface SpendDecisionInput {
  command: string;
  risk: SpendRisk;
  /** Per-session cap in USD (`0` = allowance disabled). */
  capUsd: number;
  /** USD already auto-authorized in this session. */
  alreadySpentUsd: number;
  params?: Record<string, unknown>;
}

export type SpendDecisionReason =
  | "non-mutating"
  | "allowance-disabled"
  | "destructive-requires-human"
  | "within-cap"
  | "over-cap"
  | "unknown-cost"
  | "non-self-spend";

export interface SpendDecision {
  /** When true the broker may run the command without a human confirmation. */
  autoAuthorize: boolean;
  /** Estimated USD to add to the session ledger when auto-authorized (self-spend
   * only); `null` for non-self-spend or unknown. */
  estimatedCostUsd: number | null;
  reason: SpendDecisionReason;
}

/**
 * Decide whether a Cloud command may be auto-authorized under the capped
 * allowance. Pure: no env reads, no ledger mutation, no clock — fully testable.
 */
export function decideSpendAuthorization(
  input: SpendDecisionInput,
): SpendDecision {
  const { command, risk, capUsd, alreadySpentUsd, params } = input;

  // Reads never mutate state or money.
  if (risk === "read" || risk === "dry-run") {
    return {
      autoAuthorize: true,
      estimatedCostUsd: null,
      reason: "non-mutating",
    };
  }

  // Allowance off → preserve the original confirm-everything behavior.
  if (!(capUsd > 0)) {
    return {
      autoAuthorize: false,
      estimatedCostUsd: null,
      reason: "allowance-disabled",
    };
  }

  // Destructive actions always need a human, regardless of cap.
  if (risk === "destructive") {
    return {
      autoAuthorize: false,
      estimatedCostUsd: null,
      reason: "destructive-requires-human",
    };
  }

  // Self-spend: meter the estimated cost against the remaining budget.
  if (SELF_SPEND_COMMANDS.has(command)) {
    const cost = estimateSelfSpendCostUsd(command, params);
    if (cost === null) {
      return {
        autoAuthorize: false,
        estimatedCostUsd: null,
        reason: "unknown-cost",
      };
    }
    const remaining = capUsd - alreadySpentUsd;
    if (cost <= remaining) {
      return {
        autoAuthorize: true,
        estimatedCostUsd: cost,
        reason: "within-cap",
      };
    }
    return { autoAuthorize: false, estimatedCostUsd: cost, reason: "over-cap" };
  }

  // Other mutating / revenue commands do not debit our balance.
  return {
    autoAuthorize: true,
    estimatedCostUsd: null,
    reason: "non-self-spend",
  };
}

// ---------------------------------------------------------------------------
// Per-session spend ledger (in-memory; resets on restart — see module note).
// ---------------------------------------------------------------------------

const sessionSpendUsd = new Map<string, number>();

export function getSessionSpendUsd(sessionId: string): number {
  return sessionSpendUsd.get(sessionId) ?? 0;
}

/** Add to a session's running total; returns the new total. Negative/NaN
 * amounts are ignored. */
export function addSessionSpendUsd(
  sessionId: string,
  amountUsd: number,
): number {
  const safe = Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : 0;
  const next = getSessionSpendUsd(sessionId) + safe;
  sessionSpendUsd.set(sessionId, next);
  return next;
}

/** Clear the ledger for one session, or all sessions when omitted (test/cleanup). */
export function resetSessionSpendUsd(sessionId?: string): void {
  if (sessionId === undefined) {
    sessionSpendUsd.clear();
    return;
  }
  sessionSpendUsd.delete(sessionId);
}

/** Return a shallow copy of `params` with the reserved spend-hint key removed,
 * so it never reaches the Cloud API request. Returns `undefined` unchanged. */
export function stripSpendHints(
  params?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!params || !(SPEND_HINT_PARAM in params)) return params;
  const { [SPEND_HINT_PARAM]: _omit, ...rest } = params;
  return rest;
}
