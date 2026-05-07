import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import { MINECRAFT_SERVICE_TYPE, type MinecraftService } from "../services/minecraft-service.js";

type InventoryRow = { slot: number; name: string; count: number };
type EntityRow = { id: number; type: string; name: string; x: number; y: number; z: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function pickInventoryRows(inventory: unknown): InventoryRow[] {
  if (!Array.isArray(inventory)) return [];
  const rows: InventoryRow[] = [];
  for (const item of inventory) {
    if (!isRecord(item)) continue;
    const slot = typeof item.slot === "number" ? item.slot : null;
    const count = typeof item.count === "number" ? item.count : null;
    const name =
      typeof item.displayName === "string"
        ? item.displayName
        : typeof item.name === "string"
          ? item.name
          : null;
    if (slot === null || count === null || !name) continue;
    rows.push({ slot, name, count });
  }
  return rows;
}

function pickEntityRows(nearby: unknown): EntityRow[] {
  if (!Array.isArray(nearby)) return [];
  const rows: EntityRow[] = [];
  for (const ent of nearby) {
    if (!isRecord(ent)) continue;
    const id = typeof ent.id === "number" ? ent.id : null;
    const type = typeof ent.type === "string" ? ent.type : null;
    const username = typeof ent.username === "string" ? ent.username : null;
    const entName = typeof ent.name === "string" ? ent.name : null;
    const name = username ?? entName ?? type ?? "unknown";
    const pos = isRecord(ent.position) ? ent.position : null;
    const x = pos && typeof pos.x === "number" ? pos.x : null;
    const y = pos && typeof pos.y === "number" ? pos.y : null;
    const z = pos && typeof pos.z === "number" ? pos.z : null;
    if (id === null || !type || x === null || y === null || z === null) continue;
    rows.push({
      id,
      type,
      name,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      z: Math.round(z * 10) / 10,
    });
  }
  return rows;
}

export const minecraftWorldStateProvider: Provider = {
  name: "MC_WORLD_STATE",
  description: "Minecraft world state: connection, position, health, inventory, nearby entities",
  descriptionCompressed:
    "Read live Minecraft connection, position, health, inventory, and nearby entities.",
  dynamic: true,
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    const service = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
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
      const inventoryRows = pickInventoryRows(state.inventory);
      const entityRows = pickEntityRows(state.nearbyEntities);

      const headerLines = [
        `Minecraft: hp=${state.health ?? "?"} food=${state.food ?? "?"} pos=${pos} invItems=${inventoryRows.length} nearbyEntities=${entityRows.length}`,
      ];
      if (inventoryRows.length > 0) {
        headerLines.push(JSON.stringify({ inventory: inventoryRows }));
      }
      if (entityRows.length > 0) {
        headerLines.push(JSON.stringify({ nearbyEntities: entityRows }));
      }

      return {
        text: headerLines.join("\n"),
        values: {
          connected: true,
          health: state.health ?? null,
          food: state.food ?? null,
          x: state.position?.x ?? null,
          y: state.position?.y ?? null,
          z: state.position?.z ?? null,
          inventoryCount: inventoryRows.length,
          nearbyEntitiesCount: entityRows.length,
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
