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
import { loadAccount } from "@elizaos/auth/account-storage";
import { writeJsonAtomicSync } from "@elizaos/auth/atomic-json";
import {
  type AccessTokenOutcome,
  getAccessToken,
  saveCredentials,
} from "@elizaos/auth/credentials";
import { probeDirectApiKey } from "@elizaos/auth/direct-api-probe";
import { accountRefreshMutex } from "@elizaos/auth/refresh-mutex";
import type { DirectAccountProvider } from "@elizaos/auth/types";
import {
  DIRECT_ACCOUNT_PROVIDER_ENV,
  isDirectAccountProvider,
  isSubscriptionProvider,
} from "@elizaos/auth/types";
import {
  type CodingAgentSelectorBridge,
  type CodingProviderAvailability,
  logger,
  resolveStateDir,
  setCodingAgentSelectorBridge,
} from "@elizaos/core";
import type { LinkedAccountProviderId } from "@elizaos/shared/contracts/service-routing";
import {
  type AccountPool,
  isAccountSelectableNow,
  type Strategy,
  selectionForProvider,
} from "./account-pool.js";
import {
  claudeMinRemainingMs,
  resolveClaudeExpectedRunMs,
} from "./claude-token-refresh.js";

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

function accessTokenFailureIsAuth(
  outcome: AccessTokenOutcome | undefined,
  err?: unknown,
): boolean {
  if (outcome && !outcome.ok) return outcome.kind === "auth";
  return isAuthFailure(err);
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
    // error-policy:J3 untrusted JWT payload — an undecodable segment yields a
    // null expiry (caller treats as "unknown/expired"), not a fake timestamp.
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
      // error-policy:J3 externally-maintained auth.json — an unreadable/malformed
      // file means "no usable credential", handled as a false refresh result.
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
 * Reasoning-effort values the Codex model catalog knows. Codex itself silently
 * accepts an invalid `model_reasoning_effort`, so validation is on us: an
 * unknown operator value is warned about and dropped, never interpolated.
 */
const CODEX_EFFORT_VALUES: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

/**
 * The effort subset the pinned codex-acp adapter can deserialize. Its bundled
 * codex core's `ReasoningEffort` enum is `minimal|low|medium|high|xhigh`
 * (verified against the @zed-industries/codex-acp@0.14.0 binary's serde
 * variant table); an unknown variant fails the WHOLE config.toml parse, which
 * would also discard the `model` pin ChatGPT-account auth requires — far worse
 * than running at the default effort. `max`/`ultra` are valid catalog values
 * on newer Codex builds but are withheld here until the adapter pin moves.
 */
const PINNED_CODEX_ACP_EFFORTS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
]);

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
  // account"). Write a MINIMAL config.toml — the model plus an optional
  // validated reasoning effort — reusing the operator's working model
  // (extracted from ~/.codex/config.toml) but NOT the rest of their config,
  // which can carry fields the pinned codex-acp rejects (e.g. newer
  // reasoning-effort variants; see PINNED_CODEX_ACP_EFFORTS). Falls back to a
  // compatible default.
  const targetConfig = path.join(dir, "config.toml");
  try {
    // Resolution order: explicit env pin > app-configured model (what
    // POST /api/models/config writes for the codex coding target) > the
    // operator's machine config > the compatible default. Without the
    // POWERFUL read here, the app-configured model was a dead-end key — the
    // machine ~/.codex/config.toml silently won on every spawn.
    let model: string | undefined;
    for (const key of ["ELIZA_CODEX_MODEL", "ELIZA_CODEX_MODEL_POWERFUL"]) {
      const candidate = process.env[key]?.trim();
      if (!candidate) continue;
      // Validate the operator-supplied model: it is interpolated into TOML, so
      // a stray quote/newline would break out of the string (corrupt config) —
      // and a model name is a conservative token anyway. Reject anything else.
      if (!/^[\w.:/-]+$/.test(candidate)) {
        logger.warn(
          `[coding-account-bridge] ignoring malformed ${key}=${JSON.stringify(candidate)}`,
        );
        continue;
      }
      model = candidate;
      break;
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
    let effort = process.env.ELIZA_CODEX_EFFORT?.trim().toLowerCase();
    if (effort && !CODEX_EFFORT_VALUES.has(effort)) {
      // error-policy:J7 an invalid operator effort must not poison the spawn —
      // warn and omit the line; the model pin below still ships.
      logger.warn(
        `[coding-account-bridge] ignoring invalid ELIZA_CODEX_EFFORT=${JSON.stringify(effort)} (expected low|medium|high|xhigh|max|ultra)`,
      );
      effort = undefined;
    } else if (effort && !PINNED_CODEX_ACP_EFFORTS.has(effort)) {
      // error-policy:J7 see PINNED_CODEX_ACP_EFFORTS — writing max/ultra would
      // fail the pinned adapter's whole config.toml parse and drop the model pin.
      logger.warn(
        `[coding-account-bridge] ELIZA_CODEX_EFFORT=${JSON.stringify(effort)} is not parseable by the pinned codex-acp (supported: low|medium|high|xhigh); omitting model_reasoning_effort so config.toml stays loadable`,
      );
      effort = undefined;
    }
    writeFileSync(
      targetConfig,
      `model = "${model || "gpt-5.6-terra"}"\n${
        effort ? `model_reasoning_effort = "${effort}"\n` : ""
      }`,
      { mode: 0o600 },
    );
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
      const now = Date.now();
      for (const [agentType, providers] of Object.entries(
        AGENT_PROVIDER_CANDIDATES,
      )) {
        out[agentType] = providers.map((providerId) => {
          const accounts = pool.list(providerId);
          return {
            providerId,
            total: accounts.length,
            enabled: accounts.filter((a) => a.enabled).length,
            // `healthy` must match select()'s own eligibility gate — the
            // SubAgentRouter's failover gate and the readiness verdicts read
            // this count, so a rate-limited account whose reset has elapsed
            // (selectable again) must not be reported as unavailable.
            healthy: accounts.filter(
              (a) => a.enabled && isAccountSelectableNow(a, now),
            ).length,
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
          // Follow-up pin: a continuing session restricts the pool to its
          // spawn-time account so an expired session-affinity can't strategy-
          // drift the subprocess onto a sibling (billing/health stay keyed to
          // the account actually serving). Null when the pin is unselectable.
          ...(opts?.accountIds ? { accountIds: opts.accountIds } : {}),
        });
        if (!account) continue;
        // A prior Codex session may have rotated the one-time refresh token
        // inside its CODEX_HOME; heal the canonical record BEFORE resolving a
        // token or the refresh below burns on the consumed token.
        if (providerId === "openai-codex") {
          await adoptRotatedCodexTokens(account.id).catch(() => false);
        }
        // Claude coding spawns get a BARE `CLAUDE_CODE_OAUTH_TOKEN` the
        // third-party claude-agent-acp adapter reads ONCE and cannot refresh, so a
        // long run outlives a short-TTL token (recon gap #3). Proactively widen
        // the refresh window for anthropic-subscription so the injected token
        // survives the expected run duration. Codex self-refreshes into its
        // CODEX_HOME, so it keeps the default buffer.
        const resolveOpts =
          providerId === "anthropic-subscription"
            ? {
                minRemainingMs: claudeMinRemainingMs(
                  resolveClaudeExpectedRunMs((key) => process.env[key]),
                ),
              }
            : undefined;
        let accessToken: string | null = null;
        let resolveOutcome: AccessTokenOutcome | undefined;
        let resolveError: unknown;
        try {
          resolveOutcome = await getAccessToken(providerId, account.id, {
            ...resolveOpts,
            outcome: true,
          });
          accessToken = resolveOutcome.ok ? resolveOutcome.accessToken : null;
          // A widened Claude resolve is only a freshness preference. The
          // default-buffer retry preserves a still-valid token when refresh is
          // transiently unavailable or the vendor minted a shorter-lived token.
          if (
            accessToken === null &&
            resolveOpts &&
            resolveOutcome &&
            !resolveOutcome.ok &&
            resolveOutcome.kind !== "auth"
          ) {
            const stillValid = await getAccessToken(providerId, account.id, {
              outcome: true,
            });
            resolveOutcome = stillValid;
            if (stillValid.ok) {
              logger.info(
                `[coding-account-bridge] proactive refresh for ${providerId}/${account.id} did not yield a fresh token; using the still-valid shorter-TTL token (a long run may hit the typed expiry signal)`,
              );
              accessToken = stillValid.accessToken;
            }
          }
        } catch (err) {
          resolveError = err;
          logger.warn(
            `[coding-account-bridge] token resolve failed for ${providerId}/${account.id}: ${String(err)}`,
          );
        }
        if (!accessToken) {
          // Only flag for re-auth on a genuine auth failure; a transient
          // network/5xx blip must not pull a healthy account out of rotation.
          if (accessTokenFailureIsAuth(resolveOutcome, resolveError)) {
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

    markRateLimited(
      providerId: LinkedAccountProviderId,
      accountId,
      untilMs,
      detail,
    ) {
      return pool.markRateLimited(accountId, untilMs, detail, { providerId });
    },
    async markNeedsReauth(
      providerId: LinkedAccountProviderId,
      accountId,
      detail,
    ) {
      // Session-level auth failures can come from an injected token aging out.
      // Verify the stored credential before evicting the account from rotation.
      if (providerId === "openai-codex") {
        await adoptRotatedCodexTokens(accountId).catch(() => false);
      }
      try {
        const tokenOutcome = await getAccessToken(providerId, accountId, {
          outcome: true,
        });
        if (tokenOutcome.ok) {
          const token = tokenOutcome.accessToken;
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
        if (tokenOutcome.kind !== "auth") {
          logger.info(
            `[coding-account-bridge] ${providerId}/${accountId} auth-failure verify did not produce a reauth failure (${tokenOutcome.kind}) — leaving rotation state to the keep-alive sweep`,
          );
          return;
        }
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
    async recordUsage(providerId: LinkedAccountProviderId, accountId, result) {
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
 * Install the coding-agent selector bridge. Idempotent — called from
 * `getDefaultAccountPool()` so it is present before the first spawn. The
 * symbol + accessors live in `@elizaos/core` so producer and plugin consumers
 * share one contract.
 */
export function installCodingAgentSelectorBridge(pool: AccountPool): void {
  setCodingAgentSelectorBridge(makeBridge(pool));
}

export { getCodingAgentSelectorBridge } from "@elizaos/core";
