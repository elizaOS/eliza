import {
  buildDefaultElizaCloudServiceRouting,
  buildElizaCloudServiceRoute,
  type DeploymentTargetConfig,
  type LinkedAccountFlagsConfig,
  normalizeOnboardingProviderId,
  type OnboardingCredentialInputs,
  type OnboardingLocalProviderId,
  requiresAdditionalRuntimeProvider,
  type ServiceRouteConfig,
  type ServiceRoutingConfig,
} from "@elizaos/shared";
import {
  isElizaCloudOnboardingTarget,
  type OnboardingServerTarget,
} from "./server-target";

export interface BuildOnboardingConnectionArgs {
  onboardingServerTarget?: OnboardingServerTarget;
  onboardingCloudApiKey: string;
  onboardingProvider: string;
  onboardingApiKey: string;
  omitRuntimeProvider?: boolean;
  onboardingVoiceProvider: string;
  onboardingVoiceApiKey: string;
  onboardingPrimaryModel: string;
  onboardingOpenRouterModel: string;
  onboardingRemoteConnected: boolean;
  onboardingRemoteApiBase: string;
  onboardingRemoteToken: string;
  onboardingNanoModel?: string;
  onboardingSmallModel?: string;
  onboardingMediumModel?: string;
  onboardingLargeModel?: string;
  onboardingMegaModel?: string;
  onboardingResponseHandlerModel?: string;
  onboardingActionPlannerModel?: string;
  // Feature toggles from onboarding features step
  onboardingFeatureTelegram?: boolean;
  onboardingFeatureDiscord?: boolean;
  onboardingFeaturePhone?: boolean;
  onboardingFeatureCrypto?: boolean;
  onboardingFeatureBrowser?: boolean;
  onboardingFeatureComputerUse?: boolean;
  onboardingUseLocalEmbeddings?: boolean;
}

/** Feature selections from the onboarding features step. */
export interface OnboardingFeatureSetup {
  connectors: {
    telegram?: { managed: boolean };
    discord?: { managed: boolean };
  };
  capabilities: {
    crypto?: boolean;
    browser?: boolean;
    computeruse?: boolean;
  };
}

export interface BuildOnboardingRuntimeConfigResult {
  deploymentTarget: DeploymentTargetConfig;
  linkedAccounts: LinkedAccountFlagsConfig | undefined;
  serviceRouting: ServiceRoutingConfig | undefined;
  credentialInputs: OnboardingCredentialInputs | undefined;
  needsProviderSetup: boolean;
  featureSetup: OnboardingFeatureSetup | undefined;
}

type OnboardingModelConfig = {
  nanoModel: string | undefined;
  smallModel: string | undefined;
  mediumModel: string | undefined;
  largeModel: string | undefined;
  megaModel: string | undefined;
  responseHandlerModel: string | undefined;
  actionPlannerModel: string | undefined;
};

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveLocalProviderId(
  provider: string,
): OnboardingLocalProviderId | null {
  const normalized = normalizeOnboardingProviderId(provider);
  return normalized && normalized !== "elizacloud" ? normalized : null;
}

function resolveArgsServerTarget(
  args: Pick<BuildOnboardingConnectionArgs, "onboardingServerTarget">,
): OnboardingServerTarget {
  return args.onboardingServerTarget ?? "";
}

function resolveOnboardingPrimaryModel(args: {
  providerId: string;
  onboardingPrimaryModel: string;
  onboardingOpenRouterModel: string;
}): string | undefined {
  if (args.providerId === "openrouter") {
    return trimToUndefined(args.onboardingOpenRouterModel);
  }
  return trimToUndefined(args.onboardingPrimaryModel);
}

function buildOnboardingLinkedAccounts(
  args: BuildOnboardingConnectionArgs,
): LinkedAccountFlagsConfig {
  const linkedAccounts: LinkedAccountFlagsConfig = {};
  const cloudApiKey = trimToUndefined(args.onboardingCloudApiKey);
  if (cloudApiKey) {
    linkedAccounts.elizacloud = { status: "linked", source: "api-key" };
  }
  const localProviderId = resolveLocalProviderId(args.onboardingProvider);
  if (
    localProviderId === "anthropic-subscription" ||
    localProviderId === "openai-subscription"
  ) {
    linkedAccounts[localProviderId] = {
      status: "linked",
      source: "subscription",
    };
  }
  return linkedAccounts;
}

function buildDeploymentTarget(args: {
  serverTarget: OnboardingServerTarget;
  persistRuntimeOnConnectedRemote: boolean;
  useElizaCloudRuntime: boolean;
  onboardingRemoteApiBase: string;
  onboardingRemoteConnected: boolean;
  onboardingRemoteToken: string;
}): DeploymentTargetConfig {
  if (args.persistRuntimeOnConnectedRemote) return { runtime: "local" };
  if (args.serverTarget === "remote") {
    return {
      runtime: "remote",
      provider: "remote",
      remoteApiBase: trimToUndefined(args.onboardingRemoteApiBase) ?? "",
      ...(trimToUndefined(args.onboardingRemoteToken)
        ? { remoteAccessToken: trimToUndefined(args.onboardingRemoteToken) }
        : {}),
    };
  }
  if (args.useElizaCloudRuntime && !args.onboardingRemoteConnected) {
    return { runtime: "cloud", provider: "elizacloud" };
  }
  return { runtime: "local" };
}

function buildLocalServiceRoute(args: {
  localProviderId: OnboardingLocalProviderId;
  serverTarget: OnboardingServerTarget;
  persistRuntimeOnConnectedRemote: boolean;
  onboardingRemoteApiBase: string;
  primaryModel: string | undefined;
}): ServiceRouteConfig {
  if (args.serverTarget === "remote" && !args.persistRuntimeOnConnectedRemote) {
    return {
      backend: args.localProviderId,
      transport: "remote",
      remoteApiBase: trimToUndefined(args.onboardingRemoteApiBase) ?? "",
      ...(args.primaryModel ? { primaryModel: args.primaryModel } : {}),
    };
  }
  return {
    backend: args.localProviderId,
    transport: "direct",
    ...(args.primaryModel ? { primaryModel: args.primaryModel } : {}),
  };
}

function buildOnboardingLlmRoute(args: {
  source: BuildOnboardingConnectionArgs;
  localProviderId: OnboardingLocalProviderId | null;
  serverTarget: OnboardingServerTarget;
  persistRuntimeOnConnectedRemote: boolean;
  shouldConfigureRuntimeProvider: boolean;
  models: OnboardingModelConfig;
}): ServiceRouteConfig | undefined {
  if (
    args.source.onboardingProvider === "elizacloud" &&
    args.shouldConfigureRuntimeProvider
  ) {
    return buildElizaCloudServiceRoute(args.models);
  }
  if (!args.shouldConfigureRuntimeProvider || !args.localProviderId)
    return undefined;
  const primaryModel = resolveOnboardingPrimaryModel({
    providerId: args.localProviderId,
    onboardingPrimaryModel: args.source.onboardingPrimaryModel,
    onboardingOpenRouterModel: args.source.onboardingOpenRouterModel,
  });
  return buildLocalServiceRoute({
    localProviderId: args.localProviderId,
    serverTarget: args.serverTarget,
    persistRuntimeOnConnectedRemote: args.persistRuntimeOnConnectedRemote,
    onboardingRemoteApiBase: args.source.onboardingRemoteApiBase,
    primaryModel,
  });
}

function buildOnboardingModelConfig(
  args: BuildOnboardingConnectionArgs,
): OnboardingModelConfig {
  return {
    nanoModel: trimToUndefined(args.onboardingNanoModel),
    smallModel: trimToUndefined(args.onboardingSmallModel),
    mediumModel: trimToUndefined(args.onboardingMediumModel),
    largeModel: trimToUndefined(args.onboardingLargeModel),
    megaModel: trimToUndefined(args.onboardingMegaModel),
    responseHandlerModel: trimToUndefined(
      args.onboardingResponseHandlerModel ?? "",
    ),
    actionPlannerModel: trimToUndefined(
      args.onboardingActionPlannerModel ?? "",
    ),
  };
}

function shouldUseCloudDefaults(args: {
  onboardingProvider: string;
  deploymentTarget: DeploymentTargetConfig;
}): boolean {
  return (
    args.onboardingProvider === "elizacloud" ||
    (args.deploymentTarget.runtime === "cloud" &&
      args.deploymentTarget.provider === "elizacloud")
  );
}

function buildOnboardingServiceRouting(args: {
  source: BuildOnboardingConnectionArgs;
  localProviderId: OnboardingLocalProviderId | null;
  serverTarget: OnboardingServerTarget;
  persistRuntimeOnConnectedRemote: boolean;
  shouldConfigureRuntimeProvider: boolean;
  deploymentTarget: DeploymentTargetConfig;
  models: OnboardingModelConfig;
}): ServiceRoutingConfig {
  const serviceRouting: ServiceRoutingConfig = {};
  const llmTextRoute = buildOnboardingLlmRoute({
    source: args.source,
    localProviderId: args.localProviderId,
    serverTarget: args.serverTarget,
    persistRuntimeOnConnectedRemote: args.persistRuntimeOnConnectedRemote,
    shouldConfigureRuntimeProvider: args.shouldConfigureRuntimeProvider,
    models: args.models,
  });

  if (llmTextRoute) {
    serviceRouting.llmText = llmTextRoute;
  }

  if (
    shouldUseCloudDefaults({
      onboardingProvider: args.source.onboardingProvider,
      deploymentTarget: args.deploymentTarget,
    })
  ) {
    Object.assign(
      serviceRouting,
      buildDefaultElizaCloudServiceRouting({
        base: serviceRouting,
        includeInference:
          args.shouldConfigureRuntimeProvider &&
          args.source.onboardingProvider === "elizacloud",
        excludeServices: args.source.onboardingUseLocalEmbeddings
          ? ["embeddings"]
          : undefined,
        ...args.models,
      }),
    );
  }

  return serviceRouting;
}

function buildOnboardingCredentialInputs(args: {
  source: BuildOnboardingConnectionArgs;
  llmTextRoute: ServiceRouteConfig | undefined;
}): OnboardingCredentialInputs {
  const credentialInputs: OnboardingCredentialInputs = {};
  const cloudApiKey = trimToUndefined(args.source.onboardingCloudApiKey);
  if (cloudApiKey) {
    credentialInputs.cloudApiKey = cloudApiKey;
  }

  const llmApiKey = trimToUndefined(args.source.onboardingApiKey);
  if (
    llmApiKey &&
    args.llmTextRoute?.backend &&
    args.llmTextRoute.backend !== "elizacloud"
  ) {
    credentialInputs.llmApiKey = llmApiKey;
  }
  return credentialInputs;
}

function emptyToUndefined<T extends object>(value: T): T | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}

function buildOnboardingFeatureSetup(
  args: BuildOnboardingConnectionArgs,
): OnboardingFeatureSetup | undefined {
  const hasFeatures =
    args.onboardingFeatureTelegram ||
    args.onboardingFeatureDiscord ||
    args.onboardingFeatureCrypto ||
    args.onboardingFeatureBrowser ||
    args.onboardingFeatureComputerUse;
  if (!hasFeatures) return undefined;
  return {
    connectors: {
      ...(args.onboardingFeatureTelegram
        ? { telegram: { managed: true } }
        : {}),
      ...(args.onboardingFeatureDiscord ? { discord: { managed: true } } : {}),
    },
    capabilities: {
      ...(args.onboardingFeatureCrypto ? { crypto: true } : {}),
      ...(args.onboardingFeatureBrowser ? { browser: true } : {}),
      ...(args.onboardingFeatureComputerUse ? { computeruse: true } : {}),
    },
  };
}

export function buildOnboardingRuntimeConfig(
  args: BuildOnboardingConnectionArgs,
): BuildOnboardingRuntimeConfigResult {
  const serverTarget = resolveArgsServerTarget(args);
  const persistRuntimeOnConnectedRemote =
    serverTarget === "remote" && args.onboardingRemoteConnected;
  const useElizaCloudRuntime = isElizaCloudOnboardingTarget(serverTarget);
  const models = buildOnboardingModelConfig(args);
  const localProviderId = resolveLocalProviderId(args.onboardingProvider);
  const linkedAccounts = buildOnboardingLinkedAccounts(args);
  const deploymentTarget = buildDeploymentTarget({
    serverTarget,
    persistRuntimeOnConnectedRemote,
    useElizaCloudRuntime,
    onboardingRemoteApiBase: args.onboardingRemoteApiBase,
    onboardingRemoteConnected: args.onboardingRemoteConnected,
    onboardingRemoteToken: args.onboardingRemoteToken,
  });
  const shouldConfigureRuntimeProvider =
    !args.omitRuntimeProvider &&
    !requiresAdditionalRuntimeProvider(args.onboardingProvider);
  const serviceRouting = buildOnboardingServiceRouting({
    source: args,
    localProviderId,
    serverTarget,
    persistRuntimeOnConnectedRemote,
    shouldConfigureRuntimeProvider,
    deploymentTarget,
    models,
  });
  const credentialInputs = buildOnboardingCredentialInputs({
    source: args,
    llmTextRoute: serviceRouting.llmText,
  });
  const featureSetup = buildOnboardingFeatureSetup(args);

  return {
    deploymentTarget,
    linkedAccounts: emptyToUndefined(linkedAccounts),
    serviceRouting: emptyToUndefined(serviceRouting),
    credentialInputs: emptyToUndefined(credentialInputs),
    needsProviderSetup: !serviceRouting.llmText,
    featureSetup,
  };
}
