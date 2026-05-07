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
import {
  emit,
  mergedInput,
  parseVec3,
  readBoolean,
  readNumber,
  readString,
  withMinecraftTimeout,
} from "./helpers.js";

const ACTION_NAME = "MC_LOCOMOTE_OP";

type LocomoteOp = "goto" | "stop" | "look" | "control" | "waypoint-goto";

const OPS: readonly LocomoteOp[] = ["goto", "stop", "look", "control", "waypoint-goto"];

function isLocomoteOp(value: string | null): value is LocomoteOp {
  return value !== null && (OPS as readonly string[]).includes(value);
}

function inferOp(text: string, params: Record<string, unknown>): LocomoteOp | null {
  const explicit = readString(params, "op", "operation", "mode");
  if (explicit) {
    const normalized = explicit.toLowerCase().replace(/_/g, "-");
    if (isLocomoteOp(normalized)) return normalized;
    if (normalized === "walk" || normalized === "move" || normalized === "pathfind") return "goto";
    if (normalized === "cancel") return "stop";
    if (normalized === "press" || normalized === "key") return "control";
    if (normalized === "view" || normalized === "turn") return "look";
    if (normalized === "waypoint" || normalized === "navigate") return "waypoint-goto";
  }

  const lower = text.toLowerCase();
  if (/\bwaypoint\b/.test(lower) && /\b(goto|go to|navigate)\b/.test(lower)) return "waypoint-goto";
  if (/\b(stop|cancel)\b/.test(lower)) return "stop";
  if (/\b(look|yaw|pitch|turn)\b/.test(lower)) return "look";
  if (/\b(control|jump|sprint|sneak|press)\b/.test(lower)) return "control";
  if (/\b(goto|go to|move|walk|pathfind)\b/.test(lower)) return "goto";
  return null;
}

function parseControl(
  params: Record<string, unknown>,
  text: string
): { control: string; state: boolean; durationMs?: number } | null {
  const control = readString(params, "control", "key", "direction");
  const state = readBoolean(params, "state", "pressed", "enabled");
  const durationMs = readNumber(params, "durationMs", "duration");
  if (control && state !== null) {
    return durationMs && durationMs > 0 ? { control, state, durationMs } : { control, state };
  }

  const match = text.trim().match(/^(\S+)\s+(true|false)(?:\s+(\d+))?$/i);
  if (!match) return null;
  const parsedDuration = match[3] ? Number(match[3]) : undefined;
  if (parsedDuration !== undefined && !Number.isFinite(parsedDuration)) return null;
  return parsedDuration
    ? { control: match[1], state: match[2].toLowerCase() === "true", durationMs: parsedDuration }
    : { control: match[1], state: match[2].toLowerCase() === "true" };
}

function parseLook(
  params: Record<string, unknown>,
  text: string
): { yaw: number; pitch: number } | null {
  const yaw = readNumber(params, "yaw");
  const pitch = readNumber(params, "pitch");
  if (yaw !== null && pitch !== null) return { yaw, pitch };

  const match = text.trim().match(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const parsedYaw = Number(match[1]);
  const parsedPitch = Number(match[2]);
  if (!Number.isFinite(parsedYaw) || !Number.isFinite(parsedPitch)) return null;
  return { yaw: parsedYaw, pitch: parsedPitch };
}

function parseWaypointName(text: string, params: Record<string, unknown>): string | null {
  const explicit = readString(params, "name", "waypointName", "waypoint", "target");
  if (explicit) return explicit;

  const stripped = text
    .trim()
    .replace(/\b(?:minecraft|mc|waypoints?|goto|go to|navigate|to)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped || null;
}

export const minecraftLocomoteOpAction: Action = {
  name: ACTION_NAME,
  contexts: ["automation", "media"],
  contextGate: { anyOf: ["automation", "media"] },
  roleGate: { minRole: "USER" },
  similes: ["MC_MOVE", "MC_GOTO", "MC_STOP", "MC_LOOK", "MC_CONTROL"],
  description:
    "Locomote the Minecraft bot: goto coords, stop movement, look yaw/pitch, set a control key, or navigate to a saved waypoint.",
  descriptionCompressed: "Minecraft locomote: goto, stop, look, control, waypoint-goto.",
  parameters: [
    {
      name: "op",
      description: "Locomote operation.",
      descriptionCompressed: "operation",
      required: true,
      schema: {
        type: "string",
        enum: ["goto", "stop", "look", "control", "waypoint-goto"],
      },
    },
    {
      name: "x",
      description: "Target x for goto.",
      descriptionCompressed: "x coord",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "y",
      description: "Target y for goto.",
      descriptionCompressed: "y coord",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "z",
      description: "Target z for goto.",
      descriptionCompressed: "z coord",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "yaw",
      description: "Yaw for look.",
      descriptionCompressed: "yaw",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "pitch",
      description: "Pitch for look.",
      descriptionCompressed: "pitch",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "control",
      description: "Control key (forward, back, left, right, jump, sprint, sneak).",
      descriptionCompressed: "control key",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "state",
      description: "Pressed state for control.",
      descriptionCompressed: "control state",
      required: false,
      schema: { type: "boolean" },
    },
    {
      name: "durationMs",
      description: "Optional control hold duration in ms.",
      descriptionCompressed: "duration ms",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "name",
      description: "Waypoint name for waypoint-goto.",
      descriptionCompressed: "waypoint name",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    if (!runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE)) return false;
    const text = message.content.text ?? "";
    return /\b(goto|go to|move|walk|pathfind|stop|cancel|look|yaw|pitch|turn|control|jump|sprint|sneak|press|waypoint|navigate)\b/i.test(
      text
    );
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
        "Missing locomote op (goto, stop, look, control, waypoint-goto).",
        message.content.source,
        { success: false }
      );
    }

    try {
      switch (op) {
        case "stop": {
          await withMinecraftTimeout(service.request("stop", {}), "minecraft stop");
          return await emit(ACTION_NAME, callback, "Stopped movement.", message.content.source, {
            success: true,
          });
        }
        case "look": {
          const req = parseLook(params, text);
          if (!req) {
            return emit(ACTION_NAME, callback, "Missing yaw/pitch.", message.content.source, {
              success: false,
            });
          }
          await withMinecraftTimeout(
            service.request("look", { yaw: req.yaw, pitch: req.pitch }),
            "minecraft look",
          );
          return await emit(ACTION_NAME, callback, "Adjusted view.", message.content.source, {
            success: true,
          });
        }
        case "control": {
          const req = parseControl(params, text);
          if (!req) {
            return emit(ACTION_NAME, callback, "Missing control command.", message.content.source, {
              success: false,
            });
          }
          await withMinecraftTimeout(
            service.request("control", {
              control: req.control,
              state: req.state,
              ...(typeof req.durationMs === "number" ? { durationMs: Math.min(req.durationMs, 10_000) } : {}),
            }),
            "minecraft control",
          );
          return await emit(
            ACTION_NAME,
            callback,
            `Set control ${req.control}=${String(req.state)}${req.durationMs ? ` for ${req.durationMs}ms` : ""}.`,
            message.content.source,
            { success: true }
          );
        }
        case "waypoint-goto": {
          const waypoints = runtime.getService<WaypointsService>(WAYPOINTS_SERVICE_TYPE);
          if (!waypoints) {
            return emit(
              ACTION_NAME,
              callback,
              "Waypoints service not available.",
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
          const wp = waypoints.getWaypoint(name);
          if (!wp) {
            return emit(
              ACTION_NAME,
              callback,
              `No waypoint named "${name}".`,
              message.content.source,
              { success: false }
            );
          }
          await withMinecraftTimeout(
            service.request("goto", { x: wp.x, y: wp.y, z: wp.z }),
            "minecraft waypoint goto",
          );
          return await emit(
            ACTION_NAME,
            callback,
            `Navigating to waypoint "${wp.name}" at (${wp.x.toFixed(1)}, ${wp.y.toFixed(1)}, ${wp.z.toFixed(1)}).`,
            message.content.source,
            { success: true }
          );
        }
        case "goto": {
          const vec = parseVec3(params, text);
          if (!vec) {
            return emit(
              ACTION_NAME,
              callback,
              "Missing coordinates (x y z).",
              message.content.source,
              { success: false }
            );
          }
          await withMinecraftTimeout(
            service.request("goto", { x: vec.x, y: vec.y, z: vec.z }),
            "minecraft goto",
          );
          return await emit(
            ACTION_NAME,
            callback,
            `Moving to (${vec.x}, ${vec.y}, ${vec.z}).`,
            message.content.source,
            { success: true }
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return emit(ACTION_NAME, callback, `Locomote failed: ${msg}`, message.content.source, {
        success: false,
        data: { error: msg },
      });
    }
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "Move the Minecraft bot to 10 64 -20" } },
      {
        name: "{{agent}}",
        content: { text: "Moving.", actions: [ACTION_NAME] },
      },
    ],
  ] as ActionExample[][],
};
