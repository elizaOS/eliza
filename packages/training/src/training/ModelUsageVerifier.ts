/**
 * Model Usage Verifier
 *
 * Verifies that agents are using the correct models.
 * Provides assertions and logging for model usage verification.
 */

import { getLlmLogAdapter, getTrainingDataAdapter } from "../adapter";
import type { IAgentRuntimeLike } from "../dependencies";
import { logger } from "../utils/logger";

export interface ModelUsageStats {
  agentId: string;
  modelUsed: string;
  modelSource: "groq" | "claude" | "openai" | "unknown";
  inferenceCount: number;
}

export interface VerificationResult {
  success: boolean;
  agentsChecked: number;
  details: ModelUsageStats[];
  errors: string[];
}

export class ModelUsageVerifier {
  /**
   * Verify an agent's model usage
   *
   * Checks the agent's runtime configuration to determine which model
   * is being used.
   *
   * @param agentUserId - Unique identifier for the agent
   * @param runtime - Agent runtime to verify
   * @returns ModelUsageStats with model information and inference count
   */
  static async verifyAgentModelUsage(
    agentUserId: string,
    runtime: IAgentRuntimeLike,
  ): Promise<ModelUsageStats> {
    const character = (runtime as Record<string, unknown>).character as
      | { settings?: Record<string, unknown> }
      | undefined;
    const settings = character?.settings;

    // Check for different model providers
    const groqModel = String(
      settings?.GROQ_LARGE_MODEL || settings?.GROQ_SMALL_MODEL || "",
    );
    const claudeModel = String(settings?.CLAUDE_MODEL || "");
    const openaiModel = String(settings?.OPENAI_MODEL || "");

    let modelUsed: string;
    let modelSource: "groq" | "claude" | "openai" | "unknown";

    if (claudeModel) {
      modelUsed = claudeModel;
      modelSource = "claude";
    } else if (openaiModel) {
      modelUsed = openaiModel;
      modelSource = "openai";
    } else if (groqModel) {
      modelUsed = groqModel;
      modelSource = "groq";
    } else {
      modelUsed = "unknown";
      modelSource = "unknown";
    }

    // Count inferences from logs (using trajectoryId)
    const trajectoryIds =
      await getTrainingDataAdapter().getTrajectoryIdsByAgent(agentUserId);

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    let inferenceCount = 0;
    const llmAdapter = getLlmLogAdapter();
    if (llmAdapter && trajectoryIds.length > 0) {
      inferenceCount = await llmAdapter.countRecentLLMCalls(
        trajectoryIds,
        twentyFourHoursAgo,
      );
    }

    return {
      agentId: agentUserId,
      modelUsed,
      modelSource,
      inferenceCount,
    };
  }

  /**
   * Verify multiple agents
   */
  static async verifyMultipleAgents(
    agentUserIds: string[],
    runtimes: Map<string, IAgentRuntimeLike>,
  ): Promise<VerificationResult> {
    const details: ModelUsageStats[] = [];
    const errors: string[] = [];

    for (const agentId of agentUserIds) {
      const runtime = runtimes.get(agentId);
      if (!runtime) {
        errors.push(`Runtime not found for agent ${agentId}`);
        continue;
      }

      const stats = await ModelUsageVerifier.verifyAgentModelUsage(
        agentId,
        runtime,
      );
      details.push(stats);
    }

    return {
      success: details.length > 0,
      agentsChecked: details.length,
      details,
      errors,
    };
  }

  /**
   * Assert that an agent is using a model
   */
  static async assertModelUsage(
    agentUserId: string,
    runtime: IAgentRuntimeLike,
  ): Promise<void> {
    const stats = await ModelUsageVerifier.verifyAgentModelUsage(
      agentUserId,
      runtime,
    );

    if (stats.modelSource === "unknown") {
      throw new Error(
        `Agent ${agentUserId} has no configured model. ` +
          `Using: ${stats.modelUsed}`,
      );
    }

    logger.info(
      "Model usage verified",
      {
        agentId: agentUserId,
        model: stats.modelUsed,
        source: stats.modelSource,
      },
      "ModelUsageVerifier",
    );
  }

  /**
   * Get model usage summary
   */
  static async getModelUsageSummary(): Promise<{
    totalAgents: number;
  }> {
    const agents = await getTrainingDataAdapter().getAgentUsers();

    return {
      totalAgents: agents.length,
    };
  }
}
