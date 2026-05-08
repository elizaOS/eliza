import type { AgentRuntime } from "@elizaos/core";

/** Optional methods on some elizaOS AgentRuntime builds (not in all type versions). */
type AgentRuntimeFeatureFlags = {
  isTrajectoriesEnabled?: () => boolean;
  isDocumentsEnabled?: () => boolean;
};

export function runtimeTrajectoriesEnabled(runtime: AgentRuntime): boolean {
  const runtimeWithFlags = runtime as AgentRuntime & AgentRuntimeFeatureFlags;
  return (
    typeof runtimeWithFlags.isTrajectoriesEnabled === "function" &&
    runtimeWithFlags.isTrajectoriesEnabled()
  );
}

export function runtimeDocumentsEnabled(runtime: AgentRuntime): boolean {
  const runtimeWithFlags = runtime as AgentRuntime & AgentRuntimeFeatureFlags;
  return (
    typeof runtimeWithFlags.isDocumentsEnabled === "function" &&
    runtimeWithFlags.isDocumentsEnabled()
  );
}

