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
  DIRECT_ACCOUNT_PROVIDER_ENV,
  type DirectAccountProvider,
  getAccessToken,
  listProviderAccounts,
} from "@elizaos/agent";
import { logger } from "@elizaos/core";
import { getDefaultAccountPool } from "../account-pool.js";

// ── Credential source registry ───────────────────────────────────────

interface CredentialSource {
  providerId: string;
  envVar: string;
  /** "subscription" means the value is an OAuth token for the subscription flow. */
  authType: "api-key" | "subscription";
  resolve: () => string | null;
}

const CREDENTIAL_SOURCES: CredentialSource[] = [
  // Direct API keys
  {
    providerId: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    authType: "api-key",
    resolve: () => process.env.ANTHROPIC_API_KEY?.trim() || null,
  },
  {
    providerId: "openai",
    envVar: "OPENAI_API_KEY",
    authType: "api-key",
    resolve: () => process.env.OPENAI_API_KEY?.trim() || null,
  },
  {
    providerId: "groq",
    envVar: "GROQ_API_KEY",
    authType: "api-key",
    resolve: () => process.env.GROQ_API_KEY?.trim() || null,
  },
  {
    providerId: "gemini",
    envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    authType: "api-key",
    resolve: () =>
      process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
      process.env.GOOGLE_API_KEY?.trim() ||
      null,
  },
  {
    providerId: "openrouter",
    envVar: "OPENROUTER_API_KEY",
    authType: "api-key",
    resolve: () => process.env.OPENROUTER_API_KEY?.trim() || null,
  },
  {
    providerId: "grok",
    envVar: "XAI_API_KEY",
    authType: "api-key",
    resolve: () => process.env.XAI_API_KEY?.trim() || null,
  },
  {
    providerId: "deepseek",
    envVar: "DEEPSEEK_API_KEY",
    authType: "api-key",
    resolve: () => process.env.DEEPSEEK_API_KEY?.trim() || null,
  },
  {
    providerId: "mistral",
    envVar: "MISTRAL_API_KEY",
    authType: "api-key",
    resolve: () => process.env.MISTRAL_API_KEY?.trim() || null,
  },
  {
    providerId: "together",
    envVar: "TOGETHER_API_KEY",
    authType: "api-key",
    resolve: () => process.env.TOGETHER_API_KEY?.trim() || null,
  },
  {
    providerId: "zai",
    envVar: "ZAI_API_KEY",
    authType: "api-key",
    resolve: () =>
      process.env.ZAI_API_KEY?.trim() ||
      process.env.Z_AI_API_KEY?.trim() ||
      null,
  },
  {
    providerId: "moonshot",
    envVar: "MOONSHOT_API_KEY",
    authType: "api-key",
    resolve: () =>
      process.env.MOONSHOT_API_KEY?.trim() ||
      process.env.KIMI_API_KEY?.trim() ||
      null,
  },
];

const DIRECT_ACCOUNT_PROVIDER_BY_REQUEST: Readonly<
  Record<string, DirectAccountProvider>
> = {
  anthropic: "anthropic-api",
  "anthropic-api": "anthropic-api",
  openai: "openai-api",
  "openai-api": "openai-api",
  deepseek: "deepseek-api",
  "deepseek-api": "deepseek-api",
  zai: "zai-api",
  "z.ai": "zai-api",
  "zai-api": "zai-api",
  moonshot: "moonshot-api",
  kimi: "moonshot-api",
  moonshotai: "moonshot-api",
  "moonshot-api": "moonshot-api",
};

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
  for (const source of CREDENTIAL_SOURCES) {
    if (source.providerId !== providerId) continue;
    const key = source.resolve();
    if (key) {
      logger.info(
        `[credential-resolver] Resolved ${source.envVar} for ${providerId} (${key.length} chars, ${source.authType})`,
      );
      return {
        providerId: source.providerId,
        envVar: source.envVar,
        apiKey: key,
        authType: source.authType,
      };
    }
  }
  return null;
}

/**
 * Multi-account credential resolution. When the install has any
 * `LinkedAccountConfig` records for the requested provider, the pool
 * picks one (priority by default, with health-aware skipping) and we
 * return its access token via WS1's `getAccessToken`. When no accounts
 * are configured, falls back to the legacy single-source resolver.
 *
 * `sessionKey` (optional) keeps repeated calls in the same logical
 * session glued to the same account so token refreshes and rate-limit
 * tracking stay coherent.
 */
export async function resolveProviderCredentialMulti(
  providerId: string,
  opts?: { sessionKey?: string; exclude?: string[] },
): Promise<ResolvedCredential | null> {
  const subscriptionMatch =
    providerId === "anthropic-subscription" ||
    providerId === "openai-codex" ||
    providerId === "gemini-cli" ||
    providerId === "zai-coding" ||
    providerId === "kimi-coding" ||
    providerId === "deepseek-coding";
  if (subscriptionMatch) {
    logger.info(
      `[credential-resolver] Refusing to expose ${providerId} as a direct API credential; subscription coding plans must use their first-party coding surface.`,
    );
    return null;
  }
  const directProvider = DIRECT_ACCOUNT_PROVIDER_BY_REQUEST[providerId];
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
  for (const source of CREDENTIAL_SOURCES) {
    if (seen.has(source.envVar)) continue;
    const key = source.resolve();
    if (key) {
      seen.add(source.envVar);
      results.push({
        providerId: source.providerId,
        envVar: source.envVar,
        apiKey: key,
        authType: source.authType,
      });
    }
  }
  return results;
}
