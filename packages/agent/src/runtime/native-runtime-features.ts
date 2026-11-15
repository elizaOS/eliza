/** Optional features are owned by registered services, not removed core flags. */
import type { AgentRuntime } from "@elizaos/core";

export function runtimeDocumentsEnabled(runtime: AgentRuntime): boolean {
  if (runtime.getService("documents")) return true;
  const status = runtime.getServiceRegistrationStatus("documents");
  return status === "pending" || status === "registering";
}
