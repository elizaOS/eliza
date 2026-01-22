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
  type UUID,
} from "@elizaos/core";
import {
  checkSimilarityTemplate,
  extractGoalTemplate,
} from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import { createGoalDataService } from "../services/goalDataService";

interface GoalInput {
  name: string;
  description?: string;
  ownerType: "agent" | "entity";
}

interface SimilarityCheckResult {
  hasSimilar: boolean;
  similarGoalName?: string;
  confidence: number;
}

async function extractGoalInfo(
  runtime: IAgentRuntime,
  message: Memory,
  state: State
): Promise<GoalInput | null> {
  try {
    const messageHistory = formatMessages({
      messages: (state.data?.messages as Memory[]) || [],
      entities: (state.data?.entities as Entity[]) || [],
    });

    const prompt = composePrompt({
      state: {
        text: message.content.text || "",
        messageHistory,
      },
      template: extractGoalTemplate,
    });

    const result = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      stopSequences: [],
    });

    logger.debug("Extract goal result:", result);

    // Parse XML from the text results
    const parsedResult = parseKeyValueXml(result);

    if (!parsedResult || !parsedResult.name) {
      logger.error("Failed to extract valid goal information from XML");
      return null;
    }

    return {
      name: String(parsedResult.name),
      description: parsedResult.description ? String(parsedResult.description) : undefined,
      ownerType: (parsedResult.ownerType === "agent" ? "agent" : "entity") as "agent" | "entity",
    };
  } catch (error) {
    logger.error("Error extracting goal information:", error);
    return null;
  }
}

interface ExistingGoal {
  name: string;
  description?: string;
}

async function checkForSimilarGoal(
  runtime: IAgentRuntime,
  newGoal: GoalInput,
  existingGoals: ExistingGoal[]
): Promise<SimilarityCheckResult> {
  try {
    if (existingGoals.length === 0) {
      return { hasSimilar: false, confidence: 0 };
    }

    const existingGoalsText = existingGoals
      .map((goal) => `- ${goal.name}: ${goal.description || "No description"}`)
      .join("\n");

    const prompt = composePrompt({
      state: {
        newGoalName: newGoal.name,
        newGoalDescription: newGoal.description || "No description",
        existingGoals: existingGoalsText,
      },
      template: checkSimilarityTemplate,
    });

    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      stopSequences: [],
    });

    const parsedResult = parseKeyValueXml(result) as SimilarityCheckResult | null;

    if (!parsedResult) {
      return { hasSimilar: false, confidence: 0 };
    }

    return {
      hasSimilar: String(parsedResult.hasSimilar) === "true",
      similarGoalName: parsedResult.similarGoalName,
      confidence: parseInt(String(parsedResult.confidence || 0), 10),
    };
  } catch (error) {
    logger.error("Error checking for similar goals:", error);
    return { hasSimilar: false, confidence: 0 };
  }
}

const spec = requireActionSpec("CREATE_GOAL");

export const createGoalAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,

  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => {
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const currentState = state || (await runtime.composeState(message, ["GOALS"]));
      const goalInfo = await extractGoalInfo(runtime, message, currentState);

      if (!goalInfo) {
        if (callback) {
          await callback({
            text: "I couldn't understand what goal you want to create. Could you please provide a clear goal description?",
            actions: ["CREATE_GOAL_FAILED"],
            source: message.content.source,
          });
        }
        return {
          success: false,
          error: "Could not understand goal description",
        };
      }

      const dataService = createGoalDataService(runtime);
      const ownerId = goalInfo.ownerType === "agent" ? runtime.agentId : (message.entityId as UUID);
      const activeGoalCount = await dataService.countGoals(goalInfo.ownerType, ownerId, false);

      if (activeGoalCount >= 10) {
        if (callback) {
          await callback({
            text: `Cannot add new goal: The ${goalInfo.ownerType === "agent" ? "agent" : "user"} already has 10 active goals, which is the maximum allowed. Please complete or remove some existing goals first.`,
            actions: ["CREATE_GOAL_LIMIT_REACHED"],
            source: message.content.source,
          });
        }
        return { success: false, error: "Goal limit reached" };
      }

      const existingGoals = await dataService.getAllGoalsForOwner(goalInfo.ownerType, ownerId);
      const similarityCheck = await checkForSimilarGoal(runtime, goalInfo, existingGoals);

      if (similarityCheck.hasSimilar && similarityCheck.confidence > 70) {
        if (callback) {
          await callback({
            text: `It looks like there's already a similar goal: "${similarityCheck.similarGoalName}". Are you sure you want to add this as a separate goal?`,
            actions: ["CREATE_GOAL_SIMILAR_EXISTS"],
            source: message.content.source,
          });
        }
        return { success: false, error: "Similar goal exists" };
      }

      const tags = ["GOAL"];
      if (goalInfo.ownerType === "agent") {
        tags.push("agent-goal");
      } else {
        tags.push("entity-goal");
      }

      const metadata: Record<string, unknown> = {
        createdAt: new Date().toISOString(),
      };

      const createdGoalId = await dataService.createGoal({
        agentId: runtime.agentId,
        ownerType: goalInfo.ownerType,
        ownerId,
        name: goalInfo.name,
        description: goalInfo.description || goalInfo.name,
        metadata,
        tags,
      });

      if (!createdGoalId) {
        throw new Error("Failed to create goal");
      }

      let successMessage = `✅ New goal created: "${goalInfo.name}"`;

      if (activeGoalCount >= 4) {
        successMessage += `\n\n⚠️ You now have ${activeGoalCount + 1} active goals. Consider focusing on completing some of these before adding more.`;
      }

      if (callback) {
        await callback({
          text: successMessage,
          actions: ["CREATE_GOAL_SUCCESS"],
          source: message.content.source,
        });
      }
      return { success: true, text: successMessage };
    } catch (error) {
      logger.error("Error in createGoal handler:", error);
      if (callback) {
        await callback({
          text: "I encountered an error while creating your goal. Please try again.",
          actions: ["CREATE_GOAL_FAILED"],
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

export default createGoalAction;
