/**
 * Runs the ordered post-ready contributor pipeline for one concrete runtime.
 * The host injects each capability so this module owns ordering and liveness,
 * while route, service, and process lifecycle remain with their owners.
 */
import { markDeferredBootPhase } from "@elizaos/agent/runtime/deferred-boot-status";
import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";

export interface StoppableRuntimeResource {
  stop(): void;
}

export interface RuntimeBootResources {
  tailRuntime: AgentRuntime | null;
  triggerEventBridge: StoppableRuntimeResource | null;
  connectorTargetCatalog: StoppableRuntimeResource | null;
}

export interface PostReadyBootSteps {
  registerAppRoutePlugins(runtime: AgentRuntime): Promise<void>;
  registerRuntimeHooks(runtime: AgentRuntime): Promise<void>;
  registerCoreSensitiveRequestAdapters(runtime: AgentRuntime): void;
  registerSubAgentCredentialBridge(runtime: AgentRuntime): Promise<void>;
  registerSubAgentCredentialBridgeAdapter(runtime: AgentRuntime): boolean;
  ensureTriggerEventBridge(runtime: AgentRuntime): Promise<void>;
  ensureConnectorTargetCatalog(runtime: AgentRuntime): Promise<void>;
  startDeferredVoiceWarmup(runtime: AgentRuntime): void;
}

/** Creates resource ownership for one boot attempt. */
export function createRuntimeBootResources(): RuntimeBootResources {
  return {
    tailRuntime: null,
    triggerEventBridge: null,
    connectorTargetCatalog: null,
  };
}

/** Runs contributors in the dependency order required by feature startup. */
export async function runPostReadyBootTail(
  runtime: AgentRuntime,
  steps: PostReadyBootSteps,
  resources: RuntimeBootResources,
): Promise<void> {
  // Hot restart may publish another runtime before this deferred promise runs.
  // Only the boot attempt that owns this resource slot may mutate its runtime.
  if (!ownsBootResources(runtime, resources)) {
    logger.info("[eliza] post-ready boot tail skipped — runtime superseded");
    return;
  }

  await steps.registerAppRoutePlugins(runtime);
  // Teardown or hot restart can clear `resources.tailRuntime` while any later
  // step is awaiting. Ownership is re-checked between every contributor so a
  // torn-down runtime never registers hooks, bridges, catalogs, or warmup
  // after teardown (#25110): the already-started contributor may finish, but
  // no subsequent contributor or completion stamp may run.
  if (!ownsBootResources(runtime, resources)) {
    logger.info(
      "[eliza] post-ready boot tail aborted — runtime lost ownership mid-tail",
    );
    return;
  }
  await steps.registerRuntimeHooks(runtime);
  if (!ownsBootResources(runtime, resources)) {
    logger.info(
      "[eliza] post-ready boot tail aborted — runtime lost ownership mid-tail",
    );
    return;
  }
  steps.registerCoreSensitiveRequestAdapters(runtime);
  steps.registerSubAgentCredentialBridgeAdapter(runtime);
  await steps.registerSubAgentCredentialBridge(runtime);
  if (!ownsBootResources(runtime, resources)) {
    logger.info(
      "[eliza] post-ready boot tail aborted — runtime lost ownership mid-tail",
    );
    return;
  }
  await steps.ensureTriggerEventBridge(runtime);
  if (!ownsBootResources(runtime, resources)) {
    logger.info(
      "[eliza] post-ready boot tail aborted — runtime lost ownership mid-tail",
    );
    return;
  }
  await steps.ensureConnectorTargetCatalog(runtime);
  if (!ownsBootResources(runtime, resources)) {
    logger.info(
      "[eliza] post-ready boot tail aborted — runtime lost ownership mid-tail",
    );
    return;
  }
  void steps.startDeferredVoiceWarmup(runtime);

  // Completion is stamped inside the liveness guard so a superseded tail
  // cannot overwrite the phase belonging to a newer boot attempt.
  markDeferredBootPhase("app-route-tail", "complete");
}

/** True only while this runtime still owns its boot resource slot. */
function ownsBootResources(
  runtime: AgentRuntime,
  resources: RuntimeBootResources,
): boolean {
  return resources.tailRuntime === runtime;
}
