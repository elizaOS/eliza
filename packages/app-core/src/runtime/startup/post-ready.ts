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
  if (resources.tailRuntime !== runtime) {
    logger.info("[eliza] post-ready boot tail skipped — runtime superseded");
    return;
  }

  await steps.registerAppRoutePlugins(runtime);
  await steps.registerRuntimeHooks(runtime);
  steps.registerCoreSensitiveRequestAdapters(runtime);
  steps.registerSubAgentCredentialBridgeAdapter(runtime);
  await steps.registerSubAgentCredentialBridge(runtime);
  await steps.ensureTriggerEventBridge(runtime);
  await steps.ensureConnectorTargetCatalog(runtime);
  void steps.startDeferredVoiceWarmup(runtime);

  // Completion is stamped inside the liveness guard so a superseded tail
  // cannot overwrite the phase belonging to a newer boot attempt.
  markDeferredBootPhase("app-route-tail", "complete");
}
