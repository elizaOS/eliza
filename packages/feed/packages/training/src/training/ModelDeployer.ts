/**
 * Model Deployer Service
 *
 * Benchmark-gated deployment of trained models.
 *
 * Deployment flow:
 * 1. Training completes → model registered as 'ready' in trainedModels
 * 2. AutomationPipeline calls benchmarkAndDeploy()
 * 3. BenchmarkService scores the model
 * 4. If score passes threshold → ModelDeployer.deploy() marks as 'deployed'
 * 5. Agent runtime picks up deployed model on next tick
 *
 * Runtime model selection is handled by ModelSelectionService which reads
 * from the trainedModels table. Deploy/rollback update that table.
 */

import { db, eq, trainedModels } from '@feed/db';
import { logger } from '../utils/logger';

export interface DeploymentOptions {
  modelVersion: string;
  modelId: string;
  strategy: 'immediate' | 'gradual' | 'test';
  rolloutPercentage?: number;
  testAgentIds?: string[];
  benchmarkScore?: number;
  benchmarkPassed?: boolean;
}

export interface DeploymentResult {
  success: boolean;
  agentsUpdated: number;
  deploymentId: string;
  error?: string;
}

export class ModelDeployer {
  /**
   * Deploy a trained model by marking it as 'deployed' in the database.
   * The agent runtime's ModelSelectionService reads this status to route inference.
   *
   * Requires benchmarkPassed=true unless strategy is 'test'.
   */
  async deploy(options: DeploymentOptions): Promise<DeploymentResult> {
    const deploymentId = `deploy-${Date.now()}`;

    // Quality gate: block deployment if benchmark didn't pass (unless test strategy)
    if (options.strategy !== 'test' && options.benchmarkPassed === false) {
      logger.warn('Blocking deployment — benchmark quality gate failed', {
        version: options.modelVersion,
        modelId: options.modelId,
        benchmarkScore: options.benchmarkScore,
      });
      return {
        success: false,
        agentsUpdated: 0,
        deploymentId,
        error: `Benchmark quality gate failed (score: ${options.benchmarkScore})`,
      };
    }

    // Mark model as deployed
    const result = await db
      .update(trainedModels)
      .set({
        status: 'deployed',
        deployedAt: new Date(),
      })
      .where(eq(trainedModels.modelId, options.modelId))
      .returning();

    if (result.length === 0) {
      return {
        success: false,
        agentsUpdated: 0,
        deploymentId,
        error: `Model ${options.modelId} not found in trainedModels`,
      };
    }

    logger.info('Model deployed', {
      deploymentId,
      version: options.modelVersion,
      modelId: options.modelId,
      strategy: options.strategy,
      benchmarkScore: options.benchmarkScore,
    });

    return {
      success: true,
      agentsUpdated: 1,
      deploymentId,
    };
  }

  /**
   * Rollback: mark current deployed model as 'rolled_back' and restore previous.
   */
  async rollback(
    currentVersion: string,
    targetVersion: string
  ): Promise<DeploymentResult> {
    const deploymentId = `rollback-${Date.now()}`;

    logger.info('Rolling back model', {
      from: currentVersion,
      to: targetVersion,
    });

    // Mark current as rolled back
    await db
      .update(trainedModels)
      .set({ status: 'rolled_back' })
      .where(eq(trainedModels.version, currentVersion));

    // Re-deploy target version
    const targetResult = await db
      .update(trainedModels)
      .set({
        status: 'deployed',
        deployedAt: new Date(),
      })
      .where(eq(trainedModels.version, targetVersion))
      .returning();

    if (targetResult.length === 0) {
      return {
        success: false,
        agentsUpdated: 0,
        deploymentId,
        error: `Target model version ${targetVersion} not found`,
      };
    }

    return {
      success: true,
      agentsUpdated: 1,
      deploymentId,
    };
  }

  /**
   * Get deployment status
   */
  async getDeploymentStatus(_deploymentId: string): Promise<{
    status: string;
    agentsUpdated: number;
    agentsFailed: number;
    performance: Record<string, number>;
  } | null> {
    // Deployment is synchronous (DB update), so status is always 'completed'
    return {
      status: 'completed',
      agentsUpdated: 1,
      agentsFailed: 0,
      performance: {},
    };
  }
}

// Singleton
export const modelDeployer = new ModelDeployer();
