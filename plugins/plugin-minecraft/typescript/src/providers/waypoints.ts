import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import {
  WAYPOINTS_SERVICE_TYPE,
  type WaypointsService,
} from "../services/waypoints-service.js";

export const minecraftWaypointsProvider: Provider = {
  name: "MC_WAYPOINTS",
  description: "Saved Minecraft waypoints (names and coordinates)",
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    const service = runtime.getService<WaypointsService>(
      WAYPOINTS_SERVICE_TYPE,
    );
    if (!service) {
      return {
        text: "Waypoints service not available",
        values: { count: 0 },
        data: { waypoints: [] },
      };
    }

    const list = service.listWaypoints();
    const lines = list.map(
      (w) =>
        `- ${w.name}: (${w.x.toFixed(1)}, ${w.y.toFixed(1)}, ${w.z.toFixed(1)})`,
    );
    return {
      text: list.length
        ? `Waypoints:\n${lines.join("\n")}`
        : "No waypoints saved.",
      values: { count: list.length },
      data: {
        waypoints: list.map((w) => ({
          name: w.name,
          x: w.x,
          y: w.y,
          z: w.z,
          createdAt: w.createdAt.toISOString(),
        })),
      },
    };
  },
};
