import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import type { RobloxService } from "../services/RobloxService";
import { ROBLOX_SERVICE_NAME } from "../types";

const actionName = "EXECUTE_ROBLOX_ACTION";

const executeGameActionExamples: ActionExample[][] = [
  [
    {
      name: actionName,
      content: {
        text: "Start a fireworks show in the game",
      },
    },
    {
      name: actionName,
      content: {
        text: "I'll trigger the fireworks show for everyone in the game!",
        action: "EXECUTE_ROBLOX_ACTION",
      },
    },
  ],
  [
    {
      name: "{{user1}}",
      content: {
        text: "Give player456 100 coins as a reward",
      },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "I'll give player456 100 coins right away!",
        action: "EXECUTE_ROBLOX_ACTION",
      },
    },
  ],
  [
    {
      name: "{{user1}}",
      content: {
        text: "Teleport everyone to the lobby",
      },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Teleporting all players to the lobby now!",
        action: "EXECUTE_ROBLOX_ACTION",
      },
    },
  ],
];

interface GameActionConfig {
  name: string;
  patterns: RegExp[];
  extractParams: (match: RegExpMatchArray) => Record<string, string | number>;
}

const KNOWN_ACTIONS: GameActionConfig[] = [
  {
    name: "move_npc",
    patterns: [
      /(?:move|walk)\s+(?:the\s+)?(?:npc|bot|agent)?\s*(?:to|towards)\s+(?:the\s+)?(\w+)/i,
      /(?:move|walk)\s+to\s+\(?(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\)?/i,
    ],
    extractParams: (match): Record<string, string | number> => {
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
      playerId: parseInt(match[1], 10),
      amount: parseInt(match[2], 10),
    }),
  },
  {
    name: "teleport",
    patterns: [/teleport\s+(?:everyone|all)\s+to\s+(?:the\s+)?(\w+)/i],
    extractParams: (match) => ({
      destination: match[1],
    }),
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
    extractParams: (match) => ({
      eventType: match[1],
    }),
  },
];

function parseGameAction(
  message: string
): { actionName: string; parameters: Record<string, string | number> } | null {
  for (const action of KNOWN_ACTIONS) {
    for (const pattern of action.patterns) {
      const match = message.match(pattern);
      if (match) {
        return {
          actionName: action.name,
          parameters: action.extractParams(match),
        };
      }
    }
  }

  const genericMatch = message.match(/(?:execute|run|do)\s+(\w+)/i);
  if (genericMatch) {
    return {
      actionName: genericMatch[1].toLowerCase(),
      parameters: {},
    };
  }

  return null;
}

const executeGameAction: Action = {
  name: actionName,
  similes: [],
  description: "Execute an action in the connected Roblox game.",
  examples: executeGameActionExamples,

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const apiKey = runtime.getSetting("ROBLOX_API_KEY");
    const universeId = runtime.getSetting("ROBLOX_UNIVERSE_ID");
    return Boolean(apiKey && universeId);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    try {
      const service = runtime.getService<RobloxService>(ROBLOX_SERVICE_NAME);
      if (!service) {
        logger.error("Roblox service not found");
        if (callback) {
          callback({
            text: "Roblox service not available.",
            action: "EXECUTE_ROBLOX_ACTION",
          });
        }
        return {
          success: false,
          error: "Roblox service not found",
        };
      }

      const messageContent =
        (state?.message as string) || (message.content as { text?: string }).text || "";

      const parsedAction = parseGameAction(messageContent);

      if (!parsedAction) {
        logger.warn("Could not parse game action from message");
        if (callback) {
          callback({
            text: "Could not parse action from message.",
            action: "EXECUTE_ROBLOX_ACTION",
          });
        }
        return {
          success: false,
          error: "Could not parse game action from message",
        };
      }

      const { actionName, parameters } = parsedAction;

      const playerIdMatch = messageContent.match(/player\s*(\d+)/i);
      const targetPlayerIds = playerIdMatch ? [parseInt(playerIdMatch[1], 10)] : undefined;

      await service.executeAction(runtime.agentId, actionName, parameters, targetPlayerIds);

      logger.info({ actionName, parameters, targetPlayerIds }, "Executed Roblox game action");

      if (callback) {
        callback({
          text: `I've triggered the "${actionName}" action in the game.`,
          action: "EXECUTE_ROBLOX_ACTION",
        });
      }

      return {
        success: true,
        text: `Executed "${actionName}" action in the game`,
        data: {
          actionName,
          parameters: parameters as Record<string, string | number | boolean | null | undefined>,
          targetPlayerIds: targetPlayerIds || undefined,
        },
      };
    } catch (error) {
      logger.error({ error }, "Failed to execute Roblox action");
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      if (callback) {
        callback({
          text: "Error executing action.",
          action: "EXECUTE_ROBLOX_ACTION",
        });
      }
      return {
        success: false,
        error: errorMessage,
      };
    }
  },
};

export default executeGameAction;
