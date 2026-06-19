import type { IAgentRuntime, Route, RouteRequest, RouteResponse } from '@elizaos/core';
import type { WorkflowDefinition } from '../types/index';
import { validateNodeInputs, validateNodeParameters, validateWorkflow } from '../utils/workflow';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return isRecord(value) && Array.isArray(value.nodes) && isRecord(value.connections);
}

/**
 * POST /workflows/validate
 * Validate a workflow without deploying.
 *
 * Body: { nodes: [...], connections: {...}, ... }
 */
async function validate(
  req: RouteRequest,
  res: RouteResponse,
  _runtime: IAgentRuntime
): Promise<void> {
  try {
    if (!isWorkflowDefinition(req.body)) {
      res.status(400).json({ success: false, error: 'nodes and connections are required' });
      return;
    }
    const workflow = req.body;

    const result = validateWorkflow(workflow);
    const paramWarnings = validateNodeParameters(workflow);
    const inputWarnings = validateNodeInputs(workflow);

    res.json({
      valid: result.valid,
      errors: result.errors,
      warnings: [...result.warnings, ...paramWarnings, ...inputWarnings],
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'failed_to_validate_workflow',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export const validationRoutes: Route[] = [
  { type: 'POST', path: '/workflows/validate', handler: validate },
];
