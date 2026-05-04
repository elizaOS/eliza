import type { Route, RouteRequest, RouteResponse, IAgentRuntime } from '@elizaos/core';
import { validateWorkflow, validateNodeParameters, validateNodeInputs } from '../utils/workflow';
import type { N8nWorkflow } from '../types/index';

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
    const workflow = req.body as unknown as N8nWorkflow;

    if (!workflow?.nodes || !workflow?.connections) {
      res.status(400).json({ success: false, error: 'nodes and connections are required' });
      return;
    }

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
