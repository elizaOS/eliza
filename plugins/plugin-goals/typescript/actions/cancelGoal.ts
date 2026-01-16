import {
  type Action,
  type ActionExample,
  type ActionResult,
  composePrompt,
  type Entity,
  formatMessages,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
} from "@elizaos/core";
import { extractCancellationTemplate } from "../generated/prompts/typescript/prompts.js";
import { createGoalDataService, type GoalData } from "../services/goalDataService.js";

interface TaskCancellation {
  taskId: string;
  taskName: string;
  isFound: boolean;
}

async function extractTaskCancellation(
  runtime: IAgentRuntime,
  message: Memory,
  availableGoals: GoalData[],
  state: State
): Promise<TaskCancellation> {
  try {
    const tasksText = availableGoals
      .map((task) => {
        return `ID: ${task.id}\nName: ${task.name}\nDescription: ${task.description || task.name}\nTags: ${task.tags?.join(", ") || "none"}\n`;
      })
      .join("\n---\n");

    const messageHistory = formatMessages({
      messages: (state.data?.messages as Memory[]) || [],
      entities: (state.data?.entities as Entity[]) || [],
    });

    const prompt = composePrompt({
      state: {
        text: message.content.text || "",
        availableTasks: tasksText,
        messageHistory: messageHistory,
      },
      template: extractCancellationTemplate,
    });

    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      stopSequences: [],
    });

    const parsedResult = parseKeyValueXml(result) as TaskCancellation | null;

    logger.debug({ parsedResult }, "Parsed XML Result");

    if (!parsedResult || typeof parsedResult.isFound === "undefined") {
      logger.error("Failed to parse valid task cancellation information from XML");
      return { taskId: "", taskName: "", isFound: false };
    }

    const finalResult: TaskCancellation = {
      taskId: parsedResult.taskId === "null" ? "" : String(parsedResult.taskId || ""),
      taskName: parsedResult.taskName === "null" ? "" : String(parsedResult.taskName || ""),
      isFound: String(parsedResult.isFound) === "true",
    };

    return finalResult;
  } catch (error) {
    logger.error("Error extracting task cancellation information:", error);
    return { taskId: "", taskName: "", isFound: false };
  }
}

export const cancelGoalAction: Action = {
  name: "CANCEL_GOAL",
  similes: ["DELETE_GOAL", "REMOVE_TASK", "DELETE_TASK", "REMOVE_GOAL"],
  description: "Cancels and deletes a goal item from the user's task list immediately.",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    try {
      if (!message.roomId) {
        return false;
      }
      const dataService = createGoalDataService(runtime);
      const goals = await dataService.getGoals({
        ownerType: "entity",
        ownerId: message.entityId,
        isCompleted: false,
      });
      return goals.length > 0;
    } catch (error) {
      logger.error("Error validating CANCEL_GOAL action:", error);
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
            actions: ["CANCEL_GOAL_ERROR"],
            source: message.content.source,
          });
        }
        return;
      }
      if (!message.roomId) {
        if (callback) {
          await callback({
            text: "I cannot manage goals without a room context.",
            actions: ["CANCEL_GOAL_ERROR"],
            source: message.content.source,
          });
        }
        return;
      }
      const dataService = createGoalDataService(runtime);
      const activeGoals = await dataService.getGoals({
        ownerType: "entity",
        ownerId: message.entityId,
        isCompleted: false,
      });

      if (activeGoals.length === 0) {
        if (callback) {
          await callback({
            text: "You don't have any active goals to cancel.",
            actions: ["CANCEL_GOAL_NONE"],
            source: message.content.source,
          });
        }
        return;
      }

      const cancelInfo = await extractTaskCancellation(runtime, message, activeGoals, state);

      if (!cancelInfo.isFound || !cancelInfo.taskId) {
        const goalsList = activeGoals.map((goal, index) => `${index + 1}. ${goal.name}`).join("\n");

        if (callback) {
          await callback({
            text: `I couldn't determine which goal you want to cancel. Here are your active goals:\n\n${goalsList}\n\nPlease specify which one you'd like to cancel.`,
            actions: ["CANCEL_GOAL_NOT_FOUND"],
            source: message.content.source,
          });
        }
        return;
      }

      const goalToCancel = activeGoals.find((g) => g.id === cancelInfo.taskId);

      if (!goalToCancel) {
        if (callback) {
          await callback({
            text: `I couldn't find a goal matching "${cancelInfo.taskName}". Please try again.`,
            actions: ["CANCEL_GOAL_NOT_FOUND"],
            source: message.content.source,
          });
        }
        return;
      }

      const success = await dataService.deleteGoal(goalToCancel.id);

      if (success) {
        if (callback) {
          await callback({
            text: `✅ Cancelled goal: "${goalToCancel.name}"`,
            actions: ["CANCEL_GOAL_SUCCESS"],
            source: message.content.source,
          });
        }
      } else {
        throw new Error("Failed to delete goal");
      }
      return { success: true, text: "Goal cancelled" };
    } catch (error) {
      logger.error("Error in cancelGoal handler:", error);
      if (callback) {
        await callback({
          text: "I encountered an error while trying to cancel your task. Please try again.",
          actions: ["CANCEL_GOAL_ERROR"],
          source: message.content.source,
        });
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Cancel my task to finish taxes",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: 'Are you sure you want to cancel this one-off task: "Finish taxes" (Priority 2, due 4/15/2023)? Once cancelled, it will be permanently removed.',
          actions: ["CANCEL_GOAL_CONFIRM"],
        },
      },
      {
        name: "{{name1}}",
        content: {
          text: "Yes, please cancel it",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: '✓ Task cancelled: "Finish taxes" has been removed from your goal list.',
          actions: ["CANCEL_GOAL"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "I don't want to do 50 pushups anymore, please delete that task",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: 'Are you sure you want to cancel this daily task: "Do 50 pushups"? Once cancelled, it will be permanently removed.',
          actions: ["CANCEL_GOAL_CONFIRM"],
        },
      },
      {
        name: "{{name1}}",
        content: {
          text: "No, I changed my mind, I'll keep it",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: 'I\'ve kept your daily task "Do 50 pushups" active. Keep up the good work!',
          actions: ["CANCEL_GOAL_REJECTED"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default cancelGoalAction;
