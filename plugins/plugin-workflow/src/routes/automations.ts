/**
 * `/api/automations` route handler. Lives in plugin-workflow because the
 * response is built directly from the in-process WorkflowService (no proxy)
 * plus the runtime task and room APIs.
 */

import type http from 'node:http';
import type { AgentRuntime } from '@elizaos/core';
import { buildAutomationListResponse } from '../lib/automations-builder';
import { getRouteOwnerEntityId } from './_helpers';

type JsonResponder = (res: http.ServerResponse, body: unknown, status?: number) => void;

export interface AutomationsRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  runtime: AgentRuntime | null;
  /** Authenticated entity principal supplied by a non-HTTP dispatcher. */
  principalId?: string;
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
    const payload = await buildAutomationListResponse(
      ctx.runtime,
      ctx.principalId?.trim() || getRouteOwnerEntityId(ctx.runtime)
    );
    sendJson(ctx, 200, payload);
  } catch (error) {
    // error-policy:J1 aggregate route boundary translation.
    sendJson(ctx, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}
