/**
 * Coding-agent account-selector bridge.
 *
 * The orchestrator plugin (`@elizaos/plugin-agent-orchestrator`) spawns Claude
 * Code / Codex / OpenCode sub-agents but depends only on `@elizaos/core` — it
 * cannot import the `AccountPool` or the credential store. So, exactly like the
 * Anthropic and subscription-selector bridges in `account-pool.ts`, we publish a
 * narrow contract on a `globalThis` symbol that the plugin reads at spawn time.
 *
 * Responsibilities:
 *  - Map a coding-agent type ("claude" / "codex" / …) to its candidate provider
 *    ids and pick one account from the pool (default `least-used`).
 *  - Resolve that account's credential and return the env vars the spawned
 *    coding-agent subprocess needs to authenticate AS THAT ACCOUNT:
 *      claude  → `CLAUDE_CODE_OAUTH_TOKEN`
 *      codex   → a per-account `CODEX_HOME` dir holding an `auth.json`
 *      *-api   → the provider's direct API-key env var
 *  - Record usage + health back into the pool keyed by the serving account.
 *
 * Subscription tokens only ever leave this layer to flow into the first-party
 * coding subprocess (which IS Claude Code / Codex) — never into the runtime's
 * own `process.env`. That respects the providers' TOS the same way
 * `applySubscriptionCredentialsLocal` does.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAccount } from "@elizaos/agent/auth/account-storage";
import {
  getAccessToken,
  saveCredentials,
} from "@elizaos/agent/auth/credentials";
import { probeDirectApiKey } from "@elizaos/agent/auth/direct-api-probe";
import { accountRefreshMutex } from "@elizaos/agent/auth/refresh-mutex";
import type { DirectAccountProvider } from "@elizaos/agent/auth/types";
import {
  DIRECT_ACCOUNT_PROVIDER_ENV,
  isDirectAccountProvider,
  isSubscriptionProvider,
} from "@elizaos/agent/auth/types";
import { writeJsonAtomicSync } from "@elizaos/agent/utils/atomic-json";
import { logger, resolveStateDir } from "@elizaos/core";
import type {
  LinkedAccountProviderId,
  LinkedAccountUsage,
} from "@elizaos/shared/contracts/service-routing";
import {
  type AccountPool,
  type Strategy,
  selectionForProvider,
} from "./account-pool.js";

const CODING_AGENT_SELECTOR_BRIDGE_SYMBOL: unique symbol = Symbol.for(
  "eliza.account-pool.coding-agent.v1",
);

const VALID_CODING_STRATEGIES = new Set<Strategy>([
  "priority",
  "round-robin",
  "least-used",
  "quota-aware",
]);

/** Last-resort strategy — the ELIZA_CODING_ACCOUNT_STRATEGY env var, else least-used. */
function getDefaultCodingStrategy(): Strategy {
  const env =
    typeof process !== "undefined"
      ? process.env.ELIZA_CODING_ACCOUNT_STRATEGY?.trim()
      : undefined;
  if (!env) return "least-used";
  if (VALID_CODING_STRATEGIES.has(env as Strategy)) return env as Strategy;
  logger.warn(
    `[coding-account-bridge] ignoring invalid ELIZA_CODING_ACCOUNT_STRATEGY=${JSON.stringify(
      env,
    )}; using least-used`,
  );
  return "least-used";
}

/**
 * Ordered provider candidates per coding-agent type. The first provider with an
 * eligible account wins; a subscription provider is preferred over its direct
 * API equivalent (subscriptions are the primary use case here).
 *
 * claude (claude-agent-acp) and codex (codex-acp) are first-party CLIs.
 * opencode authenticates through its configured backend; the only backend it
 * resolves from a pooled key is Cerebras (`CEREBRAS_API_KEY`, see
 * buildOpencodeSpawnConfig), so opencode pool-rotates across `cerebras-api`
 * accounts and no-ops otherwise. z.ai / Kimi / GLM have no first-party coding
 * CLI — their accounts serve the main runtime's API-key routing — so they are
 * deliberately absent (advertising them would offer an unspawnable path).
 */
const AGENT_PROVIDER_CANDIDATES: Readonly<
  Record<string, readonly LinkedAccountProviderId[]>
> = {
  claude: ["anthropic-subscription", "anthropic-api"],
  codex: ["openai-codex", "openai-api"],
  opencode: ["cerebras-api"],
};

export interface CodingAgentAccountDescriptor {
  providerId: LinkedAccountProviderId;
  accountId: string;
  label: string;
  source: "oauth" | "api-key";
  strategy: Strategy;
  usage?: LinkedAccountUsage;
}

export interface CodingAgentSelection extends CodingAgentAccountDescriptor {
  /** Env vars to inject into the spawned coding-agent subprocess. */
  envPatch: Record<string, string>;
}

export interface CodingProviderAvailability {
  providerId: LinkedAccountProviderId;
  total: number;
  enabled: number;
  healthy: number;
}

export interface CodingAgentSelectorBridge {
  /** Which providers can serve each coding-agent type, with account counts. */
  describe(): Record<string, CodingProviderAvailability[]>;
  /** Pick an account for a new (or continuing) coding sub-agent. */
  select(
    agentType: string,
    opts?: { sessionKey?: string; strategy?: Strategy; exclude?: string[] },
  ): Promise<CodingAgentSelection | null>;
  markRateLimited(
    providerId: LinkedAccountProviderId,
    accountId: string,
    untilMs: number,
    detail?: string,
  ): Promise<void>;
  markNeedsReauth(
    providerId: LinkedAccountProviderId,
    accountId: string,
    detail?: string,
  ): Promise<void>;
  recordUsage(
    providerId: LinkedAccountProviderId,
    accountId: string,
    result: {
      tokens?: number;
      ok: boolean;
      model?: string;
      latencyMs?: number;
    },
  ): Promise<void>;
}

function candidatesFor(agentType: string): readonly LinkedAccountProviderId[] {
  return AGENT_PROVIDER_CANDIDATES[agentType.toLowerCase()] ?? [];
}

/**
 * Whether a token-resolve failure is a genuine auth problem (→ needs-reauth)
 * vs a transient network/5xx blip. A transient failure must NOT sideline a
 * healthy account — that would exclude it from the pool until the next
 * keep-alive sweep (~5 min). `undefined` (getAccessToken returned null without
 * throwing) means no credential is present at all → genuine needs-reauth.
 */
const AUTH_FAILURE_PATTERN =
  /\b(40[13]|invalid[_ ]?grant|invalid[_ ]?token|unauthor|forbidden|re-?auth|revoked|expired)\b/i;
export function isAuthFailure(err: unknown): boolean {
  if (err === undefined) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return AUTH_FAILURE_PATTERN.test(msg);
}

function codexHomeDir(accountId: string): string {
  return path.join(
    process.env.ELIZA_HOME || resolveStateDir(),
    "auth",
    "_codex-home",
    accountId,
  );
}

/** Decode the `exp` claim (epoch ms) from a JWT access token, or null. */
function jwtExpiryMs(accessToken: string): number | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8"),
    ) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

/** Shape of the ChatGPT-mode `auth.json` a Codex CLI maintains in CODEX_HOME. */
interface MaterializedCodexAuthJson {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
  };
  last_refresh?: string;
}

/**
 * Adopt tokens a spawned Codex CLI rotated inside its per-account CODEX_HOME
 * back into the canonical account record.
 *
 * OpenAI refresh tokens are ONE-TIME-USE: when a long-running Codex session
 * self-refreshes, it writes the rotated pair to `CODEX_HOME/auth.json` only —
 * the canonical record at `auth/openai-codex/{accountId}.json` is left holding
 * an already-consumed refresh token. Every later canonical refresh (next
 * spawn's `getAccessToken`, the keep-alive usage sweep) then fails with
 * `invalid_grant` and the account is marked needs-reauth — forcing a manual
 * re-login even though the CLI's copy holds perfectly good tokens. Calling
 * this before any canonical token resolution heals that drift.
 *
 * Serialized on the same per-account refresh mutex as `getAccessToken` so an
 * adoption can't interleave with an in-flight canonical refresh.
 */
export async function adoptRotatedCodexTokens(
  accountId: string,
): Promise<boolean> {
  const authPath = path.join(codexHomeDir(accountId), "auth.json");
  if (!existsSync(authPath)) return false;
  return accountRefreshMutex.acquire(`openai-codex:${accountId}`, async () => {
    let parsed: MaterializedCodexAuthJson;
    try {
      parsed = JSON.parse(
        readFileSync(authPath, "utf-8"),
      ) as MaterializedCodexAuthJson;
    } catch {
      return false;
    }
    const tokens = parsed?.tokens;
    if (!tokens?.access_token || !tokens.refresh_token) return false;
    const record = loadAccount("openai-codex", accountId);
    if (!record) return false;
    // Same refresh token → the CLI never rotated; nothing to adopt.
    if (tokens.refresh_token === record.credentials.refresh) return false;
    // Only adopt when the CLI's copy is NEWER than the canonical record. An
    // older materialized copy (e.g. the account was re-linked via OAuth after
    // that session ran) would clobber a fresh login with dead tokens.
    const materializedAt =
      typeof parsed.last_refresh === "string"
        ? Date.parse(parsed.last_refresh)
        : Number.NaN;
    if (
      !Number.isFinite(materializedAt) ||
      materializedAt <= record.updatedAt
    ) {
      return false;
    }
    // Prefer the access token's own exp claim; an undecodable token is saved
    // as already-expired so the next getAccessToken refreshes it immediately
    // (with the adopted, still-valid refresh token).
    const expires = jwtExpiryMs(tokens.access_token) ?? Date.now();
    saveCredentials(
      "openai-codex",
      {
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires,
        ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
      },
      accountId,
    );
    logger.info(
      `[coding-account-bridge] adopted rotated Codex tokens from CODEX_HOME for account "${accountId}" (CLI self-refresh)`,
    );
    return true;
  });
}

/**
 * Materialize a per-account `CODEX_HOME` so Codex authenticates as the selected
 * account instead of the machine's single `~/.codex` login. Writes the
 * ChatGPT-login `auth.json` shape Codex reads; the account_id is the OAuth
 * account id baked into the credential record (`organizationId`).
 */
function materializeCodexHome(accountId: string, accessToken: string): string {
  const dir = codexHomeDir(accountId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const record = loadAccount("openai-codex", accountId);
  const refreshToken = record?.credentials.refresh;
  if (!refreshToken) {
    throw new Error(
      `openai-codex account "${accountId}" is missing a refresh token`,
    );
  }
  const chatgptAccountId = record?.organizationId;
  // Codex's chatgpt-mode auth loader requires `tokens.id_token`; omitting it
  // fails with "Authentication required" even when access_token is valid (an
  // expired id_token is tolerated — Codex refreshes — but it must be present).
  const idToken = record?.credentials.idToken;
  const authJson = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null as string | null,
    tokens: {
      ...(idToken ? { id_token: idToken } : {}),
      access_token: accessToken,
      refresh_token: refreshToken,
      ...(chatgptAccountId ? { account_id: chatgptAccountId } : {}),
    },
    last_refresh: new Date().toISOString(),
  };
  writeJsonAtomicSync(path.join(dir, "auth.json"), authJson);

  // Codex reads its model from CODEX_HOME/config.toml; with none, codex-acp
  // falls back to a built-in default (e.g. gpt-5.3-codex) that ChatGPT-account
  // auth rejects ("model is not supported when using Codex with a ChatGPT
  // account"). Write a MINIMAL config.toml with just the model — reusing the
  // operator's working model (extracted from ~/.codex/config.toml) but NOT the
  // rest of their config, which can carry fields the pinned codex-acp rejects
  // (e.g. newer reasoning-effort variants). Falls back to a compatible default.
  const targetConfig = path.join(dir, "config.toml");
  try {
    let model = process.env.ELIZA_CODEX_MODEL?.trim();
    // Validate the operator-supplied model: it is interpolated into TOML, so a
    // stray quote/newline would break out of the string (corrupt config) — and
    // a model name is a conservative token anyway. Reject anything else.
    if (model && !/^[\w.:/-]+$/.test(model)) {
      logger.warn(
        `[coding-account-bridge] ignoring malformed ELIZA_CODEX_MODEL=${JSON.stringify(model)}`,
      );
      model = undefined;
    }
    if (!model) {
      const machineConfig = path.join(os.homedir(), ".codex", "config.toml");
      if (existsSync(machineConfig)) {
        // Accept both double- and single-quoted TOML strings (both are valid +
        // common); the captured value can't contain the quote char so it's
        // safe to re-emit double-quoted.
        const m = readFileSync(machineConfig, "utf-8").match(
          /^\s*model\s*=\s*["']([^"']+)["']/m,
        );
        if (m?.[1]) model = m[1];
      }
    }
    writeFileSync(targetConfig, `model = "${model || "gpt-5.1-codex"}"\n`, {
      mode: 0o600,
    });
  } catch (err) {
    logger.warn(
      `[coding-account-bridge] could not materialize codex config.toml: ${String(err)}`,
    );
  }
  return dir;
}

async function buildEnvPatch(
  providerId: LinkedAccountProviderId,
  accountId: string,
  accessToken: string,
): Promise<Record<string, string>> {
  switch (providerId) {
    case "anthropic-subscription":
      return { CLAUDE_CODE_OAUTH_TOKEN: accessToken };
    case "openai-codex":
      return { CODEX_HOME: materializeCodexHome(accountId, accessToken) };
    default: {
      // Direct API providers (e.g. cerebras-api → CEREBRAS_API_KEY for opencode)
      // inject under their canonical env key; run-main.ts normalizes aliases
      // (Z_AI_API_KEY → ZAI_API_KEY, KIMI_API_KEY → MOONSHOT_API_KEY).
      const envKey =
        DIRECT_ACCOUNT_PROVIDER_ENV[providerId as DirectAccountProvider];
      return envKey ? { [envKey]: accessToken } : {};
    }
  }
}

function makeBridge(pool: AccountPool): CodingAgentSelectorBridge {
  return {
    describe() {
      const out: Record<string, CodingProviderAvailability[]> = {};
      for (const [agentType, providers] of Object.entries(
        AGENT_PROVIDER_CANDIDATES,
      )) {
        out[agentType] = providers.map((providerId) => {
          const accounts = pool.list(providerId);
          return {
            providerId,
            total: accounts.length,
            enabled: accounts.filter((a) => a.enabled).length,
            healthy: accounts.filter((a) => a.enabled && a.health === "ok")
              .length,
          };
        });
      }
      return out;
    },

    async select(agentType, opts) {
      const candidates = candidatesFor(agentType);
      if (candidates.length === 0) return null;
      for (const providerId of candidates) {
        // Explicit caller override > the app's per-provider
        // config.accountStrategies (same live selectionForProvider read the
        // anthropic/subscription bridges use, so the rotation-strategy picker
        // steers coding spawns too) > ELIZA_CODING_ACCOUNT_STRATEGY env >
        // least-used. Strategy only — the llmText route's accountIds pin the
        // chat brain's account, not coding sub-agents.
        const strategy =
          opts?.strategy ??
          selectionForProvider(providerId).strategy ??
          getDefaultCodingStrategy();
        const account = await pool.select({
          providerId,
          strategy,
          ...(opts?.sessionKey ? { sessionKey: opts.sessionKey } : {}),
          ...(opts?.exclude ? { exclude: opts.exclude } : {}),
        });
        if (!account) continue;
        // A prior Codex session may have rotated the one-time refresh token
        // inside its CODEX_HOME; heal the canonical record BEFORE resolving a
        // token or the refresh below burns on the consumed token.
        if (providerId === "openai-codex") {
          await adoptRotatedCodexTokens(account.id).catch(() => false);
        }
        let accessToken: string | null = null;
        let resolveError: unknown;
        try {
          accessToken = await getAccessToken(providerId, account.id);
        } catch (err) {
          resolveError = err;
          logger.warn(
            `[coding-account-bridge] token resolve failed for ${providerId}/${account.id}: ${String(err)}`,
          );
        }
        if (!accessToken) {
          // Only flag for re-auth on a genuine auth failure; a transient
          // network/5xx blip must not pull a healthy account out of rotation.
          if (isAuthFailure(resolveError)) {
            await pool.markNeedsReauth(
              account.id,
              "No valid credential / token refresh failed",
              { providerId },
            );
          }
          continue;
        }
        const envPatch = await buildEnvPatch(
          providerId,
          account.id,
          accessToken,
        );
        if (Object.keys(envPatch).length === 0) continue;
        const source: "oauth" | "api-key" = isSubscriptionProvider(providerId)
          ? "oauth"
          : "api-key";
        logger.info(
          `[coding-account-bridge] ${agentType} → ${providerId} account "${account.label}" (${account.id}) via ${strategy}`,
        );
        return {
          providerId,
          accountId: account.id,
          label: account.label,
          source,
          strategy,
          ...(account.usage ? { usage: account.usage } : {}),
          envPatch,
        };
      }
      return null;
    },

    markRateLimited(providerId, accountId, untilMs, detail) {
      return pool.markRateLimited(accountId, untilMs, detail, { providerId });
    },
    async markNeedsReauth(providerId, accountId, detail) {
      // A session-level 401 usually means the token INJECTED at spawn aged out
      // mid-run (Claude gets a bare access token it cannot refresh), not that
      // the account's credential is dead. Verify before evicting: adopt any
      // CLI-rotated Codex tokens, resolve a token through the normal refresh
      // path, then prove it server-side with the usage probe (a cached-but-
      // revoked access token must not keep a dead account in rotation; probe
      // success also restores health + usage). Only an auth-shaped verify
      // failure marks needs-reauth — a transient blip leaves the account for
      // the keep-alive sweep to re-check.
      if (providerId === "openai-codex") {
        await adoptRotatedCodexTokens(accountId).catch(() => false);
      }
      try {
        const token = await getAccessToken(providerId, accountId);
        if (token) {
          if (isSubscriptionProvider(providerId)) {
            const record = pool.get(accountId, providerId);
            await pool.refreshUsage(accountId, token, {
              providerId,
              ...(record?.organizationId
                ? { codexAccountId: record.organizationId }
                : {}),
            });
          } else if (isDirectAccountProvider(providerId)) {
            // #11033 regression fix: a direct-API key resolves offline from
            // local storage with a never-expires sentinel, so a successful
            // `getAccessToken` proves NOTHING — a cached-but-revoked key that
            // just 401'd a session would otherwise be logged "verified" and
            // kept in rotation forever (doomed failover respawns). Probe it
            // against the provider; only a real 2xx keeps it, a 401/403 falls
            // through to markNeedsReauth. A network/timeout blip (status 0)
            // is inconclusive → leave rotation state to the keep-alive sweep.
            const probe = await probeDirectApiKey(providerId, token);
            if (!probe.ok) {
              if (probe.status === 401 || probe.status === 403) {
                return pool.markNeedsReauth(accountId, detail, { providerId });
              }
              logger.info(
                `[coding-account-bridge] ${providerId}/${accountId} auth-failure verify was inconclusive (probe status ${probe.status}${probe.error ? `: ${probe.error}` : ""}) — leaving rotation state to the keep-alive sweep`,
              );
              return;
            }
          }
          logger.info(
            `[coding-account-bridge] ${providerId}/${accountId} reported an auth failure but its credential verifies — keeping it in rotation (injected token likely expired mid-session)${detail ? `: ${detail}` : ""}`,
          );
          return;
        }
        // Token resolve returned null: no credential / refresh failed → mark.
      } catch (err) {
        if (!isAuthFailure(err)) {
          logger.info(
            `[coding-account-bridge] ${providerId}/${accountId} auth-failure verify hit a transient error (${String(err)}) — leaving rotation state to the keep-alive sweep`,
          );
          return;
        }
      }
      return pool.markNeedsReauth(accountId, detail, { providerId });
    },
    async recordUsage(providerId, accountId, result) {
      // Session end is the natural sync point for tokens a Codex CLI rotated
      // mid-run — heal the canonical record before the next sweep refreshes
      // against the consumed one.
      if (providerId === "openai-codex") {
        await adoptRotatedCodexTokens(accountId).catch(() => false);
      }
      return pool.recordCall(accountId, result, { providerId });
    },
  };
}

/**
 * Install the coding-agent selector bridge on `globalThis`. Idempotent — called
 * from `getDefaultAccountPool()` so it is present before the first spawn.
 */
export function installCodingAgentSelectorBridge(pool: AccountPool): void {
  if (typeof globalThis === "undefined") return;
  (globalThis as Record<symbol, unknown>)[CODING_AGENT_SELECTOR_BRIDGE_SYMBOL] =
    makeBridge(pool);
}

/** Read the installed bridge (null when no pool has been constructed yet). */
export function getCodingAgentSelectorBridge(): CodingAgentSelectorBridge | null {
  if (typeof globalThis === "undefined") return null;
  const bridge = (globalThis as Record<symbol, unknown>)[
    CODING_AGENT_SELECTOR_BRIDGE_SYMBOL
  ];
  return (bridge as CodingAgentSelectorBridge | undefined) ?? null;
}
