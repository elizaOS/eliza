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
import { getAccessToken } from "@elizaos/agent/auth/credentials";
import type { DirectAccountProvider } from "@elizaos/agent/auth/types";
import {
  DIRECT_ACCOUNT_PROVIDER_ENV,
  isSubscriptionProvider,
} from "@elizaos/agent/auth/types";
import { writeJsonAtomicSync } from "@elizaos/agent/utils/atomic-json";
import { logger, resolveStateDir } from "@elizaos/core";
import type {
  LinkedAccountProviderId,
  LinkedAccountUsage,
} from "@elizaos/shared";
import type { AccountPool, Strategy } from "./account-pool.js";

const CODING_AGENT_SELECTOR_BRIDGE_SYMBOL: unique symbol = Symbol.for(
  "eliza.account-pool.coding-agent.v1",
);

const VALID_CODING_STRATEGIES = new Set([
  "priority",
  "round-robin",
  "least-used",
  "quota-aware",
]);

/** Default selection strategy — overridable via ELIZA_CODING_ACCOUNT_STRATEGY env var. */
function getDefaultCodingStrategy(): Strategy {
  const env = process.env.ELIZA_CODING_ACCOUNT_STRATEGY?.trim();
  if (env && VALID_CODING_STRATEGIES.has(env)) return env as Strategy;
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

function codexHomeDir(accountId: string): string {
  return path.join(
    process.env.ELIZA_HOME || resolveStateDir(),
    "auth",
    "_codex-home",
    accountId,
  );
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
  const refreshToken = record?.credentials.refresh ?? "";
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
    if (!model) {
      const machineConfig = path.join(os.homedir(), ".codex", "config.toml");
      if (existsSync(machineConfig)) {
        const m = readFileSync(machineConfig, "utf-8").match(
          /^\s*model\s*=\s*"([^"]+)"/m,
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
      const strategy = opts?.strategy ?? getDefaultCodingStrategy();
      for (const providerId of candidates) {
        const account = await pool.select({
          providerId,
          strategy,
          ...(opts?.sessionKey ? { sessionKey: opts.sessionKey } : {}),
          ...(opts?.exclude ? { exclude: opts.exclude } : {}),
        });
        if (!account) continue;
        let accessToken: string | null = null;
        try {
          accessToken = await getAccessToken(providerId, account.id);
        } catch (err) {
          logger.warn(
            `[coding-account-bridge] token resolve failed for ${providerId}/${account.id}: ${String(err)}`,
          );
        }
        if (!accessToken) {
          await pool.markNeedsReauth(
            account.id,
            "No valid credential / token refresh failed",
            { providerId },
          );
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
    markNeedsReauth(providerId, accountId, detail) {
      return pool.markNeedsReauth(accountId, detail, { providerId });
    },
    recordUsage(providerId, accountId, result) {
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
