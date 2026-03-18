import {
  normalizeOnboardingProviderId,
  ONBOARDING_PROVIDER_CATALOG,
  type OnboardingConnection,
  type OnboardingLocalProviderId,
} from "@elizaos/autonomous/contracts/onboarding";
import type { BuildOnboardingConnectionArgs } from "../onboarding-config";
import type { OnboardingStep } from "./types";

const REDACTED_SECRET = "[REDACTED]";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function hasConfigValue(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value === true;
}

function readString(
  source: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = source?.[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNonRedactedString(
  source: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = readString(source, key);
  return value === REDACTED_SECRET ? null : value;
}

function readEnvString(
  config: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const env = asRecord(config?.env);
  const vars = asRecord(env?.vars);
  return readString(vars, key) ?? readString(env, key);
}

function readEnvSecret(
  config: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = readEnvString(config, key);
  return value === REDACTED_SECRET ? null : value;
}

function readPrimaryModel(
  config: Record<string, unknown> | null | undefined,
): string | null {
  const agents = asRecord(config?.agents);
  const defaults = asRecord(agents?.defaults);
  const model = asRecord(defaults?.model);
  return readString(model, "primary");
}

function isPiAiEnabled(
  config: Record<string, unknown> | null | undefined,
): boolean {
  const value = readEnvString(config, "ELIZA_USE_PI_AI");
  if (!value) {
    return false;
  }
  return value !== "0" && value.toLowerCase() !== "false";
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

  if (isPiAiEnabled(config)) {
    return "pi-ai";
  }

  for (const provider of ONBOARDING_PROVIDER_CATALOG) {
    if (provider.id === "elizacloud" || !provider.envKey) {
      continue;
    }
    if (readEnvString(config, provider.envKey)) {
      return provider.id;
    }
  }

  return null;
}

export function hasPartialOnboardingConnectionConfig(
  config: Record<string, unknown> | null | undefined,
): boolean {
  const cloud = asRecord(config?.cloud);
  if (!cloud) {
    return false;
  }

  return [
    cloud.enabled,
    cloud.apiKey,
    cloud.provider,
    cloud.inferenceMode,
    cloud.remoteApiBase,
    cloud.remoteAccessToken,
  ].some(hasConfigValue);
}

export function inferOnboardingResumeStep(args: {
  config?: Record<string, unknown> | null;
  persistedStep?: OnboardingStep | null;
}): OnboardingStep {
  if (args.persistedStep) {
    return args.persistedStep;
  }

  return hasPartialOnboardingConnectionConfig(args.config)
    ? "senses"
    : "identity";
}

export function deriveOnboardingResumeConnection(
  config: Record<string, unknown> | null | undefined,
): OnboardingConnection | null {
  const cloud = asRecord(config?.cloud);
  const models = asRecord(config?.models);
  const remoteApiBase = readString(cloud, "remoteApiBase");
  const remoteAccessToken = readNonRedactedString(cloud, "remoteAccessToken");
  const localProvider = resolveConfiguredLocalProvider(config);
  const primaryModel = readPrimaryModel(config) ?? undefined;
  const localProviderOption = ONBOARDING_PROVIDER_CATALOG.find(
    (provider) => provider.id === localProvider,
  );
  const localApiKey =
    localProviderOption?.envKey != null
      ? (readEnvSecret(config, localProviderOption.envKey) ?? undefined)
      : undefined;

  if (remoteApiBase || remoteAccessToken) {
    return {
      kind: "remote-provider",
      remoteApiBase: remoteApiBase ?? "",
      remoteAccessToken: remoteAccessToken ?? undefined,
      provider: localProvider ?? undefined,
      apiKey: localApiKey,
      primaryModel,
    };
  }

  const cloudProvider = normalizeOnboardingProviderId(
    readString(cloud, "provider"),
  );
  const cloudApiKey = readNonRedactedString(cloud, "apiKey") ?? undefined;
  const smallModel = readString(models, "small") ?? undefined;
  const largeModel = readString(models, "large") ?? undefined;

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

export function deriveOnboardingResumeFields(
  connection: OnboardingConnection | null | undefined,
): Partial<BuildOnboardingConnectionArgs> {
  if (!connection) {
    return {};
  }

  switch (connection.kind) {
    case "cloud-managed":
      return {
        onboardingRunMode: "cloud",
        onboardingCloudProvider: "elizacloud",
        onboardingApiKey: connection.apiKey ?? "",
        onboardingSmallModel: connection.smallModel ?? "",
        onboardingLargeModel: connection.largeModel ?? "",
        onboardingRemoteConnected: false,
        onboardingRemoteApiBase: "",
        onboardingRemoteToken: "",
        onboardingProvider: "",
        onboardingPrimaryModel: "",
        onboardingOpenRouterModel: "",
      };
    case "local-provider":
      return {
        onboardingRunMode: "local",
        onboardingCloudProvider: "",
        onboardingProvider: connection.provider,
        onboardingApiKey: connection.apiKey ?? "",
        onboardingPrimaryModel:
          connection.provider === "openrouter"
            ? ""
            : (connection.primaryModel ?? ""),
        onboardingOpenRouterModel:
          connection.provider === "openrouter"
            ? (connection.primaryModel ?? "")
            : "",
        onboardingRemoteConnected: false,
        onboardingRemoteApiBase: "",
        onboardingRemoteToken: "",
      };
    case "remote-provider":
      return {
        onboardingRunMode: "cloud",
        onboardingCloudProvider: "remote",
        onboardingProvider: connection.provider ?? "",
        onboardingApiKey: connection.apiKey ?? "",
        onboardingPrimaryModel:
          connection.provider === "openrouter"
            ? ""
            : (connection.primaryModel ?? ""),
        onboardingOpenRouterModel:
          connection.provider === "openrouter"
            ? (connection.primaryModel ?? "")
            : "",
        onboardingRemoteConnected: true,
        onboardingRemoteApiBase: connection.remoteApiBase,
        onboardingRemoteToken: connection.remoteAccessToken ?? "",
      };
  }
}
