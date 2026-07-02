/**
 * Chat-brain multi-account rotation for the SAFE/CLI inference route (issue
 * #11180 Gap A).
 *
 * The problem: `plugin-cli-inference` authenticates the warm claude-sdk / codex-sdk
 * session from the machine's single ambient credential (`~/.claude` /
 * `CLAUDE_CODE_OAUTH_TOKEN`, or `~/.codex` / `CODEX_HOME`). When THAT account hits
 * its hourly/monthly subscription limit, the SDK ends the turn by streaming the
 * limit envelope, the session handlers throw (per the throw-to-failover contract),
 * and `useModel` skips straight to the next provider TIER (cloud / API key) — it
 * never asks the pool for the next healthy *account* of the SAME provider first. A
 * user with two Claude Max accounts still stalls the brain when account #1 limits,
 * exactly like a solo account.
 *
 * The fix (this module): on a subscription-limit-classed throw, consume the
 * `eliza.account-pool.coding-agent.v1` bridge (the SAME bridge coding sub-agents
 * rotate through — it maps backend → provider, pool-selects the next healthy
 * account, and MATERIALIZES the exact env the subprocess needs:
 * `CLAUDE_CODE_OAUTH_TOKEN` for claude, a per-account `CODEX_HOME` for codex).
 * We build a subprocess-only env patch for the next SDK session, dispose the
 * warm session so it re-auths as the new account on its next start, and retry the
 * turn transparently. Only when the pool returns null (all accounts limited / no
 * pool / single account) do we rethrow so the caller's existing provider-failover
 * chain runs. Rotation (account A → account B, same provider) therefore composes
 * with — and runs BEFORE — failover (claude → cloud → api).
 *
 * Design notes:
 *  - **Bridge over `globalThis`, not an app-core import.** The pool + credential
 *    store live in `@elizaos/app-core`; this plugin depends only on
 *    `@elizaos/core`. Like `plugin-agent-orchestrator/coding-account-selection.ts`
 *    we read the narrow contract off a `Symbol.for(...)` key. When no pool is
 *    configured the bridge is absent and this module is a pass-through no-op
 *    (single-account behavior is byte-for-byte unchanged).
 *  - **TOS invariant preserved.** The subscription token materialized by the
 *    bridge only ever lands in the first-party SDK subprocess env (`query
 *    options.env` / `new Codex({ env })`), never the runtime's shared
 *    `process.env`, never logs, never a third-party API. `CODEX_HOME` is a
 *    directory path, not a secret.
 *  - **Rotation is opt-out-able**, gated like the rest of the plugin's env
 *    conventions: `ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION` (default ON when a pool
 *    is present; set `0`/`false`/`off` to disable and go straight to failover).
 *  - **Only rate-limit-class errors rotate.** A non-limit failure (timeout parsed
 *    as retryable is still a limit-shaped signal; a 400/empty-completion/auth
 *    error is NOT) rethrows immediately so we never burn the pool on a bug.
 *
 * @module plugin-cli-inference/account-rotation
 */

import { logger } from "@elizaos/core";

/** Symbol the app-core coding-agent selector bridge is published under. */
const CODING_AGENT_SELECTOR_BRIDGE_SYMBOL: unique symbol = Symbol.for(
  "eliza.account-pool.coding-agent.v1"
);

export type RotationAgentType = "claude" | "codex";
export type RotationSubprocessEnv = Record<string, string | undefined>;

interface RotationState {
  selection: RotationAccountSelection;
  subprocessEnv: RotationSubprocessEnv;
}

const rotationStateBySession = new Map<string, RotationState>();

/** A selected account plus the env the first-party subprocess needs to auth as it. */
export interface RotationAccountSelection {
  providerId: string;
  accountId: string;
  label: string;
  source: "oauth" | "api-key";
  strategy: string;
  /** Secrets / paths injected into the SDK subprocess env, never persisted or logged. */
  envPatch: Record<string, string>;
}

/** The narrow slice of the coding-agent bridge this module consumes. */
interface CodingAgentSelectorBridge {
  select(
    agentType: string,
    opts?: { sessionKey?: string; strategy?: string; exclude?: string[] }
  ): Promise<RotationAccountSelection | null>;
  markRateLimited(
    providerId: string,
    accountId: string,
    untilMs: number,
    detail?: string
  ): Promise<void>;
  recordUsage(
    providerId: string,
    accountId: string,
    result: { tokens?: number; ok: boolean; model?: string; latencyMs?: number }
  ): Promise<void>;
}

/** Read the installed bridge, or null when no pool has been constructed. */
export function getCodingAccountBridge(): CodingAgentSelectorBridge | null {
  if (typeof globalThis === "undefined") return null;
  const bridge = (globalThis as Record<symbol, unknown>)[CODING_AGENT_SELECTOR_BRIDGE_SYMBOL];
  return (bridge as CodingAgentSelectorBridge | undefined) ?? null;
}

/**
 * The backends whose warm SDK sessions authenticate per pooled account. The
 * cold `claude --print` / `codex exec` CLIs read the machine's single on-disk
 * login and are out of scope for in-runtime rotation (they'd need the CLI shim,
 * issue #11180 Gap B), so ONLY the SDK backends map to a rotation agent type.
 */
const BACKEND_TO_AGENT_TYPE: Readonly<Record<string, RotationAgentType>> = {
  "claude-sdk": "claude",
  "codex-sdk": "codex",
};

/** Map an inference backend to the coding-agent pool type, or null when unrotatable. */
export function rotationAgentTypeForBackend(backend: string): RotationAgentType | null {
  return BACKEND_TO_AGENT_TYPE[backend] ?? null;
}

/** Default cool-off applied to an account that hit a subscription limit (15 min). */
export const ROTATION_RATE_LIMIT_COOLOFF_MS = 15 * 60_000;

/**
 * True when this error is the subscription-limit / rate-limit class that should
 * trigger account rotation. Deliberately CONSERVATIVE: the session handlers
 * already narrow their throws (they only surface the limit envelope as a
 * "subscription rate limit reached: …" message, or a `ProviderApiError` whose
 * message carries the upstream status), so we anchor on those same signals plus
 * a 429/529/quota vocabulary. A false positive burns a healthy account out of
 * the pool for 15 min, so anything ambiguous (400, empty completion, plain auth
 * failure, generic timeout) does NOT rotate — it rethrows to failover.
 */
export function isSubscriptionLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const statusCode = (err as { statusCode?: unknown })?.statusCode;
  if (typeof statusCode === "number" && (statusCode === 429 || statusCode === 529)) {
    return true;
  }
  const t = message.toLowerCase();
  return (
    // The claude-sdk session's own limit throw ("subscription rate limit reached: …").
    t.includes("subscription rate limit reached") ||
    // Explicit status the SDK envelope carries.
    /\b(429|529)\b/.test(t) ||
    // Provider limit / quota vocabulary. Kept tight: "rate limit" + "usage limit
    // reached" + "quota exceeded/exhausted" + "too many requests" are the
    // unambiguous provider signals (matches the orchestrator's classifier).
    /rate[\s-]?limit(?:ed|ing)?/.test(t) ||
    t.includes("usage limit reached") ||
    /quota (?:exceeded|exhausted)/.test(t) ||
    // OpenAI's CLASSIC quota envelope inverts the word order ("You exceeded
    // your current quota, please check your plan and billing details") and
    // carries the machine code `insufficient_quota` — none of which contain
    // "quota exceeded" or a literal 429. Anchor on the provider's exact
    // envelope phrases / error code, NOT generic quota/billing prose, so a
    // model merely talking about quotas still does not rotate.
    t.includes("exceeded your current quota") ||
    t.includes("check your plan and billing details") ||
    t.includes("insufficient_quota") ||
    t.includes("too many requests")
  );
}

/** Resolve whether rotation is enabled (default ON; opt-out via env/setting). */
export function rotationEnabled(getValue: (key: string) => string | undefined): boolean {
  const raw = getValue("ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION")?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return true;
}

/**
 * Ambient auth vars that would compete with a rotated account's env patch.
 * Both SDKs replace the subprocess environment when `env` is provided, so the
 * merge spreads `process.env` (PATH/HOME survive) but drops these first;
 * otherwise an operator's own ambient key/home could outrank the selected pool
 * account.
 */
const COMPETING_AUTH_VARS: Readonly<Record<RotationAgentType, readonly string[]>> = {
  claude: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  codex: ["CODEX_HOME", "OPENAI_API_KEY"],
};

/**
 * Build the SDK subprocess env for a rotated account. Pure: it never mutates
 * `process.env`, so pooled credentials cannot leak into the parent process or
 * other in-process consumers.
 */
export function buildRotatedSubprocessEnv(
  agentType: RotationAgentType,
  envPatch: Record<string, string>
): RotationSubprocessEnv {
  const env: RotationSubprocessEnv = typeof process === "undefined" ? {} : { ...process.env };
  for (const key of COMPETING_AUTH_VARS[agentType]) {
    delete env[key];
  }
  return { ...env, ...envPatch };
}

/** A description safe to log about a selection (label + provider, NEVER the token). */
function safeAccountLabel(sel: RotationAccountSelection): string {
  return `${sel.providerId}/${sel.label}`;
}

export interface RotationContext {
  /** The configured inference backend (claude-sdk / codex-sdk / claude / codex). */
  backend: string;
  /** Read a runtime setting/env value (rotation gate). */
  getValue: (key: string) => string | undefined;
  /** Stable key so pool session-affinity ties a conversation to one account. */
  sessionKey?: string;
  /**
   * Called after a successful rotation, BEFORE the retry, so the caller can tear
   * down the warm SDK session bound to the old account's credential — the fresh
   * session then re-auths as the newly-selected account on its next start.
   */
  onRotate: () => void | Promise<void>;
  /** Selection strategy override (else the pool's default). */
  strategy?: string;
}

function rotationStateKey(ctx: RotationContext): string {
  return `${ctx.backend}\u001f${ctx.sessionKey ?? "__default"}`;
}

/** Test seam: keeps per-test rotation state independent. */
export function resetRotationStateForTests(): void {
  rotationStateBySession.clear();
}

/**
 * Run `attempt` with transparent account rotation on subscription-limit errors.
 *
 * Flow:
 *  1. Try `attempt()`. On success, return it (and best-effort record usage on the
 *     currently-selected account if we rotated into it).
 *  2. If it throws and the error is NOT a subscription-limit (or rotation is
 *     disabled / no bridge / backend not rotatable), rethrow immediately →
 *     the caller's existing provider-failover chain handles it.
 *  3. On a limit error: mark the current account rate-limited, select the next
 *     healthy account from the pool (excluding every account already tried),
 *     build its subprocess-only env, dispose the warm session (`onRotate`), and retry.
 *     Repeat until an attempt succeeds or the pool is exhausted; when the pool
 *     returns null, rethrow the LAST limit error so failover runs.
 *
 * A single structured `warn` is emitted per rotation (no credential/envelope
 * leakage). At most `maxRotations` swaps are attempted to bound the loop even if
 * the pool mis-reports health.
 */
export async function withAccountRotation(
  attempt: (env?: RotationSubprocessEnv) => Promise<string>,
  ctx: RotationContext,
  maxRotations = 8
): Promise<string> {
  const agentType = rotationAgentTypeForBackend(ctx.backend);
  const bridge = agentType ? getCodingAccountBridge() : null;
  // No rotation possible/desired → single, un-wrapped attempt (behavior
  // identical to pre-rotation: any throw goes straight to the caller's failover).
  if (!bridge || !agentType || !rotationEnabled(ctx.getValue)) {
    return attempt();
  }

  const stateKey = rotationStateKey(ctx);
  let state = rotationStateBySession.get(stateKey) ?? null;
  const tried: string[] = state ? [state.selection.accountId] : [];
  let lastError: unknown;

  for (let rotations = 0; rotations <= maxRotations; rotations += 1) {
    try {
      const result = await attempt(state?.subprocessEnv);
      // Record a successful call against the account we rotated INTO so
      // quota-aware selection reflects real usage (best-effort; never throws).
      if (state) {
        void bridge
          .recordUsage(state.selection.providerId, state.selection.accountId, { ok: true })
          .catch(() => undefined);
      }
      return result;
    } catch (err) {
      lastError = err;
      if (!isSubscriptionLimitError(err)) {
        // Not a limit — a genuine failure. Do NOT rotate (would burn a healthy
        // account); rethrow so the caller's provider-failover chain runs.
        throw err;
      }
      // The active account just limited. Mark it (with its reset window) so
      // quota-aware selection routes around it, then pick the next healthy one.
      // Only for an account WE selected (the ambient credential is untracked).
      if (state) {
        void bridge
          .markRateLimited(
            state.selection.providerId,
            state.selection.accountId,
            Date.now() + ROTATION_RATE_LIMIT_COOLOFF_MS,
            "cli-inference subscription limit"
          )
          .catch(() => undefined);
        rotationStateBySession.delete(stateKey);
        state = null;
      }

      let selection: RotationAccountSelection | null = null;
      try {
        selection = await bridge.select(agentType, {
          ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
          ...(ctx.strategy ? { strategy: ctx.strategy } : {}),
          exclude: tried,
        });
      } catch (selectErr) {
        // Pool selection itself failed — treat as pool-exhausted and fail over.
        logger.warn(
          {
            src: "cli-inference:rotation",
            backend: ctx.backend,
            reason: "select-failed",
          },
          `[cli-inference] account rotation select failed (${String(selectErr)}) — falling through to provider failover`
        );
        throw err;
      }

      if (!selection) {
        // Pool exhausted: every healthy account tried, or none configured.
        // Rethrow the limit error so the caller's failover chain (cloud / API)
        // runs — rotation composes with, and yields to, failover.
        logger.warn(
          {
            src: "cli-inference:rotation",
            backend: ctx.backend,
            tried: tried.length,
            reason: "pool-exhausted",
          },
          `[cli-inference] all pooled ${agentType} accounts rate-limited (${tried.length} tried) — failing over to next provider tier`
        );
        throw err;
      }

      tried.push(selection.accountId);
      state = {
        selection,
        subprocessEnv: buildRotatedSubprocessEnv(agentType, selection.envPatch),
      };
      rotationStateBySession.set(stateKey, state);
      // Tear down the warm session so it re-auths as the newly-selected account.
      try {
        await ctx.onRotate();
      } catch {
        // Session teardown is best-effort; the fresh start will re-init anyway.
      }
      logger.warn(
        {
          src: "cli-inference:rotation",
          backend: ctx.backend,
          account: safeAccountLabel(selection),
          strategy: selection.strategy,
          attempt: rotations + 1,
        },
        `[cli-inference] rotated to next ${agentType} account after subscription limit`
      );
      // loop retries the turn on the new account
    }
  }

  // Exhausted maxRotations without success — fail over with the last error.
  throw lastError instanceof Error
    ? lastError
    : new Error(`[cli-inference] account rotation exhausted: ${String(lastError)}`);
}
