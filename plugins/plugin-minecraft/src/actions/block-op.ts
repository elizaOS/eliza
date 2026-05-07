import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { JsonValue } from "../protocol.js";
import { MINECRAFT_SERVICE_TYPE, type MinecraftService } from "../services/minecraft-service.js";
import {
  emit,
  isPlaceFace,
  mergedInput,
  type PlaceFace,
  parseVec3,
  readString,
  withMinecraftTimeout,
} from "./helpers.js";

const ACTION_NAME = "MC_BLOCK_OP";

type BlockOp = "dig" | "place";

function inferOp(text: string, params: Record<string, unknown>): BlockOp | null {
  const explicit = readString(params, "op", "operation", "mode")?.toLowerCase();
  if (explicit === "dig" || explicit === "mine" || explicit === "break") return "dig";
  if (explicit === "place" || explicit === "build") return "place";

  const lower = text.toLowerCase();
  if (/\b(dig|mine|break)\b/.test(lower)) return "dig";
  if (/\b(place|build)\b/.test(lower)) return "place";
  return null;
}

function parsePlaceFace(params: Record<string, unknown>, text: string): PlaceFace | null {
  const explicit = readString(params, "face");
  if (isPlaceFace(explicit)) return explicit;
  const match = text.trim().match(/\b(up|down|north|south|east|west)\b/i);
  if (!match) return null;
  const candidate = match[1].toLowerCase();
  return isPlaceFace(candidate) ? candidate : null;
}

export const minecraftBlockOpAction: Action = {
  name: ACTION_NAME,
  contexts: ["automation", "media"],
  contextGate: { anyOf: ["automation", "media"] },
  roleGate: { minRole: "USER" },
  similes: ["MC_DIG", "MC_PLACE", "MC_BUILD", "MC_MINE"],
  description:
    "Operate on a Minecraft block at coordinates: dig the block or place a block facing.",
  descriptionCompressed: "Minecraft block ops: dig, place.",
  parameters: [
    {
      name: "op",
      description: "Block operation.",
      descriptionCompressed: "operation",
      required: true,
      schema: { type: "string", enum: ["dig", "place"] },
    },
    {
      name: "x",
      description: "Target x coordinate.",
      descriptionCompressed: "x coord",
      required: true,
      schema: { type: "number" },
    },
    {
      name: "y",
      description: "Target y coordinate.",
      descriptionCompressed: "y coord",
      required: true,
      schema: { type: "number" },
    },
    {
      name: "z",
      description: "Target z coordinate.",
      descriptionCompressed: "z coord",
      required: true,
      schema: { type: "number" },
    },
    {
      name: "face",
      description: "Reference block face for place.",
      descriptionCompressed: "place face",
      required: false,
      schema: { type: "string", enum: ["up", "down", "north", "south", "east", "west"] },
    },
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    if (!runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE)) return false;
    return /\b(dig|mine|break|place|build)\b/i.test(message.content.text ?? "");
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions | Record<string, JsonValue | undefined>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
    if (!service) return { text: "Minecraft service is not available", success: false };

    const params = mergedInput(message, options);
    const text = message.content.text ?? "";
    const op = inferOp(text, params);
    if (!op) {
      return emit(
        ACTION_NAME,
        callback,
        "Missing block op (dig or place).",
        message.content.source,
        {
          success: false,
        }
      );
    }

    const vec = parseVec3(params, text);
    if (!vec) {
      return emit(ACTION_NAME, callback, "Missing coordinates (x y z).", message.content.source, {
        success: false,
      });
    }

    try {
      if (op === "dig") {
        const data = await withMinecraftTimeout(
          service.request("dig", { x: vec.x, y: vec.y, z: vec.z }),
          "minecraft dig"
        );
        const blockName = typeof data.blockName === "string" ? data.blockName : "block";
        return await emit(
          ACTION_NAME,
          callback,
          `Dug ${blockName} at (${vec.x}, ${vec.y}, ${vec.z}).`,
          message.content.source,
          { success: true, data }
        );
      }

      const face = parsePlaceFace(params, text);
      if (!face) {
        return emit(
          ACTION_NAME,
          callback,
          "Missing placement face (up/down/north/south/east/west).",
          message.content.source,
          { success: false }
        );
      }
      await withMinecraftTimeout(
        service.request("place", { x: vec.x, y: vec.y, z: vec.z, face }),
        "minecraft place"
      );
      return await emit(
        ACTION_NAME,
        callback,
        `Placed block at (${vec.x}, ${vec.y}, ${vec.z}) face=${face}.`,
        message.content.source,
        { success: true }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return emit(ACTION_NAME, callback, `Block op failed: ${msg}`, message.content.source, {
        success: false,
        data: { error: msg },
      });
    }
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "Dig the block at 10 64 -20" } },
      {
        name: "{{agent}}",
        content: { text: "Digging.", actions: [ACTION_NAME] },
      },
    ],
  ] as ActionExample[][],
};
