/**
 * containerHealthProvider — Container health in agent state (private, on-demand).
 */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { CloudAuthService } from "../services/cloud-auth";
import type { CloudContainerService } from "../services/cloud-container";

const MAX_HEALTH_REPORTS = 10;

export const containerHealthProvider: Provider = {
  name: "elizacloud_health",
  description: "ElizaCloud container health",
  descriptionCompressed: "ElizaCloud container health.",
  dynamic: true,
  position: 92,
  private: true,
  contexts: ["settings", "finance"],
  contextGate: { anyOf: ["settings", "finance"] },
  cacheStable: false,
  cacheScope: "turn",
  async get(runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> {
    try {
      const auth = runtime.getService("CLOUD_AUTH") as CloudAuthService | undefined;
      if (!auth?.isAuthenticated()) return { text: "" };

      const svc = runtime.getService("CLOUD_CONTAINER") as CloudContainerService | undefined;
      const running = svc?.getTrackedContainers().filter((c) => c.status === "running") ?? [];
      if (running.length === 0)
        return {
          text: "No running containers.",
          values: { healthyContainers: 0 },
        };

    // NOTE: True health would require hitting each container's health_check_path
    // endpoint over the network.  We approximate here using locally-cached state:
    // a container is considered healthy when it is running, billing is active,
    // and there is no recorded error message.
      const reports = running.slice(0, MAX_HEALTH_REPORTS).map((c) => ({
        id: c.id,
        name: c.name,
        healthy: c.status === "running" && c.billing_status === "active" && !c.error_message,
        status: c.status,
        billing: c.billing_status,
      }));

    const healthy = reports.filter((r) => r.healthy).length;
    const text = [
      `Health: ${healthy}/${reports.length} healthy`,
      ...reports.map(
        (r) =>
          `  - ${r.name}: ${r.healthy ? "OK" : "UNHEALTHY"} (status=${r.status}, billing=${r.billing})`
      ),
    ].join("\n");

      return {
        text,
        values: {
          healthyContainers: healthy,
          unhealthyContainers: reports.length - healthy,
        },
        data: { reports, truncated: running.length > reports.length },
      };
    } catch {
      return { text: "", values: {}, data: {} };
    }
  },
};
