/**
 * Subscription auth types for eliza.
 */

export interface OAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
}

export type SubscriptionProvider =
  | "anthropic-subscription"
  | "openai-codex"
  | "gemini-cli"
  | "zai-coding"
  | "kimi-coding"
  | "deepseek-coding";

export type OAuthSubscriptionProvider =
  | "anthropic-subscription"
  | "openai-codex";

export type CodingPlanKeySubscriptionProvider = "zai-coding" | "kimi-coding";

export type ExternalCliSubscriptionProvider = "gemini-cli";

export type UnavailableSubscriptionProvider = "deepseek-coding";

export type DirectAccountProvider =
  | "anthropic-api"
  | "openai-api"
  | "deepseek-api"
  | "zai-api"
  | "moonshot-api";

export type AccountCredentialProvider =
  | SubscriptionProvider
  | DirectAccountProvider;

export const SUBSCRIPTION_PROVIDER_IDS = [
  "anthropic-subscription",
  "openai-codex",
  "gemini-cli",
  "zai-coding",
  "kimi-coding",
  "deepseek-coding",
] as const satisfies readonly SubscriptionProvider[];

export const OAUTH_SUBSCRIPTION_PROVIDER_IDS = [
  "anthropic-subscription",
  "openai-codex",
] as const satisfies readonly OAuthSubscriptionProvider[];

export const CODING_PLAN_KEY_SUBSCRIPTION_PROVIDER_IDS = [
  "zai-coding",
  "kimi-coding",
] as const satisfies readonly CodingPlanKeySubscriptionProvider[];

export const EXTERNAL_CLI_SUBSCRIPTION_PROVIDER_IDS = [
  "gemini-cli",
] as const satisfies readonly ExternalCliSubscriptionProvider[];

export const UNAVAILABLE_SUBSCRIPTION_PROVIDER_IDS = [
  "deepseek-coding",
] as const satisfies readonly UnavailableSubscriptionProvider[];

export const DIRECT_ACCOUNT_PROVIDER_IDS = [
  "anthropic-api",
  "openai-api",
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

export function isOAuthSubscriptionProvider(
  value: unknown,
): value is OAuthSubscriptionProvider {
  return (OAUTH_SUBSCRIPTION_PROVIDER_IDS as readonly unknown[]).includes(
    value,
  );
}

export function isCodingPlanKeySubscriptionProvider(
  value: unknown,
): value is CodingPlanKeySubscriptionProvider {
  return (
    CODING_PLAN_KEY_SUBSCRIPTION_PROVIDER_IDS as readonly unknown[]
  ).includes(value);
}

export function isExternalCliSubscriptionProvider(
  value: unknown,
): value is ExternalCliSubscriptionProvider {
  return (
    EXTERNAL_CLI_SUBSCRIPTION_PROVIDER_IDS as readonly unknown[]
  ).includes(value);
}

export function isUnavailableSubscriptionProvider(
  value: unknown,
): value is UnavailableSubscriptionProvider {
  return (UNAVAILABLE_SUBSCRIPTION_PROVIDER_IDS as readonly unknown[]).includes(
    value,
  );
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
  "deepseek-api": "DEEPSEEK_API_KEY",
  "zai-api": "ZAI_API_KEY",
  "moonshot-api": "MOONSHOT_API_KEY",
};

/** Maps subscription provider IDs to their model provider short names. */
export const SUBSCRIPTION_PROVIDER_MAP: Record<SubscriptionProvider, string> = {
  "anthropic-subscription": "anthropic",
  "openai-codex": "codex-cli",
  "gemini-cli": "gemini-cli",
  "zai-coding": "zai-coding",
  "kimi-coding": "kimi-coding",
  "deepseek-coding": "deepseek-coding",
};

export const CODING_PLAN_PROVIDER_BASE_URL: Record<
  CodingPlanKeySubscriptionProvider,
  string
> = {
  "zai-coding": "https://api.z.ai/api/coding/paas/v4",
  "kimi-coding": "https://api.kimi.com/coding/v1",
};

export type SubscriptionProviderAuthMode =
  | "oauth"
  | "external-cli"
  | "coding-plan-key"
  | "unavailable";

export type SubscriptionProviderBillingMode =
  | "subscription-coding-plan"
  | "subscription-coding-cli";

export type SubscriptionProviderAvailability =
  | "available"
  | "external"
  | "unavailable";

export interface SubscriptionProviderMetadata {
  providerId: SubscriptionProvider;
  displayName: string;
  selectionIds: readonly string[];
  allowedClient: string;
  billingMode: SubscriptionProviderBillingMode;
  authMode: SubscriptionProviderAuthMode;
  availability: SubscriptionProviderAvailability;
  setupHint: string;
  directProviderId?: DirectAccountProvider;
  defaultBaseUrl?: string;
  probePath?: string;
  availabilityReason?: string;
}

export const SUBSCRIPTION_PROVIDER_METADATA: Record<
  SubscriptionProvider,
  SubscriptionProviderMetadata
> = {
  "anthropic-subscription": {
    providerId: "anthropic-subscription",
    displayName: "Claude Subscription",
    selectionIds: ["anthropic-subscription"],
    allowedClient: "Claude Code CLI",
    billingMode: "subscription-coding-cli",
    authMode: "oauth",
    availability: "available",
    setupHint: "Sign in through the app or run claude auth login.",
    directProviderId: "anthropic-api",
  },
  "openai-codex": {
    providerId: "openai-codex",
    displayName: "OpenAI Codex",
    selectionIds: ["openai-subscription"],
    allowedClient: "Codex CLI / Codex-backed provider",
    billingMode: "subscription-coding-cli",
    authMode: "oauth",
    availability: "available",
    setupHint: "Sign in through the app or run codex login.",
    directProviderId: "openai-api",
  },
  "gemini-cli": {
    providerId: "gemini-cli",
    displayName: "Gemini CLI",
    selectionIds: ["gemini-subscription"],
    allowedClient: "Gemini CLI",
    billingMode: "subscription-coding-cli",
    authMode: "external-cli",
    availability: "external",
    setupHint:
      "Run gemini auth login; tokens are not imported into API env vars.",
  },
  "zai-coding": {
    providerId: "zai-coding",
    displayName: "z.ai Coding Plan",
    selectionIds: ["zai-coding-subscription"],
    allowedClient: "z.ai Coding endpoint",
    billingMode: "subscription-coding-plan",
    authMode: "coding-plan-key",
    availability: "available",
    setupHint:
      "Add a z.ai Coding Plan credential for the dedicated coding endpoint.",
    directProviderId: "zai-api",
    defaultBaseUrl: CODING_PLAN_PROVIDER_BASE_URL["zai-coding"],
    probePath: "/models",
  },
  "kimi-coding": {
    providerId: "kimi-coding",
    displayName: "Kimi Code",
    selectionIds: ["kimi-coding-subscription"],
    allowedClient: "Kimi Code endpoint",
    billingMode: "subscription-coding-plan",
    authMode: "coding-plan-key",
    availability: "available",
    setupHint: "Add a Kimi Code credential for the dedicated coding endpoint.",
    directProviderId: "moonshot-api",
    defaultBaseUrl: CODING_PLAN_PROVIDER_BASE_URL["kimi-coding"],
    probePath: "/models",
  },
  "deepseek-coding": {
    providerId: "deepseek-coding",
    displayName: "DeepSeek Coding Plan",
    selectionIds: ["deepseek-coding-subscription"],
    allowedClient: "Unavailable",
    billingMode: "subscription-coding-plan",
    authMode: "unavailable",
    availability: "unavailable",
    setupHint:
      "Use the DeepSeek direct API-key provider if you have API billing.",
    directProviderId: "deepseek-api",
    availabilityReason:
      "No first-party DeepSeek coding subscription surface is available to integrate without substituting general API billing.",
  },
} as const;

export function getSubscriptionProviderMetadata(
  provider: SubscriptionProvider,
): SubscriptionProviderMetadata {
  return SUBSCRIPTION_PROVIDER_METADATA[provider];
}

export interface StoredCredentials {
  provider: AccountCredentialProvider;
  credentials: OAuthCredentials;
  createdAt: number;
  updatedAt: number;
}
