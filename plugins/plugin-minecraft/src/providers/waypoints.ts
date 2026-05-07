import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { WAYPOINTS_SERVICE_TYPE, type WaypointsService } from "../services/waypoints-service.js";

const MAX_WAYPOINTS_IN_STATE = 50;

export const minecraftWaypointsProvider: Provider = {
  name: "MC_WAYPOINTS",
  description: "Saved Minecraft waypoints (names and coordinates)",
  descriptionCompressed: "List saved Minecraft waypoint names and coordinates.",
  dynamic: true,
  contexts: ["automation", "agent_internal"],
  contextGate: { anyOf: ["automation", "agent_internal"] },
  cacheStable: false,
  cacheScope: "turn",
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    const service = runtime.getService<WaypointsService>(WAYPOINTS_SERVICE_TYPE);
    if (!service) {
      return {
        text: "Waypoints service not available",
        values: { count: 0 },
        data: { waypoints: [] },
      };
    }

    try {
      const list = service.listWaypoints();
      const shown = list.slice(0, MAX_WAYPOINTS_IN_STATE);
      const truncated = list.length > shown.length;
      const lines = shown.map(
        (w) => `- ${w.name}: (${w.x.toFixed(1)}, ${w.y.toFixed(1)}, ${w.z.toFixed(1)})`
      );
      return {
        text: list.length
          ? `Waypoints (${shown.length}/${list.length}${truncated ? ", truncated" : ""}):\n${lines.join("\n")}`
          : "No waypoints saved.",
        values: { count: list.length, shown: shown.length, truncated },
        data: {
          waypoints: shown.map((w) => ({
            name: w.name,
            x: w.x,
            y: w.y,
            z: w.z,
            createdAt: w.createdAt.toISOString(),
          })),
        },
      };
    } catch (error) {
      return {
        text: "Unable to load Minecraft waypoints",
        values: { count: 0, error: true },
        data: { waypoints: [], error: error instanceof Error ? error.message : String(error) },
      };
    }
  },
};
