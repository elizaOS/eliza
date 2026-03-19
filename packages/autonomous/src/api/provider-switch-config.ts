import {
  applySubscriptionCredentials,
  deleteCredentials,
} from "@miladyai/autonomous/auth";
import type { SubscriptionProvider } from "../auth/types";
import { SUBSCRIPTION_PROVIDER_MAP } from "../auth/types";
import {
  getOnboardingProviderOption,
  isCloudManagedConnection,
  isLocalProviderConnection,
  isRemoteProviderConnection,
  normalizeOnboardingProviderId,
  type OnboardingConnection,
  type OnboardingLocalProviderId,
} from "../contracts/onboarding";
import type { MiladyConfig } from "../config/types.milady";

const REDACTED_SECRET = "[REDACTED]";

type MutableMiladyConfig = Partial<MiladyConfig> & {
  cloud?: Record<string, unknown>;
  models?: Record<string, unknown>;
  wallet?: { rpcProviders?: Record<string, string> };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function trimToUndefined(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSecret(
  value: string | null | undefined,
  existing?: string,
): string | undefined {
  const trimmed = trimToUndefined(value);
  if (!trimmed || trimmed.toUpperCase() === REDACTED_SECRET) {
    return existing;
  }
  return trimmed;
}

function ensureEnv(config: MutableMiladyConfig): Record<string, string> {
  config.env ??= {};
  return config.env as Record<string, string>;
}

function ensureDefaults(
  config: MutableMiladyConfig,
): NonNullable<NonNullable<MiladyConfig["agents"]>["defaults"]> {
  config.agents ??= {};
  config.agents.defaults ??= {};
  return config.agents.defaults;
}

function setEnvValue(
  config: MutableMiladyConfig,
  key: string,
  value: string | undefined,
): void {
  const env = ensureEnv(config);
  if (value) {
    env[key] = value;
    process.env[key] = value;
    return;
  }
  delete env[key];
  delete process.env[key];
}

function setPrimaryModel(
  config: MutableMiladyConfig,
  primaryModel: string | undefined,
): void {
  const defaults = ensureDefaults(config);
  if (!primaryModel) {
    if (defaults.model) {
      delete defaults.model.primary;
    }
    return;
  }
  defaults.model = { ...defaults.model, primary: primaryModel };
}

function clearPiAiFlag(config: MutableMiladyConfig): void {
  const env = ensureEnv(config);
  delete env.MILADY_USE_PI_AI;
  delete process.env.MILADY_USE_PI_AI;
}

function readString(
  source: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = source?.[key];
  return trimToUndefined(typeof value === "string" ? value : undefined);
}

function readEnvString(
  config: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const env = asRecord(config?.env);
  const vars = asRecord(env?.vars);
  return readString(vars, key) ?? readString(env, key);
}

function resolveConfiguredLocalProvider(
  config: Record<string, unknown> | null | undefined,
): OnboardingLocalProviderId | null {
  const agents = asRecord(config?.agents);
  const defaults = asRecord(agents?.defaults);
  const storedSubscriptionProvider = normalizeOnboardingProviderId(
    readString(defaults, "subscriptionProvider"),
  );

  if (
    storedSubscriptionProvider &&
    storedSubscriptionProvider !== "elizacloud"
  ) {
    return storedSubscriptionProvider;
  }

  const piAiEnabled = readEnvString(config, "MILADY_USE_PI_AI");
  if (piAiEnabled && piAiEnabled !== "0" && piAiEnabled !== "false") {
    return "pi-ai";
  }

  const localProvider = (
    [
      "anthropic",
      "deepseek",
      "gemini",
      "grok",
      "groq",
      "mistral",
      "ollama",
      "openai",
      "openrouter",
      "pi-ai",
      "together",
      "zai",
    ] as const satisfies readonly OnboardingLocalProviderId[]
  ).find((providerId) => {
    const providerOption = getOnboardingProviderOption(providerId);
    return providerOption?.envKey
      ? Boolean(readEnvString(config, providerOption.envKey))
      : false;
  });

  return localProvider ?? null;
}

/**
 * Apply subscription provider configuration to the config object.
 *
 * Sets `agents.defaults.subscriptionProvider` and `agents.defaults.model.primary`
 * so the runtime auto-detects the correct provider on restart.
 *
 * Mutates `config` in place.
 */
export function applySubscriptionProviderConfig(
  config: Partial<MiladyConfig>,
  provider: string,
): void {
  config.agents ??= {};
  config.agents.defaults ??= {};
  const defaults = config.agents.defaults;

  const subscriptionKey =
    provider === "openai-subscription" ? "openai-codex" : provider;
  const modelProvider =
    SUBSCRIPTION_PROVIDER_MAP[
      subscriptionKey as keyof typeof SUBSCRIPTION_PROVIDER_MAP
    ];

  if (modelProvider) {
    defaults.subscriptionProvider = subscriptionKey;
    defaults.model = { ...defaults.model, primary: modelProvider };
  }
}

/**
 * Clear subscription provider configuration from the config object.
 *
 * Removes `agents.defaults.subscriptionProvider` so the runtime
 * doesn't try to auto-detect a subscription provider on restart.
 *
 * Mutates `config` in place.
 */
export function clearSubscriptionProviderConfig(
  config: Partial<MiladyConfig>,
): void {
  config.agents ??= {};
  config.agents.defaults ??= {};
  delete config.agents.defaults.subscriptionProvider;
}

export function createProviderSwitchConnection(args: {
  provider: string;
  apiKey?: string;
  primaryModel?: string;
}): OnboardingConnection | null {
  const provider = normalizeOnboardingProviderId(args.provider);
  if (!provider || provider === "elizacloud") {
    return null;
  }

  return {
    kind: "local-provider",
    provider,
    apiKey: trimToUndefined(args.apiKey),
    primaryModel: trimToUndefined(args.primaryModel),
  };
}

export function resolveExistingOnboardingConnection(
  config: Record<string, unknown> | null | undefined,
): OnboardingConnection | null {
  const cloud = asRecord(config?.cloud);
  const models = asRecord(config?.models);
  const agentDefaults = asRecord(asRecord(config?.agents)?.defaults);
  const agentModel = asRecord(agentDefaults?.model);
  const remoteApiBase = readString(cloud, "remoteApiBase");
  const remoteAccessToken = normalizeSecret(
    readString(cloud, "remoteAccessToken"),
  );
  const localProvider = resolveConfiguredLocalProvider(config);
  const primaryModel = readString(agentModel, "primary");
  const localProviderOption = getOnboardingProviderOption(localProvider);
  const localApiKey =
    localProviderOption?.envKey != null
      ? normalizeSecret(readEnvString(config, localProviderOption.envKey))
      : undefined;

  if (remoteApiBase || remoteAccessToken) {
    return {
      kind: "remote-provider",
      remoteApiBase: remoteApiBase ?? "",
      remoteAccessToken,
      provider: localProvider ?? undefined,
      apiKey: localApiKey,
      primaryModel,
    };
  }

  const cloudProvider = normalizeOnboardingProviderId(
    readString(cloud, "provider"),
  );
  const cloudApiKey = normalizeSecret(readString(cloud, "apiKey"));
  const smallModel = readString(models, "small");
  const largeModel = readString(models, "large");

  if (
    cloud?.enabled === true ||
    cloudProvider === "elizacloud" ||
    readString(cloud, "inferenceMode") === "cloud" ||
    cloudApiKey ||
    smallModel ||
    largeModel
  ) {
    return {
      kind: "cloud-managed",
      cloudProvider: "elizacloud",
      apiKey: cloudApiKey,
      smallModel,
      largeModel,
    };
  }

  if (!localProvider) {
    return null;
  }

  return {
    kind: "local-provider",
    provider: localProvider,
    apiKey: localApiKey,
    primaryModel,
  };
}

export function mergeOnboardingConnectionWithExisting(
  nextConnection: OnboardingConnection,
  existingConnection: OnboardingConnection | null | undefined,
): OnboardingConnection {
  if (!existingConnection || existingConnection.kind !== nextConnection.kind) {
    return nextConnection;
  }

  if (nextConnection.kind === "cloud-managed") {
    if (
      !isCloudManagedConnection(existingConnection) ||
      existingConnection.cloudProvider !== nextConnection.cloudProvider
    ) {
      return nextConnection;
    }
    return {
      ...existingConnection,
      ...nextConnection,
      apiKey: normalizeSecret(nextConnection.apiKey, existingConnection.apiKey),
      smallModel: nextConnection.smallModel ?? existingConnection.smallModel,
      largeModel: nextConnection.largeModel ?? existingConnection.largeModel,
    };
  }

  if (nextConnection.kind === "local-provider") {
    if (
      !isLocalProviderConnection(existingConnection) ||
      existingConnection.provider !== nextConnection.provider
    ) {
      return nextConnection;
    }
    return {
      ...existingConnection,
      ...nextConnection,
      apiKey: normalizeSecret(nextConnection.apiKey, existingConnection.apiKey),
      primaryModel:
        nextConnection.primaryModel ?? existingConnection.primaryModel,
    };
  }

  if (!isRemoteProviderConnection(existingConnection)) {
    return nextConnection;
  }

  return {
    ...existingConnection,
    ...nextConnection,
    apiKey: normalizeSecret(nextConnection.apiKey, existingConnection.apiKey),
    remoteAccessToken: normalizeSecret(
      nextConnection.remoteAccessToken,
      existingConnection.remoteAccessToken,
    ),
    primaryModel:
      nextConnection.primaryModel ?? existingConnection.primaryModel,
  };
}

export async function applyOnboardingConnectionConfig(
  config: MutableMiladyConfig,
  connection: OnboardingConnection,
): Promise<void> {
  if (connection.kind === "cloud-managed") {
    config.cloud ??= {};
    config.models ??= {};
    config.cloud.enabled = true;
    config.cloud.provider = "elizacloud";
    config.cloud.inferenceMode = "cloud";
    config.cloud.runtime = "cloud";

    const apiKey = trimToUndefined(connection.apiKey);
    if (apiKey) {
      config.cloud.apiKey = apiKey;
      process.env.ELIZAOS_CLOUD_API_KEY = apiKey;
    }
    if (connection.smallModel) {
      config.models.small = connection.smallModel;
    }
    if (connection.largeModel) {
      config.models.large = connection.largeModel;
    }

    clearSubscriptionProviderConfig(config);
    clearPiAiFlag(config);
    return;
  }

  if (connection.kind === "remote-provider") {
    config.cloud ??= {};
    config.cloud.enabled = true;
    config.cloud.provider = "remote";
    config.cloud.runtime = "cloud";
    (config.cloud as Record<string, unknown>).remoteApiBase =
      connection.remoteApiBase;
    if (connection.remoteAccessToken) {
      (config.cloud as Record<string, unknown>).remoteAccessToken =
        connection.remoteAccessToken;
    }

    if (connection.provider) {
      const localConnection = createProviderSwitchConnection({
        provider: connection.provider,
        apiKey: connection.apiKey,
        primaryModel: connection.primaryModel,
      });
      if (localConnection) {
        await applyOnboardingConnectionConfig(config, localConnection);
      }
    }
    return;
  }

  config.cloud ??= {};
  config.cloud.enabled = false;
  config.cloud.runtime = "local";

  const normalizedProvider =
    connection.provider === "openai-subscription"
      ? "openai-codex"
      : connection.provider;

  if (
    normalizedProvider === "anthropic-subscription" ||
    normalizedProvider === "openai-codex"
  ) {
    applySubscriptionProviderConfig(config, normalizedProvider);

    const setupToken =
      normalizedProvider === "anthropic-subscription"
        ? trimToUndefined(connection.apiKey)
        : undefined;

    if (setupToken?.startsWith("sk-ant-")) {
      setEnvValue(config, "ANTHROPIC_API_KEY", setupToken);
      deleteCredentials("anthropic-subscription");
      deleteCredentials("openai-codex");
      return;
    }

    await applySubscriptionCredentials(config);
    deleteCredentials(
      (normalizedProvider === "anthropic-subscription"
        ? "openai-codex"
        : "anthropic-subscription") satisfies SubscriptionProvider,
    );
    return;
  }

  clearSubscriptionProviderConfig(config);

  if (normalizedProvider === "pi-ai") {
    setEnvValue(config, "MILADY_USE_PI_AI", "1");
  } else {
    clearPiAiFlag(config);
  }

  const providerOption = getOnboardingProviderOption(normalizedProvider);
  if (providerOption?.envKey) {
    setEnvValue(
      config,
      providerOption.envKey,
      trimToUndefined(connection.apiKey),
    );
  }

  setPrimaryModel(config, trimToUndefined(connection.primaryModel));
}
