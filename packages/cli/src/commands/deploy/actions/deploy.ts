/**
 * Deploy Action - Main deployment logic
 */

import { logger } from '@elizaos/core';
import type { DeployOptions, DeploymentResult } from '../types';
import { deployWithECS } from './deploy-ecs';

/**
 * Main deployment handler - uses Docker and AWS ECS
 */
export async function deployProject(options: DeployOptions): Promise<DeploymentResult> {
  try {
    logger.info('🚀 Starting ElizaOS deployment with Docker + AWS ECS');
    return await deployWithECS(options);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Deployment error:', errorMessage);
    return {
      success: false,
      error: errorMessage,
    };
  }
}
