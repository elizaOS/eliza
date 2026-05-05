import type {
  Action,
  ActionExample,
  ActionParameters,
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { JsonObject, JsonValue } from "../protocol.js";
import { MINECRAFT_SERVICE_TYPE, type MinecraftService } from "../services/minecraft-service.js";
import { WAYPOINTS_SERVICE_TYPE, type WaypointsService } from "../services/waypoints-service.js";
import { extractVec3, type Vec3 } from "./utils.js";

type MinecraftSubaction =
  | "connect"
  | "movement"
  | "look"
  | "scan"
  | "dig"
  | "place"
  | "chat"
  | "attack"
  | "waypoints";

type ControlRequest = { control: string; state: boolean; durationMs?: number };
type PlaceRequest = Vec3 & { face: "up" | "down" | "north" | "south" | "east" | "west" };

const actionName = "MC_ACTION";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readParams(
  options?: HandlerOptions | Record<string, JsonValue | undefined>
): Record<string, unknown> {
  const maybeParams = isRecord(options) && isRecord(options.parameters) ? options.parameters : {};
  return maybeParams as ActionParameters;
}

function mergedInput(
  message: Memory,
  options?: HandlerOptions | Record<string, JsonValue | undefined>
): Record<string, unknown> {
  return {
    ...parseJsonObject(message.content.text ?? ""),
    ...readParams(options),
  };
}

function readString(params: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readNumber(params: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readBoolean(params: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
    }
  }
  return null;
}

function readStringArray(params: Record<string, unknown>, key: string): string[] | null {
  const value = params[key];
  if (Array.isArray(value)) {
    const items = value.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0
    );
    return items.length ? items.map((item) => item.trim()) : null;
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return null;
}

function normalizeSubaction(value: string | null): MinecraftSubaction | null {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "_");
  if (!normalized) return null;
  if (["connect", "disconnect", "server", "session"].includes(normalized)) return "connect";
  if (["movement", "move", "goto", "walk", "control", "stop"].includes(normalized)) {
    return "movement";
  }
  if (normalized === "look" || normalized === "view") return "look";
  if (normalized === "scan" || normalized === "find_blocks") return "scan";
  if (normalized === "dig" || normalized === "mine" || normalized === "break") return "dig";
  if (normalized === "place" || normalized === "build") return "place";
  if (normalized === "chat" || normalized === "say" || normalized === "message") return "chat";
  if (normalized === "attack" || normalized === "hit") return "attack";
  if (normalized === "waypoint" || normalized === "waypoints") return "waypoints";
  return null;
}

function inferSubaction(text: string, params: Record<string, unknown>): MinecraftSubaction | null {
  const explicit = normalizeSubaction(readString(params, "subaction", "action", "type"));
  if (explicit) return explicit;

  const lower = text.toLowerCase();
  if (/\b(waypoint|waypoints)\b/.test(lower)) return "waypoints";
  if (/\b(disconnect|connect|join|leave|quit)\b/.test(lower)) return "connect";
  if (/\b(goto|go to|move|walk|pathfind|stop|control|jump|sprint|sneak)\b/.test(lower)) {
    return "movement";
  }
  if (/\b(look|turn|yaw|pitch)\b/.test(lower)) return "look";
  if (/\b(scan|find blocks?|nearby blocks?)\b/.test(lower)) return "scan";
  if (/\b(dig|mine|break)\b/.test(lower)) return "dig";
  if (/\b(place|build)\b/.test(lower)) return "place";
  if (/\b(chat|say|tell)\b/.test(lower)) return "chat";
  if (/\b(attack|hit)\b/.test(lower)) return "attack";
  return null;
}

function parseVec3(params: Record<string, unknown>, text: string): Vec3 | null {
  const x = readNumber(params, "x");
  const y = readNumber(params, "y");
  const z = readNumber(params, "z");
  if (x !== null && y !== null && z !== null) return { x, y, z };
  return extractVec3(text);
}

function parseControl(params: Record<string, unknown>, text: string): ControlRequest | null {
  const control = readString(params, "control", "key", "direction");
  const state = readBoolean(params, "state", "pressed", "enabled");
  const durationMs = readNumber(params, "durationMs", "duration");
  if (control && state !== null) {
    return durationMs && durationMs > 0 ? { control, state, durationMs } : { control, state };
  }

  const trimmed = text.trim();
  const match = trimmed.match(/^(\S+)\s+(true|false)(?:\s+(\d+))?$/i);
  if (!match) return null;
  const parsedDuration = match[3] ? Number(match[3]) : undefined;
  if (parsedDuration !== undefined && !Number.isFinite(parsedDuration)) return null;
  return parsedDuration
    ? { control: match[1], state: match[2].toLowerCase() === "true", durationMs: parsedDuration }
    : { control: match[1], state: match[2].toLowerCase() === "true" };
}

function parsePlace(params: Record<string, unknown>, text: string): PlaceRequest | null {
  const vec = parseVec3(params, text);
  const face = readString(params, "face");
  if (vec && isPlaceFace(face)) return { ...vec, face };

  const match = text
    .trim()
    .match(
      /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(up|down|north|south|east|west)\b/i
    );
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  const z = Number(match[3]);
  const parsedFace = match[4].toLowerCase();
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z) ||
    !isPlaceFace(parsedFace)
  ) {
    return null;
  }
  return { x, y, z, face: parsedFace };
}

function isPlaceFace(value: string | null): value is PlaceRequest["face"] {
  return (
    value === "up" ||
    value === "down" ||
    value === "north" ||
    value === "south" ||
    value === "east" ||
    value === "west"
  );
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

function parseEntityId(params: Record<string, unknown>, text: string): number | null {
  const fromParams = readNumber(params, "entityId", "entity");
  if (fromParams !== null) return fromParams;
  const match = text.trim().match(/\b(?:entity\s*)?(\d+)\b/i);
  if (!match) return null;
  const entityId = Number(match[1]);
  return Number.isFinite(entityId) ? entityId : null;
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

function parseMovementOperation(
  text: string,
  params: Record<string, unknown>
): "goto" | "control" | "stop" | null {
  const operation = readString(params, "operation", "op", "mode")?.toLowerCase();
  if (
    operation === "goto" ||
    operation === "move" ||
    operation === "walk" ||
    operation === "pathfind"
  ) {
    return "goto";
  }
  if (operation === "control" || operation === "press" || operation === "key") return "control";
  if (operation === "stop" || operation === "cancel") return "stop";

  const lower = text.toLowerCase();
  if (/\b(stop|cancel)\b/.test(lower)) return "stop";
  if (parseControl(params, text)) return "control";
  if (parseVec3(params, text)) return "goto";
  return null;
}

function parseWaypointOperation(
  text: string,
  params: Record<string, unknown>
): "set" | "delete" | "goto" | "list" | null {
  const operation = readString(params, "operation", "op", "mode")?.toLowerCase();
  if (operation === "set" || operation === "save" || operation === "create") return "set";
  if (operation === "delete" || operation === "remove") return "delete";
  if (operation === "goto" || operation === "go" || operation === "navigate") return "goto";
  if (operation === "list" || operation === "read" || operation === "show") return "list";

  const lower = text.toLowerCase();
  if (/\b(delete|remove)\b/.test(lower)) return "delete";
  if (/\b(goto|go to|navigate)\b/.test(lower)) return "goto";
  if (/\b(list|read|show)\b/.test(lower)) return "list";
  if (/\b(set|save|create)\b/.test(lower)) return "set";
  return null;
}

function parseWaypointName(text: string, params: Record<string, unknown>): string | null {
  const explicit = readString(params, "waypointName", "waypoint", "name");
  if (explicit) return explicit;

  const stripped = text
    .trim()
    .replace(
      /\b(?:minecraft|mc|waypoints?|set|save|create|delete|remove|goto|go to|navigate|list|read|show)\b/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
  return stripped || null;
}

function callbackContent(text: string, source: unknown): Content {
  return {
    text,
    actions: [actionName],
    source: typeof source === "string" ? source : undefined,
  };
}

async function emit(
  callback: HandlerCallback | undefined,
  text: string,
  source: unknown,
  result: Omit<ActionResult, "text">
): Promise<ActionResult> {
  const content = callbackContent(text, source);
  await callback?.(content, actionName);
  return { text: content.text ?? text, ...result };
}

async function handleConnect(
  runtime: IAgentRuntime,
  message: Memory,
  params: Record<string, unknown>,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const service = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
  if (!service) return { text: "Minecraft service is not available", success: false };

  const operation = readString(params, "operation", "op")?.toLowerCase();
  const wantsDisconnect =
    operation === "disconnect" ||
    operation === "leave" ||
    /\b(disconnect|leave|quit)\b/i.test(message.content.text ?? "");

  if (wantsDisconnect) {
    const session = service.getCurrentSession();
    if (!session) return { text: "No Minecraft bot is connected", success: false };
    await service.destroyBot(session.botId);
    return emit(callback, "Disconnected Minecraft bot.", message.content.source, {
      success: true,
      values: { connected: false },
    });
  }

  const session = await service.createBot(parseConnectOverrides(params));
  return emit(
    callback,
    `Connected Minecraft bot (botId=${session.botId}).`,
    message.content.source,
    {
      success: true,
      data: { botId: session.botId },
      values: { connected: true },
    }
  );
}

async function handleMovement(
  runtime: IAgentRuntime,
  message: Memory,
  params: Record<string, unknown>,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const service = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
  if (!service) return { text: "Minecraft service is not available", success: false };

  const operation = parseMovementOperation(message.content.text ?? "", params);
  if (!operation)
    return { text: "Missing movement operation: goto, control, or stop", success: false };

  if (operation === "stop") {
    await service.request("stop", {});
    return emit(callback, "Stopped movement.", message.content.source, { success: true });
  }

  if (operation === "control") {
    const req = parseControl(params, message.content.text ?? "");
    if (!req) return { text: "Missing control command", success: false };
    await service.request("control", {
      control: req.control,
      state: req.state,
      ...(typeof req.durationMs === "number" ? { durationMs: req.durationMs } : {}),
    });
    return emit(
      callback,
      `Set control ${req.control}=${String(req.state)}${req.durationMs ? ` for ${req.durationMs}ms` : ""}.`,
      message.content.source,
      { success: true }
    );
  }

  const vec = parseVec3(params, message.content.text ?? "");
  if (!vec) return { text: "Missing coordinates (x y z)", success: false };
  await service.request("goto", { x: vec.x, y: vec.y, z: vec.z });
  return emit(callback, `Moving to (${vec.x}, ${vec.y}, ${vec.z}).`, message.content.source, {
    success: true,
  });
}

async function handleLook(
  runtime: IAgentRuntime,
  message: Memory,
  params: Record<string, unknown>,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const service = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
  if (!service) return { text: "Minecraft service is not available", success: false };
  const req = parseLook(params, message.content.text ?? "");
  if (!req) return { text: "Missing yaw/pitch", success: false };
  await service.request("look", { yaw: req.yaw, pitch: req.pitch });
  return emit(callback, "Adjusted view.", message.content.source, { success: true });
}

async function handleScan(
  runtime: IAgentRuntime,
  message: Memory,
  params: Record<string, unknown>,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const service = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
  if (!service) return { text: "Minecraft service is not available", success: false };
  const blocks = readStringArray(params, "blocks");
  const radius = readNumber(params, "radius");
  const maxResults = readNumber(params, "maxResults");
  const data = await service.request("scan", {
    ...(blocks ? { blocks } : {}),
    ...(radius !== null ? { radius } : {}),
    ...(maxResults !== null ? { maxResults } : {}),
  });
  const foundBlocks = Array.isArray(data.blocks) ? data.blocks : [];
  return emit(callback, `Scan found ${foundBlocks.length} blocks.`, message.content.source, {
    success: true,
    data,
    values: { count: foundBlocks.length },
  });
}

async function handleDig(
  runtime: IAgentRuntime,
  message: Memory,
  params: Record<string, unknown>,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const service = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
  if (!service) return { text: "Minecraft service is not available", success: false };
  const vec = parseVec3(params, message.content.text ?? "");
  if (!vec) return { text: "Missing coordinates (x y z)", success: false };
  const data = await service.request("dig", { x: vec.x, y: vec.y, z: vec.z });
  const blockName = typeof data.blockName === "string" ? data.blockName : "block";
  return emit(
    callback,
    `Dug ${blockName} at (${vec.x}, ${vec.y}, ${vec.z}).`,
    message.content.source,
    {
      success: true,
      data,
    }
  );
}

async function handlePlace(
  runtime: IAgentRuntime,
  message: Memory,
  params: Record<string, unknown>,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const service = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
  if (!service) return { text: "Minecraft service is not available", success: false };
  const req = parsePlace(params, message.content.text ?? "");
  if (!req) return { text: "Missing placement target (x y z face)", success: false };
  await service.request("place", { x: req.x, y: req.y, z: req.z, face: req.face });
  return emit(
    callback,
    `Placed block at (${req.x}, ${req.y}, ${req.z}) face=${req.face}.`,
    message.content.source,
    { success: true }
  );
}

async function handleChat(
  runtime: IAgentRuntime,
  message: Memory,
  params: Record<string, unknown>,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const service = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
  if (!service) return { text: "Minecraft service is not available", success: false };
  const text = readString(params, "message", "text") ?? (message.content.text ?? "").trim();
  if (!text) return { text: "No chat message provided", success: false };
  await service.chat(text);
  return emit(callback, `Sent Minecraft chat: ${text}`, message.content.source, {
    success: true,
    values: { sent: true },
  });
}

async function handleAttack(
  runtime: IAgentRuntime,
  message: Memory,
  params: Record<string, unknown>,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const service = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
  if (!service) return { text: "Minecraft service is not available", success: false };
  const entityId = parseEntityId(params, message.content.text ?? "");
  if (entityId === null) return { text: "Missing entityId", success: false };
  await service.request("attack", { entityId });
  return emit(callback, `Attacked entity ${entityId}.`, message.content.source, { success: true });
}

async function handleWaypoints(
  runtime: IAgentRuntime,
  message: Memory,
  params: Record<string, unknown>,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const waypoints = runtime.getService<WaypointsService>(WAYPOINTS_SERVICE_TYPE);
  if (!waypoints) return { text: "Waypoints service not available", success: false };

  const operation = parseWaypointOperation(message.content.text ?? "", params);
  if (!operation) {
    return { text: "Missing waypoint operation: set, delete, or goto", success: false };
  }

  if (operation === "list") {
    return emit(
      callback,
      "Saved waypoint state is provided by MC_WAYPOINTS; MC_ACTION changes waypoints with set, delete, or goto.",
      message.content.source,
      { success: true, data: { waypointCount: waypoints.listWaypoints().length } }
    );
  }

  const name = parseWaypointName(message.content.text ?? "", params);
  if (!name) return { text: "Missing waypoint name", success: false };

  if (operation === "delete") {
    const deleted = await waypoints.deleteWaypoint(name);
    return emit(
      callback,
      deleted ? `Deleted waypoint "${name}".` : `No waypoint named "${name}".`,
      message.content.source,
      { success: deleted, values: { deleted } }
    );
  }

  const mc = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
  if (!mc) return { text: "Minecraft service is not available", success: false };

  if (operation === "set") {
    const worldState = await mc.getWorldState();
    const pos = worldState.position;
    if (!pos) return { text: "No position available (is the bot connected?)", success: false };
    const waypoint = await waypoints.setWaypoint(name, pos.x, pos.y, pos.z);
    return emit(
      callback,
      `Saved waypoint "${waypoint.name}" at (${waypoint.x.toFixed(1)}, ${waypoint.y.toFixed(1)}, ${waypoint.z.toFixed(1)}).`,
      message.content.source,
      {
        success: true,
        data: {
          name: waypoint.name,
          x: waypoint.x,
          y: waypoint.y,
          z: waypoint.z,
          createdAt: waypoint.createdAt.toISOString(),
        },
      }
    );
  }

  const waypoint = waypoints.getWaypoint(name);
  if (!waypoint) {
    return emit(callback, `No waypoint named "${name}".`, message.content.source, {
      success: false,
    });
  }

  await mc.request("goto", { x: waypoint.x, y: waypoint.y, z: waypoint.z });
  return emit(
    callback,
    `Navigating to waypoint "${waypoint.name}" at (${waypoint.x.toFixed(1)}, ${waypoint.y.toFixed(1)}, ${waypoint.z.toFixed(1)}).`,
    message.content.source,
    { success: true }
  );
}

export const minecraftAction: Action = {
  name: actionName,
  similes: ["MINECRAFT_ACTION", "MINECRAFT", "MC_ROUTER"],
  description:
    "Route Minecraft automation with subaction connect, movement, look, scan, dig, place, chat, attack, or waypoints.",
  descriptionCompressed:
    "minecraft router; subactions connect movement look scan dig place chat attack waypoints",
  parameters: [
    {
      name: "subaction",
      description: "Minecraft operation group.",
      descriptionCompressed: "operation group",
      required: true,
      schema: {
        type: "string",
        enum: [
          "connect",
          "movement",
          "look",
          "scan",
          "dig",
          "place",
          "chat",
          "attack",
          "waypoints",
        ],
      },
    },
    {
      name: "operation",
      description:
        "Optional operation inside connect (connect/disconnect), movement (goto/control/stop), or waypoints (set/delete/goto).",
      descriptionCompressed: "nested operation",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "x",
      description: "Target x coordinate for movement, dig, place, or waypoint data.",
      descriptionCompressed: "x coordinate",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "y",
      description: "Target y coordinate for movement, dig, place, or waypoint data.",
      descriptionCompressed: "y coordinate",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "z",
      description: "Target z coordinate for movement, dig, place, or waypoint data.",
      descriptionCompressed: "z coordinate",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "message",
      description: "Chat text for the chat subaction.",
      descriptionCompressed: "chat text",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "yaw",
      description: "Yaw angle for look.",
      descriptionCompressed: "look yaw",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "pitch",
      description: "Pitch angle for look.",
      descriptionCompressed: "look pitch",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "face",
      description: "Reference block face for place.",
      descriptionCompressed: "place face",
      required: false,
      schema: { type: "string", enum: ["up", "down", "north", "south", "east", "west"] },
    },
    {
      name: "blocks",
      description: "Block names to scan for.",
      descriptionCompressed: "scan block names",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
    {
      name: "radius",
      description: "Scan radius.",
      descriptionCompressed: "scan radius",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "maxResults",
      description: "Maximum scan results.",
      descriptionCompressed: "scan max results",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "entityId",
      description: "Entity ID for attack.",
      descriptionCompressed: "attack entity id",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "control",
      description: "Movement control such as forward, back, left, right, jump, sprint, or sneak.",
      descriptionCompressed: "movement control",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "state",
      description: "Control pressed state.",
      descriptionCompressed: "control state",
      required: false,
      schema: { type: "boolean" },
    },
    {
      name: "durationMs",
      description: "Optional control duration in milliseconds.",
      descriptionCompressed: "control duration ms",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "waypointName",
      description: "Waypoint name for set, delete, or goto.",
      descriptionCompressed: "waypoint name",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "host",
      description: "Minecraft server host override for connect.",
      descriptionCompressed: "server host",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "port",
      description: "Minecraft server port override for connect.",
      descriptionCompressed: "server port",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "username",
      description: "Minecraft username override for connect.",
      descriptionCompressed: "minecraft username",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "auth",
      description: "Minecraft auth mode override for connect.",
      descriptionCompressed: "auth mode",
      required: false,
      schema: { type: "string", enum: ["offline", "microsoft"] },
    },
    {
      name: "version",
      description: "Minecraft version override for connect.",
      descriptionCompressed: "minecraft version",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const text = message.content.text ?? "";
    const params = parseJsonObject(text);
    const hasIntent =
      Boolean(normalizeSubaction(readString(params, "subaction", "action", "type"))) ||
      /\b(minecraft|mc|connect|disconnect|goto|move|walk|stop|control|look|scan|dig|mine|break|place|chat|say|attack|waypoint)\b/i.test(
        text
      );
    if (!hasIntent) return false;
    return Boolean(
      runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE) ||
        runtime.getService<WaypointsService>(WAYPOINTS_SERVICE_TYPE)
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions | Record<string, JsonValue | undefined>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const params = mergedInput(message, options);
    const text = message.content.text ?? "";
    const subaction = inferSubaction(text, params);

    try {
      switch (subaction) {
        case "connect":
          return await handleConnect(runtime, message, params, callback);
        case "movement":
          return await handleMovement(runtime, message, params, callback);
        case "look":
          return await handleLook(runtime, message, params, callback);
        case "scan":
          return await handleScan(runtime, message, params, callback);
        case "dig":
          return await handleDig(runtime, message, params, callback);
        case "place":
          return await handlePlace(runtime, message, params, callback);
        case "chat":
          return await handleChat(runtime, message, params, callback);
        case "attack":
          return await handleAttack(runtime, message, params, callback);
        case "waypoints":
          return await handleWaypoints(runtime, message, params, callback);
        default:
          return { text: "Missing Minecraft subaction", success: false };
      }
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      return emit(callback, `Minecraft action failed: ${messageText}`, message.content.source, {
        success: false,
        data: { error: messageText },
      });
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Move the Minecraft bot to 10 64 -20" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Moving the bot.",
          actions: [actionName],
        },
      },
    ],
  ] as ActionExample[][],
};
