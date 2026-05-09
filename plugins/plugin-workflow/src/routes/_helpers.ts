import type { IAgentRuntime } from '@elizaos/core';
import type { WorkflowService } from '../services/workflow-service';
import { WORKFLOW_SERVICE_TYPE } from '../services/workflow-service';

/**
 * Extract WorkflowService from runtime services
 */
export function getService(runtime: IAgentRuntime): WorkflowService {
  const service = runtime.getService(WORKFLOW_SERVICE_TYPE) as unknown as
    | WorkflowService
    | undefined;

  if (!service) {
    throw new Error('WorkflowService not available in runtime');
  }

  return service;
}

/**
 * Validate and clamp limit parameter
 */
export function validateLimit(limitParam: unknown, defaultLimit = 20, maxLimit = 100): number {
  const limit = Number(limitParam);
  if (!Number.isFinite(limit) || limit <= 0) {
    return defaultLimit;
  }
  return Math.min(limit, maxLimit);
}
