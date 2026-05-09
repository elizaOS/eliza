import type { IAgentRuntime, Route, RouteRequest, RouteResponse } from '@elizaos/core';
import type { WorkflowDefinition } from '../types/index';
import {
  positionNodes,
  validateNodeInputs,
  validateNodeParameters,
  validateWorkflow,
} from '../utils/workflow';
import { getService } from './_helpers';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    Array.isArray(value.nodes) &&
    isRecord(value.connections)
  );
}

function readWorkflowBody(
  body: RouteRequest['body']
): { workflow: WorkflowDefinition; userId: string; activate?: boolean } | null {
  if (!isRecord(body) || !isWorkflowDefinition(body.workflow) || typeof body.userId !== 'string') {
    return null;
  }
  return {
    workflow: body.workflow,
    userId: body.userId,
    activate: typeof body.activate === 'boolean' ? body.activate : undefined,
  };
}

/**
 * GET /workflows
 */
async function listWorkflows(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  try {
    const userId = req.query?.userId as string | undefined;
    const service = getService(runtime);
    const workflows = await service.listWorkflows(userId);
    res.json({ success: true, data: workflows });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'failed_to_list_workflows',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * POST /workflows
 * Body: { workflow: WorkflowDefinition, userId: string, activate?: boolean }
 */
async function createWorkflow(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  try {
    const payload = readWorkflowBody(req.body);
    if (!payload) {
      res.status(400).json({ success: false, error: 'workflow and userId are required' });
      return;
    }
    const { workflow, userId, activate } = payload;

    const validation = validateWorkflow(workflow);
    if (!validation.valid) {
      res.status(422).json({
        success: false,
        error: 'validation_failed',
        errors: validation.errors,
        warnings: validation.warnings,
      });
      return;
    }

    const paramWarnings = validateNodeParameters(workflow);
    const inputWarnings = validateNodeInputs(workflow);
    const positioned = positionNodes(workflow);

    const service = getService(runtime);
    const result = await service.deployWorkflow(positioned, userId);

    if (result.missingCredentials.length > 0 && !result.id) {
      res.status(200).json({
        success: false,
        reason: 'missing_integrations',
        missingIntegrations: result.missingCredentials,
        warnings: [...paramWarnings, ...inputWarnings],
      });
      return;
    }

    if (activate === false && result.active && result.id) {
      await service.deactivateWorkflow(result.id);
      result.active = false;
    }

    res.json({
      success: true,
      data: result,
      warnings: [...paramWarnings, ...inputWarnings],
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'failed_to_create_workflow',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /workflows/:id
 */
async function getWorkflow(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  try {
    const id = req.params?.id;
    if (!id) {
      res.status(400).json({ success: false, error: 'workflow_id_required' });
      return;
    }

    const service = getService(runtime);
    const workflow = await service.getWorkflow(id);
    res.json({ success: true, data: workflow });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'failed_to_get_workflow',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * PUT /workflows/:id
 * Body: { workflow: WorkflowDefinition, userId: string }
 *
 * Uses deployWorkflow which handles credential resolution + update (when id is set).
 */
async function updateWorkflow(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  try {
    const id = req.params?.id;
    if (!id) {
      res.status(400).json({ success: false, error: 'workflow_id_required' });
      return;
    }

    const payload = readWorkflowBody(req.body);
    if (!payload) {
      res.status(400).json({ success: false, error: 'workflow and userId are required' });
      return;
    }
    const { workflow, userId } = payload;

    const validation = validateWorkflow(workflow);
    if (!validation.valid) {
      res.status(422).json({
        success: false,
        error: 'validation_failed',
        errors: validation.errors,
        warnings: validation.warnings,
      });
      return;
    }

    const paramWarnings = validateNodeParameters(workflow);
    const inputWarnings = validateNodeInputs(workflow);
    const positioned = positionNodes({ ...workflow, id });

    const service = getService(runtime);
    const result = await service.deployWorkflow(positioned, userId);

    if (result.missingCredentials.length > 0 && !result.id) {
      res.status(200).json({
        success: false,
        reason: 'missing_integrations',
        missingIntegrations: result.missingCredentials,
        warnings: [...paramWarnings, ...inputWarnings],
      });
      return;
    }

    res.json({
      success: true,
      data: result,
      warnings: [...paramWarnings, ...inputWarnings],
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'failed_to_update_workflow',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * DELETE /workflows/:id
 */
async function deleteWorkflow(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  try {
    const id = req.params?.id;
    if (!id) {
      res.status(400).json({ success: false, error: 'workflow_id_required' });
      return;
    }

    const service = getService(runtime);
    await service.deleteWorkflow(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'failed_to_delete_workflow',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * POST /workflows/:id/activate
 */
async function activateWorkflow(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  try {
    const id = req.params?.id;
    if (!id) {
      res.status(400).json({ success: false, error: 'workflow_id_required' });
      return;
    }

    const service = getService(runtime);
    await service.activateWorkflow(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'failed_to_activate_workflow',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * POST /workflows/:id/deactivate
 */
async function deactivateWorkflow(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  try {
    const id = req.params?.id;
    if (!id) {
      res.status(400).json({ success: false, error: 'workflow_id_required' });
      return;
    }

    const service = getService(runtime);
    await service.deactivateWorkflow(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'failed_to_deactivate_workflow',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export const workflowRoutes: Route[] = [
  { type: 'GET', path: '/workflows', handler: listWorkflows },
  { type: 'POST', path: '/workflows', handler: createWorkflow },
  { type: 'GET', path: '/workflows/:id', handler: getWorkflow },
  { type: 'PUT', path: '/workflows/:id', handler: updateWorkflow },
  { type: 'DELETE', path: '/workflows/:id', handler: deleteWorkflow },
  { type: 'POST', path: '/workflows/:id/activate', handler: activateWorkflow },
  {
    type: 'POST',
    path: '/workflows/:id/deactivate',
    handler: deactivateWorkflow,
  },
];
