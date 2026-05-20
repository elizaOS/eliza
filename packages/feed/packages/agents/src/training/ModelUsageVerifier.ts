/**
 * Model Usage Verifier
 *
 * Verifies that agents are using the correct models.
 * Provides assertions and logging for model usage verification.
 */

import {
  and,
  count,
  db,
  eq,
  gte,
  inArray,
  llmCallLogs,
  trajectories,
  users,
} from '@feed/db';
import type { IAgentRuntime } from '@elizaos/core';
import { logger } from '@feed/shared';

export interface ModelUsageStats {
  agentId: string;
  modelUsed: string;
  modelSource: 'groq' | 'claude' | 'openai' | 'unknown';
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
    runtime: IAgentRuntime
  ): Promise<ModelUsageStats> {
    const settings = runtime.character?.settings;

    // Check for different model providers
    const groqModel = String(
      settings?.GROQ_LARGE_MODEL || settings?.GROQ_SMALL_MODEL || ''
    );
    const claudeModel = String(settings?.CLAUDE_MODEL || '');
    const openaiModel = String(settings?.OPENAI_MODEL || '');

    let modelUsed: string;
    let modelSource: 'groq' | 'claude' | 'openai' | 'unknown';

    if (claudeModel) {
      modelUsed = claudeModel;
      modelSource = 'claude';
    } else if (openaiModel) {
      modelUsed = openaiModel;
      modelSource = 'openai';
    } else if (groqModel) {
      modelUsed = groqModel;
      modelSource = 'groq';
    } else {
      modelUsed = 'unknown';
      modelSource = 'unknown';
    }

    // Count inferences from logs (using trajectoryId)
    const agentTrajectories = await db
      .select({ trajectoryId: trajectories.trajectoryId })
      .from(trajectories)
      .where(eq(trajectories.agentId, agentUserId));

    const trajectoryIds = agentTrajectories.map((t) => t.trajectoryId);

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    let inferenceCount = 0;
    if (trajectoryIds.length > 0) {
      const inferenceCountResult = await db
        .select({ count: count() })
        .from(llmCallLogs)
        .where(
          and(
            gte(llmCallLogs.createdAt, twentyFourHoursAgo),
            inArray(llmCallLogs.trajectoryId, trajectoryIds)
          )
        );
      inferenceCount = inferenceCountResult[0]?.count || 0;
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
    runtimes: Map<string, IAgentRuntime>
  ): Promise<VerificationResult> {
    const details: ModelUsageStats[] = [];
    const errors: string[] = [];

    for (const agentId of agentUserIds) {
      const runtime = runtimes.get(agentId);
      if (!runtime) {
        errors.push(`Runtime not found for agent ${agentId}`);
        continue;
      }

      const stats = await this.verifyAgentModelUsage(agentId, runtime);
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
    runtime: IAgentRuntime
  ): Promise<void> {
    const stats = await this.verifyAgentModelUsage(agentUserId, runtime);

    if (stats.modelSource === 'unknown') {
      throw new Error(
        `Agent ${agentUserId} has no configured model. ` +
          `Using: ${stats.modelUsed}`
      );
    }

    logger.info(
      'Model usage verified',
      {
        agentId: agentUserId,
        model: stats.modelUsed,
        source: stats.modelSource,
      },
      'ModelUsageVerifier'
    );
  }

  /**
   * Get model usage summary
   */
  static async getModelUsageSummary(): Promise<{
    totalAgents: number;
  }> {
    const agents = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isAgent, true));

    return {
      totalAgents: agents.length,
    };
  }
}
