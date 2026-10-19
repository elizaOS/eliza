/**
 * Anthropic OAuth credential store with multi-account support.
 *
 * If the host runtime has installed the account-pool bridge on
 * `globalThis` (app does this when the multi-account `LinkedAccountConfig`
 * store is non-empty), token reads route through the pool: `select` picks
 * the active account, the OAuth fetch wrapper retries on 401 against a
 * different account, and the pool tracks rate-limited / invalid health.
 *
 * Without the bridge, behavior uses the single-source flow
 * (env var → keychain → ~/.claude/.credentials.json).
 */

import {
  type AnthropicAccountPoolBridge,
  ElizaError,
  getAnthropicAccountPoolBridge,
  resolveStateDir,
} from "@elizaos/core";

interface OAuthToken {
  accessToken: string;
  expiresAt: number;
  /**
   * Account identifier resolved through the pool; undefined when the token
   * came from the env var or the single-source reader.
   */
  accountId?: string;
}

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType: string;
    rateLimitTier: string;
  };
}

function getAccountPoolBridge(): AnthropicAccountPoolBridge | undefined {
  return getAnthropicAccountPoolBridge() ?? undefined;
}

const tokenCache = new Map<string, OAuthToken>();
const ENV_CACHE_KEY = "__env__";
const APP_CREDENTIAL_CACHE_KEY = "__app_anthropic_subscription__";

interface AppSubscriptionCredentials {
  credentials?: {
    access?: string;
    expires?: number;
  };
}

/**
 * Ref: https://code.claude.com/docs/en/authentication
 *
 * Returns a synchronously-loaded token. When the multi-account bridge is
 * installed, callers should prefer `getClaudeOAuthTokenAsync` so the pool
 * can pick a fresh account on cache miss; the sync path falls back to the
 * file/keychain reader.
 */
export function getClaudeOAuthToken(opts?: { accountId?: string }): OAuthToken {
  const appRead = readAppManagedAnthropicToken();
  const appToken = appRead.token;
  if (appToken) {
    tokenCache.set(APP_CREDENTIAL_CACHE_KEY, appToken);
    return appToken;
  }

  const cacheKey = opts?.accountId ?? ENV_CACHE_KEY;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached;
  }

  const envToken = getEnvVar("CLAUDE_CODE_OAUTH_TOKEN") ?? getEnvVar("ANTHROPIC_OAUTH_TOKEN");
  if (envToken) {
    const token: OAuthToken = {
      accessToken: envToken,
      expiresAt: Number.POSITIVE_INFINITY,
    };
    tokenCache.set(ENV_CACHE_KEY, token);
    return token;
  }

  const credentials = readFromCredentialStore();
  if (!credentials?.claudeAiOauth?.accessToken) {
    if (appRead.error) throw appRead.error;
    throw new Error(
      "[Anthropic] Could not read Claude OAuth token. " +
        "Either set CLAUDE_CODE_OAUTH_TOKEN env var (via `claude setup-token`), " +
        "or ensure Claude Code is authenticated (run `claude auth login`)."
    );
  }

  const token: OAuthToken = {
    accessToken: credentials.claudeAiOauth.accessToken,
    expiresAt: credentials.claudeAiOauth.expiresAt,
  };
  tokenCache.set(cacheKey, token);
  return token;
}

/**
 * Multi-account aware token resolution. Picks an account through the pool
 * if installed; otherwise falls back to `getClaudeOAuthToken`.
 *
 * `exclude` is propagated to the pool so callers can request a *different*
 * account after a 401 / 429.
 */
export async function getClaudeOAuthTokenAsync(opts?: {
  sessionKey?: string;
  exclude?: string[];
}): Promise<OAuthToken> {
  const appToken = readAppManagedAnthropicToken().token;
  if (appToken) {
    tokenCache.set(APP_CREDENTIAL_CACHE_KEY, appToken);
    return appToken;
  }

  const envToken = getEnvVar("CLAUDE_CODE_OAUTH_TOKEN") ?? getEnvVar("ANTHROPIC_OAUTH_TOKEN");
  if (envToken) {
    const token: OAuthToken = {
      accessToken: envToken,
      expiresAt: Number.POSITIVE_INFINITY,
    };
    tokenCache.set(ENV_CACHE_KEY, token);
    return token;
  }

  const bridge = getAccountPoolBridge();
  if (bridge) {
    const account = await bridge.selectAnthropicSubscription(opts);
    if (account) {
      const cached = tokenCache.get(account.id);
      if (cached && Date.now() < cached.expiresAt - 60_000) {
        return cached;
      }
      const access = await bridge.getAccessToken("anthropic-subscription", account.id);
      if (access) {
        const token: OAuthToken = {
          accessToken: access,
          expiresAt: account.expiresAt || Number.POSITIVE_INFINITY,
          accountId: account.id,
        };
        tokenCache.set(account.id, token);
        return token;
      }
    }
  }

  return getClaudeOAuthToken();
}

/**
 * Notify the pool that the supplied account is no longer valid (e.g. 401
 * after refresh) and clear the in-memory cache entry. Returns true when the
 * pool was notified, false when no bridge is installed.
 */
export function reportClaudeOAuthInvalid(accountId: string | undefined, detail?: string): boolean {
  if (accountId) {
    tokenCache.delete(accountId);
  } else {
    tokenCache.clear();
  }
  const bridge = getAccountPoolBridge();
  if (!bridge || !accountId) return false;
  void bridge.markInvalid(accountId, detail);
  return true;
}

export function reportClaudeOAuthRateLimited(
  accountId: string | undefined,
  untilMs: number,
  detail?: string
): boolean {
  if (accountId) {
    tokenCache.delete(accountId);
  }
  const bridge = getAccountPoolBridge();
  if (!bridge || !accountId) return false;
  void bridge.markRateLimited(accountId, untilMs, detail);
  return true;
}

export function getClaudeOAuthMeta(): ClaudeCredentials["claudeAiOauth"] | null {
  const appToken = readAppManagedAnthropicToken().token;
  if (appToken) {
    return {
      accessToken: appToken.accessToken,
      refreshToken: "",
      expiresAt: appToken.expiresAt,
      scopes: [],
      subscriptionType: "app-managed",
      rateLimitTier: "",
    };
  }

  const envToken = getEnvVar("CLAUDE_CODE_OAUTH_TOKEN") ?? getEnvVar("ANTHROPIC_OAUTH_TOKEN");
  if (envToken) return null;

  const credentials = readFromCredentialStore();
  return credentials?.claudeAiOauth ?? null;
}

export function clearTokenCache(accountId?: string): void {
  if (accountId) {
    tokenCache.delete(accountId);
    return;
  }
  tokenCache.clear();
}

function getEnvVar(key: string): string | undefined {
  return process.env[key];
}

interface AppManagedTokenRead {
  token: OAuthToken | null;
  /**
   * Set when a credential file exists but cannot be read or parsed. The caller
   * reports it only after every other token source failed, so an unreadable
   * file is never silently reported as "no credentials".
   */
  error?: ElizaError;
}

function readAppManagedAnthropicToken(): AppManagedTokenRead {
  const cached = tokenCache.get(APP_CREDENTIAL_CACHE_KEY);
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return { token: cached };
  }

  const { join } = require("node:path") as typeof import("node:path");
  const { homedir } = require("node:os") as typeof import("node:os");
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const stateDir = resolveStateDir();
  const accountId = getEnvVar("ANTHROPIC_SUBSCRIPTION_ACCOUNT_ID")?.trim() || "default";
  const paths = [
    join(stateDir, "auth", "anthropic-subscription", `${accountId}.json`),
    join(homedir(), ".eliza", "auth", "anthropic-subscription", `${accountId}.json`),
    join(homedir(), ".eliza", "auth", "anthropic-subscription.json"),
  ];
  let unreadable: ElizaError | undefined;

  for (const credentialPath of paths) {
    let raw: string;
    try {
      raw = readFileSync(credentialPath, "utf-8");
    } catch (error) {
      // A missing file is the expected "not here" signal and moves to the next
      // location. Any other read failure (permissions, I/O) is a real problem.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" && !unreadable) {
        unreadable = new ElizaError("Failed to read app-managed Anthropic credential file", {
          code: "CREDENTIALS_UNREADABLE",
          cause: error,
          context: { credentialPath },
        });
      }
      continue;
    }

    let parsed: AppSubscriptionCredentials;
    try {
      parsed = JSON.parse(raw) as AppSubscriptionCredentials;
    } catch (error) {
      // error-policy:J2 context-adding rethrow — a file that exists but does
      // not parse is corrupt, not absent. It is reported once every other
      // credential source has failed.
      if (!unreadable) {
        unreadable = new ElizaError(
          "App-managed Anthropic credential file is corrupt (invalid JSON)",
          {
            code: "CREDENTIALS_CORRUPT",
            cause: error,
            context: { credentialPath },
          }
        );
      }
      continue;
    }

    const access = parsed.credentials?.access?.trim();
    if (!access) continue;
    const expires = parsed.credentials?.expires;
    const token: OAuthToken = {
      accessToken: access,
      expiresAt:
        typeof expires === "number" && Number.isFinite(expires)
          ? expires
          : Number.POSITIVE_INFINITY,
    };
    if (Date.now() < token.expiresAt - 60_000) {
      return { token };
    }
  }

  tokenCache.delete(APP_CREDENTIAL_CACHE_KEY);
  return { token: null, error: unreadable };
}

function readFromCredentialStore(): ClaudeCredentials | null {
  const { join } = require("node:path") as typeof import("node:path");
  const { homedir } = require("node:os") as typeof import("node:os");

  const configDirOverride = getEnvVar("CLAUDE_CONFIG_DIR")?.trim();
  const configDir = configDirOverride || join(homedir(), ".claude");

  const credPath = join(configDir, ".credentials.json");
  const { readFileSync } = require("node:fs") as typeof import("node:fs");

  let raw: string;
  try {
    raw = readFileSync(credPath, "utf-8");
  } catch (error) {
    // error-policy:J3 untrusted-input sanitizing — a missing credential file is
    // the expected "not authenticated this way" signal (null). Any other read
    // failure (permissions, I/O) is a real problem the caller must not read as
    // "no credentials", so it surfaces as a typed error.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw new ElizaError("Failed to read Claude credential file", {
      code: "CREDENTIALS_UNREADABLE",
      cause: error,
      context: { credPath },
    });
  }

  // A file that exists but does not parse is corrupt, not absent — surfacing it
  // prevents a silent downgrade of auth that would look identical to "no creds".
  try {
    return JSON.parse(raw);
  } catch (error) {
    // error-policy:J2 context-adding rethrow — typed CREDENTIALS_CORRUPT with cause.
    throw new ElizaError("Claude credential file is corrupt (invalid JSON)", {
      code: "CREDENTIALS_CORRUPT",
      cause: error,
      context: { credPath },
    });
  }
}
