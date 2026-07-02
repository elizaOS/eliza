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

import { logger } from "@elizaos/core";
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
  const rawHint = toNonNegativeNumber(params?.[SPEND_HINT_PARAM]);
  // A declared cost of exactly 0 for a *paid* command is not a credible price —
  // treat it as "no hint". Otherwise an attacker-declared `spendEstimateUsd: 0`
  // meters the command at $0 and slips under any cap forever (the old
  // `hint ?? default` also returned 0, because `??` only catches null/undefined).
  const positiveHint = rawHint !== null && rawHint > 0 ? rawHint : null;
  if (command === "containers.create" || command === "containers.update") {
    // Containers have a known base daily cost. Never meter below it — a caller
    // that omits or under-declares the hint is still charged at least the base.
    return Math.max(positiveHint ?? 0, CONTAINER_DAILY_COST_USD);
  }
  // domains.buy, media.*, promote.*, advertising.* — require an explicit,
  // positive hint (e.g. the quoted price from domains.check). Unknown or a
  // non-positive declared cost → null → the caller asks a human to confirm.
  return positiveHint;
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
// Per-session spend ledger.
//
// The in-memory Map is the fast read path the sync cap check uses. When a
// durable backend is installed (`configureSpendLedger`) every debit is also
// persisted write-through, and a session's persisted total is rehydrated into
// the cache on (re)attach (`hydrateSessionSpendUsd`), so a configured spend cap
// survives a process restart instead of silently resetting to zero (#8924).
// Without a backend the behavior is exactly the original throttle-only Map.
// ---------------------------------------------------------------------------

const sessionSpendUsd = new Map<string, number>();

/**
 * Durable store for per-session spend, implemented over the
 * OrchestratorTaskStore (a `spendUsd` field on the session record) — see
 * `createTaskStoreSpendLedger`.
 */
export interface SpendLedgerBackend {
  /** Persisted USD total for a session (0 when none recorded). */
  load(sessionId: string): Promise<number>;
  /** Persist the new running total for a session. */
  save(sessionId: string, totalUsd: number): Promise<void>;
}

let ledgerBackend: SpendLedgerBackend | null = null;

/** Install (or clear, with `null`) the durable spend backend. Called once at
 * orchestrator boot; tests pass a fake backend. */
export function configureSpendLedger(backend: SpendLedgerBackend | null): void {
  ledgerBackend = backend;
}

export function getSessionSpendUsd(sessionId: string): number {
  return sessionSpendUsd.get(sessionId) ?? 0;
}

/**
 * Rehydrate the in-memory total for a session from the durable backend so the
 * sync cap check sees money spent before a restart. No-op (returns the cached
 * value) when no backend is installed. Call when a session is (re)attached.
 */
export async function hydrateSessionSpendUsd(
  sessionId: string,
): Promise<number> {
  if (!ledgerBackend) return getSessionSpendUsd(sessionId);
  const persisted = await ledgerBackend.load(sessionId);
  // Never lower the in-memory total: a debit committed this run may not have
  // been persisted yet (the write-through `save` is fire-and-forget), so a
  // lagging durable read must not erase it — that would let the next command
  // re-authorize spend already consumed (cap bypass). Spend only grows, so MAX
  // is correct and also folds in another instance's higher durable total.
  const merged = Math.max(getSessionSpendUsd(sessionId), persisted);
  sessionSpendUsd.set(sessionId, merged);
  return merged;
}

// Per-session serialization for the hydrate -> check -> commit critical section.
// Concurrent Cloud commands in one session must not both read the pre-commit
// total and each self-authorize within a budget the other is about to consume.
const sessionSpendLocks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after any in-flight spend critical section for the same session has
 * settled, so hydrate/check/commit is atomic per session. A prior section's
 * failure does not reject the next. In-process only — cross-instance accuracy
 * relies on the monotonic durable total, matching the cap's "safety throttle,
 * not a durable ledger" contract.
 */
export function withSessionSpendLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = sessionSpendLocks.get(sessionId) ?? Promise.resolve();
  const result = prior.then(
    () => fn(),
    () => fn(),
  );
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  sessionSpendLocks.set(sessionId, tail);
  void tail.then(() => {
    if (sessionSpendLocks.get(sessionId) === tail) {
      sessionSpendLocks.delete(sessionId);
    }
  });
  return result;
}

/** Add to a session's running total; returns the new total. Negative/NaN
 * amounts are ignored. With a durable backend the new total is persisted
 * write-through; persistence failures are logged, never thrown (the cap stays
 * enforced from the in-memory total). */
export function addSessionSpendUsd(
  sessionId: string,
  amountUsd: number,
): number {
  const safe = Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : 0;
  const next = getSessionSpendUsd(sessionId) + safe;
  sessionSpendUsd.set(sessionId, next);
  if (safe > 0 && ledgerBackend) {
    void ledgerBackend.save(sessionId, next).catch((err) => {
      logger.warn(
        { src: "spend-allowance", sessionId, err: errorMessage(err) },
        "[spend-allowance] failed to persist session spend",
      );
    });
  }
  return next;
}

/** Clear the in-memory ledger for one session, or all when omitted. Does NOT
 * delete the durable record — that survives by design (cache reset for
 * test/cleanup, and the path a restart simulates). */
export function resetSessionSpendUsd(sessionId?: string): void {
  if (sessionId === undefined) {
    sessionSpendUsd.clear();
    return;
  }
  sessionSpendUsd.delete(sessionId);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Minimal structural view of the OrchestratorTaskStore the ledger needs —
 * structurally typed to avoid a hard import / circular dependency. */
export interface SpendLedgerStore {
  findSession(
    sessionId: string,
  ): Promise<{ session: { metadata: Record<string, unknown> } } | null>;
  updateSession(
    sessionId: string,
    patch: { metadata: Record<string, unknown> },
  ): Promise<void>;
}

const SPEND_METADATA_KEY = "spendUsd";

/**
 * Durable backend that persists per-session spend in the session record's
 * `metadata.spendUsd` (#8924). Read-modify-write preserves any other metadata.
 */
export function createTaskStoreSpendLedger(
  store: SpendLedgerStore,
): SpendLedgerBackend {
  return {
    async load(sessionId) {
      const found = await store.findSession(sessionId);
      return (
        toNonNegativeNumber(found?.session.metadata?.[SPEND_METADATA_KEY]) ?? 0
      );
    },
    async save(sessionId, totalUsd) {
      const found = await store.findSession(sessionId);
      // Monotonic write: the running total only grows, so a concurrent save
      // carrying a stale-lower total (read-modify-write race) must not regress
      // the persisted value. Keep the larger of what's stored and what we hold.
      const existing =
        toNonNegativeNumber(found?.session.metadata?.[SPEND_METADATA_KEY]) ?? 0;
      const metadata = {
        ...(found?.session.metadata ?? {}),
        [SPEND_METADATA_KEY]: Math.max(existing, totalUsd),
      };
      await store.updateSession(sessionId, { metadata });
    },
  };
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
