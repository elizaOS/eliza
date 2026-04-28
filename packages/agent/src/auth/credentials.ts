/**
 * Credential storage and token refresh for subscription providers.
 *
 * Stores OAuth credentials in ~/.eliza/auth/ as JSON files.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";
import { resolveElizaCloudTopology } from "@elizaos/shared/contracts";
import { refreshAnthropicToken } from "./anthropic.js";
import { refreshCodexToken } from "./openai-codex.js";
import {
  type OAuthCredentials,
  type StoredCredentials,
  SUBSCRIPTION_PROVIDER_MAP,
  type SubscriptionProvider,
} from "./types.js";

const AUTH_DIR = path.join(
  process.env.ELIZA_HOME || path.join(os.homedir(), ".eliza"),
  "auth",
);

/** Buffer before expiry to trigger refresh (5 minutes) */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const invalidClaudeCodeRefreshTokens = new Set<string>();

function ensureAuthDir(): void {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  }
}

function credentialPath(provider: SubscriptionProvider): string {
  return path.join(AUTH_DIR, `${provider}.json`);
}

/**
 * Save credentials for a provider.
 */
export function saveCredentials(
  provider: SubscriptionProvider,
  credentials: OAuthCredentials,
): void {
  ensureAuthDir();
  const stored: StoredCredentials = {
    provider,
    credentials,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  fs.writeFileSync(credentialPath(provider), JSON.stringify(stored, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  logger.info(`[auth] Saved ${provider} credentials`);
}

/**
 * Load stored credentials for a provider.
 */
export function loadCredentials(
  provider: SubscriptionProvider,
): StoredCredentials | null {
  const filePath = credentialPath(provider);
  try {
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data) as StoredCredentials;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Delete stored credentials for a provider.
 */
export function deleteCredentials(provider: SubscriptionProvider): void {
  const filePath = credentialPath(provider);
  try {
    fs.unlinkSync(filePath);
    logger.info(`[auth] Deleted ${provider} credentials`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

/**
 * Check if credentials exist and are not expired.
 */
export function hasValidCredentials(provider: SubscriptionProvider): boolean {
  const stored = loadCredentials(provider);
  if (!stored) return false;
  return stored.credentials.expires > Date.now();
}

/**
 * Get a valid access token, refreshing if needed.
 * Returns null if no credentials stored or refresh fails.
 */
export async function getAccessToken(
  provider: SubscriptionProvider,
): Promise<string | null> {
  const stored = loadCredentials(provider);
  if (!stored) return null;

  const { credentials } = stored;

  // Token still valid
  if (credentials.expires > Date.now() + REFRESH_BUFFER_MS) {
    return credentials.access;
  }

  // Need to refresh
  logger.info(`[auth] Refreshing ${provider} token...`);
  try {
    let refreshed: OAuthCredentials;
    if (provider === "anthropic-subscription") {
      refreshed = await refreshAnthropicToken(credentials.refresh);
    } else if (provider === "openai-codex") {
      refreshed = await refreshCodexToken(credentials.refresh);
    } else {
      logger.error(`[auth] Unknown provider: ${provider}`);
      return null;
    }

    // Save refreshed credentials
    saveCredentials(provider, refreshed);
    return refreshed.access;
  } catch (err) {
    logger.error(`[auth] Failed to refresh ${provider} token: ${err}`);
    return null;
  }
}

function readConfiguredAnthropicSetupToken(): string | null {
  const namespace = process.env.ELIZA_NAMESPACE?.trim() || "milady";
  const configPath =
    process.env.ELIZA_CONFIG_PATH?.trim() ||
    path.join(
      process.env.ELIZA_STATE_DIR?.trim() ||
        path.join(os.homedir(), `.${namespace}`),
      `${namespace}.json`,
    );
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
    const data = JSON.parse(fs.readFileSync(authPath, "utf-8")) as {
      auth_mode?: string;
      OPENAI_API_KEY?: string;
    };
    return Boolean(
      data.OPENAI_API_KEY?.trim() &&
        data.auth_mode?.trim() &&
        data.auth_mode.trim().toLowerCase() !== "api-key",
    );
  } catch {
    return false;
  }
}

/**
 * Get all configured subscription providers and their status.
 *
 * IMPORTANT: stays synchronous. For Anthropic we check whether a
 * Claude Code OAuth credential blob exists on disk or in the keychain
 * via `readClaudeCodeOAuthBlob()` (sync, no refresh) rather than
 * calling `importClaudeCodeOAuthToken()` which is async and returns
 * a `Promise<string | null>` that would always be truthy when
 * awaited without `await` — silently marking every user as
 * "configured: true".
 */
export function getSubscriptionStatus(): Array<{
  provider: SubscriptionProvider;
  configured: boolean;
  valid: boolean;
  expiresAt: number | null;
}> {
  const providers: SubscriptionProvider[] = [
    "anthropic-subscription",
    "openai-codex",
  ];
  return providers.map((provider) => {
    const stored = loadCredentials(provider);
    // Read the Claude Code OAuth blob exactly once per provider row.
    // On macOS this helper shells out to `security` to query the
    // keychain — calling it twice per poll used to double the cost
    // of every `GET /api/subscription/status` request.
    const claudeBlob =
      provider === "anthropic-subscription" ? readClaudeCodeOAuthBlob() : null;
    let importedClaudeAuth: string | null = null;
    if (provider === "anthropic-subscription") {
      if (claudeBlob?.accessToken) {
        // Blob exists with a parsed accessToken — the user has Claude
        // Code installed and authenticated. Expiry is validated
        // below via the `valid` field.
        importedClaudeAuth = claudeBlob.accessToken;
      } else {
        importedClaudeAuth = readConfiguredAnthropicSetupToken();
      }
    }
    const importedCodexAuth =
      provider === "openai-codex" && hasCodexCliSubscriptionAuth();

    // For the Claude blob path, derive expiry from the blob itself
    // so the UI can surface an accurate "valid" state even before a
    // refresh runs. Older Claude Code credential files omit
    // `expiresAt` entirely — treat a null expiry on an otherwise
    // parseable blob as "valid" (the presence of an accessToken is
    // itself evidence the user is authenticated; the runtime will
    // refresh via the refresh token on first use if needed).
    const blobExpiresAt = claudeBlob?.expiresAt ?? null;
    const blobValid = claudeBlob
      ? blobExpiresAt === null || blobExpiresAt > Date.now()
      : false;

    return {
      provider,
      configured:
        stored !== null || Boolean(importedClaudeAuth || importedCodexAuth),
      valid: stored
        ? stored.credentials.expires > Date.now()
        : provider === "anthropic-subscription" && importedClaudeAuth
          ? blobValid
          : Boolean(importedCodexAuth),
      expiresAt: stored?.credentials.expires ?? blobExpiresAt,
    };
  });
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

  // Try to refresh. Claude Code's persisted access token is often stale even
  // when the user is actively using Claude Code, because Claude Code keeps the
  // live token in memory and only persists the original OAuth grant.
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
 * Codex / ChatGPT subscription tokens *are* applied to the environment
 * because OpenAI permits direct API usage with those tokens.
 *
 * When a `config` is provided and the active subscription provider has
 * credentials, `model.primary` is auto-set so the user doesn't need to
 * configure it manually — but only for providers whose tokens are applied
 * to the runtime (currently Codex only).
 */
export async function applySubscriptionCredentials(config?: {
  agents?: {
    defaults?: { subscriptionProvider?: string; model?: { primary?: string } };
  };
  serviceRouting?: Record<string, unknown>;
  deploymentTarget?: Record<string, unknown>;
  cloud?: Record<string, unknown>;
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
  let anthropicToken = await getAccessToken("anthropic-subscription");
  if (!anthropicToken) {
    anthropicToken = await importClaudeCodeOAuthToken();
  }
  if (anthropicToken) {
    logger.info(
      "[auth] Anthropic subscription detected — available for coding agents (Claude Code CLI). " +
        "Not applied to runtime env. Add an API key or connect Eliza Cloud for the main agent.",
    );
  }

  const cloudInferenceEnabled = config
    ? resolveElizaCloudTopology(config as Record<string, unknown>).services
        .inference
    : false;

  // ── OpenAI Codex subscription → set OPENAI_API_KEY ────────────────────
  const codexToken = await getAccessToken("openai-codex");
  if (codexToken && !cloudInferenceEnabled) {
    process.env.OPENAI_API_KEY = codexToken;
    logger.info(
      "[auth] Applied OpenAI Codex subscription credentials to environment",
    );
  } else if (codexToken) {
    logger.info(
      "[auth] OpenAI Codex subscription detected, but cloud inference is active; skipping runtime OPENAI_API_KEY injection",
    );
  }

  // Auto-set model.primary from subscription provider (Codex only —
  // anthropic subscription tokens don't power the runtime directly).
  if (config?.agents?.defaults) {
    const defaults = config.agents.defaults;
    const provider =
      defaults.subscriptionProvider as keyof typeof SUBSCRIPTION_PROVIDER_MAP;

    if (provider) {
      const modelId = SUBSCRIPTION_PROVIDER_MAP[provider];
      if (modelId) {
        if (cloudInferenceEnabled) {
          logger.info(
            `[auth] Cloud inference is active; ignoring subscription model.primary auto-selection for "${modelId}"`,
          );
        } else if (!defaults.model) {
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
