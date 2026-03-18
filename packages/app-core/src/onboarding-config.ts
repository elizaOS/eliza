import {
  isCloudManagedConnection,
  normalizeOnboardingProviderId,
  type OnboardingConnection,
  type OnboardingLocalProviderId,
} from "@elizaos/autonomous/contracts/onboarding";

export interface BuildOnboardingConnectionArgs {
  onboardingRunMode: "local" | "cloud" | "";
  onboardingCloudProvider: string;
  onboardingProvider: string;
  onboardingApiKey: string;
  onboardingPrimaryModel: string;
  onboardingOpenRouterModel: string;
  onboardingRemoteConnected: boolean;
  onboardingRemoteApiBase: string;
  onboardingRemoteToken: string;
  onboardingSmallModel: string;
  onboardingLargeModel: string;
}

function trimToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveLocalProviderId(
  provider: string,
): OnboardingLocalProviderId | null {
  const normalized = normalizeOnboardingProviderId(provider);
  return normalized && normalized !== "elizacloud" ? normalized : null;
}

export function resolveOnboardingPrimaryModel(args: {
  providerId: string;
  onboardingPrimaryModel: string;
  onboardingOpenRouterModel: string;
}): string | undefined {
  if (args.providerId === "openrouter") {
    return trimToUndefined(args.onboardingOpenRouterModel);
  }
  return trimToUndefined(args.onboardingPrimaryModel);
}

export function buildOnboardingConnectionConfig(
  args: BuildOnboardingConnectionArgs,
): OnboardingConnection | null {
  if (
    args.onboardingRunMode === "cloud" &&
    args.onboardingCloudProvider === "elizacloud" &&
    !args.onboardingRemoteConnected
  ) {
    return {
      kind: "cloud-managed",
      cloudProvider: "elizacloud",
      apiKey: trimToUndefined(args.onboardingApiKey),
      smallModel: trimToUndefined(args.onboardingSmallModel),
      largeModel: trimToUndefined(args.onboardingLargeModel),
    };
  }

  if (args.onboardingProvider === "elizacloud") {
    return {
      kind: "cloud-managed",
      cloudProvider: "elizacloud",
      apiKey: trimToUndefined(args.onboardingApiKey),
    };
  }

  const providerId = resolveLocalProviderId(args.onboardingProvider);
  if (!providerId) {
    if (args.onboardingCloudProvider === "remote") {
      return {
        kind: "remote-provider",
        remoteApiBase: args.onboardingRemoteApiBase.trim(),
        remoteAccessToken: trimToUndefined(args.onboardingRemoteToken),
      };
    }
    return null;
  }

  const primaryModel = resolveOnboardingPrimaryModel({
    providerId,
    onboardingPrimaryModel: args.onboardingPrimaryModel,
    onboardingOpenRouterModel: args.onboardingOpenRouterModel,
  });

  if (
    args.onboardingRunMode === "cloud" &&
    args.onboardingCloudProvider === "remote"
  ) {
    return {
      kind: "remote-provider",
      remoteApiBase: args.onboardingRemoteApiBase.trim(),
      remoteAccessToken: trimToUndefined(args.onboardingRemoteToken),
      provider: providerId,
      apiKey: trimToUndefined(args.onboardingApiKey),
      primaryModel,
    };
  }

  return {
    kind: "local-provider",
    provider: providerId,
    apiKey: trimToUndefined(args.onboardingApiKey),
    primaryModel,
  };
}

export function isElizaCloudConnectionReady(args: {
  connection: OnboardingConnection | null | undefined;
  elizaCloudConnected: boolean;
}): boolean {
  if (args.elizaCloudConnected) {
    return true;
  }
  return Boolean(
    isCloudManagedConnection(args.connection) &&
      args.connection.cloudProvider === "elizacloud" &&
      args.connection.apiKey?.trim(),
  );
}
