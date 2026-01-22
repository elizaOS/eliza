import {
  type Action,
  type ActionExample,
  type ActionResult,
  composePrompt,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
  type UUID,
} from "@elizaos/core";
import {
  extractGoalSelectionTemplate,
  extractGoalUpdateTemplate,
} from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import { createGoalDataService, type GoalData } from "../services/goalDataService";

interface GoalSelection {
  goalId: string;
  goalName: string;
  isFound: boolean;
}

interface GoalUpdate {
  name?: string;
  description?: string;
}

async function extractGoalSelection(
  runtime: IAgentRuntime,
  message: Memory,
  availableGoals: GoalData[]
): Promise<GoalSelection> {
  try {
    const goalsText = availableGoals
      .map((goal) => {
        return `ID: ${goal.id}\nName: ${goal.name}\nDescription: ${goal.description || goal.name}\nOwner Type: ${goal.ownerType}\nTags: ${goal.tags?.join(", ") || "none"}\n`;
      })
      .join("\n---\n");

    const prompt = composePrompt({
      state: {
        text: message.content.text || "",
        availableGoals: goalsText,
      },
      template: extractGoalSelectionTemplate,
    });

    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      stopSequences: [],
    });

    const parsedResult = parseKeyValueXml(result) as GoalSelection | null;

    if (!parsedResult || typeof parsedResult.isFound === "undefined") {
      logger.error("Failed to parse valid goal selection information from XML");
      return { goalId: "", goalName: "", isFound: false };
    }

    const finalResult: GoalSelection = {
      goalId: parsedResult.goalId === "null" ? "" : String(parsedResult.goalId || ""),
      goalName: parsedResult.goalName === "null" ? "" : String(parsedResult.goalName || ""),
      isFound: String(parsedResult.isFound) === "true",
    };

    return finalResult;
  } catch (error) {
    logger.error("Error extracting goal selection information:", error);
    return { goalId: "", goalName: "", isFound: false };
  }
}

/**
 * Extracts what updates the user wants to make to the goal
 */
async function extractGoalUpdate(
  runtime: IAgentRuntime,
  message: Memory,
  goal: GoalData
): Promise<GoalUpdate | null> {
  try {
    let goalDetails = `Name: ${goal.name}\n`;
    if (goal.description) goalDetails += `Description: ${goal.description}\n`;
    goalDetails += `Owner Type: ${goal.ownerType}\n`;
    goalDetails += `Created: ${goal.createdAt?.toLocaleDateString() || "Unknown"}\n`;

    const prompt = composePrompt({
      state: {
        text: message.content.text || "",
        goalDetails,
      },
      template: extractGoalUpdateTemplate,
    });

    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      stopSequences: [],
    });

    const parsedUpdate = parseKeyValueXml(result) as GoalUpdate | null;

    if (!parsedUpdate || Object.keys(parsedUpdate).length === 0) {
      logger.error("Failed to extract valid goal update information from XML");
      return null;
    }

    // Return only valid fields
    const finalUpdate: GoalUpdate = {};
    if (parsedUpdate.name) finalUpdate.name = String(parsedUpdate.name);
    if (parsedUpdate.description) finalUpdate.description = String(parsedUpdate.description);

    // Return null if no valid fields remain
    if (Object.keys(finalUpdate).length === 0) {
      logger.warn("No valid update fields found after parsing XML.");
      return null;
    }

    return finalUpdate;
  } catch (error) {
    logger.error("Error extracting goal update information:", error);
    return null;
  }
}

const spec = requireActionSpec("UPDATE_GOAL");

export const updateGoalAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: `${spec.description} Update a goal name or description.`,

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    try {
      const dataService = createGoalDataService(runtime);

      // Check both agent and entity goals
      const agentGoalCount = await dataService.countGoals("agent", runtime.agentId, false);
      const entityGoalCount = message.entityId
        ? await dataService.countGoals("entity", message.entityId as UUID, false)
        : 0;

      return agentGoalCount + entityGoalCount > 0;
    } catch (error) {
      logger.error("Error validating UPDATE_GOAL action:", error);
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      if (!state) {
        if (callback) {
          await callback({
            text: "Unable to process request without state context.",
            actions: ["UPDATE_GOAL_ERROR"],
            source: message.content.source,
          });
        }
        return { success: false, error: "No state context" };
      }

      const dataService = createGoalDataService(runtime);

      // Get all active goals (both agent and entity)
      const agentGoals = await dataService.getGoals({
        ownerType: "agent",
        ownerId: runtime.agentId,
        isCompleted: false,
      });

      const entityGoals = message.entityId
        ? await dataService.getGoals({
            ownerType: "entity",
            ownerId: message.entityId as UUID,
            isCompleted: false,
          })
        : [];

      const availableGoals = [...agentGoals, ...entityGoals];

      if (availableGoals.length === 0) {
        if (callback) {
          await callback({
            text: "There are no active goals to update. Would you like to create a new goal?",
            actions: ["UPDATE_GOAL_NO_GOALS"],
            source: message.content.source,
          });
        }
        return { success: false, error: "No active goals" };
      }

      const goalSelection = await extractGoalSelection(runtime, message, availableGoals);
      if (!goalSelection.isFound) {
        if (callback) {
          await callback({
            text:
              "I couldn't determine which goal you want to update. Could you be more specific? Here are the current goals:\n\n" +
              availableGoals.map((goal) => `- ${goal.name} (${goal.ownerType} goal)`).join("\n"),
            actions: ["UPDATE_GOAL_NOT_FOUND"],
            source: message.content.source,
          });
        }
        return { success: false, error: "Goal not found" };
      }

      const goal = availableGoals.find((g) => g.id === goalSelection.goalId);
      if (!goal) {
        if (callback) {
          await callback({
            text: `I couldn't find a goal matching "${goalSelection.goalName}". Please try again with the exact goal name.`,
            actions: ["UPDATE_GOAL_NOT_FOUND"],
            source: message.content.source,
          });
        }
        return { success: false, error: "Goal not found" };
      }

      const update = await extractGoalUpdate(runtime, message, goal);
      if (!update) {
        if (callback) {
          await callback({
            text: `I couldn't determine what changes you want to make to "${goal.name}". You can update the goal's name or description.`,
            actions: ["UPDATE_GOAL_INVALID_UPDATE"],
            source: message.content.source,
          });
        }
        return { success: false, error: "Invalid update" };
      }

      await dataService.updateGoal(goal.id, update);

      const ownerText = goal.ownerType === "agent" ? "Agent" : "User";
      const updateText: string[] = [];
      if (update.name) updateText.push(`name to "${update.name}"`);
      if (update.description) updateText.push(`description to "${update.description}"`);

      if (callback) {
        await callback({
          text: `✓ ${ownerText} goal updated: Changed ${updateText.join(" and ")}.`,
          actions: ["UPDATE_GOAL_SUCCESS"],
          source: message.content.source,
        });
      }
      return {
        success: true,
        text: `Updated goal: ${updateText.join(" and ")}`,
      };
    } catch (error) {
      logger.error("Error in updateGoal handler:", error);
      if (callback) {
        await callback({
          text: "I encountered an error while trying to update your goal. Please try again.",
          actions: ["UPDATE_GOAL_ERROR"],
          source: message.content.source,
        });
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },

  examples: (spec.examples ?? []) as ActionExample[][],
};

export default updateGoalAction;
