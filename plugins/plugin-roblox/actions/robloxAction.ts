import {
  type Action,
  type ActionExample,
  type ActionParameters,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import type { RobloxService } from "../services/RobloxService";
import {
  type JsonValue,
  ROBLOX_SERVICE_NAME,
  type RobloxGameAction,
  type RobloxUser,
} from "../types";

type RobloxSubaction = "message" | "execute" | "get_player";
type RobloxActionParameters = Record<string, string | number | boolean | null>;

const actionName = "ROBLOX_ACTION";
const ROBLOX_ACTION_TIMEOUT_MS = 15_000;
const MAX_ROBLOX_TARGET_IDS = 25;
const MAX_ROBLOX_MESSAGE_LENGTH = 1000;

interface GameActionConfig {
  name: string;
  patterns: RegExp[];
  extractParams: (match: RegExpMatchArray) => RobloxActionParameters;
}

const KNOWN_GAME_ACTIONS: GameActionConfig[] = [
  {
    name: "move_npc",
    patterns: [
      /(?:move|walk)\s+(?:the\s+)?(?:npc|bot|agent)?\s*(?:to|towards)\s+(?:the\s+)?(\w+)/i,
      /(?:move|walk)\s+to\s+\(?(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\)?/i,
    ],
    extractParams: (match) => {
      if (match.length >= 4 && match[1] && match[2] && match[3]) {
        return {
          x: Number.parseFloat(match[1]),
          y: Number.parseFloat(match[2]),
          z: Number.parseFloat(match[3]),
        };
      }
      return { waypoint: match[1] || "" };
    },
  },
  {
    name: "give_coins",
    patterns: [/give\s+(?:player\s*)?(\d+)\s+(\d+)\s+coins?/i],
    extractParams: (match) => ({
      playerId: Number.parseInt(match[1], 10),
      amount: Number.parseInt(match[2], 10),
    }),
  },
  {
    name: "teleport",
    patterns: [/teleport\s+(?:everyone|all)\s+to\s+(?:the\s+)?(\w+)/i],
    extractParams: (match) => ({ destination: match[1] }),
  },
  {
    name: "spawn_entity",
    patterns: [/spawn\s+(?:a\s+)?(\w+)\s+at\s+(\w+)/i],
    extractParams: (match) => ({
      entityType: match[1],
      location: match[2],
    }),
  },
  {
    name: "start_event",
    patterns: [/start\s+(?:a\s+)?(\w+)\s+(?:show|event|celebration)/i],
    extractParams: (match) => ({ eventType: match[1] }),
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return {};

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

function normalizeSubaction(value: string | null): RobloxSubaction | null {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "_");
  if (!normalized) return null;
  if (["message", "send_message", "send", "chat", "announce"].includes(normalized)) {
    return "message";
  }
  if (["execute", "action", "game_action", "run", "trigger"].includes(normalized)) {
    return "execute";
  }
  if (["get_player", "player", "player_info", "user", "lookup"].includes(normalized)) {
    return "get_player";
  }
  return null;
}

function inferSubaction(text: string, params: Record<string, unknown>): RobloxSubaction | null {
  const explicit = normalizeSubaction(readString(params, "subaction", "action", "type"));
  if (explicit) return explicit;

  const lower = text.toLowerCase();
  if (/\b(who is|look up|lookup|find|get).*\b(player|user|roblox)\b/.test(lower)) {
    return "get_player";
  }
  if (/\b(execute|run|trigger|start|give|teleport|spawn|move|walk)\b/.test(lower)) {
    return "execute";
  }
  if (/\b(send|message|tell|announce|chat|say)\b/.test(lower)) {
    return "message";
  }
  return null;
}

function readTargetPlayerIds(params: Record<string, unknown>, text: string): number[] | undefined {
  const explicit = params.targetPlayerIds;
  if (Array.isArray(explicit)) {
    const ids = explicit
      .map((value) =>
        typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
      )
      .filter((value) => Number.isInteger(value) && value > 0);
    if (ids.length) return ids.slice(0, MAX_ROBLOX_TARGET_IDS);
  }

  const single = readNumber(params, "targetPlayerId", "playerId", "userId");
  if (single !== null && Number.isInteger(single) && single > 0) return [single];

  const matches = [...text.matchAll(/\bplayer\s*(\d+)\b/gi)];
  return matches.length
    ? matches.map((match) => Number.parseInt(match[1], 10)).slice(0, MAX_ROBLOX_TARGET_IDS)
    : undefined;
}

function withRobloxTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), ROBLOX_ACTION_TIMEOUT_MS),
    ),
  ]);
}

function parseGameAction(text: string, params: Record<string, unknown>): RobloxGameAction | null {
  const explicitActionName = readString(params, "actionName", "gameAction", "command");
  const explicitParameters = params.parameters;
  if (explicitActionName) {
    return {
      name: explicitActionName,
      parameters: sanitizeParameters(explicitParameters),
      targetPlayerIds: readTargetPlayerIds(params, text),
    };
  }

  for (const gameAction of KNOWN_GAME_ACTIONS) {
    for (const pattern of gameAction.patterns) {
      const match = text.match(pattern);
      if (match) {
        return {
          name: gameAction.name,
          parameters: gameAction.extractParams(match),
          targetPlayerIds: readTargetPlayerIds(params, text),
        };
      }
    }
  }

  const genericMatch = text.match(/(?:execute|run|do|trigger)\s+(\w+)/i);
  if (genericMatch) {
    return {
      name: genericMatch[1].toLowerCase(),
      parameters: {},
      targetPlayerIds: readTargetPlayerIds(params, text),
    };
  }

  return null;
}

function sanitizeParameters(value: unknown): RobloxActionParameters {
  if (!isRecord(value)) return {};
  const out: RobloxActionParameters = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null) {
      out[key] = null;
    } else if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      out[key] = item;
    }
  }
  return out;
}

function extractUserIdentifier(
  text: string,
  params: Record<string, unknown>
): { type: "id"; value: number } | { type: "username"; value: string } | null {
  const userId = readNumber(params, "playerId", "userId", "id");
  if (userId !== null && Number.isInteger(userId) && userId > 0) {
    return { type: "id", value: userId };
  }

  const username = readString(params, "username", "playerName", "user");
  if (username && !/^\d+$/.test(username)) {
    return { type: "username", value: username };
  }

  const idMatch = text.match(/\b(?:player|user|id)\s*[:#]?\s*(\d{5,})\b/i);
  if (idMatch) {
    return { type: "id", value: Number.parseInt(idMatch[1], 10) };
  }

  const usernameMatch = text.match(/\b(?:user(?:name)?|player)\s*[:#]?\s*([A-Za-z0-9_]{3,20})\b/i);
  if (usernameMatch && !/^\d+$/.test(usernameMatch[1])) {
    return { type: "username", value: usernameMatch[1] };
  }

  return null;
}

async function handleMessage(
  runtime: IAgentRuntime,
  service: RobloxService,
  message: Memory,
  state: State | undefined,
  params: Record<string, unknown>,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const content =
    readString(params, "message", "text", "content") ??
    (typeof state?.message === "string" ? state.message : undefined) ??
    (message.content.text ?? "").trim();

  if (!content) {
    await callback?.({ text: "I need a message to send to the Roblox game.", action: actionName });
    return { success: false, error: "No message content to send" };
  }

  const targetPlayerIds = readTargetPlayerIds(params, content);
  const cappedContent = content.slice(0, MAX_ROBLOX_MESSAGE_LENGTH);
  await withRobloxTimeout(
    service.sendMessage(runtime.agentId, cappedContent, targetPlayerIds),
    "roblox message",
  );

  const targetText =
    targetPlayerIds && targetPlayerIds.length > 0
      ? `to ${targetPlayerIds.length} player(s)`
      : "to all players";
  await callback?.({ text: `Sent Roblox message ${targetText}.`, action: actionName });
  return {
    success: true,
    text: `Sent Roblox message ${targetText}`,
    data: { subaction: "message", targetPlayerIds, messageLength: cappedContent.length },
  };
}

async function handleExecute(
  runtime: IAgentRuntime,
  service: RobloxService,
  message: Memory,
  params: Record<string, unknown>,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const parsedAction = parseGameAction(message.content.text ?? "", params);
  if (!parsedAction) {
    await callback?.({ text: "Could not parse Roblox game action.", action: actionName });
    return { success: false, error: "Could not parse Roblox game action" };
  }

  await withRobloxTimeout(
    service.executeAction(
      runtime.agentId,
      parsedAction.name,
      parsedAction.parameters,
      parsedAction.targetPlayerIds
    ),
    "roblox execute",
  );

  await callback?.({ text: `Triggered Roblox action "${parsedAction.name}".`, action: actionName });
  return {
    success: true,
    text: `Executed Roblox action "${parsedAction.name}"`,
    data: {
      subaction: "execute",
      actionName: parsedAction.name,
      parameters: parsedAction.parameters,
      targetPlayerIds: parsedAction.targetPlayerIds,
    },
  };
}

async function handleGetPlayer(
  runtime: IAgentRuntime,
  service: RobloxService,
  message: Memory,
  params: Record<string, unknown>,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const client = service.getClient(runtime.agentId);
  if (!client) {
    await callback?.({ text: "The Roblox client is not available.", action: actionName });
    return { success: false, error: "Roblox client not found for agent" };
  }

  const identifier = extractUserIdentifier(message.content.text ?? "", params);
  if (!identifier) {
    await callback?.({
      text: "I need a Roblox player ID or username to look up.",
      action: actionName,
    });
    return { success: false, error: "Could not extract Roblox player identifier" };
  }

  let user: RobloxUser | null;
  if (identifier.type === "id") {
    user = await withRobloxTimeout(client.getUserById(identifier.value), "roblox get user");
  } else {
    user = await withRobloxTimeout(
      client.getUserByUsername(identifier.value),
      "roblox get user",
    );
  }

  if (!user) {
    await callback?.({
      text: `No Roblox user found for ${identifier.type}: ${identifier.value}.`,
      action: actionName,
    });
    return {
      success: true,
      text: `Roblox user not found for ${identifier.type}: ${identifier.value}`,
      data: { subaction: "get_player", found: false, identifier },
    };
  }

  const avatarUrl = await withRobloxTimeout(client.getAvatarUrl(user.id), "roblox avatar");
  user.avatarUrl = avatarUrl;

  await callback?.({
    text: `${user.displayName} (@${user.username}) - Roblox user ID ${user.id}`,
    action: actionName,
  });
  return {
    success: true,
    text: `Found Roblox user: ${user.displayName} (@${user.username})`,
    data: {
      subaction: "get_player",
      found: true,
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: avatarUrl || undefined,
      isBanned: user.isBanned,
      createdAt: user.createdAt ? user.createdAt.toISOString() : undefined,
    },
  };
}

export const robloxAction: Action = {
  name: actionName,
  contexts: ["media", "automation"],
  contextGate: { anyOf: ["media", "automation"] },
  similes: ["ROBLOX", "ROBLOX_ROUTER", "ROBLOX_GAME_ACTION"],
  description: "Route Roblox game integration with subaction message, execute, or get_player.",
  descriptionCompressed: "Route Roblox game subaction: message, execute, or get_player.",
  parameters: [
    {
      name: "subaction",
      description: "Roblox operation: message, execute, or get_player.",
      descriptionCompressed: "Roblox subaction.",
      required: true,
      schema: { type: "string", enum: ["message", "execute", "get_player"] },
    },
    {
      name: "message",
      description: "Message content for the message subaction.",
      descriptionCompressed: "message text",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "actionName",
      description: "Game-side action name for execute.",
      descriptionCompressed: "game action name",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "parameters",
      description: "Game-side action parameters for execute.",
      descriptionCompressed: "game action params",
      required: false,
      schema: { type: "object" },
    },
    {
      name: "targetPlayerIds",
      description: "Roblox player IDs to target for message or execute.",
      descriptionCompressed: "target player ids",
      required: false,
      schema: { type: "array", items: { type: "number" } },
    },
    {
      name: "playerId",
      description: "Roblox player/user ID for lookup or targeting.",
      descriptionCompressed: "Roblox user id",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "username",
      description: "Roblox username for lookup.",
      descriptionCompressed: "Roblox username",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const params = parseJsonObject(message.content.text ?? "");
    const hasIntent =
      Boolean(normalizeSubaction(readString(params, "subaction", "action", "type"))) ||
      /\b(roblox|player|user|send|message|announce|execute|trigger|teleport|spawn|coins|lookup|look up)\b/i.test(
        message.content.text ?? ""
      );
    if (!hasIntent) return false;

    const apiKey = runtime.getSetting("ROBLOX_API_KEY");
    const universeId = runtime.getSetting("ROBLOX_UNIVERSE_ID");
    return Boolean(apiKey && universeId);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions | Record<string, JsonValue | undefined>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService<RobloxService>(ROBLOX_SERVICE_NAME);
    if (!service) {
      logger.error("Roblox service not found");
      await callback?.({ text: "Roblox service not available.", action: actionName });
      return { success: false, error: "Roblox service not found" };
    }

    const params = mergedInput(message, options);
    const maxRobloxTargetIds = MAX_ROBLOX_TARGET_IDS;
    if (Array.isArray(params.targetPlayerIds)) {
      params.targetPlayerIds = params.targetPlayerIds.slice(0, maxRobloxTargetIds);
    }
    const subaction = inferSubaction(message.content.text ?? "", params);

    try {
      if (subaction === "message") {
        return await handleMessage(runtime, service, message, state, params, callback);
      }
      if (subaction === "execute") {
        return await handleExecute(runtime, service, message, params, callback);
      }
      if (subaction === "get_player") {
        return await handleGetPlayer(runtime, service, message, params, callback);
      }

      return {
        success: false,
        error: "Missing Roblox subaction",
        text: "Missing Roblox subaction",
      };
    } catch (error) {
      logger.error({ error }, "Roblox action failed");
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      await callback?.({ text: `Roblox action failed: ${errorMessage}`, action: actionName });
      return { success: false, error: errorMessage };
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Tell everyone in Roblox that the event starts now" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll send that message to the Roblox game.",
          action: actionName,
        },
      },
    ],
  ] as ActionExample[][],
};

export default robloxAction;
