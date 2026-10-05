/** Optional features are owned by registered services, not removed core flags. */
import type { AgentRuntime } from "@elizaos/core";

function serviceSelected(
  runtime: AgentRuntime,
  serviceType: "trajectories" | "documents",
): boolean {
  if (runtime.getService(serviceType)) return true;
  const status = runtime.getServiceRegistrationStatus(serviceType);
  return status === "pending" || status === "registering";
}

export function runtimeTrajectoriesEnabled(runtime: AgentRuntime): boolean {
  return serviceSelected(runtime, "trajectories");
}

export function runtimeDocumentsEnabled(runtime: AgentRuntime): boolean {
  return serviceSelected(runtime, "documents");
}
