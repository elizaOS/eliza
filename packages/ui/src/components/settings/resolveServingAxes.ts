/**
 * Resolves the two independent serving axes Settings must show: where the
 * agent process lives (runtime) and where chat tokens are computed
 * (inference). Cloud-hybrid / unsigned cloud-proxy must not collapse those
 * into a single "Cloud is active" / "Local mode" bit.
 */

import type { RuntimeDeploymentRuntime } from "../../api/runtime-mode-client";
import type { MobileRuntimeMode } from "../../first-run/mobile-runtime-mode";
import type { FirstRunRuntimeTarget } from "../../first-run/runtime-target";
import type { RuntimeTarget } from "../../state/startup-coordinator";

export type ServingRuntime = "local" | "cloud" | "remote";
export type ServingInference = "local" | "cloud";

export type ServingCombination =
  | "all-local"
  | "cloud-inference"
  | "cloud-runtime"
  | "both"
  | "remote";

export interface ServingAxesInput {
  /**
   * `deploymentRuntime` from `GET /api/runtime/mode`, when the snapshot has
   * resolved. This is the server's own view of the persisted
   * `deploymentTarget.runtime`, which already records hybrid as `local`
   * (`buildDeploymentTarget` in first-run/first-run-config.ts), so it is
   * preferred over every client-side pin below. `null` while loading or when
   * the endpoint is unreachable.
   */
  deploymentRuntime: RuntimeDeploymentRuntime | null;
  startupTarget: RuntimeTarget | null;
  firstRunRuntimeTarget: FirstRunRuntimeTarget | "" | null;
  mobileRuntimeMode: MobileRuntimeMode | null;
  elizaCloudConnected: boolean;
  isCloudSelected: boolean;
  cloudCallsDisabled: boolean;
}

export interface ServingAxes {
  runtime: ServingRuntime;
  inference: ServingInference;
  combination: ServingCombination;
  /** Cloud-proxy is the configured route but the account is unsigned-in. */
  inferenceFallback: boolean;
}

function isHybridRuntime(
  mobileRuntimeMode: MobileRuntimeMode | null,
  firstRunRuntimeTarget: FirstRunRuntimeTarget | "" | null,
): boolean {
  return (
    mobileRuntimeMode === "cloud-hybrid" ||
    firstRunRuntimeTarget === "elizacloud-hybrid"
  );
}

/**
 * Where the agent process lives. Hybrid is local runtime by definition
 * (on-device agent, cloud models). The server snapshot wins when present;
 * otherwise live startup topology wins over a stale first-run pin, except
 * where hybrid would be misread as hosted Cloud.
 */
export function resolveServingRuntime({
  deploymentRuntime,
  startupTarget,
  firstRunRuntimeTarget,
  mobileRuntimeMode,
}: Pick<
  ServingAxesInput,
  | "deploymentRuntime"
  | "startupTarget"
  | "firstRunRuntimeTarget"
  | "mobileRuntimeMode"
>): ServingRuntime {
  if (deploymentRuntime) return deploymentRuntime;
  if (isHybridRuntime(mobileRuntimeMode, firstRunRuntimeTarget)) {
    return "local";
  }
  if (startupTarget === "cloud-managed") return "cloud";
  if (startupTarget === "remote-backend") return "remote";
  if (startupTarget === "embedded-local") return "local";
  if (mobileRuntimeMode === "cloud" || firstRunRuntimeTarget === "elizacloud") {
    return "cloud";
  }
  if (firstRunRuntimeTarget === "remote") return "remote";
  return "local";
}

/**
 * Where chat tokens are computed. Unsigned cloud-proxy is local inference,
 * not Cloud — the handler is not live.
 */
export function resolveServingInference({
  elizaCloudConnected,
  isCloudSelected,
  cloudCallsDisabled,
}: Pick<
  ServingAxesInput,
  "elizaCloudConnected" | "isCloudSelected" | "cloudCallsDisabled"
>): ServingInference {
  if (cloudCallsDisabled) return "local";
  if (isCloudSelected && elizaCloudConnected) return "cloud";
  return "local";
}

export function resolveServingCombination(
  runtime: ServingRuntime,
  inference: ServingInference,
): ServingCombination {
  if (runtime === "remote") return "remote";
  if (runtime === "cloud" && inference === "cloud") return "both";
  if (runtime === "cloud") return "cloud-runtime";
  if (inference === "cloud") return "cloud-inference";
  return "all-local";
}

export function resolveServingAxes(input: ServingAxesInput): ServingAxes {
  const runtime = resolveServingRuntime(input);
  const inference = resolveServingInference(input);
  return {
    runtime,
    inference,
    combination: resolveServingCombination(runtime, inference),
    inferenceFallback:
      input.isCloudSelected &&
      !input.elizaCloudConnected &&
      !input.cloudCallsDisabled,
  };
}

export function servingAxesHeadline(axes: ServingAxes): string {
  switch (axes.combination) {
    case "all-local":
      return "Everything is local";
    case "cloud-inference":
      return "Cloud inference";
    case "cloud-runtime":
      return "Cloud runtime";
    case "both":
      return "Cloud runtime and inference";
    case "remote":
      return "Remote runtime";
  }
}

export function servingAxesDescription(axes: ServingAxes): string {
  const fallback = axes.inferenceFallback
    ? " Eliza Cloud is not signed in, so models fall back to Local."
    : "";
  switch (axes.combination) {
    case "all-local":
      return `The agent and models run on this device.${fallback}`;
    case "cloud-inference":
      return "The agent runs on this device. Models use Eliza Cloud.";
    case "cloud-runtime":
      return `The agent runs on Eliza Cloud. Models run on this device.${fallback}`;
    case "both":
      return "The agent and models run on Eliza Cloud.";
    case "remote":
      return axes.inference === "cloud"
        ? "The agent runs on a remote host. Models use Eliza Cloud."
        : `The agent runs on a remote host. Models run with that host.${fallback}`;
  }
}
