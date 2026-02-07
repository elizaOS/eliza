/**
 * containerHealthProvider — Container health in agent state (private, on-demand).
 */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { CloudContainerService } from "../services/cloud-container";
import type { CloudAuthService } from "../services/cloud-auth";

export const containerHealthProvider: Provider = {
  name: "elizacloud_health",
  description: "ElizaCloud container health",
  dynamic: true,
  position: 92,
  private: true,

  async get(runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> {
    const auth = runtime.getService("CLOUD_AUTH") as CloudAuthService | undefined;
    if (!auth?.isAuthenticated()) return { text: "" };

    const svc = runtime.getService("CLOUD_CONTAINER") as CloudContainerService | undefined;
    const running = svc?.getTrackedContainers().filter((c) => c.status === "running") ?? [];
    if (running.length === 0) return { text: "No running containers.", values: { healthyContainers: 0 } };

    const reports = running.map((c) => ({
      id: c.id, name: c.name,
      healthy: c.billing_status === "active",
      billing: c.billing_status,
    }));

    const healthy = reports.filter((r) => r.healthy).length;
    const text = [
      `Health: ${healthy}/${reports.length} healthy`,
      ...reports.map((r) => `  - ${r.name}: ${r.healthy ? "OK" : "UNHEALTHY"} (${r.billing})`),
    ].join("\n");

    return { text, values: { healthyContainers: healthy, unhealthyContainers: reports.length - healthy }, data: { reports } };
  },
};
