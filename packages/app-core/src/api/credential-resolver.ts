/**
 * Server-side credential resolver — scans local credential stores
 * and hydrates credentials into the canonical server config + secret state.
 *
 * Credential sources:
 *   1. Claude Code OAuth → ~/.claude/.credentials.json or macOS Keychain
 *      (uses subscription auth flow, NOT direct api.anthropic.com)
 *   2. Environment variables → process.env
 *
 * The OAuth token from Claude Code is an "anthropic-subscription" credential
 * that goes through applySubscriptionCredentials(), not a direct API key.
 * Codex / Gemini / Claude subscription credentials are intentionally not
 * exposed by this resolver as API keys.
 */
import {
  getAccessToken,
  listProviderAccounts,
} from "@elizaos/auth/credentials";
import {
  DIRECT_ACCOUNT_PROVIDER_ENV,
  type DirectAccountProvider,
  isDirectAccountProvider,
} from "@elizaos/auth/types";
import {
  getDirectAccountProviderForFirstRunProvider,
  getFirstRunProviderOption,
  getStoredSubscriptionProviderForRequest,
  logger,
  MODEL_PROVIDER_SECRETS,
  normalizeFirstRunProviderId,
  SECRET_KEY_ALIASES,
} from "@elizaos/core";
import { getDefaultAccountPool } from "../account-pool.js";

// ── Credential source registry ───────────────────────────────────────

interface CredentialSource {
  providerId: string;
  envVars: readonly string[];
  /** "subscription" means the value is an OAuth token for the subscription flow. */
  authType: "api-key" | "subscription";
}

function envVarsForCanonicalKey(canonicalKey: string): string[] {
  return [
    canonicalKey,
    ...Object.entries(SECRET_KEY_ALIASES)
      .filter(([, target]) => target === canonicalKey)
      .map(([alias]) => alias),
  ];
}

function readFirstEnvValue(envVars: readonly string[]) {
  for (const envVar of envVars) {
    const value = process.env[envVar]?.trim();
    if (value) return { envVar, value };
  }
  return null;
}

function normalizeCredentialProviderId(providerId: string): string {
  const normalizedFirstRunProvider = normalizeFirstRunProviderId(providerId);
  return normalizedFirstRunProvider ?? providerId.trim().toLowerCase();
}

function canonicalProviderEnvVar(providerId: string): string | null {
  const firstRunProvider = getFirstRunProviderOption(providerId);
  const firstRunEnvVar = firstRunProvider?.envKey;
  if (firstRunEnvVar) {
    return SECRET_KEY_ALIASES[firstRunEnvVar] ?? firstRunEnvVar;
  }
  return MODEL_PROVIDER_SECRETS[providerId] ?? null;
}

function sourceForProvider(providerId: string): CredentialSource | null {
  const normalized = normalizeCredentialProviderId(providerId);
  const canonicalEnvVar = canonicalProviderEnvVar(normalized);
  if (!canonicalEnvVar?.endsWith("_API_KEY")) return null;
  return {
    providerId: normalized,
    envVars: envVarsForCanonicalKey(canonicalEnvVar),
    authType: "api-key",
  };
}

function directAccountProviderForRequest(
  providerId: string,
): DirectAccountProvider | null {
  const normalized = providerId.trim().toLowerCase();
  if (isDirectAccountProvider(normalized)) return normalized;
  const firstRunProvider = normalizeFirstRunProviderId(providerId);
  if (!firstRunProvider) return null;
  const directProvider =
    getDirectAccountProviderForFirstRunProvider(firstRunProvider);
  return isDirectAccountProvider(directProvider) ? directProvider : null;
}

function subscriptionProviderForRequest(providerId: string): string | null {
  return getStoredSubscriptionProviderForRequest(providerId);
}

// ── Public API ───────────────────────────────────────────────────────

export interface ResolvedCredential {
  providerId: string;
  envVar: string;
  apiKey: string;
  authType: "api-key" | "subscription";
}

/**
 * Resolve the real credential for a specific provider.
 */
export function resolveProviderCredential(
  providerId: string,
): ResolvedCredential | null {
  const source = sourceForProvider(providerId);
  if (!source) return null;
  const resolved = readFirstEnvValue(source.envVars);
  if (resolved) {
    logger.info(
      `[credential-resolver] Resolved ${resolved.envVar} for ${providerId} (${resolved.value.length} chars, ${source.authType})`,
    );
    return {
      providerId: source.providerId,
      envVar: resolved.envVar,
      apiKey: resolved.value,
      authType: source.authType,
    };
  }
  return null;
}

/**
 * Multi-account credential resolution. When the install has any
 * `LinkedAccountConfig` records for the requested provider, the pool
 * picks one (priority by default, with health-aware skipping) and we
 * return its access token via `getAccessToken` from `@elizaos/agent`. When
 * no accounts are configured, falls back to the env-based single-source resolver.
 *
 * `sessionKey` (optional) keeps repeated calls in the same logical
 * session glued to the same account so token refreshes and rate-limit
 * tracking stay coherent.
 */
export async function resolveProviderCredentialMulti(
  providerId: string,
  opts?: { sessionKey?: string; exclude?: string[] },
): Promise<ResolvedCredential | null> {
  const subscriptionProvider = subscriptionProviderForRequest(providerId);
  if (subscriptionProvider) {
    logger.info(
      `[credential-resolver] Refusing to expose ${providerId} as a direct API credential; subscription coding plans must use their first-party coding surface.`,
    );
    return null;
  }
  const directProvider = directAccountProviderForRequest(providerId);
  if (directProvider) {
    const accounts = listProviderAccounts(directProvider);
    if (accounts.length > 0) {
      const pool = getDefaultAccountPool();
      const account = await pool.select({
        providerId: directProvider,
        sessionKey: opts?.sessionKey,
        exclude: opts?.exclude,
      });
      if (account) {
        const token = await getAccessToken(directProvider, account.id);
        if (token) {
          const envVar = DIRECT_ACCOUNT_PROVIDER_ENV[directProvider];
          logger.info(
            `[credential-resolver] Multi-account: serving ${providerId} from "${account.label}" (${account.id})`,
          );
          return {
            providerId,
            envVar,
            apiKey: token,
            authType: "api-key",
          };
        }
      }
    }
  }
  return resolveProviderCredential(providerId);
}

/**
 * Scan all credential sources. Returns every provider that has a
 * resolvable credential on this machine.
 */
export function scanAllCredentials(): ResolvedCredential[] {
  const results: ResolvedCredential[] = [];
  const seen = new Set<string>();
  for (const providerId of Object.keys(MODEL_PROVIDER_SECRETS)) {
    const source = sourceForProvider(providerId);
    if (!source) continue;
    const resolved = readFirstEnvValue(source.envVars);
    if (resolved && !seen.has(resolved.envVar)) {
      seen.add(resolved.envVar);
      results.push({
        providerId: source.providerId,
        envVar: resolved.envVar,
        apiKey: resolved.value,
        authType: source.authType,
      });
    }
  }
  return results;
}
