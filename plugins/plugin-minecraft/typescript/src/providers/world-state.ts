import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  MINECRAFT_SERVICE_TYPE,
  type MinecraftService,
} from "../services/minecraft-service.js";

export const minecraftWorldStateProvider: Provider = {
  name: "MC_WORLD_STATE",
  description:
    "Minecraft world state: position, health, inventory, nearby entities",
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    const service = runtime.getService<MinecraftService>(
      MINECRAFT_SERVICE_TYPE,
    );
    if (!service) {
      return {
        text: "Minecraft service is not available",
        values: { connected: false },
        data: {},
      };
    }

    try {
      const state = await service.getWorldState();
      if (!state.connected) {
        return {
          text: "Minecraft bot is not connected. Use MC_CONNECT to join a server.",
          values: { connected: false },
          data: {},
        };
      }

      const pos = state.position
        ? `(${state.position.x.toFixed(1)}, ${state.position.y.toFixed(1)}, ${state.position.z.toFixed(1)})`
        : "(unknown)";
      const invCount = Array.isArray(state.inventory)
        ? state.inventory.length
        : 0;
      const entCount = Array.isArray(state.nearbyEntities)
        ? state.nearbyEntities.length
        : 0;

      return {
        text: `Minecraft: hp=${state.health ?? "?"} food=${state.food ?? "?"} pos=${pos} invItems=${invCount} nearbyEntities=${entCount}`,
        values: {
          connected: true,
          health: state.health ?? null,
          food: state.food ?? null,
          x: state.position?.x ?? null,
          y: state.position?.y ?? null,
          z: state.position?.z ?? null,
          inventoryCount: invCount,
          nearbyEntitiesCount: entCount,
        },
        data: state as Record<string, string | number | boolean | string[]>,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[Minecraft] Error getting world state: ${msg}`);
      return {
        text: "Error getting Minecraft world state",
        values: { connected: false, error: true },
        data: {},
      };
    }
  },
};
