/**
 * Shared onboarding contracts.
 */

import type { WalletConfigUpdateRequest } from "./wallet";

export interface StylePreset {
  catchphrase: string;
  hint: string;
  bio: string[];
  system: string;
  adjectives: string[];
  style: {
    all: string[];
    chat: string[];
    post: string[];
  };
  postExamples: string[];
  postExamples_zhCN?: string[];
  messageExamples: Array<
    Array<{
      user: string;
      content: { text: string };
    }>
  >;
}

export type OnboardingProviderFamily =
  | "anthropic"
  | "deepseek"
  | "elizacloud"
  | "gemini"
  | "grok"
  | "groq"
  | "mistral"
  | "ollama"
  | "openai"
  | "openrouter"
  | "pi-ai"
  | "together"
  | "zai";

export type OnboardingProviderId =
  | "anthropic"
  | "anthropic-subscription"
  | "deepseek"
  | "elizacloud"
  | "gemini"
  | "grok"
  | "groq"
  | "mistral"
  | "ollama"
  | "openai"
  | "openai-subscription"
  | "openrouter"
  | "pi-ai"
  | "together"
  | "zai";

export type OnboardingProviderAuthMode =
  | "api-key"
  | "cloud"
  | "credentials"
  | "local"
  | "subscription";

export type OnboardingProviderGroup = "cloud" | "local" | "subscription";

export interface ProviderOption {
  id: OnboardingProviderId;
  name: string;
  envKey: string | null;
  pluginName: string;
  keyPrefix: string | null;
  description: string;
  family: OnboardingProviderFamily;
  authMode: OnboardingProviderAuthMode;
  group: OnboardingProviderGroup;
  order: number;
  recommended?: boolean;
  labelKey?: string;
  storedProvider?: string;
  supportsPrimaryModelOverride?: boolean;
}

export interface CloudProviderOption {
  id: "elizacloud";
  name: string;
  description: string;
}

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  description: string;
}

export interface OpenRouterModelOption {
  id: string;
  name: string;
  description: string;
}

export interface PiAiModelOption {
  id: string;
  name: string;
  provider: string;
  isDefault: boolean;
}

export interface MessageExampleContent {
  text: string;
  actions?: string[];
}

export interface MessageExample {
  user: string;
  content: MessageExampleContent;
}

export interface ConnectorConfig {
  enabled?: boolean;
  botToken?: string;
  token?: string;
  apiKey?: string;
  [key: string]:
    | string
    | boolean
    | number
    | string[]
    | Record<string, unknown>
    | undefined;
}

export interface RpcProviderOption {
  id: string;
  label: string;
  envKey?: string | null;
  requiresKey?: boolean;
}

export interface InventoryProviderOption {
  id: string;
  name: string;
  description: string;
  rpcProviders: RpcProviderOption[];
}

export type SubscriptionProviderSelectionId =
  | "anthropic-subscription"
  | "openai-subscription";

export type StoredSubscriptionProviderId =
  | "anthropic-subscription"
  | "openai-codex";

export const SUBSCRIPTION_PROVIDER_SELECTIONS = [
  {
    id: "anthropic-subscription",
    storedProvider: "anthropic-subscription",
    family: "anthropic",
    labelKey: "providerswitcher.claudeSubscription",
  },
  {
    id: "openai-subscription",
    storedProvider: "openai-codex",
    family: "openai",
    labelKey: "providerswitcher.chatgptSubscription",
  },
] as const satisfies ReadonlyArray<{
  id: SubscriptionProviderSelectionId;
  storedProvider: StoredSubscriptionProviderId;
  family: "anthropic" | "openai";
  labelKey: string;
}>;

export const ONBOARDING_PROVIDER_CATALOG = [
  {
    id: "elizacloud",
    name: "Eliza Cloud",
    envKey: null,
    pluginName: "@elizaos/plugin-elizacloud",
    keyPrefix: null,
    description: "Managed hosting for Eliza agents and bundled infrastructure.",
    family: "elizacloud",
    authMode: "cloud",
    group: "cloud",
    order: 10,
    recommended: true,
  },
  {
    id: "anthropic-subscription",
    name: "Claude Subscription",
    envKey: null,
    pluginName: "@elizaos/plugin-anthropic",
    keyPrefix: null,
    description:
      "Use your Claude Pro or Max subscription via OAuth or setup token.",
    family: "anthropic",
    authMode: "subscription",
    group: "subscription",
    order: 20,
    recommended: true,
    labelKey: "providerswitcher.claudeSubscription",
    storedProvider: "anthropic-subscription",
  },
  {
    id: "openai-subscription",
    name: "ChatGPT Subscription",
    envKey: null,
    pluginName: "@elizaos/plugin-openai",
    keyPrefix: null,
    description: "Use your ChatGPT Plus or Pro subscription via OAuth.",
    family: "openai",
    authMode: "subscription",
    group: "subscription",
    order: 30,
    recommended: true,
    labelKey: "providerswitcher.chatgptSubscription",
    storedProvider: "openai-codex",
  },
  {
    id: "pi-ai",
    name: "Pi Credentials",
    envKey: null,
    pluginName: "@elizaos/plugin-pi-ai",
    keyPrefix: null,
    description:
      "Use credentials from ~/.pi/agent/auth.json (API keys or OAuth).",
    family: "pi-ai",
    authMode: "credentials",
    group: "local",
    order: 40,
    supportsPrimaryModelOverride: true,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    pluginName: "@elizaos/plugin-anthropic",
    keyPrefix: "sk-ant-",
    description: "Claude models via API key.",
    family: "anthropic",
    authMode: "api-key",
    group: "local",
    order: 50,
  },
  {
    id: "openai",
    name: "OpenAI",
    envKey: "OPENAI_API_KEY",
    pluginName: "@elizaos/plugin-openai",
    keyPrefix: "sk-",
    description: "GPT models via API key.",
    family: "openai",
    authMode: "api-key",
    group: "local",
    order: 60,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    pluginName: "@elizaos/plugin-openrouter",
    keyPrefix: "sk-or-",
    description: "Access multiple models via one API key.",
    family: "openrouter",
    authMode: "api-key",
    group: "local",
    order: 70,
    supportsPrimaryModelOverride: true,
  },
  {
    id: "gemini",
    name: "Gemini",
    envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    pluginName: "@elizaos/plugin-google-genai",
    keyPrefix: null,
    description: "Google's Gemini models.",
    family: "gemini",
    authMode: "api-key",
    group: "local",
    order: 80,
  },
  {
    id: "grok",
    name: "xAI (Grok)",
    envKey: "XAI_API_KEY",
    pluginName: "@elizaos/plugin-xai",
    keyPrefix: "xai-",
    description: "xAI's Grok models.",
    family: "grok",
    authMode: "api-key",
    group: "local",
    order: 90,
  },
  {
    id: "groq",
    name: "Groq",
    envKey: "GROQ_API_KEY",
    pluginName: "@elizaos/plugin-groq",
    keyPrefix: "gsk_",
    description: "Fast inference.",
    family: "groq",
    authMode: "api-key",
    group: "local",
    order: 100,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    pluginName: "@elizaos/plugin-deepseek",
    keyPrefix: "sk-",
    description: "DeepSeek models.",
    family: "deepseek",
    authMode: "api-key",
    group: "local",
    order: 110,
  },
  {
    id: "mistral",
    name: "Mistral",
    envKey: "MISTRAL_API_KEY",
    pluginName: "@elizaos/plugin-mistral",
    keyPrefix: null,
    description: "Mistral AI models.",
    family: "mistral",
    authMode: "api-key",
    group: "local",
    order: 120,
  },
  {
    id: "together",
    name: "Together AI",
    envKey: "TOGETHER_API_KEY",
    pluginName: "@elizaos/plugin-together",
    keyPrefix: null,
    description: "Open-source model hosting.",
    family: "together",
    authMode: "api-key",
    group: "local",
    order: 130,
  },
  {
    id: "ollama",
    name: "Ollama",
    envKey: null,
    pluginName: "@elizaos/plugin-ollama",
    keyPrefix: null,
    description: "Local models, no API key needed.",
    family: "ollama",
    authMode: "local",
    group: "local",
    order: 140,
  },
  {
    id: "zai",
    name: "z.ai",
    envKey: "ZAI_API_KEY",
    pluginName: "@homunculuslabs/plugin-zai",
    keyPrefix: null,
    description: "GLM models via z.ai Coding Plan.",
    family: "zai",
    authMode: "api-key",
    group: "local",
    order: 150,
  },
] as const satisfies ReadonlyArray<ProviderOption>;

export const ONBOARDING_CLOUD_PROVIDER_OPTIONS = [
  {
    id: "elizacloud",
    name: "Eliza Cloud",
    description:
      "Managed cloud infrastructure. Wallets, LLMs, and RPCs included.",
  },
] as const satisfies ReadonlyArray<CloudProviderOption>;

export type OnboardingLocalProviderId = Exclude<
  OnboardingProviderId,
  "elizacloud"
>;

export interface OnboardingCloudManagedConnection {
  kind: "cloud-managed";
  cloudProvider: "elizacloud";
  apiKey?: string;
  smallModel?: string;
  largeModel?: string;
}

export interface OnboardingLocalProviderConnection {
  kind: "local-provider";
  provider: OnboardingLocalProviderId;
  apiKey?: string;
  primaryModel?: string;
}

export interface OnboardingRemoteProviderConnection {
  kind: "remote-provider";
  remoteApiBase: string;
  remoteAccessToken?: string;
  provider?: OnboardingLocalProviderId;
  apiKey?: string;
  primaryModel?: string;
}

export type OnboardingConnection =
  | OnboardingCloudManagedConnection
  | OnboardingLocalProviderConnection
  | OnboardingRemoteProviderConnection;

export interface OnboardingOptions {
  names: string[];
  styles: StylePreset[];
  providers: ProviderOption[];
  cloudProviders: CloudProviderOption[];
  models: {
    small: ModelOption[];
    large: ModelOption[];
  };
  openrouterModels?: OpenRouterModelOption[];
  piAiModels?: PiAiModelOption[];
  piAiDefaultModel?: string | null;
  inventoryProviders: InventoryProviderOption[];
  sharedStyleRules: string;
  githubOAuthAvailable?: boolean;
}

export interface OnboardingData {
  name: string;
  sandboxMode?: "off" | "light" | "standard" | "max";
  bio: string[];
  systemPrompt: string;
  style?: {
    all: string[];
    chat: string[];
    post: string[];
  };
  adjectives?: string[];
  postExamples?: string[];
  messageExamples?: MessageExample[][];
  connection: OnboardingConnection;
  channels?: Record<string, unknown>;
  walletConfig?: WalletConfigUpdateRequest;
  inventoryProviders?: Array<{
    chain: string;
    rpcProvider: string;
    rpcApiKey?: string;
  }>;
  connectors?: Record<string, ConnectorConfig>;
  telegramToken?: string;
  discordToken?: string;
  whatsappSessionPath?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioPhoneNumber?: string;
  blooioApiKey?: string;
  blooioPhoneNumber?: string;
  githubToken?: string;
}

export interface SubscriptionProviderStatus {
  provider: string;
  configured: boolean;
  valid: boolean;
  expiresAt: number | null;
}

export interface SubscriptionStatusResponse {
  providers: SubscriptionProviderStatus[];
}

const ONBOARDING_PROVIDER_ALIASES: Record<string, OnboardingProviderId> = {
  "openai-codex": "openai-subscription",
  "openai-subscription": "openai-subscription",
  "anthropic-subscription": "anthropic-subscription",
  google: "gemini",
  "google-genai": "gemini",
  gemini: "gemini",
  xai: "grok",
  grok: "grok",
  "together-ai": "together",
  together: "together",
  "z.ai": "zai",
  zai: "zai",
};

export function isSubscriptionProviderSelectionId(
  value: unknown,
): value is SubscriptionProviderSelectionId {
  return SUBSCRIPTION_PROVIDER_SELECTIONS.some(
    (provider) => provider.id === value,
  );
}

export function normalizeSubscriptionProviderSelectionId(
  value: unknown,
): SubscriptionProviderSelectionId | null {
  if (value === "anthropic-subscription") return "anthropic-subscription";
  if (value === "openai-subscription" || value === "openai-codex") {
    return "openai-subscription";
  }
  return null;
}

export function getStoredSubscriptionProvider(
  selectionId: SubscriptionProviderSelectionId,
): StoredSubscriptionProviderId {
  return selectionId === "anthropic-subscription"
    ? "anthropic-subscription"
    : "openai-codex";
}

export function getSubscriptionProviderFamily(
  selectionId: SubscriptionProviderSelectionId,
): "anthropic" | "openai" {
  return selectionId === "anthropic-subscription" ? "anthropic" : "openai";
}

export function normalizeOnboardingProviderId(
  value: unknown,
): OnboardingProviderId | null {
  if (typeof value !== "string") return null;
  const directMatch = ONBOARDING_PROVIDER_CATALOG.find(
    (provider) => provider.id === value,
  );
  if (directMatch) {
    return directMatch.id;
  }
  return ONBOARDING_PROVIDER_ALIASES[value] ?? null;
}

export function getOnboardingProviderOption(
  providerId: unknown,
): ProviderOption | null {
  const normalized = normalizeOnboardingProviderId(providerId);
  if (!normalized) return null;
  return (
    ONBOARDING_PROVIDER_CATALOG.find(
      (provider) => provider.id === normalized,
    ) ?? null
  );
}

export function getOnboardingProviderFamily(
  providerId: unknown,
): OnboardingProviderFamily | null {
  return getOnboardingProviderOption(providerId)?.family ?? null;
}

export function getStoredOnboardingProviderId(
  providerId: unknown,
): string | null {
  const provider = getOnboardingProviderOption(providerId);
  if (!provider) return null;
  return provider.storedProvider ?? provider.id;
}

export function sortOnboardingProviders(
  providers: readonly ProviderOption[],
): ProviderOption[] {
  return [...providers].sort((left, right) => {
    const recommendedDelta =
      Number(Boolean(right.recommended)) - Number(Boolean(left.recommended));
    if (recommendedDelta !== 0) {
      return recommendedDelta;
    }
    return left.order - right.order;
  });
}

export function isCloudManagedConnection(
  connection: OnboardingConnection | null | undefined,
): connection is OnboardingCloudManagedConnection {
  return connection?.kind === "cloud-managed";
}

export function isRemoteProviderConnection(
  connection: OnboardingConnection | null | undefined,
): connection is OnboardingRemoteProviderConnection {
  return connection?.kind === "remote-provider";
}

export function isLocalProviderConnection(
  connection: OnboardingConnection | null | undefined,
): connection is OnboardingLocalProviderConnection {
  return connection?.kind === "local-provider";
}
