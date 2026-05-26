import {
  buildDefaultElizaCloudServiceRouting,
  buildElizaCloudServiceRoute,
  type DeploymentTargetConfig,
  type FirstRunCredentialInputs,
  type FirstRunLocalProviderId,
  type LinkedAccountFlagsConfig,
  normalizeFirstRunProviderId,
  requiresAdditionalRuntimeProvider,
  type ServiceRouteConfig,
  type ServiceRoutingConfig,
} from "@elizaos/shared";
import {
  type FirstRunRuntimeTarget,
  isElizaCloudFirstRunTarget,
} from "./runtime-target";

export interface BuildFirstRunConnectionArgs {
  firstRunRuntimeTarget?: FirstRunRuntimeTarget;
  firstRunCloudApiKey: string;
  firstRunProvider: string;
  firstRunApiKey: string;
  omitRuntimeProvider?: boolean;
  firstRunVoiceProvider: string;
  firstRunVoiceApiKey: string;
  firstRunPrimaryModel: string;
  firstRunOpenRouterModel: string;
  firstRunRemoteConnected: boolean;
  firstRunRemoteApiBase: string;
  firstRunRemoteToken: string;
  firstRunNanoModel?: string;
  firstRunSmallModel?: string;
  firstRunMediumModel?: string;
  firstRunLargeModel?: string;
  firstRunMegaModel?: string;
  firstRunResponseHandlerModel?: string;
  firstRunActionPlannerModel?: string;
  // Feature toggles from first-run capabilities step
  firstRunFeatureTelegram?: boolean;
  firstRunFeatureDiscord?: boolean;
  firstRunFeaturePhone?: boolean;
  firstRunFeatureCrypto?: boolean;
  firstRunFeatureBrowser?: boolean;
  firstRunFeatureComputerUse?: boolean;
  firstRunUseLocalEmbeddings?: boolean;
}

/** Feature selections from the first-run capabilities step. */
export interface FirstRunCapabilitySetup {
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

export interface BuildFirstRunRuntimeConfigResult {
  deploymentTarget: DeploymentTargetConfig;
  linkedAccounts: LinkedAccountFlagsConfig | undefined;
  serviceRouting: ServiceRoutingConfig | undefined;
  credentialInputs: FirstRunCredentialInputs | undefined;
  needsProviderSetup: boolean;
  featureSetup: FirstRunCapabilitySetup | undefined;
}

type FirstRunModelConfig = {
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
): FirstRunLocalProviderId | null {
  const normalized = normalizeFirstRunProviderId(provider);
  return normalized && normalized !== "elizacloud" ? normalized : null;
}

function resolveArgsServerTarget(
  args: Pick<BuildFirstRunConnectionArgs, "firstRunRuntimeTarget">,
): FirstRunRuntimeTarget {
  return args.firstRunRuntimeTarget ?? "";
}

function resolveFirstRunPrimaryModel(args: {
  providerId: string;
  firstRunPrimaryModel: string;
  firstRunOpenRouterModel: string;
}): string | undefined {
  if (args.providerId === "openrouter") {
    return trimToUndefined(args.firstRunOpenRouterModel);
  }
  return trimToUndefined(args.firstRunPrimaryModel);
}

function buildFirstRunLinkedAccounts(
  args: BuildFirstRunConnectionArgs,
): LinkedAccountFlagsConfig {
  const linkedAccounts: LinkedAccountFlagsConfig = {};
  const cloudApiKey = trimToUndefined(args.firstRunCloudApiKey);
  if (cloudApiKey) {
    linkedAccounts.elizacloud = { status: "linked", source: "api-key" };
  }
  const localProviderId = resolveLocalProviderId(args.firstRunProvider);
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
  serverTarget: FirstRunRuntimeTarget;
  persistRuntimeOnConnectedRemote: boolean;
  useElizaCloudRuntime: boolean;
  firstRunRemoteApiBase: string;
  firstRunRemoteConnected: boolean;
  firstRunRemoteToken: string;
}): DeploymentTargetConfig {
  if (args.persistRuntimeOnConnectedRemote) return { runtime: "local" };
  if (args.serverTarget === "remote") {
    return {
      runtime: "remote",
      provider: "remote",
      remoteApiBase: trimToUndefined(args.firstRunRemoteApiBase) ?? "",
      ...(trimToUndefined(args.firstRunRemoteToken)
        ? { remoteAccessToken: trimToUndefined(args.firstRunRemoteToken) }
        : {}),
    };
  }
  if (args.useElizaCloudRuntime && !args.firstRunRemoteConnected) {
    return { runtime: "cloud", provider: "elizacloud" };
  }
  return { runtime: "local" };
}

function buildLocalServiceRoute(args: {
  localProviderId: FirstRunLocalProviderId;
  serverTarget: FirstRunRuntimeTarget;
  persistRuntimeOnConnectedRemote: boolean;
  firstRunRemoteApiBase: string;
  primaryModel: string | undefined;
}): ServiceRouteConfig {
  if (args.serverTarget === "remote" && !args.persistRuntimeOnConnectedRemote) {
    return {
      backend: args.localProviderId,
      transport: "remote",
      remoteApiBase: trimToUndefined(args.firstRunRemoteApiBase) ?? "",
      ...(args.primaryModel ? { primaryModel: args.primaryModel } : {}),
    };
  }
  return {
    backend: args.localProviderId,
    transport: "direct",
    ...(args.primaryModel ? { primaryModel: args.primaryModel } : {}),
  };
}

function buildFirstRunLlmRoute(args: {
  source: BuildFirstRunConnectionArgs;
  localProviderId: FirstRunLocalProviderId | null;
  serverTarget: FirstRunRuntimeTarget;
  persistRuntimeOnConnectedRemote: boolean;
  shouldConfigureRuntimeProvider: boolean;
  models: FirstRunModelConfig;
}): ServiceRouteConfig | undefined {
  if (
    args.source.firstRunProvider === "elizacloud" &&
    args.shouldConfigureRuntimeProvider
  ) {
    return buildElizaCloudServiceRoute(args.models);
  }
  if (!args.shouldConfigureRuntimeProvider || !args.localProviderId)
    return undefined;
  const primaryModel = resolveFirstRunPrimaryModel({
    providerId: args.localProviderId,
    firstRunPrimaryModel: args.source.firstRunPrimaryModel,
    firstRunOpenRouterModel: args.source.firstRunOpenRouterModel,
  });
  return buildLocalServiceRoute({
    localProviderId: args.localProviderId,
    serverTarget: args.serverTarget,
    persistRuntimeOnConnectedRemote: args.persistRuntimeOnConnectedRemote,
    firstRunRemoteApiBase: args.source.firstRunRemoteApiBase,
    primaryModel,
  });
}

function buildFirstRunModelConfig(
  args: BuildFirstRunConnectionArgs,
): FirstRunModelConfig {
  return {
    nanoModel: trimToUndefined(args.firstRunNanoModel),
    smallModel: trimToUndefined(args.firstRunSmallModel),
    mediumModel: trimToUndefined(args.firstRunMediumModel),
    largeModel: trimToUndefined(args.firstRunLargeModel),
    megaModel: trimToUndefined(args.firstRunMegaModel),
    responseHandlerModel: trimToUndefined(
      args.firstRunResponseHandlerModel ?? "",
    ),
    actionPlannerModel: trimToUndefined(args.firstRunActionPlannerModel ?? ""),
  };
}

function shouldUseCloudDefaults(args: {
  firstRunProvider: string;
  deploymentTarget: DeploymentTargetConfig;
}): boolean {
  return (
    args.firstRunProvider === "elizacloud" ||
    (args.deploymentTarget.runtime === "cloud" &&
      args.deploymentTarget.provider === "elizacloud")
  );
}

function buildFirstRunServiceRouting(args: {
  source: BuildFirstRunConnectionArgs;
  localProviderId: FirstRunLocalProviderId | null;
  serverTarget: FirstRunRuntimeTarget;
  persistRuntimeOnConnectedRemote: boolean;
  shouldConfigureRuntimeProvider: boolean;
  deploymentTarget: DeploymentTargetConfig;
  models: FirstRunModelConfig;
}): ServiceRoutingConfig {
  const serviceRouting: ServiceRoutingConfig = {};
  const llmTextRoute = buildFirstRunLlmRoute({
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
      firstRunProvider: args.source.firstRunProvider,
      deploymentTarget: args.deploymentTarget,
    })
  ) {
    Object.assign(
      serviceRouting,
      buildDefaultElizaCloudServiceRouting({
        base: serviceRouting,
        includeInference:
          args.shouldConfigureRuntimeProvider &&
          args.source.firstRunProvider === "elizacloud",
        excludeServices: args.source.firstRunUseLocalEmbeddings
          ? ["embeddings"]
          : undefined,
        ...args.models,
      }),
    );
  }

  return serviceRouting;
}

function buildFirstRunCredentialInputs(args: {
  source: BuildFirstRunConnectionArgs;
  llmTextRoute: ServiceRouteConfig | undefined;
}): FirstRunCredentialInputs {
  const credentialInputs: FirstRunCredentialInputs = {};
  const cloudApiKey = trimToUndefined(args.source.firstRunCloudApiKey);
  if (cloudApiKey) {
    credentialInputs.cloudApiKey = cloudApiKey;
  }

  const llmApiKey = trimToUndefined(args.source.firstRunApiKey);
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

function buildFirstRunCapabilitySetup(
  args: BuildFirstRunConnectionArgs,
): FirstRunCapabilitySetup | undefined {
  const hasFeatures =
    args.firstRunFeatureTelegram ||
    args.firstRunFeatureDiscord ||
    args.firstRunFeatureCrypto ||
    args.firstRunFeatureBrowser ||
    args.firstRunFeatureComputerUse;
  if (!hasFeatures) return undefined;
  return {
    connectors: {
      ...(args.firstRunFeatureTelegram ? { telegram: { managed: true } } : {}),
      ...(args.firstRunFeatureDiscord ? { discord: { managed: true } } : {}),
    },
    capabilities: {
      ...(args.firstRunFeatureCrypto ? { crypto: true } : {}),
      ...(args.firstRunFeatureBrowser ? { browser: true } : {}),
      ...(args.firstRunFeatureComputerUse ? { computeruse: true } : {}),
    },
  };
}

export function buildFirstRunRuntimeConfig(
  args: BuildFirstRunConnectionArgs,
): BuildFirstRunRuntimeConfigResult {
  const serverTarget = resolveArgsServerTarget(args);
  const persistRuntimeOnConnectedRemote =
    serverTarget === "remote" && args.firstRunRemoteConnected;
  const useElizaCloudRuntime = isElizaCloudFirstRunTarget(serverTarget);
  const models = buildFirstRunModelConfig(args);
  const localProviderId = resolveLocalProviderId(args.firstRunProvider);
  const linkedAccounts = buildFirstRunLinkedAccounts(args);
  const deploymentTarget = buildDeploymentTarget({
    serverTarget,
    persistRuntimeOnConnectedRemote,
    useElizaCloudRuntime,
    firstRunRemoteApiBase: args.firstRunRemoteApiBase,
    firstRunRemoteConnected: args.firstRunRemoteConnected,
    firstRunRemoteToken: args.firstRunRemoteToken,
  });
  const shouldConfigureRuntimeProvider =
    !args.omitRuntimeProvider &&
    !requiresAdditionalRuntimeProvider(args.firstRunProvider);
  const serviceRouting = buildFirstRunServiceRouting({
    source: args,
    localProviderId,
    serverTarget,
    persistRuntimeOnConnectedRemote,
    shouldConfigureRuntimeProvider,
    deploymentTarget,
    models,
  });
  const credentialInputs = buildFirstRunCredentialInputs({
    source: args,
    llmTextRoute: serviceRouting.llmText,
  });
  const featureSetup = buildFirstRunCapabilitySetup(args);

  return {
    deploymentTarget,
    linkedAccounts: emptyToUndefined(linkedAccounts),
    serviceRouting: emptyToUndefined(serviceRouting),
    credentialInputs: emptyToUndefined(credentialInputs),
    needsProviderSetup: !serviceRouting.llmText,
    featureSetup,
  };
}
