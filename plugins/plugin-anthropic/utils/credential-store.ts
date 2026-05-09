/**
 * Anthropic OAuth credential store with multi-account support.
 *
 * If the host runtime has installed the account-pool bridge on
 * `globalThis` (app-core does this when the multi-account `LinkedAccountConfig`
 * store is non-empty), token reads route through the pool: `select` picks
 * the active account, the OAuth fetch wrapper retries on 401 against a
 * different account, and the pool tracks rate-limited / invalid health.
 *
 * Without the bridge, behavior uses the single-source flow
 * (env var → keychain → ~/.claude/.credentials.json).
 */

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

interface AccountPoolBridge {
  /** Pick an Anthropic subscription account; null when none are eligible. */
  selectAnthropicSubscription(opts?: {
    sessionKey?: string;
    exclude?: string[];
  }): Promise<{ id: string; expiresAt: number } | null>;
  /** Get an access token for a previously-selected account. */
  getAccessToken(providerId: "anthropic-subscription", accountId: string): Promise<string | null>;
  /** Mark health = invalid (e.g. persistent 401 after refresh). */
  markInvalid(accountId: string, detail?: string): void | Promise<void>;
  /** Mark health = rate-limited until `untilMs`. */
  markRateLimited(accountId: string, untilMs: number, detail?: string): void | Promise<void>;
}

const AccountPoolBridgeSymbol: unique symbol = Symbol.for("eliza.account-pool.anthropic.v1");

function getAccountPoolBridge(): AccountPoolBridge | undefined {
  if (typeof globalThis === "undefined") return undefined;
  const slot = (globalThis as Record<symbol, unknown>)[AccountPoolBridgeSymbol];
  return slot as AccountPoolBridge | undefined;
}

export const ANTHROPIC_ACCOUNT_POOL_SYMBOL = AccountPoolBridgeSymbol;

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
  const appToken = readAppManagedAnthropicToken();
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
  const appToken = readAppManagedAnthropicToken();
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
  const appToken = readAppManagedAnthropicToken();
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
  if (typeof process === "undefined") return undefined;
  return process.env[key];
}

function readAppManagedAnthropicToken(): OAuthToken | null {
  if (typeof process === "undefined") return null;

  const cached = tokenCache.get(APP_CREDENTIAL_CACHE_KEY);
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached;
  }

  const { join } = require("node:path") as typeof import("node:path");
  const { homedir } = require("node:os") as typeof import("node:os");
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const namespace = getEnvVar("ELIZA_NAMESPACE")?.trim() || "eliza";
  const stateDir = getEnvVar("ELIZA_STATE_DIR")?.trim() || join(homedir(), `.${namespace}`);
  const accountId = getEnvVar("ANTHROPIC_SUBSCRIPTION_ACCOUNT_ID")?.trim() || "default";
  const paths = [
    join(stateDir, "auth", "anthropic-subscription", `${accountId}.json`),
    join(homedir(), ".eliza", "auth", "anthropic-subscription", `${accountId}.json`),
    join(homedir(), ".eliza", "auth", "anthropic-subscription.json"),
  ];

  for (const credentialPath of paths) {
    try {
      const parsed = JSON.parse(
        readFileSync(credentialPath, "utf-8")
      ) as AppSubscriptionCredentials;
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
        return token;
      }
    } catch {
      // Try the next known app-managed credential location.
    }
  }

  tokenCache.delete(APP_CREDENTIAL_CACHE_KEY);
  return null;
}

function readFromCredentialStore(): ClaudeCredentials | null {
  if (typeof process === "undefined") return null;

  const { join } = require("node:path") as typeof import("node:path");
  const { homedir } = require("node:os") as typeof import("node:os");

  if (process.platform === "darwin") {
    const fromKeychain = readFromMacKeychain();
    if (fromKeychain) return fromKeychain;
  }

  const configDir = getEnvVar("CLAUDE_CONFIG_DIR") ?? join(homedir(), ".claude");
  const credPath = join(configDir, ".credentials.json");
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const raw = readFileSync(credPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readFromMacKeychain(): ClaudeCredentials | null {
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
