/**
 * Direct-API provider surface for the team credential pool (#11332).
 *
 * Phase 1 pools provider API keys only. Subscription providers
 * (`anthropic-subscription`, `openai-codex`, coding CLIs) are per-seat
 * licenses and are rejected here — Phase 2 gates them behind an explicit
 * flag + org allowlist, never the public API.
 */

import type { LinkedAccountProviderId } from "@elizaos/contracts";
import type { SecretProvider } from "../../../db/schemas/secrets";

export const POOLED_DIRECT_PROVIDERS = [
  "anthropic-api",
  "openai-api",
  "deepseek-api",
  "zai-api",
  "moonshot-api",
  "cerebras-api",
] as const satisfies readonly LinkedAccountProviderId[];

export type PooledDirectProvider = (typeof POOLED_DIRECT_PROVIDERS)[number];

export function isPooledDirectProvider(value: string): value is PooledDirectProvider {
  return (POOLED_DIRECT_PROVIDERS as readonly string[]).includes(value);
}

/** Providers Phase 1 must refuse with a clear "Phase 2" message. */
export const SUBSCRIPTION_PROVIDER_IDS = [
  "anthropic-subscription",
  "openai-codex",
  "gemini-cli",
  "zai-coding",
  "kimi-coding",
  "deepseek-coding",
] as const;

export function isSubscriptionProviderId(value: string): boolean {
  return (SUBSCRIPTION_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Env var each provider's key is delivered under (matches
 * DIRECT_ACCOUNT_PROVIDER_ENV in packages/agent/src/auth/types.ts).
 */
export const POOLED_PROVIDER_ENV_KEYS: Record<PooledDirectProvider, string> = {
  "anthropic-api": "ANTHROPIC_API_KEY",
  "openai-api": "OPENAI_API_KEY",
  "deepseek-api": "DEEPSEEK_API_KEY",
  "zai-api": "ZAI_API_KEY",
  "moonshot-api": "MOONSHOT_API_KEY",
  "cerebras-api": "CEREBRAS_API_KEY",
};

/** Secrets-vault provider enum value for each pooled provider. */
export const POOLED_PROVIDER_SECRET_PROVIDER: Record<PooledDirectProvider, SecretProvider> = {
  "anthropic-api": "anthropic",
  "openai-api": "openai",
  "deepseek-api": "custom",
  "zai-api": "custom",
  "moonshot-api": "custom",
  "cerebras-api": "custom",
};

export function keyLast4(apiKey: string): string {
  return apiKey.slice(-4);
}
