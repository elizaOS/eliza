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
import { WAYPOINTS_SERVICE_TYPE, type WaypointsService } from "../services/waypoints-service.js";
import { emit, mergedInput, readString, withMinecraftTimeout } from "./helpers.js";

const ACTION_NAME = "MC_WAYPOINT_OP";

type WaypointOp = "set" | "delete" | "goto";

function inferOp(text: string, params: Record<string, unknown>): WaypointOp | null {
  const explicit = readString(params, "op", "operation", "mode")?.toLowerCase();
  if (explicit === "set" || explicit === "save" || explicit === "create") return "set";
  if (explicit === "delete" || explicit === "remove") return "delete";
  if (explicit === "goto" || explicit === "go" || explicit === "navigate") return "goto";

  const lower = text.toLowerCase();
  if (/\b(delete|remove)\b/.test(lower)) return "delete";
  if (/\b(goto|go to|navigate)\b/.test(lower)) return "goto";
  if (/\b(set|save|create)\b/.test(lower)) return "set";
  return null;
}

function parseWaypointName(text: string, params: Record<string, unknown>): string | null {
  const explicit = readString(params, "name", "waypointName", "waypoint");
  if (explicit) return explicit;

  const stripped = text
    .trim()
    .replace(
      /\b(?:minecraft|mc|waypoints?|set|save|create|delete|remove|goto|go to|navigate)\b/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
  return stripped || null;
}

export const minecraftWaypointOpAction: Action = {
  name: ACTION_NAME,
  contexts: ["automation", "memory", "media"],
  contextGate: { anyOf: ["automation", "memory", "media"] },
  roleGate: { minRole: "USER" },
  similes: ["MC_WAYPOINT_SET", "MC_WAYPOINT_DELETE", "MC_WAYPOINT_GOTO"],
  description:
    "Manage Minecraft waypoints: set the current position as a named waypoint, delete a waypoint, or navigate to a saved waypoint.",
  descriptionCompressed: "Minecraft waypoint ops: set, delete, goto.",
  parameters: [
    {
      name: "op",
      description: "Waypoint operation.",
      descriptionCompressed: "operation",
      required: true,
      schema: { type: "string", enum: ["set", "delete", "goto"] },
    },
    {
      name: "name",
      description: "Waypoint name.",
      descriptionCompressed: "waypoint name",
      required: true,
      schema: { type: "string" },
    },
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    if (!runtime.getService<WaypointsService>(WAYPOINTS_SERVICE_TYPE)) return false;
    return /\bwaypoints?\b/i.test(message.content.text ?? "");
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions | Record<string, JsonValue | undefined>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const waypoints = runtime.getService<WaypointsService>(WAYPOINTS_SERVICE_TYPE);
    if (!waypoints) {
      return { text: "Waypoints service not available", success: false };
    }

    const params = mergedInput(message, options);
    const text = message.content.text ?? "";
    const op = inferOp(text, params);
    if (!op) {
      return emit(
        ACTION_NAME,
        callback,
        "Missing waypoint op (set, delete, goto).",
        message.content.source,
        { success: false }
      );
    }

    const name = parseWaypointName(text, params);
    if (!name) {
      return emit(ACTION_NAME, callback, "Missing waypoint name.", message.content.source, {
        success: false,
      });
    }

    try {
      if (op === "delete") {
        const deleted = await waypoints.deleteWaypoint(name);
        return await emit(
          ACTION_NAME,
          callback,
          deleted ? `Deleted waypoint "${name}".` : `No waypoint named "${name}".`,
          message.content.source,
          { success: deleted, values: { deleted } }
        );
      }

      const mc = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
      if (!mc) {
        return emit(
          ACTION_NAME,
          callback,
          "Minecraft service is not available.",
          message.content.source,
          { success: false }
        );
      }

      if (op === "set") {
        const worldState = await withMinecraftTimeout(mc.getWorldState(), "minecraft world state");
        const pos = worldState.position;
        if (!pos) {
          return emit(
            ACTION_NAME,
            callback,
            "No position available (is the bot connected?).",
            message.content.source,
            { success: false }
          );
        }
        const wp = await waypoints.setWaypoint(name, pos.x, pos.y, pos.z);
        return await emit(
          ACTION_NAME,
          callback,
          `Saved waypoint "${wp.name}" at (${wp.x.toFixed(1)}, ${wp.y.toFixed(1)}, ${wp.z.toFixed(1)}).`,
          message.content.source,
          {
            success: true,
            data: {
              name: wp.name,
              x: wp.x,
              y: wp.y,
              z: wp.z,
              createdAt: wp.createdAt.toISOString(),
            },
          }
        );
      }

      const wp = waypoints.getWaypoint(name);
      if (!wp) {
        return emit(ACTION_NAME, callback, `No waypoint named "${name}".`, message.content.source, {
          success: false,
        });
      }
      await withMinecraftTimeout(
        mc.request("goto", { x: wp.x, y: wp.y, z: wp.z }),
        "minecraft waypoint goto"
      );
      return await emit(
        ACTION_NAME,
        callback,
        `Navigating to waypoint "${wp.name}" at (${wp.x.toFixed(1)}, ${wp.y.toFixed(1)}, ${wp.z.toFixed(1)}).`,
        message.content.source,
        { success: true }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return emit(ACTION_NAME, callback, `Waypoint op failed: ${msg}`, message.content.source, {
        success: false,
        data: { error: msg },
      });
    }
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "Save my current spot as Home." } },
      {
        name: "{{agent}}",
        content: { text: "Saving waypoint.", actions: [ACTION_NAME] },
      },
    ],
  ] as ActionExample[][],
};
