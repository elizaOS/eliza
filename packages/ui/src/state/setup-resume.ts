/**
 * Onboarding-resume derivation from a partial server config. When the backend
 * reports first-run incomplete but eliza.json already carries connection
 * evidence (deployment target, linked accounts, service routing), the polling
 * phase uses these helpers to seed the surviving first-run fields (runtime
 * target, provider, remote connection) so the in-chat conductor resumes with
 * the right context instead of a blank slate.
 */

import {
  isElizaCloudLinkedInConfig,
  normalizeFirstRunProviderId,
  resolveDeploymentTargetInConfig,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared";
import { readPersistedMobileRuntimeMode } from "../first-run/mobile-runtime-mode";
import type { FirstRunRuntimeTarget } from "../first-run/runtime-target";
import { asRecord } from "./config-readers";

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

export interface FirstRunResumeFields {
  firstRunRuntimeTarget: FirstRunRuntimeTarget;
  firstRunProvider: string;
  firstRunRemoteConnected: boolean;
  firstRunRemoteApiBase: string;
  firstRunRemoteToken: string;
}

export function deriveFirstRunResumeFieldsFromConfig(
  config: Record<string, unknown> | null | undefined,
): FirstRunResumeFields {
  const deploymentTarget = resolveDeploymentTargetInConfig(config);
  const serviceRouting = resolveServiceRoutingInConfig(config);
  const llmText = serviceRouting?.llmText ?? null;
  const llmBackend = normalizeFirstRunProviderId(llmText?.backend);

  const pinnedRuntimeMode = readPersistedMobileRuntimeMode();
  const cloudServerTarget =
    pinnedRuntimeMode === "cloud-hybrid" ? "elizacloud-hybrid" : "elizacloud";
  // Honor an explicit local choice (set when the user switches to the on-device
  // agent). Without this, a device whose eliza.json is still cloud-LINKED
  // (deploymentTarget.runtime === "cloud") re-resumes cloud on every boot and
  // overrides the user's on-device selection. We only suppress the auto-resume
  // here — the cloud link in the config is left intact, so the user can switch
  // back to cloud at any time.
  const firstRunRuntimeTarget =
    pinnedRuntimeMode === "local"
      ? "local"
      : deploymentTarget.runtime === "remote"
        ? "remote"
        : deploymentTarget.runtime === "cloud"
          ? cloudServerTarget
          : "local";

  // The provider resumes only when the routing unambiguously names one: the
  // Eliza Cloud proxy route, or an explicit non-cloud backend.
  const firstRunProvider =
    llmText &&
    llmText.transport === "cloud-proxy" &&
    llmBackend === "elizacloud"
      ? "elizacloud"
      : llmBackend && llmBackend !== "elizacloud"
        ? llmBackend
        : "";

  return {
    firstRunRuntimeTarget,
    firstRunProvider,
    firstRunRemoteConnected:
      deploymentTarget.runtime === "remote" &&
      Boolean(deploymentTarget.remoteApiBase),
    firstRunRemoteApiBase: deploymentTarget.remoteApiBase ?? "",
    firstRunRemoteToken: deploymentTarget.remoteAccessToken ?? "",
  };
}
