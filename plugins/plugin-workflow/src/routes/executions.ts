/**
 * Plugin-relative route handlers for querying workflow executions, mounted under
 * `/workflow/executions`. Reads the execution log through WorkflowService; the
 * runtime prefixes these non-rawPath routes with the plugin name.
 */
import type { IAgentRuntime, Route, RouteRequest, RouteResponse } from '@elizaos/core';
import { WorkflowApiError } from '../types/index';
import { getRouteOwnerEntityId, getService, validateLimit } from './_helpers';

function sendExecutionRouteError(res: RouteResponse, error: unknown, fallbackCode: string): void {
  const status = error instanceof WorkflowApiError ? (error.statusCode ?? 500) : 500;
  res.status(status).json({
    success: false,
    error: status === 404 ? 'workflow_resource_not_found' : fallbackCode,
    message:
      status === 404
        ? 'Workflow resource not found'
        : error instanceof Error
          ? error.message
          : 'Unknown error',
  });
}

/**
 * GET /executions?workflowId=x&status=y&limit=z&cursor=c
 */
async function listExecutions(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  try {
    const workflowId = req.query?.workflowId as string | undefined;
    const status = req.query?.status as
      | 'canceled'
      | 'error'
      | 'running'
      | 'success'
      | 'waiting'
      | undefined;
    const limit = validateLimit(req.query?.limit, 50, 250);
    const cursor = req.query?.cursor as string | undefined;

    const service = getService(runtime);
    const response = await service.listExecutions(
      {
        workflowId,
        status,
        limit,
        cursor,
      },
      getRouteOwnerEntityId(runtime)
    );
    res.json({
      success: true,
      data: response.data,
      nextCursor: response.nextCursor,
    });
  } catch (error) {
    // error-policy:J1 plugin-relative HTTP boundary translation.
    sendExecutionRouteError(res, error, 'failed_to_list_executions');
  }
}

/**
 * GET /executions/:id
 */
async function getExecution(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  try {
    const id = req.params?.id;
    if (!id) {
      res.status(400).json({ success: false, error: 'execution_id_required' });
      return;
    }

    const service = getService(runtime);
    const execution = await service.getExecutionDetail(id, getRouteOwnerEntityId(runtime));
    res.json({ success: true, data: execution });
  } catch (error) {
    // error-policy:J1 plugin-relative HTTP boundary translation.
    sendExecutionRouteError(res, error, 'failed_to_fetch_execution');
  }
}

export const executionRoutes: Route[] = [
  { type: 'GET', path: '/executions', handler: listExecutions },
  { type: 'GET', path: '/executions/:id', handler: getExecution },
];
