/**
 * Subscription auth types for eliza.
 */

export interface OAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
}

export type SubscriptionProvider = "anthropic-subscription" | "openai-codex";

export type DirectAccountProvider =
  | "anthropic-api"
  | "openai-api"
  | "openrouter-api"
  | "deepseek-api"
  | "zai-api"
  | "moonshot-api";

export type AccountCredentialProvider =
  | SubscriptionProvider
  | DirectAccountProvider;

export const SUBSCRIPTION_PROVIDER_IDS = [
  "anthropic-subscription",
  "openai-codex",
] as const satisfies readonly SubscriptionProvider[];

export const DIRECT_ACCOUNT_PROVIDER_IDS = [
  "anthropic-api",
  "openai-api",
  "openrouter-api",
  "deepseek-api",
  "zai-api",
  "moonshot-api",
] as const satisfies readonly DirectAccountProvider[];

export const ACCOUNT_CREDENTIAL_PROVIDER_IDS = [
  ...SUBSCRIPTION_PROVIDER_IDS,
  ...DIRECT_ACCOUNT_PROVIDER_IDS,
] as const satisfies readonly AccountCredentialProvider[];

export function isSubscriptionProvider(
  value: unknown,
): value is SubscriptionProvider {
  return (SUBSCRIPTION_PROVIDER_IDS as readonly unknown[]).includes(value);
}

export function isAccountCredentialProvider(
  value: unknown,
): value is AccountCredentialProvider {
  return (ACCOUNT_CREDENTIAL_PROVIDER_IDS as readonly unknown[]).includes(
    value,
  );
}

export const DIRECT_ACCOUNT_PROVIDER_ENV: Record<
  DirectAccountProvider,
  string
> = {
  "anthropic-api": "ANTHROPIC_API_KEY",
  "openai-api": "OPENAI_API_KEY",
  "openrouter-api": "OPENROUTER_API_KEY",
  "deepseek-api": "DEEPSEEK_API_KEY",
  "zai-api": "ZAI_API_KEY",
  "moonshot-api": "MOONSHOT_API_KEY",
};

/** Maps subscription provider IDs to their model provider short names. */
export const SUBSCRIPTION_PROVIDER_MAP: Record<SubscriptionProvider, string> = {
  "anthropic-subscription": "anthropic",
  "openai-codex": "openai",
};

export interface StoredCredentials {
  provider: AccountCredentialProvider;
  credentials: OAuthCredentials;
  createdAt: number;
  updatedAt: number;
}
