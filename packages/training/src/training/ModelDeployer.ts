/**
 * Model Deployer Service
 *
 * Automatically deploys trained models to agents.
 * Handles gradual rollout and rollback if needed.
 */

import { getTrainingDataAdapter } from "../adapter";
import { getAgentRuntimeManager } from "../dependencies";
import { logger } from "../utils/logger";

export interface DeploymentOptions {
  modelVersion: string;
  strategy: "immediate" | "gradual" | "test";
  rolloutPercentage?: number;
  testAgentIds?: string[];
}

export interface DeploymentResult {
  success: boolean;
  agentsUpdated: number;
  deploymentId: string;
  error?: string;
}

interface DeploymentStatusRecord {
  deploymentId: string;
  modelVersion: string;
  status: "in_progress" | "deployed" | "degraded" | "failed";
  agentsUpdated: number;
  agentsFailed: number;
  performance: {
    rolloutSuccessRate: number;
    runtimeResetFailures: number;
  };
  startedAt: Date;
  completedAt: Date | null;
  error?: string;
}

export class ModelDeployer {
  private deploymentStatus = new Map<string, DeploymentStatusRecord>();

  /**
   * Deploy model to agents
   */
  async deploy(options: DeploymentOptions): Promise<DeploymentResult> {
    const da = getTrainingDataAdapter();

    logger.info("Starting model deployment", {
      version: options.modelVersion,
      strategy: options.strategy,
    });

    const model = await da.getModelByVersion(options.modelVersion);

    if (!model) {
      throw new Error(`Model ${options.modelVersion} not found`);
    }

    const strategy =
      options.strategy === "immediate" ? "all" : options.strategy;

    const targetAgents = await da.getAgentUsers({
      strategy,
      rolloutPercentage: options.rolloutPercentage,
      testAgentIds: options.testAgentIds,
    });

    logger.info(`Deploying to ${targetAgents.length} agents`);

    const deploymentId = `deploy-${Date.now()}`;
    this.deploymentStatus.set(deploymentId, {
      deploymentId,
      modelVersion: options.modelVersion,
      status: "in_progress",
      agentsUpdated: 0,
      agentsFailed: 0,
      performance: {
        rolloutSuccessRate: 0,
        runtimeResetFailures: 0,
      },
      startedAt: new Date(),
      completedAt: null,
    });

    await da.updateModelStatus(model.modelId, "deployed", {
      deployedAt: new Date(),
      agentsUsing: targetAgents.length,
    });

    // Clear agent runtimes so they pick up the new model.
    const runtimeManager = getAgentRuntimeManager();
    let runtimesReset = 0;
    let runtimeResetFailures = 0;
    for (const agent of targetAgents) {
      try {
        await runtimeManager.resetRuntime(agent.id);
        runtimesReset++;
      } catch (err) {
        runtimeResetFailures++;
        logger.warn("Failed to reset runtime for agent", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info("Model deployed successfully", {
      version: options.modelVersion,
      agentsUpdated: targetAgents.length,
      deploymentId,
      runtimesReset,
    });

    const successRate =
      targetAgents.length > 0 ? runtimesReset / targetAgents.length : 0;
    this.deploymentStatus.set(deploymentId, {
      deploymentId,
      modelVersion: options.modelVersion,
      status: runtimeResetFailures > 0 ? "degraded" : "deployed",
      agentsUpdated: runtimesReset,
      agentsFailed: runtimeResetFailures,
      performance: {
        rolloutSuccessRate: successRate,
        runtimeResetFailures,
      },
      startedAt:
        this.deploymentStatus.get(deploymentId)?.startedAt ?? new Date(),
      completedAt: new Date(),
    });

    return {
      success: runtimeResetFailures === 0,
      agentsUpdated: runtimesReset,
      deploymentId,
      error:
        runtimeResetFailures > 0
          ? `${runtimeResetFailures} agent runtimes failed to reset`
          : undefined,
    };
  }

  /**
   * Rollback to previous model version
   */
  async rollback(
    currentVersion: string,
    targetVersion: string,
  ): Promise<DeploymentResult> {
    logger.info("Rolling back model", {
      from: currentVersion,
      to: targetVersion,
    });

    return await this.deploy({
      modelVersion: targetVersion,
      strategy: "immediate",
    });
  }

  /**
   * Get deployment status
   */
  async getDeploymentStatus(deploymentId: string): Promise<{
    status: string;
    agentsUpdated: number;
    agentsFailed: number;
    performance: Record<string, number>;
  } | null> {
    const status = this.deploymentStatus.get(deploymentId);
    if (!status) return null;
    return {
      status: status.status,
      agentsUpdated: status.agentsUpdated,
      agentsFailed: status.agentsFailed,
      performance: {
        rolloutSuccessRate: status.performance.rolloutSuccessRate,
        runtimeResetFailures: status.performance.runtimeResetFailures,
      },
    };
  }
}

// Singleton
export const modelDeployer = new ModelDeployer();
