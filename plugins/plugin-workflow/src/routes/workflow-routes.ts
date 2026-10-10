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
import { digestId, digestKeys, digestRecord, digestText } from '../services/hosted-digest';
import { hostedNativeSourcesAvailable } from '../services/hosted-native-source';
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

export type { WorkflowStatusResponse } from '../services/workflow-status';

import { workflowRuntimeStatus } from '../services/workflow-status';

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
    if (path.startsWith('/hosted/')) {
      const embedded = embeddedFor(ctx),
        url = new URL(ctx.req.url ?? ctx.pathname, 'http://localhost');
      if (ctx.method === 'POST' && path === '/hosted/live-calendars') {
        ctx.json(
          ctx.res,
          await embedded.listDigestLiveCalendars(owner, await readBody(ctx.req, 2000))
        );
        return;
      }
      if (ctx.method === 'GET' && path === '/hosted/live-accounts') {
        ctx.json(ctx.res, await embedded.listDigestLiveAccounts(owner));
        return;
      }
      if (ctx.method === 'GET' && path === '/hosted/sources') {
        ctx.json(ctx.res, { sources: await embedded.listDigestSources(owner) });
        return;
      }
      if (ctx.method === 'POST' && path === '/hosted/sources') {
        ctx.json(ctx.res, {
          source: await embedded.saveDigestSource(owner, await readBody(ctx.req, 20000)),
        });
        return;
      }
      if (ctx.method === 'POST' && path === '/hosted/sources/revoke') {
        const body = await readBody(ctx.req);
        digestKeys(body, ['id', 'confirmed']);
        if (body.confirmed !== true) throw new WorkflowApiError('Confirm source revocation', 400);
        ctx.json(ctx.res, await embedded.revokeDigestSource(owner, digestId(body.id)));
        return;
      }
      if (ctx.method === 'GET' && path === '/hosted/loops') {
        ctx.json(ctx.res, { loops: await embedded.listHostedDigests(owner) });
        return;
      }
      if (ctx.method === 'POST' && path === '/hosted/dossier') {
        const body = await readBody(ctx.req, 2000);
        digestKeys(body, ['sourceId', 'sourceRevision', 'mutationId', 'confirmed']);
        if (body.confirmed !== true)
          throw new WorkflowApiError('Confirm this on-demand model execution', 400);
        ctx.json(ctx.res, {
          execution: await embedded.runHostedDossier(
            owner,
            digestId(body.sourceId),
            digestText(body.sourceRevision, 64),
            digestId(body.mutationId)
          ),
        });
        return;
      }
      if (ctx.method === 'POST' && path === '/hosted/loops') {
        const body = await readBody(ctx.req);
        digestKeys(body, ['spec', 'id', 'expectedVersionId', 'mutationId', 'confirmed']);
        if (body.confirmed !== true)
          throw new WorkflowApiError('Review and confirm recurring model execution', 400);
        ctx.json(ctx.res, {
          receipt: await embedded.saveHostedDigest(
            owner,
            digestId(body.mutationId),
            body.spec,
            body.id === undefined ? undefined : digestId(body.id),
            body.expectedVersionId === undefined ? undefined : digestId(body.expectedVersionId)
          ),
        });
        return;
      }
      if (ctx.method === 'GET' && path === '/hosted/results') {
        ctx.json(
          ctx.res,
          await embedded.digestResults(owner, digestId(url.searchParams.get('clientId')))
        );
        return;
      }
      if (ctx.method === 'POST' && path === '/hosted/results/ack') {
        const body = digestRecord(await readBody(ctx.req));
        digestKeys(body, ['clientId', 'cursor', 'runId']);
        ctx.json(
          ctx.res,
          await embedded.acknowledgeDigest(
            owner,
            digestId(body.clientId),
            typeof body.cursor === 'number' ? body.cursor : NaN,
            digestId(body.runId)
          )
        );
        return;
      }
      throw new WorkflowApiError('Hosted digest route not found', 404);
    }
    if (ctx.method === 'GET' && path === '/status') {
      ctx.json(ctx.res, {
        ...workflowRuntimeStatus(
          true,
          Boolean(ctx.runtime?.getService(EMBEDDED_WORKFLOW_SERVICE_TYPE))
        ),
        manualSubmissionProtocol: 1,
        approvalReceiptProtocol: 1,
        approvalPresentationProtocol: 1,
        metadataMutationProtocol: 1,
        lifecycleMutationProtocol: 1,
        typedAuthoringProtocol: 1,
        hostedDigestProtocol: 1,
        // Lapsed-source schedules pause (one unavailable result, schedule removed) and loops report sourceState.
        hostedDigestSourcePauseProtocol: 1,
        ...(hostedNativeSourcesAvailable()
          ? { hostedNativeSourceProtocol: 1, hostedNativeEveningProtocol: 1 }
          : {}),
      });
      return;
    }

    if (ctx.method === 'GET' && path === '/phone/catalog') {
      ctx.json(ctx.res, service.phoneCatalog());
      return;
    }
    if (ctx.method === 'POST' && path === '/phone/generate') {
      const body = await readBody(ctx.req, 75000);
      if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 75000)
        throw new WorkflowApiError('Generation request is too large', 413);
      if (
        Object.keys(body).some(
          (key) =>
            ![
              'prompt',
              'operations',
              'device',
              'existing',
              'catalogRevision',
              'compilerRevision',
            ].includes(key)
        )
      )
        throw new WorkflowApiError('Unsupported generation field', 400);
      const { catalogRevision, compilerRevision, ...input } = body;
      ctx.json(
        ctx.res,
        await service.generatePhoneDraft(input, catalogRevision, compilerRevision, owner)
      );
      return;
    }
    const typedReceipt = /^\/phone\/mutations\/([0-9a-f-]+)$/.exec(path);
    const typedEdit = /^\/workflows\/([^/]+)\/phone-spec$/.exec(path);
    const validMutation = (value: unknown): value is string =>
      typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
    if (ctx.method === 'GET' && typedReceipt) {
      if (!validMutation(typedReceipt[1]))
        throw new WorkflowApiError('Invalid typed mutation identity', 400);
      ctx.json(ctx.res, {
        mutationId: typedReceipt[1],
        receipt: await service.phoneMutationReceipt(owner, typedReceipt[1]),
      });
      return;
    }
    if (
      ctx.method === 'POST' &&
      (path === '/phone/validate' || path === '/phone/workflows' || typedEdit)
    ) {
      const body = await readBody(ctx.req, 70000);
      const allowed =
        path === '/phone/validate'
          ? ['spec', 'catalogRevision', 'compilerRevision']
          : [
              'spec',
              'catalogRevision',
              'compilerRevision',
              'mutationId',
              ...(typedEdit ? ['expectedVersionId'] : []),
            ];
      if (Object.keys(body).some((key) => !allowed.includes(key)))
        throw new WorkflowApiError('Unsupported typed authoring field', 400);
      if (path === '/phone/validate') {
        ctx.json(
          ctx.res,
          await service.validatePhoneDraft(
            body.spec,
            body.catalogRevision,
            body.compilerRevision,
            owner
          )
        );
        return;
      }
      if (!validMutation(body.mutationId))
        throw new WorkflowApiError('Invalid typed mutation identity', 400);
      if (
        typedEdit &&
        (typeof body.expectedVersionId !== 'string' ||
          !body.expectedVersionId ||
          body.expectedVersionId.length > 100)
      )
        throw new WorkflowApiError('Expected workflow version is required', 400);
      ctx.json(ctx.res, {
        receipt: await service.savePhoneDraft(
          owner,
          body.mutationId,
          body.spec,
          body.catalogRevision,
          body.compilerRevision,
          typedEdit ? decodePathSegment(typedEdit[1]) : undefined,
          typeof body.expectedVersionId === 'string' ? body.expectedVersionId : undefined
        ),
      });
      return;
    }
    if (ctx.method === 'GET' && path === '/removed-workflows') {
      ctx.json(ctx.res, {
        workflows: await service.listWorkflows(owner, true),
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
      const workflow = await service.generateWorkflowDraft(body.prompt, {
        userId: owner,
      });
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
    const phoneReview = /^\/executions\/([^/]+)\/phone-review$/.exec(path);
    if (ctx.method === 'GET' && phoneReview) {
      ctx.json(ctx.res, await service.phoneRunReview(decodePathSegment(phoneReview[1]), owner));
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
        ctx.json(ctx.res, {
          execution: await service.getExecutionDetail(runId, owner),
        });
        return;
      }
    }
    const approvalList = /^\/executions\/([^/]+)\/approvals$/.exec(path);
    if (ctx.method === 'GET' && approvalList) {
      ctx.json(ctx.res, await service.approvalReceipts(decodePathSegment(approvalList[1]), owner));
      return;
    }
    const approvalMatch = /^\/executions\/([^/]+)\/approvals\/([^/]+)\/(\d+)$/.exec(path);
    if (ctx.method === 'POST' && approvalMatch) {
      const body = await readBody(ctx.req);
      if (body.approved !== true && body.approved !== false) {
        throw new WorkflowApiError('approved must be a boolean', 400);
      }
      if ('requestDigest' in body || 'expectedVersionId' in body) {
        const iteration = Number(approvalMatch[3]);
        if (
          typeof body.requestDigest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(body.requestDigest) ||
          typeof body.expectedVersionId !== 'string' ||
          !body.expectedVersionId ||
          body.expectedVersionId.length > 200 ||
          !Number.isSafeInteger(iteration) ||
          iteration < 0 ||
          'decision' in body ||
          'note' in body
        )
          throw new WorkflowApiError('Exact reviewed approval identity required', 400);
        ctx.json(
          ctx.res,
          await service.decideReviewedApproval(
            decodePathSegment(approvalMatch[1]),
            decodePathSegment(approvalMatch[2]),
            iteration,
            body.approved,
            body.expectedVersionId,
            body.requestDigest,
            owner
          ),
          202
        );
        return;
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
    if (ctx.method === 'POST' && match.suffix === '/lifecycle') {
      const body = await readBody(ctx.req);
      if (
        Object.keys(body).some(
          (key) => !['mutationId', 'expectedVersionId', 'operation'].includes(key)
        ) ||
        typeof body.mutationId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          body.mutationId
        ) ||
        typeof body.expectedVersionId !== 'string' ||
        !body.expectedVersionId ||
        body.expectedVersionId.length > 200 ||
        (body.operation !== 'remove' && body.operation !== 'restore')
      )
        throw new WorkflowApiError('Invalid reviewed lifecycle mutation', 400);
      ctx.json(
        ctx.res,
        await service.changeLifecycle(
          match.id,
          body.mutationId,
          body.expectedVersionId,
          body.operation,
          owner
        )
      );
      return;
    }
    const lifecycle = /^\/lifecycle-mutations\/([0-9a-f-]+)$/.exec(match.suffix);
    if (ctx.method === 'GET' && lifecycle) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(lifecycle[1])
      )
        throw new WorkflowApiError('Invalid mutation identity', 400);
      ctx.json(ctx.res, await service.lifecycleReceipt(match.id, lifecycle[1], owner));
      return;
    }
    if (ctx.method === 'POST' && match.suffix === '/metadata') {
      const body = await readBody(ctx.req);
      if (
        Object.keys(body).some(
          (key) => !['mutationId', 'expectedVersionId', 'name', 'description'].includes(key)
        ) ||
        typeof body.mutationId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          body.mutationId
        ) ||
        typeof body.expectedVersionId !== 'string' ||
        !body.expectedVersionId ||
        body.expectedVersionId.length > 200 ||
        typeof body.name !== 'string' ||
        !body.name.trim() ||
        body.name.length > 200 ||
        typeof body.description !== 'string' ||
        body.description.length > 4000
      )
        throw new WorkflowApiError('Invalid metadata-only mutation', 400);
      ctx.json(
        ctx.res,
        {
          receipt: await service.changeMetadata(
            match.id,
            body.mutationId,
            body.expectedVersionId,
            body.name.trim(),
            body.description,
            owner
          ),
        },
        200
      );
      return;
    }
    const metadata = /^\/metadata-mutations\/([0-9a-f-]+)$/.exec(match.suffix);
    if (ctx.method === 'GET' && metadata) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(metadata[1])
      )
        throw new WorkflowApiError('Invalid mutation identity', 400);
      ctx.json(ctx.res, {
        mutationId: metadata[1],
        receipt: await service.metadataReceipt(match.id, metadata[1], owner),
      });
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
    const submission = /^\/submissions\/([0-9a-f-]+)$/.exec(match.suffix);
    if (ctx.method === 'GET' && submission) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(submission[1])
      )
        throw new WorkflowApiError('Invalid submission id', 400);
      ctx.json(ctx.res, {
        submissionId: submission[1],
        execution: await service.getManualSubmission(match.id, submission[1], owner),
      });
      return;
    }
    if (ctx.method === 'POST' && match.suffix === '/run') {
      const body = await readBody(ctx.req);
      if ('submissionId' in body || 'expectedVersionId' in body) {
        if (
          typeof body.submissionId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            body.submissionId
          ) ||
          typeof body.expectedVersionId !== 'string' ||
          !body.expectedVersionId ||
          body.expectedVersionId.length > 200 ||
          !isRecord(body.input)
        )
          throw new WorkflowApiError(
            'Reviewed submission requires UUID, expectedVersionId and input object',
            400
          );
        const execution = await service.startReviewedWorkflow(
          match.id,
          body.submissionId,
          body.expectedVersionId,
          body.input,
          owner
        );
        ctx.json(ctx.res, { submissionId: body.submissionId, execution }, 202);
        return;
      }
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
      ctx.json(ctx.res, {
        executions: await service.getWorkflowExecutions(match.id, 50, owner),
      });
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
    const refusal =
      error instanceof WorkflowApiError &&
      isRecord(error.response) &&
      [
        'HOSTED_SOURCE_NOT_SAVED',
        'WORKFLOW_VERSION_NOT_ADMITTED',
        'WORKFLOW_METADATA_NOT_APPLIED',
        'WORKFLOW_TYPED_NOT_APPLIED',
        'WORKFLOW_LIFECYCLE_NOT_APPLIED',
      ].includes(String(error.response.code)) &&
      (status === 409 || (status === 400 && error.response.code === 'HOSTED_SOURCE_NOT_SAVED'))
        ? error.response
        : undefined;
    ctx.json(
      ctx.res,
      {
        error: error instanceof Error ? error.message : String(error),
        ...(refusal
          ? {
              code: refusal.code,
              workflowId: refusal.workflowId,
              ...(refusal.submissionId ? { submissionId: refusal.submissionId } : {}),
              ...(refusal.mutationId ? { mutationId: refusal.mutationId } : {}),
              expectedVersionId: refusal.expectedVersionId,
            }
          : {}),
      },
      status
    );
  }
}
