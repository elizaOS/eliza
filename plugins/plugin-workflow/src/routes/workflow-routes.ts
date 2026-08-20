/**
 * Authenticated elizaOS HTTP boundary for native Smithers workflow definitions,
 * runs, revisions, and live events. The API talks directly to runtime services;
 * it does not proxy a Smithers Gateway or expose its protocol.
 */
import type http from 'node:http';
import type { AgentRuntime } from '@elizaos/core';
import {
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  type EmbeddedWorkflowService,
} from '../services/embedded-workflow-service';
import { MAX_WORKFLOW_JSON_BYTES } from '../services/workflow-json';
import { WORKFLOW_SERVICE_TYPE, type WorkflowService } from '../services/workflow-service';
import type { WorkflowDefinition } from '../types/index';
import { WorkflowApiError } from '../types/index';
import { getRouteOwnerEntityId } from './_helpers';

export interface WorkflowRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  runtime: AgentRuntime | null;
  principalId?: string;
  json: (res: http.ServerResponse, body: unknown, status?: number) => void;
}

export interface WorkflowStatusResponse {
  mode: 'cloud' | 'disabled';
  host: string | null;
  status: 'ready' | 'error';
  cloudConnected: boolean;
  localEnabled: boolean;
  platform: 'cloud';
  cloudHealth: 'healthy' | 'unknown';
  engine: 'smthrs';
  errorMessage?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function serviceFor(ctx: WorkflowRouteContext): WorkflowService {
  const service = ctx.runtime?.getService<WorkflowService>(WORKFLOW_SERVICE_TYPE);
  if (!service) throw new WorkflowApiError('Workflow service is unavailable', 503);
  return service;
}

function embeddedFor(ctx: WorkflowRouteContext): EmbeddedWorkflowService {
  const service = ctx.runtime?.getService<EmbeddedWorkflowService>(EMBEDDED_WORKFLOW_SERVICE_TYPE);
  if (!service) throw new WorkflowApiError('Workflow runtime is unavailable', 503);
  return service;
}

function ownerFor(ctx: WorkflowRouteContext): string {
  if (ctx.principalId?.trim()) return ctx.principalId.trim();
  if (!ctx.runtime) throw new WorkflowApiError('Workflow principal is unavailable', 503);
  return getRouteOwnerEntityId(ctx.runtime);
}

function pathFor(pathname: string): string {
  return pathname.replace(/^\/api\/workflow/, '') || '/';
}

function decodePathSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    // error-policy:J3 malformed path segments become an explicit 400 response.
    throw new WorkflowApiError('Path segment is not valid percent-encoding', 400);
  }
}

async function readBody(
  req: http.IncomingMessage,
  limit = MAX_WORKFLOW_JSON_BYTES
): Promise<Record<string, unknown>> {
  const attached = (req as http.IncomingMessage & { body?: unknown }).body;
  if (isRecord(attached)) return attached;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > limit) throw new WorkflowApiError('Request body is too large', 413);
    chunks.push(value);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (isRecord(parsed)) return parsed;
  } catch {
    // error-policy:J3 malformed request bodies become an explicit 400 response.
  }
  throw new WorkflowApiError('JSON object body is required', 400);
}

function workflowFrom(body: Record<string, unknown>): WorkflowDefinition {
  const candidate = isRecord(body.workflow) ? body.workflow : body;
  if (
    typeof candidate.name !== 'string' ||
    typeof candidate.source !== 'string' ||
    (candidate.language !== 'tsx' && candidate.language !== 'typescript')
  ) {
    throw new WorkflowApiError('Native Smithers workflow payload is required', 400);
  }
  return candidate as unknown as WorkflowDefinition;
}

function idMatch(path: string): { id: string; suffix: string } | null {
  const match = /^\/workflows\/([^/]+)(.*)$/.exec(path);
  return match ? { id: decodePathSegment(match[1]), suffix: match[2] || '' } : null;
}

async function streamEvents(
  ctx: WorkflowRouteContext,
  runId: string,
  ownerEntityId: string
): Promise<void> {
  const service = embeddedFor(ctx);
  const execution = await serviceFor(ctx).getExecutionDetail(runId, ownerEntityId);
  ctx.res.statusCode = 200;
  ctx.res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  ctx.res.setHeader('cache-control', 'no-cache, no-transform');
  ctx.res.setHeader('connection', 'keep-alive');
  ctx.res.flushHeaders?.();
  for (const event of execution.events ?? []) {
    ctx.res.write(`id: ${event.sequence}\nevent: workflow\ndata: ${JSON.stringify(event)}\n\n`);
  }
  const unsubscribe = service.subscribe(runId, (event) => {
    ctx.res.write(`id: ${event.sequence}\nevent: workflow\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => ctx.res.write(': heartbeat\n\n'), 15_000);
  await new Promise<void>((resolve) => ctx.req.once('close', resolve)).finally(() => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

export async function handleWorkflowRoutes(ctx: WorkflowRouteContext): Promise<void> {
  const path = pathFor(ctx.pathname);
  try {
    const service = serviceFor(ctx);
    const owner = ownerFor(ctx);
    if (ctx.method === 'GET' && path === '/status') {
      ctx.json(ctx.res, {
        mode: 'cloud',
        host: 'eliza-cloud',
        status: 'ready',
        cloudConnected: true,
        localEnabled: false,
        platform: 'cloud',
        cloudHealth: 'healthy',
        engine: 'smthrs',
      });
      return;
    }
    if (ctx.method === 'GET' && path === '/workflows') {
      ctx.json(ctx.res, { workflows: await service.listWorkflows(owner) });
      return;
    }
    if (ctx.method === 'POST' && path === '/workflows/generate') {
      const body = await readBody(ctx.req);
      if (typeof body.prompt !== 'string' || !body.prompt.trim())
        throw new WorkflowApiError('prompt is required', 400);
      const workflow = await service.generateWorkflowDraft(body.prompt, { userId: owner });
      ctx.json(ctx.res, { workflow }, 200);
      return;
    }
    if (ctx.method === 'POST' && path === '/workflows') {
      const body = await readBody(ctx.req);
      const created = await service.deployWorkflow(workflowFrom(body), owner, {
        activate: typeof body.activate === 'boolean' ? body.activate : undefined,
      });
      ctx.json(ctx.res, await service.getWorkflow(created.id, owner), 201);
      return;
    }
    const executionMatch = /^\/executions\/([^/]+)(?:\/(events|cancel))?$/.exec(path);
    if (executionMatch) {
      const runId = decodePathSegment(executionMatch[1]);
      const operation = executionMatch[2];
      if (ctx.method === 'GET' && operation === 'events') return streamEvents(ctx, runId, owner);
      if (ctx.method === 'POST' && operation === 'cancel') {
        ctx.json(ctx.res, { execution: await service.cancelExecution(runId, owner) }, 202);
        return;
      }
      if (ctx.method === 'GET' && !operation) {
        ctx.json(ctx.res, { execution: await service.getExecutionDetail(runId, owner) });
        return;
      }
    }
    const approvalMatch = /^\/executions\/([^/]+)\/approvals\/([^/]+)\/(\d+)$/.exec(path);
    if (ctx.method === 'POST' && approvalMatch) {
      const body = await readBody(ctx.req);
      if (body.approved !== true && body.approved !== false) {
        throw new WorkflowApiError('approved must be a boolean', 400);
      }
      ctx.json(
        ctx.res,
        {
          execution: await service.decideApproval(
            decodePathSegment(approvalMatch[1]),
            decodePathSegment(approvalMatch[2]),
            Number(approvalMatch[3]),
            body.approved,
            {
              ...(typeof body.note === 'string' ? { note: body.note } : {}),
              decidedBy: owner,
              ...(body.decision !== undefined ? { decision: body.decision } : {}),
            }
          ),
        },
        202
      );
      return;
    }
    const signalMatch = /^\/executions\/([^/]+)\/signals\/([^/]+)$/.exec(path);
    if (ctx.method === 'POST' && signalMatch) {
      const body = await readBody(ctx.req);
      ctx.json(
        ctx.res,
        {
          execution: await service.signalExecution(
            decodePathSegment(signalMatch[1]),
            decodePathSegment(signalMatch[2]),
            body.payload,
            owner
          ),
        },
        202
      );
      return;
    }
    const match = idMatch(path);
    if (!match) throw new WorkflowApiError('Workflow route not found', 404);
    if (ctx.method === 'GET' && match.suffix === '') {
      ctx.json(ctx.res, await service.getWorkflow(match.id, owner));
      return;
    }
    if (ctx.method === 'PUT' && match.suffix === '') {
      const body = await readBody(ctx.req);
      ctx.json(ctx.res, await service.updateWorkflow(match.id, workflowFrom(body), owner));
      return;
    }
    if (ctx.method === 'DELETE' && match.suffix === '') {
      await service.deleteWorkflow(match.id, owner);
      ctx.json(ctx.res, { ok: true });
      return;
    }
    if (ctx.method === 'POST' && (match.suffix === '/activate' || match.suffix === '/deactivate')) {
      const workflow =
        match.suffix === '/activate'
          ? await service.activateWorkflow(match.id, owner)
          : await service.deactivateWorkflow(match.id, owner);
      ctx.json(ctx.res, workflow);
      return;
    }
    if (ctx.method === 'POST' && match.suffix === '/run') {
      const body = await readBody(ctx.req);
      const execution = await service.startWorkflow(
        match.id,
        {
          mode: 'manual',
          input: isRecord(body.input) ? body.input : body,
        },
        owner
      );
      ctx.json(ctx.res, { execution }, 202);
      return;
    }
    if (ctx.method === 'GET' && match.suffix === '/executions') {
      ctx.json(ctx.res, { executions: await service.getWorkflowExecutions(match.id, 50, owner) });
      return;
    }
    if (ctx.method === 'GET' && match.suffix === '/revisions') {
      const workflow = await service.getWorkflow(match.id, owner);
      ctx.json(ctx.res, {
        currentVersionId: workflow.versionId,
        revisions: await service.getWorkflowRevisions(match.id, 50, owner),
      });
      return;
    }
    const restore = /^\/revisions\/([^/]+)\/restore$/.exec(match.suffix);
    if (ctx.method === 'POST' && restore) {
      ctx.json(
        ctx.res,
        await service.restoreWorkflowRevision(match.id, decodePathSegment(restore[1]), owner)
      );
      return;
    }
    if (ctx.method === 'GET' && match.suffix === '/evaluation-samples') {
      ctx.json(ctx.res, await service.getWorkflowEvaluationSuite(match.id, 20, owner));
      return;
    }
    throw new WorkflowApiError('Workflow route not found', 404);
  } catch (error) {
    // error-policy:J1 HTTP boundary translates typed workflow failures.
    const status = error instanceof WorkflowApiError ? error.statusCode : 500;
    ctx.json(ctx.res, { error: error instanceof Error ? error.message : String(error) }, status);
  }
}
