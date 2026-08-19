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

/**
 * Where chat tokens are computed. `external` covers every non-Eliza-Cloud
 * hosted route (a direct Cerebras/OpenAI/Anthropic key, a coding-plan
 * subscription that drives runtime inference); `unknown` is the honest state
 * before the server has told us who is serving. Collapsing either into
 * `local` is what made the first version of this resolver claim "This device"
 * for a direct external provider.
 */
export type ServingInference = "local" | "cloud" | "external" | "unknown";

export type ServingCombination =
  | "all-local"
  | "cloud-inference"
  | "cloud-runtime"
  | "both"
  | "remote"
  | "external-inference"
  | "inference-unknown";

/**
 * `activeChat` from `GET /api/models/config` — the server's answer to "who is
 * actually serving chat?", resolved from the serviceRouting topology and the
 * live handler registrations. `null` while the request is in flight or when
 * no routing is configured; the resolver reports `unknown` rather than
 * guessing `local` in that window.
 */
export interface ActiveChatSource {
  provider: string;
  family: "OPENAI" | "ANTHROPIC" | "ELIZAOS_CLOUD";
  endpoint: string;
}

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
  /**
   * The authoritative serving source. Account/config booleans below only
   * qualify it (an unsigned Cloud route falls back to local); they never
   * substitute for it, because "Cloud is selected" is configuration and
   * "Cloud answered" is fact.
   */
  activeChat: ActiveChatSource | null;
  /** False while `GET /api/models/config` is still in flight. */
  activeChatResolved: boolean;
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
  /** Provider name the server reported as serving, for `external` display. */
  activeChatProvider: string | null;
  activeChatEndpoint: string | null;
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
 * Where chat tokens are computed, taken from the server's `activeChat` rather
 * than recomputed from account/config state. The only local qualification is
 * the unsigned cloud-proxy case: the server names Eliza Cloud while the
 * account cannot actually serve, so replies fall back on-device.
 *
 * Absent `activeChat` is `unknown`, never `local` — a direct Cerebras/OpenAI/
 * Anthropic route would otherwise be reported as running on this device.
 */
export function resolveServingInference({
  activeChat,
  activeChatResolved,
  elizaCloudConnected,
  cloudCallsDisabled,
}: Pick<
  ServingAxesInput,
  | "activeChat"
  | "activeChatResolved"
  | "elizaCloudConnected"
  | "cloudCallsDisabled"
>): ServingInference {
  if (!activeChatResolved) return "unknown";
  // The local-only switch disables Eliza Cloud calls; it does not make an
  // explicitly routed direct provider local. Trust the server's serving fact
  // before applying that Cloud-only qualification.
  if (activeChat && activeChat.family !== "ELIZAOS_CLOUD") return "external";
  if (cloudCallsDisabled) return "local";
  if (!activeChat) return "local";
  if (activeChat.family === "ELIZAOS_CLOUD") {
    // Configured for Cloud but the account cannot serve — replies are local.
    return elizaCloudConnected ? "cloud" : "local";
  }
  return "external";
}

export function resolveServingCombination(
  runtime: ServingRuntime,
  inference: ServingInference,
): ServingCombination {
  if (inference === "unknown") return "inference-unknown";
  if (runtime === "remote") return "remote";
  if (inference === "external") return "external-inference";
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
    // Only a Cloud-named route that cannot serve is a fallback; a direct
    // external provider is serving normally and must not be labelled one.
    inferenceFallback:
      input.activeChatResolved &&
      input.activeChat?.family === "ELIZAOS_CLOUD" &&
      !input.elizaCloudConnected &&
      !input.cloudCallsDisabled,
    activeChatProvider: input.activeChat?.provider ?? null,
    activeChatEndpoint: input.activeChat?.endpoint ?? null,
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
    case "external-inference":
      return axes.activeChatProvider
        ? `Inference on ${axes.activeChatProvider}`
        : "External inference";
    case "inference-unknown":
      return "Checking what answers chat";
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
    case "external-inference":
      return axes.activeChatProvider
        ? `The agent runs on this device. Chat replies are computed by ${axes.activeChatProvider}.`
        : "The agent runs on this device. Chat replies are computed by an external provider.";
    case "inference-unknown":
      return "Waiting for the agent to report which provider is answering chat.";
  }
}
