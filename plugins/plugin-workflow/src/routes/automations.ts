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
type AutomationsResult = { status: number; body: unknown };

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

export async function readAutomations(
  runtime: AgentRuntime | null,
  ownerEntityId?: string
): Promise<AutomationsResult> {
  if (!runtime) return { status: 503, body: { error: 'Agent runtime is not available' } };
  try {
    return {
      status: 200,
      body: await buildAutomationListResponse(
        runtime,
        ownerEntityId?.trim() || getRouteOwnerEntityId(runtime)
      ),
    };
  } catch (error) {
    return {
      status: 500,
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function handleAutomationsRoutes(ctx: AutomationsRouteContext): Promise<boolean> {
  if (ctx.method.toUpperCase() !== 'GET') {
    return false;
  }
  if (ctx.pathname !== '/api/automations') {
    return false;
  }
  const result = await readAutomations(ctx.runtime, ctx.principalId);
  sendJson(ctx, result.status, result.body);
  return true;
}
