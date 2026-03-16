import {
  type Action,
  type ActionResult,
  asUUID,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import { createGoalDataService } from "../services/goalDataService.js";

const spec = requireActionSpec("COMPLETE_GOAL");

export const completeGoalAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,
  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    if (!message.roomId) {
      logger.warn("No roomId provided for complete goal validation");
      return false;
    }

    const messageText = message.content?.text?.toLowerCase() || "";
    const hasCompleteIntent =
      messageText.includes("complete") ||
      messageText.includes("achieve") ||
      messageText.includes("finish") ||
      messageText.includes("done") ||
      messageText.includes("accomplished");

    logger.info(
      { hasCompleteIntent, messageText: messageText.substring(0, 100) },
      "Complete goal validation"
    );

    return hasCompleteIntent;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      if (!message.roomId) {
        const errorMessage = "No room context available";
        if (callback) {
          await callback({
            text: errorMessage,
            error: true,
          });
        }
        return { success: false, text: errorMessage };
      }

      const dataService = createGoalDataService(runtime);
      const isEntityMessage = message.entityId && message.entityId !== runtime.agentId;
      const ownerType = isEntityMessage ? "entity" : "agent";
      const ownerId = asUUID(isEntityMessage ? message.entityId : runtime.agentId);
      const ownerText = isEntityMessage ? "User" : "Agent";
      const messageText = message.content?.text || "";

      const activeGoals = await dataService.getGoals({
        ownerType,
        ownerId,
        isCompleted: false,
      });

      if (activeGoals.length === 0) {
        const responseText = `${ownerText} don't have any active goals to complete.`;
        if (callback) {
          await callback({
            text: responseText,
            actions: ["COMPLETE_GOAL"],
          });
        }
        return { success: true, text: responseText };
      }

      const matchPrompt = `Given this completion request: "${messageText}"
      
Which of these active goals best matches the request? Return only the number.

${activeGoals.map((goal, idx) => `${idx + 1}. ${goal.name}`).join("\n")}

If none match well, return 0.`;

      const matchResult = await runtime.useModel(ModelType.TEXT_REASONING_SMALL, {
        prompt: matchPrompt,
        temperature: 0.1,
      });

      const matchIndex = parseInt(matchResult.trim(), 10) - 1;

      if (matchIndex < 0 || matchIndex >= activeGoals.length) {
        const responseText = `I couldn't determine which goal you want to complete. ${ownerText} have these active goals:\n\n${activeGoals
          .map((g) => `- ${g.name}`)
          .join("\n")}\n\nPlease be more specific.`;

        if (callback) {
          await callback({
            text: responseText,
            actions: ["COMPLETE_GOAL"],
          });
        }
        return { success: true, text: responseText };
      }

      const goal = activeGoals[matchIndex];
      await dataService.updateGoal(goal.id, {
        isCompleted: true,
        completedAt: new Date(),
        metadata: {
          ...goal.metadata,
          completedBy: message.entityId,
        },
      });

      const responseText = `🎉 Congratulations! ${ownerText} goal achieved: "${goal.name}"!`;

      if (callback) {
        await callback({
          text: responseText,
          actions: ["COMPLETE_GOAL"],
        });
      }

      return {
        success: true,
        text: responseText,
        data: {
          goalId: goal.id,
          goalName: goal.name,
        },
      };
    } catch (error) {
      logger.error("Error completing goal:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to complete goal";

      if (callback) {
        await callback({
          text: `Error: ${errorMessage}`,
          error: true,
        });
      }

      return { success: false, error: errorMessage };
    }
  },
  examples: [
    [
      {
        name: "Alice",
        content: {
          text: "I've completed my goal of learning French fluently!",
          source: "user",
        },
      },
      {
        name: "Agent",
        content: {
          text: '🎉 Congratulations! User goal achieved: "Learn French fluently"!',
          actions: ["COMPLETE_GOAL"],
        },
      },
    ],
    [
      {
        name: "Bob",
        content: {
          text: "I finally achieved my marathon goal!",
          source: "user",
        },
      },
      {
        name: "Agent",
        content: {
          text: '🎉 Congratulations! User goal achieved: "Run a marathon"!',
          actions: ["COMPLETE_GOAL"],
        },
      },
    ],
    [
      {
        name: "Carol",
        content: {
          text: "Mark my cooking goal as done",
          source: "user",
        },
      },
      {
        name: "Agent",
        content: {
          text: '🎉 Congratulations! User goal achieved: "Get better at cooking"!',
          actions: ["COMPLETE_GOAL"],
        },
      },
    ],
  ],
};

export default completeGoalAction;
