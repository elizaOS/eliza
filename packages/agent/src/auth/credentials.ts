/**
 * Credential storage and token refresh for subscription providers.
 *
 * Credentials live under `~/.eliza/auth/{providerId}/{accountId}.json`
 * (see `account-storage.ts` for the on-disk format and atomic-write
 * details). The `loadCredentials` / `saveCredentials` /
 * `deleteCredentials` / `hasValidCredentials` / `getAccessToken`
 * helpers all default to `accountId="default"` so callers that pre-date
 * multi-account support keep working without changes.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getElizaNamespace,
  logger,
  resolveStateDir,
  resolveUserPath,
} from "@elizaos/core";
import {
  type AccountCredentialRecord,
  deleteAccount,
  listAccounts,
  loadAccount,
  migrateLegacySingleAccount,
  saveAccount,
} from "./account-storage.ts";
import { refreshAnthropicToken } from "./anthropic.ts";
import { refreshCodexToken } from "./openai-codex.ts";
import { accountRefreshMutex } from "./refresh-mutex.ts";
import {
  type AccountCredentialProvider,
  isCodingPlanKeySubscriptionProvider,
  isExternalCliSubscriptionProvider,
  isOAuthSubscriptionProvider,
  isSubscriptionProvider,
  isUnavailableSubscriptionProvider,
  type OAuthCredentials,
  type StoredCredentials,
  SUBSCRIPTION_PROVIDER_IDS,
  SUBSCRIPTION_PROVIDER_MAP,
  SUBSCRIPTION_PROVIDER_METADATA,
  type SubscriptionProvider,
} from "./types.ts";

const DEFAULT_ACCOUNT_ID = "default";

/** Buffer before expiry to trigger refresh (5 minutes) */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const invalidClaudeCodeRefreshTokens = new Set<string>();

// Run the legacy → per-account migration eagerly at module load. This
// is cheap when there's nothing to migrate (one `existsSync` per
// provider) and ensures every code path sees the per-account layout.
migrateLegacySingleAccount();

function recordToStored(record: AccountCredentialRecord): StoredCredentials {
  return {
    provider: record.providerId,
    credentials: record.credentials,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Save credentials for a provider account.
 *
 * The `accountId` defaults to `"default"`. New accounts are persisted
 * with `source: "oauth"` and `label: "Default"` (or the existing
 * record's label when overwriting).
 */
export function saveCredentials(
  provider: SubscriptionProvider,
  credentials: OAuthCredentials,
  accountId: string = DEFAULT_ACCOUNT_ID,
): void {
  const existing = loadAccount(provider, accountId);
  const now = Date.now();
  const record: AccountCredentialRecord = {
    id: accountId,
    providerId: provider,
    label:
      existing?.label ??
      (accountId === DEFAULT_ACCOUNT_ID ? "Default" : accountId),
    source: existing?.source ?? "oauth",
    credentials,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(existing?.lastUsedAt !== undefined
      ? { lastUsedAt: existing.lastUsedAt }
      : {}),
    ...(existing?.organizationId !== undefined
      ? { organizationId: existing.organizationId }
      : {}),
    ...(existing?.userId !== undefined ? { userId: existing.userId } : {}),
    ...(existing?.email !== undefined ? { email: existing.email } : {}),
  };
  saveAccount(record);
}

/**
 * Load stored credentials for a provider account.
 * Returns `null` when no account is configured for the given id.
 */
export function loadCredentials(
  provider: SubscriptionProvider,
  accountId: string = DEFAULT_ACCOUNT_ID,
): StoredCredentials | null {
  const record = loadAccount(provider, accountId);
  if (!record) return null;
  return recordToStored(record);
}

/**
 * Delete stored credentials for a provider account.
 */
export function deleteCredentials(
  provider: SubscriptionProvider,
  accountId: string = DEFAULT_ACCOUNT_ID,
): void {
  deleteAccount(provider, accountId);
}

/**
 * Delete every stored credential account for a provider.
 */
export function deleteProviderCredentials(
  provider: AccountCredentialProvider,
): number {
  const accounts = listProviderAccounts(provider);
  for (const account of accounts) {
    deleteAccount(provider, account.id);
  }
  return accounts.length;
}

/**
 * Check if credentials exist and are not expired.
 */
export function hasValidCredentials(
  provider: AccountCredentialProvider,
  accountId: string = DEFAULT_ACCOUNT_ID,
): boolean {
  const record = loadAccount(provider, accountId);
  if (!record) return false;
  return record.credentials.expires > Date.now();
}

/**
 * List all accounts configured for a provider.
 */
export function listProviderAccounts(
  provider: AccountCredentialProvider,
): AccountCredentialRecord[] {
  return listAccounts(provider);
}

/**
 * Get a valid access token, refreshing if needed.
 *
 * Refreshes are serialized per `{provider}:{accountId}` via
 * `accountRefreshMutex` so concurrent callers don't race on the
 * refresh-token grant or the credential file write.
 *
 * Returns `null` when no credentials are stored or the refresh fails.
 */
export async function getAccessToken(
  provider: AccountCredentialProvider,
  accountId: string = DEFAULT_ACCOUNT_ID,
): Promise<string | null> {
  if (!isSubscriptionProvider(provider)) {
    const direct = loadAccount(provider, accountId);
    if (!direct) return null;
    if (direct.credentials.expires <= Date.now()) return null;
    return direct.credentials.access;
  }

  const initial = loadCredentials(provider, accountId);
  if (!initial) return null;

  if (initial.credentials.expires > Date.now() + REFRESH_BUFFER_MS) {
    return initial.credentials.access;
  }

  if (isCodingPlanKeySubscriptionProvider(provider)) {
    return initial.credentials.expires > Date.now()
      ? initial.credentials.access
      : null;
  }

  if (
    isExternalCliSubscriptionProvider(provider) ||
    isUnavailableSubscriptionProvider(provider)
  ) {
    logger.info(
      `[auth] ${provider} is not an importable OAuth credential; use its first-party coding client or supported coding endpoint.`,
    );
    return null;
  }

  return accountRefreshMutex.acquire(`${provider}:${accountId}`, async () => {
    // Re-read after acquiring the lock — a concurrent caller may have
    // already refreshed the token, in which case we want the new one.
    const stored = loadCredentials(provider, accountId);
    if (!stored) return null;
    const { credentials } = stored;
    if (credentials.expires > Date.now() + REFRESH_BUFFER_MS) {
      return credentials.access;
    }

    logger.info(
      `[auth] Refreshing ${provider} token for account "${accountId}"...`,
    );
    let refreshed: OAuthCredentials;
    try {
      if (provider === "anthropic-subscription") {
        refreshed = await refreshAnthropicToken(credentials.refresh);
      } else if (provider === "openai-codex") {
        refreshed = await refreshCodexToken(credentials.refresh);
      } else if (!isOAuthSubscriptionProvider(provider)) {
        logger.error(`[auth] Unknown provider: ${provider}`);
        return null;
      } else {
        logger.error(
          `[auth] Refresh not implemented for provider: ${provider}`,
        );
        return null;
      }
    } catch (err) {
      logger.error(
        `[auth] Failed to refresh ${provider} token for "${accountId}": ${err}`,
      );
      return null;
    }

    saveCredentials(provider, refreshed, accountId);
    return refreshed.access;
  });
}

/** Shape of `~/.codex/auth.json` (Codex CLI); fields vary by CLI version. */
interface CodexCliAuthJson {
  auth_mode?: string;
  OPENAI_API_KEY?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
  };
}

function parseCodexCliAuthJson(raw: string): CodexCliAuthJson | null {
  try {
    const data = JSON.parse(raw) as CodexCliAuthJson;
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

function readConfiguredAnthropicSetupToken(): string | null {
  const namespace = getElizaNamespace();
  const explicitConfig = process.env.ELIZA_CONFIG_PATH?.trim();
  const configPath = explicitConfig
    ? resolveUserPath(explicitConfig)
    : path.join(resolveStateDir(), `${namespace}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
      env?: Record<string, unknown>;
    };
    const token = parsed.env?.__anthropicSubscriptionToken;
    return typeof token === "string" && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

function hasCodexCliSubscriptionAuth(): boolean {
  const authPath = path.join(os.homedir(), ".codex", "auth.json");
  try {
    const data = parseCodexCliAuthJson(fs.readFileSync(authPath, "utf-8"));
    if (!data) return false;
    if (data.tokens?.access_token?.trim()) return true;
    return Boolean(
      data.OPENAI_API_KEY?.trim() &&
        data.auth_mode?.trim() &&
        data.auth_mode.trim().toLowerCase() !== "api-key",
    );
  } catch {
    return false;
  }
}

export type SubscriptionCredentialSource =
  | "app"
  | "claude-code-cli"
  | "setup-token"
  | "codex-cli"
  | "gemini-cli"
  | "coding-plan-key"
  | "unavailable"
  | null;

/**
 * Per-account subscription status row used by the dashboard / API.
 *
 * One row is emitted per stored account for each provider. CLI- /
 * setup-token-derived sources also produce a row with a synthetic
 * `accountId` (e.g. `"claude-code-cli"`); those rows are read-only
 * (they cannot be deleted via `DELETE /api/subscription/{provider}`).
 */
export interface SubscriptionAccountStatus {
  provider: SubscriptionProvider;
  accountId: string;
  label: string;
  configured: boolean;
  valid: boolean;
  expiresAt: number | null;
  source: SubscriptionCredentialSource;
  available?: boolean;
  availabilityReason?: string;
  allowedClient?: string;
  loginHint?: string;
  billingMode?: "subscription-coding-plan" | "subscription-coding-cli";
}

function subscriptionStatusMetadata(
  provider: SubscriptionProvider,
): Pick<
  SubscriptionAccountStatus,
  "available" | "allowedClient" | "loginHint" | "billingMode"
> & { availabilityReason?: string } {
  const metadata = SUBSCRIPTION_PROVIDER_METADATA[provider];
  return {
    available: metadata.availability !== "unavailable",
    allowedClient: metadata.allowedClient,
    loginHint: metadata.setupHint,
    billingMode: metadata.billingMode,
    ...(metadata.availabilityReason
      ? { availabilityReason: metadata.availabilityReason }
      : {}),
  };
}

function hasCommandOnPath(commandName: string): boolean {
  const command = process.platform === "win32" ? "where" : "command -v";
  try {
    execSync(`${command} ${commandName}`, {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export function getSubscriptionStatus(): SubscriptionAccountStatus[] {
  const rows: SubscriptionAccountStatus[] = [];

  for (const provider of SUBSCRIPTION_PROVIDER_IDS) {
    const metadata = subscriptionStatusMetadata(provider);
    const accounts = listProviderAccounts(provider);
    for (const account of accounts) {
      rows.push({
        ...metadata,
        provider,
        accountId: account.id,
        label: account.label,
        configured: true,
        valid: account.credentials.expires > Date.now(),
        expiresAt: account.credentials.expires,
        source:
          isCodingPlanKeySubscriptionProvider(provider) &&
          account.source === "api-key"
            ? "coding-plan-key"
            : "app",
      });
    }

    // Read the Claude Code OAuth blob exactly once per provider —
    // `readClaudeCodeOAuthBlob()` shells out to `security` on macOS
    // and calling it twice doubled the cost of every status poll.
    const claudeBlob =
      provider === "anthropic-subscription" ? readClaudeCodeOAuthBlob() : null;
    if (provider === "anthropic-subscription") {
      let importedClaudeAuth: string | null = null;
      let claudeSource: SubscriptionCredentialSource = null;
      if (claudeBlob?.accessToken) {
        importedClaudeAuth = claudeBlob.accessToken;
        claudeSource = "claude-code-cli";
      } else {
        importedClaudeAuth = readConfiguredAnthropicSetupToken();
        if (importedClaudeAuth) claudeSource = "setup-token";
      }

      if (importedClaudeAuth) {
        const blobExpiresAt = claudeBlob?.expiresAt ?? null;
        const blobValid = claudeBlob
          ? blobExpiresAt === null || blobExpiresAt > Date.now()
          : true;
        const accountId =
          claudeSource === "claude-code-cli"
            ? "claude-code-cli"
            : "setup-token";
        const label =
          claudeSource === "claude-code-cli"
            ? "Claude Code CLI"
            : "Setup Token";
        rows.push({
          ...metadata,
          provider,
          accountId,
          label,
          configured: true,
          valid: blobValid,
          expiresAt: blobExpiresAt,
          source: claudeSource,
        });
      }
    }

    if (provider === "openai-codex" && hasCodexCliSubscriptionAuth()) {
      rows.push({
        ...metadata,
        provider,
        accountId: "codex-cli",
        label: "Codex CLI",
        configured: true,
        valid: true,
        expiresAt: null,
        source: "codex-cli",
      });
    }

    if (provider === "gemini-cli") {
      const geminiCliDetected = hasCommandOnPath("gemini");
      rows.push({
        ...metadata,
        provider,
        accountId: "gemini-cli",
        label: "Gemini CLI",
        configured: geminiCliDetected,
        valid: geminiCliDetected,
        expiresAt: null,
        source: geminiCliDetected ? "gemini-cli" : null,
      });
    }

    if (provider === "deepseek-coding") {
      rows.push({
        ...metadata,
        provider,
        accountId: "deepseek-coding",
        label: "DeepSeek Coding Plan",
        configured: false,
        valid: false,
        expiresAt: null,
        source: "unavailable",
      });
    }
  }

  return rows;
}

/**
 * Parsed Claude Code OAuth credential blob.
 */
interface ClaudeCodeCredentialBlob {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  source: string;
}

function isClaudeCodeInvalidGrantError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\binvalid_grant\b/i.test(message);
}

/**
 * Try to read a Claude Code OAuth credential blob from disk or the macOS
 * keychain. Does NOT validate expiry — that's the caller's job (so it can
 * decide whether to refresh via the refresh token).
 *
 * Claude Code stores credentials in two places:
 *   - `~/.claude/.credentials.json` (Linux / older macOS installs)
 *   - macOS Keychain entry "Claude Code-credentials" (current macOS)
 *
 * Note that Claude Code's runtime keeps the live access token in memory and
 * refreshes it via the refresh token on demand — the persisted access token
 * will often be expired even though the user is actively using Claude Code.
 * That's why we always need to be ready to refresh.
 */
function readClaudeCodeOAuthBlob(): ClaudeCodeCredentialBlob | null {
  const parse = (
    raw: string,
    source: string,
  ): ClaudeCodeCredentialBlob | null => {
    try {
      const parsed = JSON.parse(raw) as {
        claudeAiOauth?: {
          accessToken?: string;
          access_token?: string;
          refreshToken?: string;
          refresh_token?: string;
          expiresAt?: number;
          expires_at?: number;
        };
      };
      const oauth = parsed?.claudeAiOauth;
      if (!oauth) return null;
      const accessToken = oauth.accessToken ?? oauth.access_token;
      if (typeof accessToken !== "string" || !accessToken.trim()) return null;
      return {
        accessToken: accessToken.trim(),
        refreshToken: oauth.refreshToken ?? oauth.refresh_token ?? null,
        expiresAt: oauth.expiresAt ?? oauth.expires_at ?? null,
        source,
      };
    } catch {
      return null;
    }
  };

  // 1. Try ~/.claude/.credentials.json
  const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
  try {
    if (fs.existsSync(credPath)) {
      const raw = fs.readFileSync(credPath, "utf-8");
      const blob = parse(raw, "credentials file");
      if (blob) return blob;
    }
  } catch {
    // Non-fatal
  }

  // 2. Try macOS Keychain
  if (process.platform === "darwin") {
    try {
      const raw = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
        { encoding: "utf8", timeout: 3000 },
      ).trim();
      if (raw) {
        const blob = parse(raw, "keychain");
        if (blob) return blob;
      }
    } catch {
      // Keychain not available or no entry
    }
  }

  return null;
}

/**
 * Import a usable Anthropic OAuth access token from Claude Code's stored
 * credentials. If the persisted access token is still valid, returns it
 * directly. If it has expired, attempts to refresh via the persisted refresh
 * token. Returns null if no credentials are available, the token is expired
 * with no refresh token, or the refresh fails.
 */
async function importClaudeCodeOAuthToken(): Promise<string | null> {
  const blob = readClaudeCodeOAuthBlob();
  if (!blob) return null;

  const expired =
    typeof blob.expiresAt === "number" && blob.expiresAt <= Date.now();

  if (!expired) {
    logger.info(`[auth] Imported OAuth token from Claude Code ${blob.source}`);
    return blob.accessToken;
  }

  if (!blob.refreshToken) {
    logger.info(
      `[auth] Claude Code OAuth token from ${blob.source} is expired and no refresh token is available. Run "claude auth login" to refresh.`,
    );
    return null;
  }

  const refreshTokenCacheKey = `${blob.source}:${blob.refreshToken}`;
  if (invalidClaudeCodeRefreshTokens.has(refreshTokenCacheKey)) {
    return null;
  }

  try {
    const refreshed = await refreshAnthropicToken(blob.refreshToken);
    logger.info(`[auth] Refreshed Claude Code OAuth token from ${blob.source}`);
    return refreshed.access;
  } catch (err) {
    if (isClaudeCodeInvalidGrantError(err)) {
      invalidClaudeCodeRefreshTokens.add(refreshTokenCacheKey);
      logger.info(
        `[auth] Claude Code OAuth refresh token from ${blob.source} is invalid or revoked. Run "claude auth login" to refresh.`,
      );
      return null;
    }
    logger.warn(
      `[auth] Failed to refresh expired Claude Code OAuth token from ${blob.source}: ${String(err)}. Run "claude auth login" to refresh.`,
    );
    return null;
  }
}

/**
 * Apply subscription credentials to the environment.
 * Called at startup to make credentials available to elizaOS plugins.
 *
 * **Claude subscription tokens are NOT applied to the runtime environment.**
 * Anthropic's TOS only permits Claude subscription tokens to be used through
 * the Claude Code CLI itself.  Eliza honours this by keeping the token
 * available for the task-agent orchestrator (which spawns `claude` CLI
 * subprocesses) but never injecting it into `process.env.ANTHROPIC_API_KEY`
 * or installing the stealth fetch interceptor.
 *
 * Codex / ChatGPT subscription tokens are also CLI credentials. They are used
 * by the Codex CLI-backed provider, not injected into `OPENAI_API_KEY`.
 */
export async function applySubscriptionCredentials(config?: {
  agents?: {
    defaults?: { subscriptionProvider?: string; model?: { primary?: string } };
  };
}): Promise<void> {
  const subscriptionCredentialsDisabled =
    process.env.ELIZA_DISABLE_SUBSCRIPTION_CREDENTIALS?.trim().toLowerCase();
  if (
    subscriptionCredentialsDisabled === "1" ||
    subscriptionCredentialsDisabled === "true" ||
    subscriptionCredentialsDisabled === "yes" ||
    subscriptionCredentialsDisabled === "on"
  ) {
    logger.info(
      "[auth] Subscription credential application disabled by ELIZA_DISABLE_SUBSCRIPTION_CREDENTIALS",
    );
    return;
  }

  // ── Anthropic subscription ──────────────────────────────────────────
  //
  // Anthropic subscription tokens (sk-ant-oat*) are restricted to the
  // Claude Code CLI by Anthropic's TOS. They must NOT be used for direct
  // API calls from the elizaOS runtime. The subscription token only flows
  // to spawned coding-agent CLI sessions via the orchestrator plugin
  // (which ARE Claude Code). If the user has only a subscription and no
  // API key, the runtime simply won't have an Anthropic provider — they
  // need an API key or Eliza Cloud for the main agent.
  const anthropicAccounts = listProviderAccounts("anthropic-subscription");
  if (anthropicAccounts.length > 0) {
    const labels = anthropicAccounts
      .map((a) => `"${a.label}" (${a.id})`)
      .join(", ");
    logger.info(
      `[auth] Anthropic subscription accounts configured: ${labels} — available for coding agents (Claude Code CLI). ` +
        "Not applied to runtime env. Add an API key or connect Eliza Cloud for the main agent.",
    );
  } else {
    const claudeImported = await importClaudeCodeOAuthToken();
    if (claudeImported) {
      logger.info(
        "[auth] Anthropic subscription detected via Claude Code CLI — available for coding agents. " +
          "Not applied to runtime env. Add an API key or connect Eliza Cloud for the main agent.",
      );
    }
  }

  // ── OpenAI Codex subscription ────────────────────────────────────────
  //
  // Codex subscriptions power the Codex CLI-backed provider and task-agent
  // subprocesses. Do not inject their OAuth access tokens into OPENAI_API_KEY:
  // the normal OpenAI API path expects scoped API keys.
  const codexAccounts = listProviderAccounts("openai-codex");
  if (codexAccounts.length > 0) {
    const labels = codexAccounts
      .map((a) => `"${a.label}" (${a.id})`)
      .join(", ");
    logger.info(
      `[auth] OpenAI Codex subscription accounts configured: ${labels} — available for Codex CLI-backed coding/model providers. ` +
        "Not applied to OPENAI_API_KEY; add a direct OpenAI API key for @elizaos/plugin-openai runtime inference.",
    );
  } else {
    if (hasCodexCliSubscriptionAuth()) {
      logger.info(
        "[auth] OpenAI Codex CLI auth detected in ~/.codex/auth.json — available for Codex CLI-backed coding/model providers. " +
          "Not applied to OPENAI_API_KEY; add a direct OpenAI API key for @elizaos/plugin-openai runtime inference.",
      );
    }
  }

  const geminiAccounts = listProviderAccounts("gemini-cli");
  if (geminiAccounts.length > 0 || hasCommandOnPath("gemini")) {
    logger.info(
      "[auth] Gemini CLI subscription surface detected/configured — available only through Gemini CLI task agents. " +
        "Not applied to GOOGLE_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY.",
    );
  }

  for (const provider of ["zai-coding", "kimi-coding"] as const) {
    const accounts = listProviderAccounts(provider);
    if (accounts.length === 0) continue;
    const labels = accounts.map((a) => `"${a.label}" (${a.id})`).join(", ");
    const envName =
      provider === "zai-coding" ? "ZAI_API_KEY" : "MOONSHOT_API_KEY";
    logger.info(
      `[auth] ${provider} coding-plan accounts configured: ${labels} — available only for the provider's dedicated coding endpoint. ` +
        `Not applied to ${envName}.`,
    );
  }

  // Auto-set model.primary only for subscription providers that have a runtime
  // model-provider plugin. CLI-only subscriptions should not point the runtime
  // at direct API-key plugins.
  if (config?.agents?.defaults) {
    const defaults = config.agents.defaults;
    const provider =
      defaults.subscriptionProvider as keyof typeof SUBSCRIPTION_PROVIDER_MAP;

    if (provider) {
      const modelId = SUBSCRIPTION_PROVIDER_MAP[provider];
      const runtimeApplicable = provider === "openai-codex";
      if (modelId && runtimeApplicable) {
        if (!defaults.model) {
          defaults.model = { primary: modelId };
          logger.info(
            `[auth] Auto-set model.primary to "${modelId}" from subscription provider`,
          );
        } else if (!defaults.model.primary) {
          defaults.model.primary = modelId;
          logger.info(
            `[auth] Auto-set model.primary to "${modelId}" from subscription provider`,
          );
        }
      }
    }
  }
}
