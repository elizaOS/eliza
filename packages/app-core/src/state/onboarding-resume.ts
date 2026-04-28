import {
  getOnboardingProviderOption,
  isElizaCloudLinkedInConfig,
  normalizeOnboardingProviderId,
  readOnboardingEnvSecret,
  resolveDeploymentTargetInConfig,
  resolveLinkedAccountsInConfig,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared";
import { readPersistedMobileRuntimeMode } from "../onboarding/mobile-runtime-mode";
import type { BuildOnboardingConnectionArgs } from "../onboarding-config";
import { asRecord } from "./config-readers";
import type { OnboardingStep } from "./types";

export function hasPartialOnboardingConnectionConfig(
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

export function inferOnboardingResumeStep(args: {
  config?: Record<string, unknown> | null;
  persistedStep?: OnboardingStep | null;
}): OnboardingStep {
  if (args.persistedStep) {
    return args.persistedStep;
  }

  if (hasPartialOnboardingConnectionConfig(args.config)) {
    return "providers";
  }

  return "deployment";
}

export function deriveOnboardingResumeFieldsFromConfig(
  config: Record<string, unknown> | null | undefined,
): Partial<BuildOnboardingConnectionArgs> {
  const deploymentTarget = resolveDeploymentTargetInConfig(config);
  const linkedAccounts = resolveLinkedAccountsInConfig(config);
  const serviceRouting = resolveServiceRoutingInConfig(config);
  const llmText = serviceRouting?.llmText ?? null;
  const llmBackend = normalizeOnboardingProviderId(llmText?.backend);
  const llmProvider = llmBackend
    ? getOnboardingProviderOption(llmBackend)
    : null;
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
  const onboardingServerTarget =
    deploymentTarget.runtime === "remote"
      ? "remote"
      : deploymentTarget.runtime === "cloud"
        ? cloudServerTarget
        : "local";

  const fields: Partial<BuildOnboardingConnectionArgs> = {
    onboardingServerTarget,
    onboardingCloudApiKey: cloudApiKey,
    onboardingProvider: "",
    onboardingApiKey: "",
    onboardingVoiceProvider: "",
    onboardingVoiceApiKey: "",
    onboardingPrimaryModel: "",
    onboardingOpenRouterModel: "",
    onboardingRemoteConnected:
      deploymentTarget.runtime === "remote" &&
      Boolean(deploymentTarget.remoteApiBase),
    onboardingRemoteApiBase: deploymentTarget.remoteApiBase ?? "",
    onboardingRemoteToken: deploymentTarget.remoteAccessToken ?? "",
    onboardingSmallModel: "",
    onboardingLargeModel: "",
  };

  if (!llmText) {
    return fields;
  }

  if (llmText.transport === "cloud-proxy" && llmBackend === "elizacloud") {
    return {
      ...fields,
      onboardingProvider: "elizacloud",
      onboardingSmallModel: llmText.smallModel ?? "",
      onboardingLargeModel: llmText.largeModel ?? "",
    };
  }

  if (llmBackend && llmBackend !== "elizacloud") {
    const apiKey =
      llmProvider?.envKey != null
        ? (readOnboardingEnvSecret(config, llmProvider.envKey) ?? "")
        : "";

    return {
      ...fields,
      onboardingProvider: llmBackend,
      onboardingApiKey: apiKey,
      onboardingPrimaryModel:
        llmBackend === "openrouter" ? "" : (llmText.primaryModel ?? ""),
      onboardingOpenRouterModel:
        llmBackend === "openrouter" ? (llmText.primaryModel ?? "") : "",
    };
  }

  return fields;
}
