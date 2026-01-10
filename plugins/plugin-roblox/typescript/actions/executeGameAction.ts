/**
 * Action to execute a custom action in a Roblox game
 */

import {
  type Action,
  type ActionExample,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import { RobloxService } from "../services/RobloxService";
import { ROBLOX_SERVICE_NAME } from "../types";

const executeGameActionExamples: ActionExample[][] = [
  [
    {
      name: "{{user1}}",
      content: {
        text: "Start a fireworks show in the game",
      },
    },
    {
      name: "{{agentName}}",
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

/**
 * Known game actions and their parameter patterns
 */
interface GameActionConfig {
  name: string;
  patterns: RegExp[];
  extractParams: (match: RegExpMatchArray) => Record<string, unknown>;
}

const KNOWN_ACTIONS: GameActionConfig[] = [
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

/**
 * Parse a message to extract action name and parameters
 */
function parseGameAction(
  message: string
): { actionName: string; parameters: Record<string, unknown> } | null {
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

  // Default: treat as a generic action request
  const genericMatch = message.match(/(?:execute|run|do)\s+(\w+)/i);
  if (genericMatch) {
    return {
      actionName: genericMatch[1].toLowerCase(),
      parameters: {},
    };
  }

  return null;
}

/**
 * Action to execute a custom action in a Roblox game
 */
const executeGameAction: Action = {
  name: "EXECUTE_ROBLOX_ACTION",
  similes: [
    "ROBLOX_ACTION",
    "GAME_ACTION",
    "DO_IN_GAME",
    "TRIGGER_EVENT",
    "RUN_GAME_COMMAND",
  ],
  description:
    "Execute a custom action in a Roblox game, such as spawning entities, giving rewards, or triggering events.",
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
    _options: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    try {
      const service = runtime.getService<RobloxService>(ROBLOX_SERVICE_NAME);
      if (!service) {
        logger.error("Roblox service not found");
        if (callback) {
          callback({
            text: "I couldn't connect to the Roblox service. Please make sure it's configured correctly.",
            action: "EXECUTE_ROBLOX_ACTION",
          });
        }
        return false;
      }

      // Extract action details from state or message
      const messageContent =
        (state?.message as string) ||
        (message.content as { text?: string }).text ||
        "";

      const parsedAction = parseGameAction(messageContent);

      if (!parsedAction) {
        logger.warn("Could not parse game action from message");
        if (callback) {
          callback({
            text: "I'm not sure what action you want me to perform. Please be more specific.",
            action: "EXECUTE_ROBLOX_ACTION",
          });
        }
        return false;
      }

      const { actionName, parameters } = parsedAction;

      // Extract target player IDs if applicable
      const playerIdMatch = messageContent.match(/player\s*(\d+)/i);
      const targetPlayerIds = playerIdMatch
        ? [parseInt(playerIdMatch[1], 10)]
        : undefined;

      // Execute the action
      await service.executeAction(
        runtime.agentId,
        actionName,
        parameters,
        targetPlayerIds
      );

      logger.info(
        { actionName, parameters, targetPlayerIds },
        "Executed Roblox game action"
      );

      if (callback) {
        callback({
          text: `I've triggered the "${actionName}" action in the game.`,
          action: "EXECUTE_ROBLOX_ACTION",
        });
      }

      return true;
    } catch (error) {
      logger.error({ error }, "Failed to execute Roblox action");
      if (callback) {
        callback({
          text: "I encountered an error executing the action in the game. Please try again.",
          action: "EXECUTE_ROBLOX_ACTION",
        });
      }
      return false;
    }
  },
};

export default executeGameAction;

