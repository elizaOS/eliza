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
} from "./onboarding/server-target";

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

export function buildOnboardingRuntimeConfig(
  args: BuildOnboardingConnectionArgs,
): BuildOnboardingRuntimeConfigResult {
  const serverTarget = resolveArgsServerTarget(args);
  const persistRuntimeOnConnectedRemote =
    serverTarget === "remote" && args.onboardingRemoteConnected;
  const useElizaCloudRuntime = isElizaCloudOnboardingTarget(serverTarget);
  const nanoModel = trimToUndefined(args.onboardingNanoModel);
  const smallModel = trimToUndefined(args.onboardingSmallModel);
  const mediumModel = trimToUndefined(args.onboardingMediumModel);
  const largeModel = trimToUndefined(args.onboardingLargeModel);
  const megaModel = trimToUndefined(args.onboardingMegaModel);
  const responseHandlerModel = trimToUndefined(
    args.onboardingResponseHandlerModel ?? "",
  );
  const actionPlannerModel = trimToUndefined(
    args.onboardingActionPlannerModel ?? "",
  );
  const linkedAccounts: LinkedAccountFlagsConfig = {};
  const cloudApiKey = trimToUndefined(args.onboardingCloudApiKey);
  if (cloudApiKey) {
    linkedAccounts.elizacloud = {
      status: "linked",
      source: "api-key",
    };
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

  const deploymentTarget: DeploymentTargetConfig =
    persistRuntimeOnConnectedRemote
      ? { runtime: "local" }
      : serverTarget === "remote"
        ? {
            runtime: "remote",
            provider: "remote",
            remoteApiBase: trimToUndefined(args.onboardingRemoteApiBase) ?? "",
            ...(trimToUndefined(args.onboardingRemoteToken)
              ? {
                  remoteAccessToken: trimToUndefined(
                    args.onboardingRemoteToken,
                  ),
                }
              : {}),
          }
        : useElizaCloudRuntime && !args.onboardingRemoteConnected
          ? {
              runtime: "cloud",
              provider: "elizacloud",
            }
          : { runtime: "local" };

  const serviceRouting: ServiceRoutingConfig = {};
  let llmTextRoute: ServiceRouteConfig | undefined;
  const shouldConfigureRuntimeProvider =
    !args.omitRuntimeProvider &&
    !requiresAdditionalRuntimeProvider(args.onboardingProvider);

  if (
    args.onboardingProvider === "elizacloud" &&
    shouldConfigureRuntimeProvider
  ) {
    llmTextRoute = buildElizaCloudServiceRoute({
      nanoModel,
      smallModel,
      mediumModel,
      largeModel,
      megaModel,
      responseHandlerModel,
      actionPlannerModel,
    });
  } else if (shouldConfigureRuntimeProvider && localProviderId) {
    const primaryModel = resolveOnboardingPrimaryModel({
      providerId: localProviderId,
      onboardingPrimaryModel: args.onboardingPrimaryModel,
      onboardingOpenRouterModel: args.onboardingOpenRouterModel,
    });
    llmTextRoute =
      serverTarget === "remote" && !persistRuntimeOnConnectedRemote
        ? {
            backend: localProviderId,
            transport: "remote",
            remoteApiBase: trimToUndefined(args.onboardingRemoteApiBase) ?? "",
            ...(primaryModel ? { primaryModel } : {}),
          }
        : {
            backend: localProviderId,
            transport: "direct",
            ...(primaryModel ? { primaryModel } : {}),
          };
  }

  if (llmTextRoute) {
    serviceRouting.llmText = llmTextRoute;
  }

  const cloudDefaultsSelected =
    args.onboardingProvider === "elizacloud" ||
    (deploymentTarget.runtime === "cloud" &&
      deploymentTarget.provider === "elizacloud");
  if (cloudDefaultsSelected) {
    Object.assign(
      serviceRouting,
      buildDefaultElizaCloudServiceRouting({
        base: serviceRouting,
        includeInference:
          shouldConfigureRuntimeProvider &&
          args.onboardingProvider === "elizacloud",
        excludeServices: args.onboardingUseLocalEmbeddings
          ? ["embeddings"]
          : undefined,
        nanoModel,
        smallModel,
        mediumModel,
        largeModel,
        megaModel,
        responseHandlerModel,
        actionPlannerModel,
      }),
    );
  }

  const hasLinkedAccounts = Object.keys(linkedAccounts).length > 0;
  const hasServiceRouting = Object.keys(serviceRouting).length > 0;
  const credentialInputs: OnboardingCredentialInputs = {};

  if (cloudApiKey) {
    credentialInputs.cloudApiKey = cloudApiKey;
  }

  const llmApiKey = trimToUndefined(args.onboardingApiKey);
  if (
    llmApiKey &&
    llmTextRoute?.backend &&
    llmTextRoute.backend !== "elizacloud"
  ) {
    credentialInputs.llmApiKey = llmApiKey;
  }

  const hasCredentialInputs = Object.keys(credentialInputs).length > 0;

  // Build feature setup from onboarding feature toggles
  const hasFeatures =
    args.onboardingFeatureTelegram ||
    args.onboardingFeatureDiscord ||
    args.onboardingFeatureCrypto ||
    args.onboardingFeatureBrowser ||
    args.onboardingFeatureComputerUse;

  const featureSetup: OnboardingFeatureSetup | undefined = hasFeatures
    ? {
        connectors: {
          ...(args.onboardingFeatureTelegram
            ? { telegram: { managed: true } }
            : {}),
          ...(args.onboardingFeatureDiscord
            ? { discord: { managed: true } }
            : {}),
        },
        capabilities: {
          ...(args.onboardingFeatureCrypto ? { crypto: true } : {}),
          ...(args.onboardingFeatureBrowser ? { browser: true } : {}),
          ...(args.onboardingFeatureComputerUse ? { computeruse: true } : {}),
        },
      }
    : undefined;

  return {
    deploymentTarget,
    linkedAccounts: hasLinkedAccounts ? linkedAccounts : undefined,
    serviceRouting: hasServiceRouting ? serviceRouting : undefined,
    credentialInputs: hasCredentialInputs ? credentialInputs : undefined,
    needsProviderSetup: !serviceRouting.llmText,
    featureSetup,
  };
}
