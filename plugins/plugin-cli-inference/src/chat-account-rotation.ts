/**
 * Chat-brain account rotation — the Gap A half of elizaOS/eliza#11180.
 *
 * The warm SDK sessions ({@link ClaudeSdkSession} / CodexSdkSession) authenticate
 * from ambient credentials (`~/.claude` / `CLAUDE_CODE_OAUTH_TOKEN` / `~/.codex`).
 * When that one account hits its subscription limit the session throws and
 * `useModel` fails over to the next model TIER — a user with N linked
 * Claude/Codex accounts still stalls the brain when account #1 limits, because
 * nothing ever consults the AccountPool.
 *
 * This module lets the sessions consume the pool WITHOUT importing
 * `@elizaos/app-core` (this plugin depends only on `@elizaos/core`): exactly like
 * the orchestrator's `coding-account-selection.ts`, it reads the account-selector
 * bridge that `getDefaultAccountPool()` installs on a `globalThis` symbol. The
 * bridge materializes per-account subprocess env (claude → `CLAUDE_CODE_OAUTH_TOKEN`,
 * codex → a per-account `CODEX_HOME`) and records limits + resets back into pool
 * health, so the account panel / keep-alive sweep see chat-brain limits too.
 *
 * ⚠ TOS invariant (mirrors `coding-account-bridge.ts`): the subscription token
 * flows ONLY into the SDK subprocess env (`query options.env` / `new Codex({env})`)
 * — NEVER into the runtime's own `process.env`.
 *
 * When no bridge / no pooled accounts exist every helper here no-ops and the
 * single-account behavior (ambient creds, throw-to-tier-failover) is untouched.
 *
 * @module plugin-cli-inference/chat-account-rotation
 */

import { logger } from "@elizaos/core";

/**
 * Same symbol the coding-agent path uses (`coding-account-bridge.ts` publishes,
 * the orchestrator's `coding-account-selection.ts` consumes). The richer
 * `select()` contract is required here — the bare `subscription-selector.v1`
 * bridge only returns an account id, which cannot materialize the subprocess
 * env or record health.
 */
const ACCOUNT_SELECTOR_BRIDGE_SYMBOL: unique symbol = Symbol.for(
  "eliza.account-pool.coding-agent.v1"
);

/** Agent types whose subscription auth the chat brain shares. */
export type ChatAgentType = "claude" | "codex";

/** A pool-selected account plus the env vars its subprocess needs. */
export interface ChatAccountSelection {
  providerId: string;
  accountId: string;
  label: string;
  /** Secrets — injected into the SDK subprocess env only, never process.env. */
  envPatch: Record<string, string>;
}

/** Narrow structural view of the app-core bridge (never imported). */
interface AccountSelectorBridge {
  select(
    agentType: string,
    opts?: { sessionKey?: string; exclude?: string[] }
  ): Promise<ChatAccountSelection | null>;
  markRateLimited(
    providerId: string,
    accountId: string,
    untilMs: number,
    detail?: string
  ): Promise<void>;
}

function getBridge(): AccountSelectorBridge | null {
  if (typeof globalThis === "undefined") return null;
  const bridge = (globalThis as Record<symbol, unknown>)[ACCOUNT_SELECTOR_BRIDGE_SYMBOL];
  if (!bridge || typeof bridge !== "object") return null;
  const b = bridge as Partial<AccountSelectorBridge>;
  return typeof b.select === "function" && typeof b.markRateLimited === "function"
    ? (b as AccountSelectorBridge)
    : null;
}

/**
 * Conservative limit classifier — the same bar as the orchestrator's
 * `classifyAccountFailure` RATE_LIMIT_RE: require an UNAMBIGUOUS quota/limit
 * signal before evicting an account from rotation. Matches both this plugin's
 * own limit-classed throws ("subscription rate limit reached: …") and raw
 * provider forms (429s, "usage limit reached", "You've hit your session limit").
 */
const ACCOUNT_LIMIT_RE =
  /\b429\b|rate[\s-]?limit(?:ed|ing)?|too many requests|quota (?:exceeded|exhausted)|usage limit reached|hit your\b[^.]*\blimit\b/i;

/** True when a thrown session error is account-limit-classed (→ rotate). */
export function isAccountLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return ACCOUNT_LIMIT_RE.test(msg);
}

/**
 * Cool-off recorded when the limit text carries no parseable reset — matching
 * the orchestrator's RATE_LIMIT_COOLOFF_MS. The pool prefers the provider's own
 * `usage.resetsAt` when its usage probe has one, so this is only the floor.
 */
export const ACCOUNT_LIMIT_COOLOFF_MS = 15 * 60_000;

/**
 * Parse the limit's reset time (epoch ms) out of the error text. The classic
 * Claude CLI envelope carries a unix epoch ("Claude AI usage limit reached|<epoch>");
 * the SDK UI string ("· resets 9:30pm (UTC)") does not — fall back to the
 * default cool-off and let the pool's authoritative `usage.resetsAt` win.
 */
export function parseLimitResetMs(detail: string, nowMs = Date.now()): number {
  const epoch = detail.match(/\|\s*(\d{10,13})\b/);
  if (epoch?.[1]) {
    const n = Number(epoch[1]);
    const ms = epoch[1].length >= 13 ? n : n * 1000;
    if (ms > nowMs) return ms;
  }
  return nowMs + ACCOUNT_LIMIT_COOLOFF_MS;
}

/**
 * Ambient auth vars that would compete with a rotated account's env patch.
 * Both SDKs REPLACE the subprocess environment when `env` is provided, so the
 * merge spreads `process.env` (PATH/HOME must survive) but drops these first —
 * otherwise an operator's own `CLAUDE_CODE_OAUTH_TOKEN` / `CODEX_HOME` /
 * API key could out-rank the account the pool just selected.
 */
const COMPETING_AUTH_VARS: Readonly<Record<ChatAgentType, readonly string[]>> = {
  claude: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  codex: ["CODEX_HOME", "OPENAI_API_KEY"],
};

/**
 * Build the SDK subprocess env for a rotated account: `process.env` minus the
 * competing ambient auth vars, plus the account's env patch. Pure — never
 * mutates `process.env` (the TOS invariant lives here).
 */
export function buildRotatedSubprocessEnv(
  agentType: ChatAgentType,
  envPatch: Record<string, string>
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of COMPETING_AUTH_VARS[agentType]) delete env[key];
  return { ...env, ...envPatch };
}

/** Rotation hooks a warm SDK session consumes. Implementations never throw. */
export interface ChatAccountRotator {
  /** Pick an account (null = no bridge / no healthy account → ambient creds). */
  select(exclude?: string[]): Promise<ChatAccountSelection | null>;
  /** Record a limit + its parsed reset into pool health (best-effort). */
  markLimited(selection: ChatAccountSelection, detail: string): Promise<void>;
}

/**
 * Default rotator: resolves the bridge lazily on every call (the pool installs
 * it after plugin construction), scopes selection to one `sessionKey` so pool
 * affinity keeps a warm session on a stable account across restarts, and
 * swallows bridge faults (a degraded pool must not break the inference path —
 * the caller just stays on ambient creds / tier failover).
 */
export function createChatAccountRotator(
  agentType: ChatAgentType,
  sessionKey: string
): ChatAccountRotator {
  return {
    async select(exclude?: string[]): Promise<ChatAccountSelection | null> {
      const bridge = getBridge();
      if (!bridge) return null;
      try {
        const selection = await bridge.select(agentType, {
          sessionKey,
          ...(exclude && exclude.length > 0 ? { exclude } : {}),
        });
        if (!selection || Object.keys(selection.envPatch ?? {}).length === 0) {
          return null;
        }
        return selection;
      } catch (err) {
        logger.warn(`[cli-inference] account select failed for ${agentType}: ${String(err)}`);
        return null;
      }
    },
    async markLimited(selection: ChatAccountSelection, detail: string): Promise<void> {
      const bridge = getBridge();
      if (!bridge) return;
      try {
        await bridge.markRateLimited(
          selection.providerId,
          selection.accountId,
          parseLimitResetMs(detail),
          detail
        );
      } catch (err) {
        // Pool feedback is best-effort — never break the failover path.
        logger.warn(
          `[cli-inference] could not record limit for ${selection.providerId}/${selection.accountId}: ${String(err)}`
        );
      }
    },
  };
}
