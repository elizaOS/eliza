/**
 * `/api/automations` route handler. Lives in plugin-workflow because the
 * response is built directly from the in-process WorkflowService (no proxy)
 * plus the runtime task and room APIs.
 */

import type http from 'node:http';
import type { AgentRuntime } from '@elizaos/core';
import { buildAutomationListResponse } from '../lib/automations-builder';

type JsonResponder = (res: http.ServerResponse, body: unknown, status?: number) => void;

export interface AutomationsRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  runtime: AgentRuntime | null;
  json: JsonResponder;
}

function sendJson(ctx: AutomationsRouteContext, status: number, body: unknown): void {
  ctx.json(ctx.res, body, status);
}

export async function handleAutomationsRoutes(ctx: AutomationsRouteContext): Promise<boolean> {
  if (ctx.method.toUpperCase() !== 'GET') {
    return false;
  }
  if (ctx.pathname !== '/api/automations') {
    return false;
  }
  if (!ctx.runtime) {
    sendJson(ctx, 503, { error: 'Agent runtime is not available' });
    return true;
  }
  try {
    const payload = await buildAutomationListResponse(ctx.runtime);
    sendJson(ctx, 200, payload);
  } catch (error) {
    sendJson(ctx, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}
