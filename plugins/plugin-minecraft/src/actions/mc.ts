/**
 * MC — single Pattern C parent action that absorbs the seven leaves
 * (MC_ATTACK, MC_BLOCK, MC_CHAT, MC_CONNECT, MC_DISCONNECT, MC_LOCOMOTE,
 * MC_WAYPOINT) into a single planner-facing surface.
 *
 * Op set:
 *   connect          { host?, port?, username?, auth?, version? }
 *   disconnect       { }
 *   goto             { x, y, z }
 *   stop             { }
 *   look             { yaw, pitch }
 *   control          { control, state, durationMs? }
 *   waypoint_goto    { name }
 *   dig              { x, y, z }
 *   place            { x, y, z, face }
 *   chat             { message }
 *   attack           { entityId }
 *   waypoint_set     { name }
 *   waypoint_delete  { name }
 *
 * Old leaf names are kept as similes for trace continuity.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { JsonObject, JsonValue } from "../protocol.js";
import {
  MINECRAFT_SERVICE_TYPE,
  type MinecraftService,
} from "../services/minecraft-service.js";
import {
  WAYPOINTS_SERVICE_TYPE,
  type WaypointsService,
} from "../services/waypoints-service.js";
import {
  emit,
  isPlaceFace,
  mergedInput,
  type PlaceFace,
  parseVec3,
  readBoolean,
  readNumber,
  readString,
  withMinecraftTimeout,
} from "./helpers.js";

const ACTION_NAME = "MC";

type McOp =
  | "connect"
  | "disconnect"
  | "goto"
  | "stop"
  | "look"
  | "control"
  | "waypoint_goto"
  | "dig"
  | "place"
  | "chat"
  | "attack"
  | "waypoint_set"
  | "waypoint_delete";

const MC_OPS: readonly McOp[] = [
  "connect",
  "disconnect",
  "goto",
  "stop",
  "look",
  "control",
  "waypoint_goto",
  "dig",
  "place",
  "chat",
  "attack",
  "waypoint_set",
  "waypoint_delete",
] as const;

function normalizeOp(value: unknown): McOp | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
  switch (normalized) {
    case "connect":
    case "join":
    case "mc_connect":
      return "connect";
    case "disconnect":
    case "leave":
    case "quit":
    case "mc_disconnect":
      return "disconnect";
    case "goto":
    case "go_to":
    case "move":
    case "walk":
    case "pathfind":
      return "goto";
    case "stop":
    case "cancel":
      return "stop";
    case "look":
    case "view":
    case "turn":
      return "look";
    case "control":
    case "press":
    case "key":
      return "control";
    case "waypoint_goto":
    case "waypointgoto":
    case "navigate":
      return "waypoint_goto";
    case "dig":
    case "mine":
    case "break":
      return "dig";
    case "place":
    case "build":
      return "place";
    case "chat":
    case "say":
    case "tell":
    case "message":
    case "mc_chat":
      return "chat";
    case "attack":
    case "hit":
    case "mc_attack":
      return "attack";
    case "waypoint_set":
    case "waypointset":
    case "save_waypoint":
      return "waypoint_set";
    case "waypoint_delete":
    case "waypointdelete":
    case "delete_waypoint":
      return "waypoint_delete";
    default:
      return MC_OPS.includes(normalized as McOp) ? (normalized as McOp) : null;
  }
}

function parseConnectOverrides(params: Record<string, unknown>): JsonObject {
  const out: JsonObject = {};
  const host = readString(params, "host");
  const port = readNumber(params, "port");
  const username = readString(params, "username");
  const auth = readString(params, "auth");
  const version = readString(params, "version");
  if (host) out.host = host;
  if (port !== null && Number.isInteger(port) && port > 0) out.port = port;
  if (username) out.username = username;
  if (auth === "offline" || auth === "microsoft") out.auth = auth;
  if (version) out.version = version;
  return out;
}

function parseControl(
  params: Record<string, unknown>,
  text: string,
): { control: string; state: boolean; durationMs?: number } | null {
  const control = readString(params, "control", "key", "direction");
  const state = readBoolean(params, "state", "pressed", "enabled");
  const durationMs = readNumber(params, "durationMs", "duration");
  if (control && state !== null) {
    return durationMs && durationMs > 0
      ? { control, state, durationMs }
      : { control, state };
  }
  const match = text.trim().match(/^(\S+)\s+(true|false)(?:\s+(\d+))?$/i);
  if (!match) return null;
  const parsedDuration = match[3] ? Number(match[3]) : undefined;
  if (parsedDuration !== undefined && !Number.isFinite(parsedDuration))
    return null;
  return parsedDuration
    ? {
        control: match[1],
        state: match[2].toLowerCase() === "true",
        durationMs: parsedDuration,
      }
    : { control: match[1], state: match[2].toLowerCase() === "true" };
}

function parseLook(
  params: Record<string, unknown>,
  text: string,
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

function parseWaypointName(
  text: string,
  params: Record<string, unknown>,
): string | null {
  const explicit = readString(
    params,
    "name",
    "waypointName",
    "waypoint",
    "target",
  );
  if (explicit) return explicit;
  const stripped = text
    .trim()
    .replace(
      /\b(?:minecraft|mc|waypoints?|set|save|create|delete|remove|goto|go to|navigate|to)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return stripped || null;
}

function parsePlaceFace(
  params: Record<string, unknown>,
  text: string,
): PlaceFace | null {
  const explicit = readString(params, "face");
  if (isPlaceFace(explicit)) return explicit;
  const match = text.trim().match(/\b(up|down|north|south|east|west)\b/i);
  if (!match) return null;
  const candidate = match[1].toLowerCase();
  return isPlaceFace(candidate) ? candidate : null;
}

function parseEntityId(
  params: Record<string, unknown>,
  text: string,
): number | null {
  const fromParams = readNumber(params, "entityId", "entity");
  if (fromParams !== null) return fromParams;
  const match = text.trim().match(/\b(?:entity\s*)?(\d+)\b/i);
  if (!match) return null;
  const entityId = Number(match[1]);
  return Number.isFinite(entityId) ? entityId : null;
}

const MC_SIMILES = [
  "MC_ATTACK",
  "MC_HIT",
  "MC_BLOCK",
  "MC_DIG",
  "MC_PLACE",
  "MC_BUILD",
  "MC_MINE",
  "MC_CHAT",
  "MC_SAY",
  "MC_MESSAGE",
  "MC_CONNECT",
  "MC_JOIN",
  "MINECRAFT_CONNECT",
  "MC_DISCONNECT",
  "MC_LEAVE",
  "MC_QUIT",
  "MC_LOCOMOTE",
  "MC_MOVE",
  "MC_GOTO",
  "MC_STOP",
  "MC_LOOK",
  "MC_CONTROL",
  "MC_WAYPOINT",
  "MC_WAYPOINT_SET",
  "MC_WAYPOINT_DELETE",
  "MC_WAYPOINT_GOTO",
];

export const minecraftAction: Action = {
  name: ACTION_NAME,
  contexts: ["connectors", "automation", "media", "messaging", "memory"],
  contextGate: {
    anyOf: ["connectors", "automation", "media", "messaging", "memory"],
  },
  roleGate: { minRole: "USER" },
  similes: MC_SIMILES,
  description:
    "Drive a Minecraft bot. Choose one op: connect (host?,port?,username?,auth?,version?), disconnect, goto (x,y,z), stop, look (yaw,pitch), control (control,state,durationMs?), waypoint_goto (name), dig (x,y,z), place (x,y,z,face), chat (message), attack (entityId), waypoint_set (name), waypoint_delete (name).",
  descriptionCompressed:
    "minecraft ops: connect|disconnect|goto|stop|look|control|waypoint_*|dig|place|chat|attack",
  parameters: [
    {
      name: "op",
      description: "Operation to run.",
      descriptionCompressed: "Op.",
      required: true,
      schema: { type: "string", enum: MC_OPS as unknown as string[] },
    },
    {
      name: "params",
      description:
        "Optional JSON object containing the fields required by the chosen op.",
      descriptionCompressed: "Op fields.",
      required: false,
      schema: { type: "object" },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    return runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE) != null;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions | Record<string, JsonValue | undefined>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
    if (!service)
      return { text: "Minecraft service is not available", success: false };

    const params = mergedInput(message, options);
    const text = message.content.text ?? "";
    const op = normalizeOp(
      params.op ?? params.subaction ?? params.actionType ?? params.type,
    );
    if (!op) {
      return emit(
        ACTION_NAME,
        callback,
        `MC requires an op: one of ${MC_OPS.join("|")}.`,
        message.content.source,
        { success: false },
      );
    }

    try {
      switch (op) {
        case "connect": {
          const session = await withMinecraftTimeout(
            service.createBot(parseConnectOverrides(params)),
            "minecraft connect",
          );
          return await emit(
            ACTION_NAME,
            callback,
            `Connected Minecraft bot (botId=${session.botId}).`,
            message.content.source,
            {
              success: true,
              data: { botId: session.botId },
              values: { connected: true },
            },
          );
        }
        case "disconnect": {
          const session = service.getCurrentSession();
          if (!session) {
            return emit(
              ACTION_NAME,
              callback,
              "No Minecraft bot is connected.",
              message.content.source,
              { success: false },
            );
          }
          await withMinecraftTimeout(
            service.destroyBot(session.botId),
            "minecraft disconnect",
          );
          return await emit(
            ACTION_NAME,
            callback,
            "Disconnected Minecraft bot.",
            message.content.source,
            { success: true, values: { connected: false } },
          );
        }
        case "stop": {
          await withMinecraftTimeout(
            service.request("stop", {}),
            "minecraft stop",
          );
          return await emit(
            ACTION_NAME,
            callback,
            "Stopped movement.",
            message.content.source,
            { success: true },
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
              { success: false },
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
            { success: true },
          );
        }
        case "look": {
          const req = parseLook(params, text);
          if (!req) {
            return emit(
              ACTION_NAME,
              callback,
              "Missing yaw/pitch.",
              message.content.source,
              { success: false },
            );
          }
          await withMinecraftTimeout(
            service.request("look", { yaw: req.yaw, pitch: req.pitch }),
            "minecraft look",
          );
          return await emit(
            ACTION_NAME,
            callback,
            "Adjusted view.",
            message.content.source,
            { success: true },
          );
        }
        case "control": {
          const req = parseControl(params, text);
          if (!req) {
            return emit(
              ACTION_NAME,
              callback,
              "Missing control command.",
              message.content.source,
              { success: false },
            );
          }
          await withMinecraftTimeout(
            service.request("control", {
              control: req.control,
              state: req.state,
              ...(typeof req.durationMs === "number"
                ? { durationMs: Math.min(req.durationMs, 10_000) }
                : {}),
            }),
            "minecraft control",
          );
          return await emit(
            ACTION_NAME,
            callback,
            `Set control ${req.control}=${String(req.state)}${req.durationMs ? ` for ${req.durationMs}ms` : ""}.`,
            message.content.source,
            { success: true },
          );
        }
        case "waypoint_goto": {
          const waypoints = runtime.getService<WaypointsService>(
            WAYPOINTS_SERVICE_TYPE,
          );
          if (!waypoints) {
            return emit(
              ACTION_NAME,
              callback,
              "Waypoints service not available.",
              message.content.source,
              { success: false },
            );
          }
          const name = parseWaypointName(text, params);
          if (!name) {
            return emit(
              ACTION_NAME,
              callback,
              "Missing waypoint name.",
              message.content.source,
              { success: false },
            );
          }
          const wp = waypoints.getWaypoint(name);
          if (!wp) {
            return emit(
              ACTION_NAME,
              callback,
              `No waypoint named "${name}".`,
              message.content.source,
              { success: false },
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
            { success: true },
          );
        }
        case "dig": {
          const vec = parseVec3(params, text);
          if (!vec) {
            return emit(
              ACTION_NAME,
              callback,
              "Missing coordinates (x y z).",
              message.content.source,
              { success: false },
            );
          }
          const data = await withMinecraftTimeout(
            service.request("dig", { x: vec.x, y: vec.y, z: vec.z }),
            "minecraft dig",
          );
          const blockName =
            typeof data.blockName === "string" ? data.blockName : "block";
          return await emit(
            ACTION_NAME,
            callback,
            `Dug ${blockName} at (${vec.x}, ${vec.y}, ${vec.z}).`,
            message.content.source,
            { success: true, data },
          );
        }
        case "place": {
          const vec = parseVec3(params, text);
          if (!vec) {
            return emit(
              ACTION_NAME,
              callback,
              "Missing coordinates (x y z).",
              message.content.source,
              { success: false },
            );
          }
          const face = parsePlaceFace(params, text);
          if (!face) {
            return emit(
              ACTION_NAME,
              callback,
              "Missing placement face (up/down/north/south/east/west).",
              message.content.source,
              { success: false },
            );
          }
          await withMinecraftTimeout(
            service.request("place", { x: vec.x, y: vec.y, z: vec.z, face }),
            "minecraft place",
          );
          return await emit(
            ACTION_NAME,
            callback,
            `Placed block at (${vec.x}, ${vec.y}, ${vec.z}) face=${face}.`,
            message.content.source,
            { success: true },
          );
        }
        case "chat": {
          const msg =
            readString(params, "message", "text") ?? text.trim();
          if (!msg) {
            return emit(
              ACTION_NAME,
              callback,
              "No chat message provided.",
              message.content.source,
              { success: false },
            );
          }
          const maxChatPreviewLength = 500;
          await withMinecraftTimeout(service.chat(msg), "minecraft chat");
          return await emit(
            ACTION_NAME,
            callback,
            `Sent Minecraft chat: ${msg.slice(0, maxChatPreviewLength)}`,
            message.content.source,
            { success: true, values: { sent: true } },
          );
        }
        case "attack": {
          const entityId = parseEntityId(params, text);
          if (entityId === null) {
            return emit(
              ACTION_NAME,
              callback,
              "Missing entityId.",
              message.content.source,
              { success: false },
            );
          }
          await withMinecraftTimeout(
            service.request("attack", { entityId }),
            "minecraft attack",
          );
          return await emit(
            ACTION_NAME,
            callback,
            `Attacked entity ${entityId}.`,
            message.content.source,
            { success: true },
          );
        }
        case "waypoint_set": {
          const waypoints = runtime.getService<WaypointsService>(
            WAYPOINTS_SERVICE_TYPE,
          );
          if (!waypoints) {
            return emit(
              ACTION_NAME,
              callback,
              "Waypoints service not available.",
              message.content.source,
              { success: false },
            );
          }
          const name = parseWaypointName(text, params);
          if (!name) {
            return emit(
              ACTION_NAME,
              callback,
              "Missing waypoint name.",
              message.content.source,
              { success: false },
            );
          }
          const worldState = await withMinecraftTimeout(
            service.getWorldState(),
            "minecraft world state",
          );
          const pos = worldState.position;
          if (!pos) {
            return emit(
              ACTION_NAME,
              callback,
              "No position available (is the bot connected?).",
              message.content.source,
              { success: false },
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
            },
          );
        }
        case "waypoint_delete": {
          const waypoints = runtime.getService<WaypointsService>(
            WAYPOINTS_SERVICE_TYPE,
          );
          if (!waypoints) {
            return emit(
              ACTION_NAME,
              callback,
              "Waypoints service not available.",
              message.content.source,
              { success: false },
            );
          }
          const name = parseWaypointName(text, params);
          if (!name) {
            return emit(
              ACTION_NAME,
              callback,
              "Missing waypoint name.",
              message.content.source,
              { success: false },
            );
          }
          const deleted = await waypoints.deleteWaypoint(name);
          return await emit(
            ACTION_NAME,
            callback,
            deleted
              ? `Deleted waypoint "${name}".`
              : `No waypoint named "${name}".`,
            message.content.source,
            { success: deleted, values: { deleted } },
          );
        }
        default: {
          const _exhaustive: never = op;
          void _exhaustive;
          return emit(
            ACTION_NAME,
            callback,
            "Unknown MC op.",
            message.content.source,
            { success: false },
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return emit(
        ACTION_NAME,
        callback,
        `MC ${op} failed: ${msg}`,
        message.content.source,
        { success: false, data: { error: msg } },
      );
    }
  },
  examples: [],
};
