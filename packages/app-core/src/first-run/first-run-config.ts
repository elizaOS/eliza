import {
  buildDefaultElizaCloudServiceRouting,
  buildElizaCloudServiceRoute,
  type DeploymentTargetConfig,
  type FirstRunCredentialInputs,
  type LinkedAccountFlagsConfig,
  requiresAdditionalRuntimeProvider,
  type ServiceRouteConfig,
  type ServiceRoutingConfig,
} from "@elizaos/shared";
import {
  type FirstRunLocalProviderId,
  normalizeFirstRunProviderId,
} from "../../../shared/src/contracts/first-run-options.js";
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

export function buildFirstRunRuntimeConfig(
  args: BuildFirstRunConnectionArgs,
): BuildFirstRunRuntimeConfigResult {
  const serverTarget = resolveArgsServerTarget(args);
  const persistRuntimeOnConnectedRemote =
    serverTarget === "remote" && args.firstRunRemoteConnected;
  const useElizaCloudRuntime = isElizaCloudFirstRunTarget(serverTarget);
  const nanoModel = trimToUndefined(args.firstRunNanoModel);
  const smallModel = trimToUndefined(args.firstRunSmallModel);
  const mediumModel = trimToUndefined(args.firstRunMediumModel);
  const largeModel = trimToUndefined(args.firstRunLargeModel);
  const megaModel = trimToUndefined(args.firstRunMegaModel);
  const responseHandlerModel = trimToUndefined(
    args.firstRunResponseHandlerModel ?? "",
  );
  const actionPlannerModel = trimToUndefined(
    args.firstRunActionPlannerModel ?? "",
  );
  const linkedAccounts: LinkedAccountFlagsConfig = {};
  const cloudApiKey = trimToUndefined(args.firstRunCloudApiKey);
  if (cloudApiKey) {
    linkedAccounts.elizacloud = {
      status: "linked",
      source: "api-key",
    };
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

  const deploymentTarget: DeploymentTargetConfig =
    persistRuntimeOnConnectedRemote
      ? { runtime: "local" }
      : serverTarget === "remote"
        ? {
            runtime: "remote",
            provider: "remote",
            remoteApiBase: trimToUndefined(args.firstRunRemoteApiBase) ?? "",
            ...(trimToUndefined(args.firstRunRemoteToken)
              ? {
                  remoteAccessToken: trimToUndefined(args.firstRunRemoteToken),
                }
              : {}),
          }
        : useElizaCloudRuntime && !args.firstRunRemoteConnected
          ? {
              runtime: "cloud",
              provider: "elizacloud",
            }
          : { runtime: "local" };

  const serviceRouting: ServiceRoutingConfig = {};
  let llmTextRoute: ServiceRouteConfig | undefined;
  const shouldConfigureRuntimeProvider =
    !args.omitRuntimeProvider &&
    !requiresAdditionalRuntimeProvider(args.firstRunProvider);

  if (
    args.firstRunProvider === "elizacloud" &&
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
    const primaryModel = resolveFirstRunPrimaryModel({
      providerId: localProviderId,
      firstRunPrimaryModel: args.firstRunPrimaryModel,
      firstRunOpenRouterModel: args.firstRunOpenRouterModel,
    });
    llmTextRoute =
      serverTarget === "remote" && !persistRuntimeOnConnectedRemote
        ? {
            backend: localProviderId,
            transport: "remote",
            remoteApiBase: trimToUndefined(args.firstRunRemoteApiBase) ?? "",
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
    args.firstRunProvider === "elizacloud" ||
    (deploymentTarget.runtime === "cloud" &&
      deploymentTarget.provider === "elizacloud");
  if (cloudDefaultsSelected) {
    Object.assign(
      serviceRouting,
      buildDefaultElizaCloudServiceRouting({
        base: serviceRouting,
        includeInference:
          shouldConfigureRuntimeProvider &&
          args.firstRunProvider === "elizacloud",
        // Embeddings follow the runtime: a cloud agent uses cloud embeddings,
        // a local agent (including local+cloud-inference hybrid) keeps
        // embeddings local so vectors never depend on a network round-trip.
        excludeServices:
          deploymentTarget.runtime === "cloud" ? undefined : ["embeddings"],
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
  const credentialInputs: FirstRunCredentialInputs = {};

  if (cloudApiKey) {
    credentialInputs.cloudApiKey = cloudApiKey;
  }

  const llmApiKey = trimToUndefined(args.firstRunApiKey);
  if (
    llmApiKey &&
    llmTextRoute?.backend &&
    llmTextRoute.backend !== "elizacloud"
  ) {
    credentialInputs.llmApiKey = llmApiKey;
  }

  const hasCredentialInputs = Object.keys(credentialInputs).length > 0;

  // Build feature setup from first-run capability toggles
  const hasFeatures =
    args.firstRunFeatureTelegram ||
    args.firstRunFeatureDiscord ||
    args.firstRunFeatureCrypto ||
    args.firstRunFeatureBrowser ||
    args.firstRunFeatureComputerUse;

  const featureSetup: FirstRunCapabilitySetup | undefined = hasFeatures
    ? {
        connectors: {
          ...(args.firstRunFeatureTelegram
            ? { telegram: { managed: true } }
            : {}),
          ...(args.firstRunFeatureDiscord
            ? { discord: { managed: true } }
            : {}),
        },
        capabilities: {
          ...(args.firstRunFeatureCrypto ? { crypto: true } : {}),
          ...(args.firstRunFeatureBrowser ? { browser: true } : {}),
          ...(args.firstRunFeatureComputerUse ? { computeruse: true } : {}),
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
