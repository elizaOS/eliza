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
import { type JsonValue, ROBLOX_SERVICE_NAME, type RobloxGameAction } from "../types";

const actionName = "EXECUTE_ROBLOX_ACTION";
const ROBLOX_ACTION_TIMEOUT_MS = 15_000;
const MAX_ROBLOX_TARGET_IDS = 25;

type RobloxActionParameters = Record<string, string | number | boolean | null>;

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
      setTimeout(() => reject(new Error(`${label} timed out`)), ROBLOX_ACTION_TIMEOUT_MS)
    ),
  ]);
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

export const executeRobloxAction: Action = {
  name: actionName,
  contexts: ["media", "automation"],
  contextGate: { anyOf: ["media", "automation"] },
  similes: ["ROBLOX_RUN", "ROBLOX_TRIGGER", "ROBLOX_GAME_ACTION"],
  description:
    "Trigger a server-side Roblox game action such as move-npc, give-coins, teleport, spawn-entity, or start-event.",
  descriptionCompressed:
    "Execute Roblox game action: move-npc, give-coins, teleport, spawn-entity, start-event.",
  parameters: [
    {
      name: "actionName",
      description: "Game-side action identifier (move_npc, give_coins, teleport, etc.).",
      descriptionCompressed: "game action name",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "parameters",
      description: "Game-side action parameters.",
      descriptionCompressed: "game action params",
      required: false,
      schema: { type: "object" },
    },
    {
      name: "targetPlayerIds",
      description: "Roblox player IDs to target with this action.",
      descriptionCompressed: "target player ids",
      required: false,
      schema: { type: "array", items: { type: "number" } },
    },
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const text = message.content.text ?? "";
    const params = parseJsonObject(text);
    const hasIntent =
      readString(params, "actionName", "gameAction", "command") !== null ||
      /\b(execute|run|trigger|start|give|teleport|spawn|move|walk)\b/i.test(text);
    if (!hasIntent) return false;

    const apiKey = runtime.getSetting("ROBLOX_API_KEY");
    const universeId = runtime.getSetting("ROBLOX_UNIVERSE_ID");
    return Boolean(apiKey && universeId);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
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
    const parsedAction = parseGameAction(message.content.text ?? "", params);
    if (!parsedAction) {
      await callback?.({ text: "Could not parse Roblox game action.", action: actionName });
      return { success: false, error: "Could not parse Roblox game action" };
    }

    const maxRobloxTargetIds = MAX_ROBLOX_TARGET_IDS;
    const cappedTargetPlayerIds = parsedAction.targetPlayerIds?.slice(0, maxRobloxTargetIds);
    await withRobloxTimeout(
      service.executeAction(
        runtime.agentId,
        parsedAction.name,
        parsedAction.parameters,
        cappedTargetPlayerIds
      ),
      "roblox action"
    );

    await callback?.({
      text: `Triggered Roblox action "${parsedAction.name}".`,
      action: actionName,
    });
    return {
      success: true,
      text: `Executed Roblox action "${parsedAction.name}"`,
      data: {
        actionName: parsedAction.name,
        parameters: parsedAction.parameters,
        targetPlayerIds: cappedTargetPlayerIds,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Spawn a dragon at plaza" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll trigger that Roblox game action.",
          action: actionName,
        },
      },
    ],
  ] as ActionExample[][],
};

export default executeRobloxAction;
