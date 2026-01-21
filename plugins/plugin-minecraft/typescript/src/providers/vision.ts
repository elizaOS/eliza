import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import {
  MINECRAFT_SERVICE_TYPE,
  type MinecraftService,
} from "../services/minecraft-service.js";

export const minecraftVisionProvider: Provider = {
  name: "MC_VISION",
  description:
    "Semantic environment context: biome, what I'm looking at, key nearby blocks (logs/ores), nearby entities",
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    const mc = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
    if (!mc) {
      return {
        text: "Minecraft service not available",
        values: { connected: false },
        data: {},
      };
    }

    const ws = await mc.getWorldState();
    if (!ws.connected) {
      return {
        text: "Minecraft bot not connected",
        values: { connected: false },
        data: {},
      };
    }

    // Best-effort, bounded scan for key blocks to give the LLM spatial anchors.
    const scan = await mc.request("scan", {
      blocks: [
        "oak_log",
        "spruce_log",
        "birch_log",
        "jungle_log",
        "acacia_log",
        "dark_oak_log",
        "stone",
        "coal_ore",
        "iron_ore",
      ],
      radius: 16,
      maxResults: 24,
    });

    const blocks = Array.isArray(scan.blocks) ? scan.blocks : [];
    const pos = ws.position
      ? `(${ws.position.x.toFixed(1)}, ${ws.position.y.toFixed(1)}, ${ws.position.z.toFixed(1)})`
      : "(unknown)";
    const biomeName =
      ws.biome &&
      typeof ws.biome === "object" &&
      "name" in ws.biome &&
      typeof ws.biome.name === "string"
        ? ws.biome.name
        : null;
    const lookingAt = ws.lookingAt as
      | {
          name?: string | null;
          position?: { x?: number; y?: number; z?: number } | null;
        }
      | null
      | undefined;
    const laName =
      lookingAt && typeof lookingAt.name === "string" ? lookingAt.name : null;
    const laPos = lookingAt?.position
      ? {
          x:
            typeof lookingAt.position.x === "number"
              ? lookingAt.position.x
              : null,
          y:
            typeof lookingAt.position.y === "number"
              ? lookingAt.position.y
              : null,
          z:
            typeof lookingAt.position.z === "number"
              ? lookingAt.position.z
              : null,
        }
      : null;
    const lookingText =
      laName &&
      laPos &&
      laPos.x !== null &&
      laPos.y !== null &&
      laPos.z !== null
        ? `Looking at: ${laName} at (${laPos.x}, ${laPos.y}, ${laPos.z})`
        : "Looking at: (unknown)";

    const entityCount = Array.isArray(ws.nearbyEntities)
      ? ws.nearbyEntities.length
      : 0;

    return {
      text: `Biome: ${biomeName ?? "unknown"}\nPosition: ${pos}\n${lookingText}\nNearbyEntities: ${entityCount}\nNearbyBlocksFound: ${blocks.length}`,
      values: {
        connected: true,
        biome: biomeName ?? null,
        entityCount,
        blocksFound: blocks.length,
      },
      data: {
        biome: ws.biome ?? null,
        position: ws.position ?? null,
        lookingAt: ws.lookingAt ?? null,
        nearbyEntities: ws.nearbyEntities ?? [],
        nearbyBlocks: blocks,
      },
    };
  },
};
