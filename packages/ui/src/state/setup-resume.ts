import {
  getFirstRunProviderOption,
  isElizaCloudLinkedInConfig,
  normalizeFirstRunProviderId,
  readFirstRunEnvSecret,
  resolveDeploymentTargetInConfig,
  resolveLinkedAccountsInConfig,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared";
import type { BuildFirstRunConnectionArgs } from "../first-run/first-run-config";
import { readPersistedMobileRuntimeMode } from "../first-run/mobile-runtime-mode";
import { asRecord } from "./config-readers";
import type { SetupStep } from "./types";

export function hasPartialSetupConnectionConfig(
  config: Record<string, unknown> | null | undefined,
): boolean {
  if (resolveServiceRoutingInConfig(config)) {
    return true;
  }

  const deploymentTarget = resolveDeploymentTargetInConfig(config);
  if (deploymentTarget.runtime !== "local") {
    return true;
  }

  const root = asRecord(config);
  if (
    root &&
    (Object.hasOwn(root, "deploymentTarget") ||
      Object.hasOwn(root, "linkedAccounts") ||
      Object.hasOwn(root, "serviceRouting"))
  ) {
    return true;
  }

  return isElizaCloudLinkedInConfig(config);
}

export function inferSetupResumeStep(args: {
  config?: Record<string, unknown> | null;
  persistedStep?: SetupStep | null;
}): SetupStep {
  if (args.persistedStep) {
    return args.persistedStep;
  }

  if (hasPartialSetupConnectionConfig(args.config)) {
    return "model";
  }

  return "connection";
}

export function deriveFirstRunResumeFieldsFromConfig(
  config: Record<string, unknown> | null | undefined,
): Partial<BuildFirstRunConnectionArgs> {
  const deploymentTarget = resolveDeploymentTargetInConfig(config);
  const linkedAccounts = resolveLinkedAccountsInConfig(config);
  const serviceRouting = resolveServiceRoutingInConfig(config);
  const llmText = serviceRouting?.llmText ?? null;
  const llmBackend = normalizeFirstRunProviderId(llmText?.backend);
  const llmProvider = llmBackend ? getFirstRunProviderOption(llmBackend) : null;
  const root = asRecord(config);
  const cloud = asRecord(root?.cloud);
  const cloudApiKey =
    linkedAccounts?.elizacloud?.status === "linked" &&
    typeof cloud?.apiKey === "string"
      ? cloud.apiKey.trim()
      : "";

  const cloudServerTarget =
    readPersistedMobileRuntimeMode() === "cloud-hybrid"
      ? "elizacloud-hybrid"
      : "elizacloud";
  const firstRunRuntimeTarget =
    deploymentTarget.runtime === "remote"
      ? "remote"
      : deploymentTarget.runtime === "cloud"
        ? cloudServerTarget
        : "local";

  const fields: Partial<BuildFirstRunConnectionArgs> = {
    firstRunRuntimeTarget,
    firstRunCloudApiKey: cloudApiKey,
    firstRunProvider: "",
    firstRunApiKey: "",
    firstRunVoiceProvider: "",
    firstRunVoiceApiKey: "",
    firstRunPrimaryModel: "",
    firstRunOpenRouterModel: "",
    firstRunRemoteConnected:
      deploymentTarget.runtime === "remote" &&
      Boolean(deploymentTarget.remoteApiBase),
    firstRunRemoteApiBase: deploymentTarget.remoteApiBase ?? "",
    firstRunRemoteToken: deploymentTarget.remoteAccessToken ?? "",
    firstRunSmallModel: "",
    firstRunLargeModel: "",
  };

  if (!llmText) {
    return fields;
  }

  if (llmText.transport === "cloud-proxy" && llmBackend === "elizacloud") {
    return {
      ...fields,
      firstRunProvider: "elizacloud",
      firstRunSmallModel: llmText.smallModel ?? "",
      firstRunLargeModel: llmText.largeModel ?? "",
    };
  }

  if (llmBackend && llmBackend !== "elizacloud") {
    const apiKey =
      llmProvider?.envKey != null
        ? (readFirstRunEnvSecret(config, llmProvider.envKey) ?? "")
        : "";

    return {
      ...fields,
      firstRunProvider: llmBackend,
      firstRunApiKey: apiKey,
      firstRunPrimaryModel:
        llmBackend === "openrouter" ? "" : (llmText.primaryModel ?? ""),
      firstRunOpenRouterModel:
        llmBackend === "openrouter" ? (llmText.primaryModel ?? "") : "",
    };
  }

  return fields;
}
