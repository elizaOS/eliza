/**
 * Shared workflow-route helpers for service lookup, owner-principal resolution,
 * and bounded query parsing. Local HTTP requests run under the same canonical
 * owner entity as client chat so both surfaces see one ownership scope.
 */
import type { IAgentRuntime } from '@elizaos/core';
import type { WorkflowService } from '../services/workflow-service';
import { WORKFLOW_SERVICE_TYPE } from '../services/workflow-service';
import { getLocalOwnerEntityId } from '../utils/context';

/**
 * Extract WorkflowService from runtime services
 */
export function getService(runtime: IAgentRuntime): WorkflowService {
  const service = runtime.getService<WorkflowService>(WORKFLOW_SERVICE_TYPE);

  if (!service) {
    throw new Error('WorkflowService not available in runtime');
  }

  return service;
}

/**
 * Resolve the entity principal represented by the authenticated local route.
 * The server's legacy plugin-route boundary authenticates the request but does
 * not pass a session principal to handlers, so the local single-owner contract
 * uses the same canonical/fallback identity as client chat. Request actor
 * headers are deliberately ignored because they are caller-controlled.
 */
export function getRouteOwnerEntityId(runtime: IAgentRuntime): string {
  return getLocalOwnerEntityId(runtime);
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
