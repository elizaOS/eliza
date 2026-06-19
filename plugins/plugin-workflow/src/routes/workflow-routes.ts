import type http from 'node:http';
import type { AgentRuntime } from '@elizaos/core';
import {
  applyResolutions,
  buildCatalogSnapshot,
  type CatalogLike,
  coerceClarifications,
  pruneResolvedClarifications,
  type WorkflowClarificationResolution,
} from '../lib/workflow-clarification';
import { WORKFLOW_SERVICE_TYPE, type WorkflowService } from '../services/workflow-service';
import type {
  TriggerContext,
  WorkflowCreationResult,
  WorkflowDefinition,
  WorkflowDefinitionResponse,
} from '../types/index';

export type WorkflowMode = 'local' | 'disabled';
export type WorkflowRuntimeStatus = 'ready' | 'error';

export interface WorkflowStatusResponse {
  mode: WorkflowMode;
  host: string | null;
  status: WorkflowRuntimeStatus;
  cloudConnected: false;
  localEnabled: boolean;
  platform: 'desktop';
  cloudHealth: 'unknown';
  errorMessage?: string | null;
}

type WorkflowJsonResponder = (res: http.ServerResponse, body: unknown, status?: number) => void;

export interface WorkflowRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  runtime: AgentRuntime | null;
  agentId?: string;
  json: WorkflowJsonResponder;
}

function sendJson(
  ctx: Pick<WorkflowRouteContext, 'res' | 'json'>,
  status: number,
  body: unknown
): void {
  ctx.json(ctx.res, body, status);
}

function normalizePath(pathname: string): string {
  const withoutPrefix = pathname.replace(/^\/api\/workflow/, '');
  return withoutPrefix.length > 0 ? withoutPrefix : '/';
}

function readId(path: string): string | null {
  const match = /^\/workflows\/([^/]+)(?:\/.*)?$/.exec(path);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function resolveAgentId(ctx: WorkflowRouteContext): string {
  if (ctx.agentId?.trim()) {
    return ctx.agentId.trim();
  }
  return (
    ctx.runtime?.agentId ?? ctx.runtime?.character?.id ?? '00000000-0000-0000-0000-000000000000'
  );
}

function getWorkflowService(ctx: WorkflowRouteContext): WorkflowService | null {
  return (ctx.runtime?.getService?.(WORKFLOW_SERVICE_TYPE) as WorkflowService | null) ?? null;
}

function getConnectorTargetCatalog(ctx: WorkflowRouteContext): CatalogLike | null {
  const raw = ctx.runtime?.getService?.('connector_target_catalog');
  const candidate = raw as unknown as CatalogLike | undefined;
  return candidate && typeof candidate.listGroups === 'function' ? candidate : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asClarificationResolution(value: unknown): WorkflowClarificationResolution | null {
  if (!isRecord(value) || typeof value.paramPath !== 'string' || typeof value.value !== 'string') {
    return null;
  }
  return { paramPath: value.paramPath, value: value.value };
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    Array.isArray(value.nodes) &&
    value.nodes.every(isRecord) &&
    isRecord(value.connections)
  );
}

async function readJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  maxBytes = 1_048_576
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      res.statusCode = 413;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'request body too large' }));
      return null;
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    return null;
  }
}

function asWorkflow(value: unknown): WorkflowDefinition | null {
  return isWorkflowDefinition(value) ? value : null;
}

async function readWorkflowPayload(
  ctx: WorkflowRouteContext
): Promise<{ workflow: WorkflowDefinition; activate?: boolean } | null> {
  const body = await readJsonBody(ctx.req, ctx.res);
  if (!body) {
    return null;
  }

  const record = body as Record<string, unknown>;
  const workflow = asWorkflow(record.workflow) ?? asWorkflow(record);
  if (!workflow) {
    sendJson(ctx, 400, { error: 'workflow payload required' });
    return null;
  }
  return {
    workflow,
    activate: typeof record.activate === 'boolean' ? record.activate : undefined,
  };
}

function toWorkflowResponse(result: WorkflowCreationResult): Pick<
  WorkflowDefinitionResponse,
  'id' | 'name' | 'active'
> & {
  nodeCount: number;
  missingCredentials: WorkflowCreationResult['missingCredentials'];
} {
  return {
    id: result.id,
    name: result.name,
    active: result.active,
    nodeCount: result.nodeCount,
    missingCredentials: result.missingCredentials,
  };
}

async function deployWorkflow(
  ctx: WorkflowRouteContext,
  service: WorkflowService,
  workflow: WorkflowDefinition,
  activate?: boolean
): Promise<void> {
  const deployed = await service.deployWorkflow(workflow, resolveAgentId(ctx));
  if (deployed.missingCredentials.length > 0 && !deployed.id) {
    sendJson(ctx, 200, {
      ...toWorkflowResponse(deployed),
      warning: 'missing credentials',
    });
    return;
  }

  if (activate === false && deployed.id && deployed.active) {
    await service.deactivateWorkflow(deployed.id);
    deployed.active = false;
  }

  const full = deployed.id ? await service.getWorkflow(deployed.id) : toWorkflowResponse(deployed);
  sendJson(ctx, 200, full);
}

async function buildTriggerContextFromConversation(
  runtime: AgentRuntime | null,
  conversationId: string
): Promise<TriggerContext | undefined> {
  const room = await runtime?.getRoom?.(conversationId);
  const metadata = isRecord(room?.metadata) ? room.metadata : null;
  const inbound = isRecord(metadata?.inbound) ? metadata.inbound : null;
  if (!inbound) {
    return undefined;
  }
  const platform = typeof inbound.platform === 'string' ? inbound.platform : undefined;
  const channelId = typeof inbound.channelId === 'string' ? inbound.channelId : undefined;
  const guildId = typeof inbound.guildId === 'string' ? inbound.guildId : undefined;
  const threadId = typeof inbound.threadId === 'string' ? inbound.threadId : undefined;
  return {
    source: platform,
    ...(platform === 'discord' || channelId || guildId || threadId
      ? { discord: { channelId, guildId, threadId } }
      : {}),
  };
}

async function handleStatus(ctx: WorkflowRouteContext): Promise<void> {
  const service = getWorkflowService(ctx);
  sendJson(ctx, 200, {
    mode: service ? 'local' : 'disabled',
    host: 'in-process',
    status: service ? 'ready' : 'error',
    cloudConnected: false,
    localEnabled: Boolean(service),
    platform: 'desktop',
    cloudHealth: 'unknown',
    errorMessage: service ? null : 'Workflow service is not registered',
  } satisfies WorkflowStatusResponse);
}

async function handleList(ctx: WorkflowRouteContext, service: WorkflowService): Promise<void> {
  const workflows = await service.listWorkflows(resolveAgentId(ctx));
  sendJson(ctx, 200, { workflows });
}

async function handleGet(
  ctx: WorkflowRouteContext,
  service: WorkflowService,
  id: string
): Promise<void> {
  sendJson(ctx, 200, await service.getWorkflow(id));
}

async function handleGenerate(ctx: WorkflowRouteContext, service: WorkflowService): Promise<void> {
  const body = await readJsonBody(ctx.req, ctx.res);
  if (!isRecord(body)) {
    sendJson(ctx, 400, { error: 'request body required' });
    return;
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    sendJson(ctx, 400, { error: 'prompt required' });
    return;
  }

  const triggerContext =
    typeof body.bridgeConversationId === 'string'
      ? await buildTriggerContextFromConversation(ctx.runtime, body.bridgeConversationId)
      : undefined;

  const draft = await service.generateWorkflowDraft(
    prompt,
    triggerContext ? { triggerContext } : undefined
  );
  if (typeof body.name === 'string' && body.name.trim()) {
    draft.name = body.name.trim();
  }
  if (typeof body.workflowId === 'string' && body.workflowId.trim()) {
    draft.id = body.workflowId.trim();
  }

  const clarifications = coerceClarifications(draft._meta?.requiresClarification);
  if (clarifications.length > 0) {
    const catalog = getConnectorTargetCatalog(ctx);
    sendJson(ctx, 200, {
      status: 'needs_clarification',
      draft,
      clarifications,
      catalog: catalog ? await buildCatalogSnapshot(catalog, clarifications) : [],
    });
    return;
  }

  await deployWorkflow(ctx, service, draft);
}

async function handleResolveClarification(
  ctx: WorkflowRouteContext,
  service: WorkflowService
): Promise<void> {
  const body = await readJsonBody(ctx.req, ctx.res);
  if (!isRecord(body) || !isRecord(body.draft) || !Array.isArray(body.resolutions)) {
    sendJson(ctx, 400, { error: 'draft and resolutions required' });
    return;
  }

  const draftRecord = body.draft;
  const draft = asWorkflow(draftRecord);
  if (!draft) {
    sendJson(ctx, 400, { error: 'valid draft workflow required' });
    return;
  }
  const resolutions = body.resolutions.map(asClarificationResolution);
  const validResolutions = resolutions.filter(
    (resolution): resolution is WorkflowClarificationResolution => resolution !== null
  );
  if (validResolutions.length !== body.resolutions.length) {
    sendJson(ctx, 400, { error: 'resolution missing paramPath or string value' });
    return;
  }
  const result = applyResolutions(draftRecord, validResolutions);
  if (result.ok === false) {
    sendJson(ctx, 400, { error: result.error, paramPath: result.paramPath });
    return;
  }

  const resolvedPaths = new Set(
    body.resolutions
      .map((resolution) => (isRecord(resolution) ? resolution.paramPath : undefined))
      .filter((path): path is string => typeof path === 'string' && path.length > 0)
  );
  const freeFormCount = body.resolutions.filter(
    (resolution) => !isRecord(resolution) || typeof resolution.paramPath !== 'string'
  ).length;
  pruneResolvedClarifications(draftRecord, resolvedPaths, freeFormCount);

  if (typeof body.name === 'string' && body.name.trim()) {
    draft.name = body.name.trim();
  }
  if (typeof body.workflowId === 'string' && body.workflowId.trim()) {
    draft.id = body.workflowId.trim();
  }

  const remaining = coerceClarifications(draft._meta?.requiresClarification);
  if (remaining.length > 0) {
    const catalog = getConnectorTargetCatalog(ctx);
    sendJson(ctx, 200, {
      status: 'needs_clarification',
      draft,
      clarifications: remaining,
      catalog: catalog ? await buildCatalogSnapshot(catalog, remaining) : [],
    });
    return;
  }

  await deployWorkflow(ctx, service, draft);
}

async function handleWrite(
  ctx: WorkflowRouteContext,
  service: WorkflowService,
  id?: string
): Promise<void> {
  const payload = await readWorkflowPayload(ctx);
  if (!payload) {
    return;
  }
  const workflow = id ? { ...payload.workflow, id } : payload.workflow;
  await deployWorkflow(ctx, service, workflow, payload.activate);
}

async function handleToggle(
  ctx: WorkflowRouteContext,
  service: WorkflowService,
  id: string,
  active: boolean
): Promise<void> {
  if (active) {
    await service.activateWorkflow(id);
  } else {
    await service.deactivateWorkflow(id);
  }
  sendJson(ctx, 200, await service.getWorkflow(id));
}

async function handleListExecutions(
  ctx: WorkflowRouteContext,
  service: WorkflowService,
  id: string
): Promise<void> {
  const url = new URL(`http://x${ctx.req.url ?? ''}`);
  const rawLimit = url.searchParams.get('limit');
  const limit = Math.min(Math.max(1, Number(rawLimit) || 10), 50);
  const response = await service.listExecutions({ workflowId: id, limit });
  sendJson(ctx, 200, { executions: response.data });
}

export async function handleWorkflowRoutes(ctx: WorkflowRouteContext): Promise<void> {
  const path = normalizePath(ctx.pathname);
  const method = ctx.method.toUpperCase();

  try {
    if (method === 'GET' && path === '/status') {
      await handleStatus(ctx);
      return;
    }

    if (method === 'POST' && path === '/runtime/start') {
      sendJson(ctx, 200, { ok: true });
      return;
    }

    const service = getWorkflowService(ctx);
    if (!service) {
      sendJson(ctx, 503, { error: 'workflow service unavailable' });
      return;
    }

    if (method === 'GET' && path === '/workflows') {
      await handleList(ctx, service);
      return;
    }

    if (method === 'POST' && path === '/workflows') {
      await handleWrite(ctx, service);
      return;
    }

    if (method === 'POST' && path === '/workflows/generate') {
      await handleGenerate(ctx, service);
      return;
    }

    if (method === 'POST' && path === '/workflows/resolve-clarification') {
      await handleResolveClarification(ctx, service);
      return;
    }

    const id = readId(path);
    if (id && method === 'GET' && path === `/workflows/${encodeURIComponent(id)}`) {
      await handleGet(ctx, service, id);
      return;
    }
    if (id && method === 'PUT' && path === `/workflows/${encodeURIComponent(id)}`) {
      await handleWrite(ctx, service, id);
      return;
    }
    if (id && method === 'DELETE' && path === `/workflows/${encodeURIComponent(id)}`) {
      await service.deleteWorkflow(id);
      sendJson(ctx, 200, { ok: true });
      return;
    }
    if (id && method === 'POST' && path === `/workflows/${encodeURIComponent(id)}/activate`) {
      await handleToggle(ctx, service, id, true);
      return;
    }
    if (id && method === 'POST' && path === `/workflows/${encodeURIComponent(id)}/deactivate`) {
      await handleToggle(ctx, service, id, false);
      return;
    }
    if (id && method === 'GET' && path === `/workflows/${encodeURIComponent(id)}/executions`) {
      await handleListExecutions(ctx, service, id);
      return;
    }

    sendJson(ctx, 404, { error: 'workflow route not found' });
  } catch (error) {
    sendJson(ctx, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
