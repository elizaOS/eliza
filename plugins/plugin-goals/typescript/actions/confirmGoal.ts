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
import { extractConfirmationTemplate } from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import { createGoalDataService } from "../services/goalDataService.js";

interface PendingGoalData {
  name: string;
  description?: string;
  taskType: "daily" | "one-off" | "aspirational";
  priority?: 1 | 2 | 3 | 4;
  urgent?: boolean;
  dueDate?: string;
  recurring?: "daily" | "weekly" | "monthly";
  tags?: string[];
  metadata?: Record<string, unknown>;
}

interface ConfirmationResponse {
  isConfirmation: boolean;
  shouldProceed: boolean;
  modifications?: string;
}

async function extractConfirmationIntent(
  runtime: IAgentRuntime,
  message: Memory,
  pendingTask: PendingGoalData | null,
  state: State
): Promise<ConfirmationResponse> {
  try {
    if (!pendingTask) {
      return { isConfirmation: false, shouldProceed: false };
    }

    const messageHistory = formatMessages({
      messages: (state.data?.messages as Memory[]) || [],
      entities: (state.data?.entities as Entity[]) || [],
    });

    const pendingTaskText = `
Name: ${pendingTask.name}
Type: ${pendingTask.taskType}
${pendingTask.priority ? `Priority: ${pendingTask.priority}` : ""}
${pendingTask.urgent ? "Urgent: Yes" : ""}
${pendingTask.dueDate ? `Due Date: ${pendingTask.dueDate}` : ""}
${pendingTask.recurring ? `Recurring: ${pendingTask.recurring}` : ""}
`;

    const prompt = composePrompt({
      state: {
        text: message.content.text || "",
        messageHistory,
        pendingTask: pendingTaskText,
      },
      template: extractConfirmationTemplate,
    });

    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      stopSequences: [],
    });

    const parsedResult = parseKeyValueXml(result) as ConfirmationResponse | null;

    if (!parsedResult) {
      logger.error("Failed to parse confirmation response");
      return { isConfirmation: false, shouldProceed: false };
    }

    return {
      isConfirmation: String(parsedResult.isConfirmation) === "true",
      shouldProceed: String(parsedResult.shouldProceed) === "true",
      modifications: parsedResult.modifications === "none" ? undefined : parsedResult.modifications,
    };
  } catch (error) {
    logger.error("Error extracting confirmation intent:", error);
    return { isConfirmation: false, shouldProceed: false };
  }
}

const spec = requireActionSpec("CONFIRM_GOAL");

export const confirmGoalAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,

  validate: async (_runtime: IAgentRuntime, _message: Memory, state?: State): Promise<boolean> => {
    const pendingGoal = state?.data?.pendingGoal as PendingGoalData | undefined;
    return !!pendingGoal;
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
            text: "Unable to process confirmation without state context.",
            actions: ["CONFIRM_GOAL_ERROR"],
            source: message.content.source,
          });
        }
        return { success: false, error: "No state context" };
      }

      const pendingGoal = state.data?.pendingGoal as PendingGoalData | undefined;
      if (!pendingGoal) {
        if (callback) {
          await callback({
            text: "I don't have a pending task to confirm. Would you like to create a new task?",
            actions: ["CONFIRM_GOAL_NO_PENDING"],
            source: message.content.source,
          });
        }
        return { success: false, error: "No pending task" };
      }

      if (!message.roomId || !message.entityId) {
        if (callback) {
          await callback({
            text: "I cannot confirm a goal without a room and entity context.",
            actions: ["CONFIRM_GOAL_ERROR"],
            source: message.content.source,
          });
        }
        return { success: false, error: "No room or entity context" };
      }

      const confirmation = await extractConfirmationIntent(runtime, message, pendingGoal, state);

      if (!confirmation.isConfirmation) {
        if (callback) {
          await callback({
            text: `I'm still waiting for your confirmation on the task "${pendingGoal.name}". Would you like me to create it?`,
            actions: ["CONFIRM_GOAL_WAITING"],
            source: message.content.source,
          });
        }
        return;
      }

      if (!confirmation.shouldProceed) {
        delete state.data.pendingGoal;

        if (callback) {
          await callback({
            text: "Okay, I've cancelled the task creation. Let me know if you'd like to create a different task.",
            actions: ["CONFIRM_GOAL_CANCELLED"],
            source: message.content.source,
          });
        }
        return;
      }

      const dataService = createGoalDataService(runtime);
      const existingGoals = await dataService.getGoals({
        ownerId: message.entityId,
        ownerType: "entity",
        isCompleted: false,
      });

      const duplicateGoal = existingGoals.find((g) => g.name.trim() === pendingGoal.name.trim());

      if (duplicateGoal) {
        delete state.data.pendingGoal;
        if (callback) {
          await callback({
            text: `It looks like you already have an active goal named "${pendingGoal.name}". I haven't added a duplicate.`,
            actions: ["CONFIRM_GOAL_DUPLICATE"],
            source: message.content.source,
          });
        }
        return;
      }

      const createdGoalId = await dataService.createGoal({
        agentId: runtime.agentId,
        ownerType: "entity",
        ownerId: message.entityId,
        name: pendingGoal.name,
        description: pendingGoal.description || pendingGoal.name,
        metadata: {
          ...pendingGoal.metadata,
          taskType: pendingGoal.taskType,
          priority: pendingGoal.priority,
          urgent: pendingGoal.urgent,
          dueDate: pendingGoal.dueDate,
          recurring: pendingGoal.recurring,
        },
        tags: pendingGoal.tags || [],
      });

      if (!createdGoalId) {
        throw new Error("Failed to create goal");
      }

      delete state.data.pendingGoal;

      let successMessage = "";
      if (pendingGoal.taskType === "daily") {
        successMessage = `✅ Created daily task: "${pendingGoal.name}".`;
      } else if (pendingGoal.taskType === "one-off") {
        const priorityText = `Priority ${pendingGoal.priority || 3}`;
        const urgentText = pendingGoal.urgent ? ", Urgent" : "";
        const dueDateText = pendingGoal.dueDate
          ? `, Due: ${new Date(pendingGoal.dueDate).toLocaleDateString()}`
          : "";
        successMessage = `✅ Created task: "${pendingGoal.name}" (${priorityText}${urgentText}${dueDateText})`;
      } else {
        successMessage = `✅ Created aspirational goal: "${pendingGoal.name}"`;
      }

      if (confirmation.modifications) {
        successMessage += `\n\nI created the task as originally described. The modifications you mentioned ("${confirmation.modifications}") weren't applied. You can use UPDATE_GOAL to make changes.`;
      }

      if (callback) {
        await callback({
          text: successMessage,
          actions: ["CONFIRM_GOAL_SUCCESS"],
          source: message.content.source,
        });
      }
      return { success: true, text: successMessage };
    } catch (error) {
      logger.error("Error in confirmGoal handler:", error);
      if (callback) {
        await callback({
          text: "I encountered an error while confirming your goal. Please try again.",
          actions: ["CONFIRM_GOAL_ERROR"],
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

export default confirmGoalAction;
