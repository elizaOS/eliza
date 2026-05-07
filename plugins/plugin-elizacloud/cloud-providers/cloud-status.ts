/**
 * cloudStatusProvider — Container and connection status in agent state.
 */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { CloudAuthService } from "../services/cloud-auth";
import type { CloudBridgeService } from "../services/cloud-bridge";
import type { CloudContainerService } from "../services/cloud-container";

const MAX_CONTAINER_SUMMARIES = 10;

export const cloudStatusProvider: Provider = {
  name: "elizacloud_status",
  description: "ElizaCloud container and connection status",
  descriptionCompressed: "ElizaCloud container/connection status.",
  dynamic: true,
  position: 90,
  contexts: ["settings", "finance"],
  contextGate: { anyOf: ["settings", "finance"] },
  cacheStable: false,
  cacheScope: "turn",
  async get(runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> {
    try {
      const auth = runtime.getService("CLOUD_AUTH") as CloudAuthService | undefined;
      if (!auth?.isAuthenticated()) {
        return {
          text: "ElizaCloud: Not authenticated",
          values: { cloudAuthenticated: false },
        };
      }

      const containerSvc = runtime.getService("CLOUD_CONTAINER") as CloudContainerService | undefined;
      const bridgeSvc = runtime.getService("CLOUD_BRIDGE") as CloudBridgeService | undefined;
      const containers = containerSvc?.getTrackedContainers() ?? [];
      const connected = bridgeSvc?.getConnectedContainerIds() ?? [];

    const running = containers.filter((c) => c.status === "running").length;
    const deploying = containers.filter(
      (c) => c.status === "pending" || c.status === "building" || c.status === "deploying"
    ).length;

      const summaries = containers.slice(0, MAX_CONTAINER_SUMMARIES).map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        url: c.load_balancer_url,
        billing: c.billing_status,
        bridged: connected.includes(c.id),
      }));

    const lines = [
      `ElizaCloud: ${containers.length} container(s), ${running} running, ${connected.length} bridged`,
      ...summaries.map(
        (c) =>
          `  - ${c.name} [${c.status}]${c.url ? ` @ ${c.url}` : ""}${c.bridged ? " (bridged)" : ""}`
      ),
    ];

      return {
        text: lines.join("\n"),
        values: {
          cloudAuthenticated: true,
          totalContainers: containers.length,
          runningContainers: running,
          deployingContainers: deploying,
        },
        data: { containers: summaries, truncated: containers.length > summaries.length },
      };
    } catch {
      return { text: "", values: {}, data: {} };
    }
  },
};
