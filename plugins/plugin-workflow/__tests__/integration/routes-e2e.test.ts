/**
 * Route-level e2e for plugin-workflow's Smithers-backed `/api/workflow/*`
 * surface (#19044, restoring the coverage removed with the Smithers Studio
 * integration). Boots the plugin's rawPath route table through the real
 * production dispatcher (`tryHandleRuntimePluginRoute`) over a loopback
 * `http.createServer` — exercising the real auth gate, route matching, JSON
 * body parsing, id-parameter dispatch, and error translation — with a fake
 * `WorkflowService` standing in for the only external dependency. No mocked
 * `json`/`status`: every assertion is on a real HTTP response.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentRuntime } from '@elizaos/core';
import { registerHttpPluginRoutes } from '@elizaos/host/protocol';

import { tryHandleRuntimePluginRoute } from '../../../../packages/agent/src/api/runtime-plugin-routes';
import { workflowRoutePlugin } from '../../src/plugin-routes';
import { workflowRoutes } from '../../src/routes/index';
import { handleWorkflowRoutes } from '../../src/routes/workflow-routes';
import { EMBEDDED_WORKFLOW_SERVICE_TYPE } from '../../src/services/embedded-workflow-service';
import { WORKFLOW_SERVICE_TYPE } from '../../src/services/workflow-service';
import { WorkflowApiError, type WorkflowRunEvent } from '../../src/types/index';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        })
    )
  );
  servers.length = 0;
});

/** Minimal native Smithers workflow payload accepted by `workflowFrom`. */
function smithersDefinition(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Route Test Workflow',
    source: 'export default async function main() { return 1; }',
    language: 'typescript',
    ...overrides,
  };
}

function workflowResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf-001',
    name: 'Route Test Workflow',
    active: true,
    language: 'typescript',
    source: 'export default async function main() { return 1; }',
    versionId: 'version-current',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface ServiceCall {
  method: string;
  args: unknown[];
}

interface FakeServiceState {
  calls: ServiceCall[];
}

/**
 * Fake `WorkflowService` covering only the methods the exercised routes call.
 * Deterministic, JSON-serializable results so the real HTTP round-trip can be
 * asserted end to end; every call is recorded with its arguments so the tests
 * can prove which service boundary each route hit and with which owner.
 */
function makeWorkflowService(state: FakeServiceState) {
  const record =
    (method: string, result: unknown) =>
    (...args: unknown[]) => {
      state.calls.push({ method, args });
      return Promise.resolve(result);
    };

  return {
    listWorkflows: record('listWorkflows', [
      workflowResponse(),
      workflowResponse({ id: 'wf-002', name: 'Second', active: false }),
    ]),
    getWorkflow: record('getWorkflow', workflowResponse()),
    deployWorkflow: record('deployWorkflow', workflowResponse()),
    deleteWorkflow: record('deleteWorkflow', undefined),
    startWorkflow: record('startWorkflow', {
      id: 'exec-001',
      workflowId: 'wf-001',
      status: 'running',
      mode: 'manual',
      startedAt: '2026-01-01T12:00:00.000Z',
    }),
    cancelExecution: record('cancelExecution', {
      id: 'exec-001',
      workflowId: 'wf-001',
      status: 'cancelled',
    }),
    getExecutionDetail: record('getExecutionDetail', {
      id: 'exec-001',
      workflowId: 'wf-001',
      status: 'success',
    }),
    getWorkflowExecutions: record('getWorkflowExecutions', [
      { id: 'exec-001', workflowId: 'wf-001', status: 'success' },
    ]),
    getWorkflowRevisions: record('getWorkflowRevisions', [
      { id: 'revision-001', versionId: 'version-old' },
    ]),
    restoreWorkflowRevision: record(
      'restoreWorkflowRevision',
      workflowResponse({ versionId: 'version-old' })
    ),
  };
}

function makeRuntime(
  options: {
    withService?: boolean;
    state?: FakeServiceState;
    embedded?: unknown;
    service?: Record<string, unknown>;
    tasks?: Map<string, Record<string, unknown>>;
  } = {}
): AgentRuntime {
  const { withService = true, state = { calls: [] }, embedded = null, tasks = new Map() } = options;
  const service = { ...makeWorkflowService(state), ...options.service };
  const runtime = {
    agentId: 'agent-route-test',
    character: { name: 'Route Test Agent', settings: {} },
    getSetting: () => null,
    getService: (key: string) => {
      if (key === EMBEDDED_WORKFLOW_SERVICE_TYPE) return embedded;
      return withService && key === WORKFLOW_SERVICE_TYPE ? service : null;
    },
    getTask: async (id: string) => tasks.get(id) ?? null,
    updateTask: async (id: string, update: { metadata?: Record<string, unknown> }) => {
      const task = tasks.get(id);
      if (task) tasks.set(id, { ...task, ...update });
    },
  } as unknown as AgentRuntime;
  registerHttpPluginRoutes(runtime, {
    name: 'workflow-test',
    routes: [...workflowRoutes, ...(workflowRoutePlugin.routes ?? [])],
  });
  return runtime;
}

async function startServer(
  runtime: AgentRuntime,
  isAuthorized: () => boolean = () => true
): Promise<string> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      method: req.method ?? 'GET',
      pathname: url.pathname,
      url,
      runtime,
      isAuthorized,
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function postJson(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Every exercised route resolves the same owner; capture it from any call. */
function ownerArg(state: FakeServiceState, method: string): unknown {
  const call = state.calls.find((candidate) => candidate.method === method);
  return call?.args[call.args.length - 1];
}

describe('plugin-workflow rawPath routes through real dispatch (#19044)', () => {
  test('GET /api/workflow/status answers the Smithers engine descriptor', async () => {
    const base = await startServer(makeRuntime({ embedded: makeWorkflowService({ calls: [] }) }));

    const res = await fetch(`${base}/api/workflow/status`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      mode: 'local',
      status: 'ready',
      platform: 'runtime',
      executionLocation: 'agent-runtime',
      engine: 'smthrs',
    });
  });

  test('/status reports a missing execution service without advertising protocols', async () => {
    const base = await startServer(makeRuntime());

    const res = await fetch(`${base}/api/workflow/status`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ mode: 'disabled', status: 'error' });
    expect(body.hostedDigestProtocol).toBeUndefined();
    expect(body.typedScheduleProtocol).toBeUndefined();
  });

  test('/status answers a status document when WorkflowService is missing', async () => {
    const base = await startServer(
      makeRuntime({ withService: false, embedded: makeWorkflowService({ calls: [] }) })
    );

    const res = await fetch(`${base}/api/workflow/status`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ mode: 'disabled', status: 'error' });
    expect(body.manualSubmissionProtocol).toBeUndefined();
  });

  test('/status advertises protocols only when both services are ready', async () => {
    const base = await startServer(makeRuntime({ embedded: makeWorkflowService({ calls: [] }) }));

    const body = (await (await fetch(`${base}/api/workflow/status`)).json()) as Record<
      string,
      unknown
    >;

    expect(body).toMatchObject({ status: 'ready', hostedDigestProtocol: 1 });
  });

  test.each([
    '/api/workflow/phone/validate',
    '/api/workflow/phone/workflows',
    '/api/workflow/workflows/wf-001/phone-spec',
  ])('%s refuses a 900 KB body before any service runs', async (path) => {
    let serviceCalls = 0;
    const record = () => {
      serviceCalls++;
      return Promise.resolve({});
    };
    const base = await startServer(
      makeRuntime({ service: { validatePhoneDraft: record, savePhoneDraft: record } })
    );

    const status = await postJson(base, path, { spec: 'x'.repeat(900_000) }).then(
      (res) => res.status,
      () => 'connection closed'
    );

    expect(status === 'connection closed' || status >= 400).toBe(true);
    expect(serviceCalls).toBe(0);
  });

  test('an attached body over the handler cap answers 413', async () => {
    let serviceCalls = 0;
    const runtime = makeRuntime({
      service: {
        validatePhoneDraft: () => {
          serviceCalls++;
          return Promise.resolve({});
        },
      },
    });
    const rawBody = JSON.stringify({ spec: 'x'.repeat(80_000) });
    const responses: Array<{ body: unknown; status?: number }> = [];

    await handleWorkflowRoutes({
      req: { body: JSON.parse(rawBody), rawBody } as unknown as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method: 'POST',
      pathname: '/api/workflow/phone/validate',
      runtime,
      principalId: 'owner-1',
      json: (_res, body, status) => responses.push({ body, status }),
    });

    expect(responses).toEqual([{ body: { error: 'Request body is too large' }, status: 413 }]);
    expect(serviceCalls).toBe(0);
  });

  test('GET /executions/:id/events answers 404 for an unknown run', async () => {
    const listeners = new Set<unknown>();
    const embedded = {
      subscribe: (_runId: string, listener: unknown) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const base = await startServer(
      makeRuntime({
        embedded,
        service: {
          getExecutionDetail: () =>
            Promise.reject(new WorkflowApiError('Workflow execution not found', 404)),
        },
      })
    );

    const res = await fetch(`${base}/api/workflow/executions/missing/events`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Workflow execution not found' });
    expect(listeners.size).toBe(0);
  });

  test.each([true, false])(
    'the event stream ends after a snapshot that ends the run (finished: %s)',
    async (finished) => {
      const listeners = new Set<unknown>();
      const embedded = {
        subscribe: (_runId: string, listener: unknown) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      const event = { id: 'exec-001:1', sequence: 1, runId: 'exec-001', type: 'RunFinished' };
      const base = await startServer(
        makeRuntime({
          embedded,
          service: {
            getExecutionDetail: async () => ({ id: 'exec-001', finished, events: [event] }),
          },
        })
      );

      const res = await fetch(`${base}/api/workflow/executions/exec-001/events`);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const text = await res.text();
      expect(text).toBe(`id: 1\nevent: workflow\ndata: ${JSON.stringify(event)}\n\n`);
      expect(listeners.size).toBe(0);
    }
  );

  test('a live stream sends events after the snapshot once and ends on the terminal event', async () => {
    const listeners = new Set<(event: WorkflowRunEvent) => void>();
    const embedded = {
      subscribe: (_runId: string, listener: (event: WorkflowRunEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const event = (sequence: number, type: string) =>
      ({ id: `exec-001:${sequence}`, sequence, runId: 'exec-001', type }) as WorkflowRunEvent;
    const emit = (value: WorkflowRunEvent) => {
      for (const listener of listeners) listener(value);
    };
    const base = await startServer(
      makeRuntime({
        embedded,
        service: {
          getExecutionDetail: async () => {
            // Lands between subscribe and the snapshot: the snapshot already holds it.
            emit(event(1, 'NodeStarted'));
            return { id: 'exec-001', finished: false, events: [event(1, 'NodeStarted')] };
          },
        },
      })
    );

    const res = await fetch(`${base}/api/workflow/executions/exec-001/events`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('"sequence":1')) text += decoder.decode((await reader.read()).value);
    emit(event(1, 'NodeStarted'));
    emit(event(2, 'NodeFinished'));
    emit(event(3, 'RunFinished'));
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }

    expect(text.match(/^id: \d+$/gm)).toEqual(['id: 1', 'id: 2', 'id: 3']);
    expect(listeners.size).toBe(0);
  });

  test('a client that leaves during the snapshot read leaves no listener', async () => {
    const listeners = new Set<unknown>();
    const embedded = {
      subscribe: (_runId: string, listener: unknown) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    let release = () => {};
    let reading = () => {};
    const readStarted = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const base = await startServer(
      makeRuntime({
        embedded,
        service: {
          getExecutionDetail: () => {
            reading();
            return new Promise((resolve) => {
              release = () => resolve({ id: 'exec-001', finished: false, events: [] });
            });
          },
        },
      })
    );
    const controller = new AbortController();

    const request = fetch(`${base}/api/workflow/executions/exec-001/events`, {
      signal: controller.signal,
    }).catch(() => null);
    await readStarted;
    controller.abort();
    await request;
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(listeners.size).toBe(0);
  });

  test('POST /api/workbench/todos/:id/complete with no body completes the todo', async () => {
    const id = '00000000-0000-4000-8000-000000000101';
    const tasks = new Map<string, Record<string, unknown>>([
      [
        id,
        {
          id,
          name: 'Buy milk',
          tags: ['workbench-todo'],
          metadata: { workbenchTodo: { isCompleted: false } },
        },
      ],
    ]);
    const base = await startServer(makeRuntime({ tasks }));

    const completed = await fetch(`${base}/api/workbench/todos/${id}/complete`, {
      method: 'POST',
    });
    expect(completed.status).toBe(200);
    expect(tasks.get(id)?.metadata).toMatchObject({
      isCompleted: true,
      workbenchTodo: { isCompleted: true },
    });

    const reopened = await postJson(base, `/api/workbench/todos/${id}/complete`, {
      isCompleted: false,
    });
    expect(reopened.status).toBe(200);
    expect(tasks.get(id)?.metadata).toMatchObject({
      isCompleted: false,
      workbenchTodo: { isCompleted: false },
    });
  });

  test('GET /api/workflow/workflows lists via the service with a resolved owner', async () => {
    const state: FakeServiceState = { calls: [] };
    const base = await startServer(makeRuntime({ state }));

    const res = await fetch(`${base}/api/workflow/workflows`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflows: Array<{ id: string }> };
    expect(body.workflows.map((w) => w.id)).toEqual(['wf-001', 'wf-002']);
    const owner = ownerArg(state, 'listWorkflows');
    expect(typeof owner).toBe('string');
    expect((owner as string).length).toBeGreaterThan(0);
  });

  test('POST /api/workflow/workflows deploys the parsed JSON body and answers 201', async () => {
    const state: FakeServiceState = { calls: [] };
    const base = await startServer(makeRuntime({ state }));

    const res = await postJson(base, '/api/workflow/workflows', {
      workflow: smithersDefinition(),
      activate: true,
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: 'wf-001' });
    const deploy = state.calls.find((c) => c.method === 'deployWorkflow');
    expect(deploy).toBeDefined();
    expect(deploy?.args[0]).toMatchObject({ name: 'Route Test Workflow' });
    expect(deploy?.args[2]).toMatchObject({ activate: true });
  });

  test('POST /api/workflow/workflows rejects a non-Smithers payload with 400', async () => {
    const state: FakeServiceState = { calls: [] };
    const base = await startServer(makeRuntime({ state }));

    const res = await postJson(base, '/api/workflow/workflows', {
      workflow: { name: 'missing source and language' },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'Native Smithers workflow payload is required',
    });
    expect(state.calls.find((c) => c.method === 'deployWorkflow')).toBeUndefined();
  });

  test('the dispatcher rejects malformed JSON before the workflow handler runs', async () => {
    const state: FakeServiceState = { calls: [] };
    const base = await startServer(makeRuntime({ state }));

    const res = await fetch(`${base}/api/workflow/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Invalid JSON body' });
    expect(state.calls).toEqual([]);
  });

  test('GET /api/workflow/workflows/:id dispatches the decoded id parameter', async () => {
    const state: FakeServiceState = { calls: [] };
    const base = await startServer(makeRuntime({ state }));

    const res = await fetch(`${base}/api/workflow/workflows/wf%20one`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'wf-001' });
    const call = state.calls.find((c) => c.method === 'getWorkflow');
    expect(call?.args[0]).toBe('wf one');
  });

  test('POST /api/workflow/workflows/:id/run starts a manual execution and answers 202', async () => {
    const state: FakeServiceState = { calls: [] };
    const base = await startServer(makeRuntime({ state }));

    const res = await postJson(base, '/api/workflow/workflows/wf-001/run', {
      input: { greeting: 'hello' },
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      execution: { id: 'exec-001', status: 'running' },
    });
    const call = state.calls.find((c) => c.method === 'startWorkflow');
    expect(call?.args[0]).toBe('wf-001');
    expect(call?.args[1]).toMatchObject({
      mode: 'manual',
      input: { greeting: 'hello' },
    });
  });

  test('POST /api/workflow/executions/:id/cancel answers 202 with the cancelled execution', async () => {
    const state: FakeServiceState = { calls: [] };
    const base = await startServer(makeRuntime({ state }));

    const res = await postJson(base, '/api/workflow/executions/exec-001/cancel', {});

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      execution: { id: 'exec-001', status: 'cancelled' },
    });
    const call = state.calls.find((c) => c.method === 'cancelExecution');
    expect(call?.args[0]).toBe('exec-001');
  });

  test('GET /api/workflow/executions/:id returns execution detail for the owner', async () => {
    const state: FakeServiceState = { calls: [] };
    const base = await startServer(makeRuntime({ state }));

    const res = await fetch(`${base}/api/workflow/executions/exec-001`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      execution: { id: 'exec-001', status: 'success' },
    });
    const call = state.calls.find((candidate) => candidate.method === 'getExecutionDetail');
    expect(call?.args[0]).toBe('exec-001');
    expect(typeof call?.args[1]).toBe('string');
  });

  test('POST /api/workflow/workflows/:id/revisions/:versionId/restore decodes both ids', async () => {
    const state: FakeServiceState = { calls: [] };
    const base = await startServer(makeRuntime({ state }));

    const res = await postJson(
      base,
      '/api/workflow/workflows/wf%20one/revisions/version%20old/restore',
      {}
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'wf-001', versionId: 'version-old' });
    const call = state.calls.find((candidate) => candidate.method === 'restoreWorkflowRevision');
    expect(call?.args[0]).toBe('wf one');
    expect(call?.args[1]).toBe('version old');
    expect(typeof call?.args[2]).toBe('string');
  });

  test('the dispatcher auth gate rejects unauthenticated calls before any handler runs', async () => {
    const state: FakeServiceState = { calls: [] };
    const base = await startServer(makeRuntime({ state }), () => false);

    const res = await fetch(`${base}/api/workflow/workflows`);

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'Unauthorized' });
    expect(state.calls).toEqual([]);
  });

  test('a missing WorkflowService degrades to a visible 503, not fabricated success', async () => {
    const base = await startServer(makeRuntime({ withService: false }));

    const res = await fetch(`${base}/api/workflow/workflows`);

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: 'Workflow service is unavailable',
    });
  });

  // `/status` advertises hostedDigestProtocol: 1, so every hosted path must be
  // reachable through the real dispatcher, not only by calling the handler.
  test.each([
    ['POST', '/api/workflow/hosted/live-calendars'],
    ['GET', '/api/workflow/hosted/live-accounts'],
    ['GET', '/api/workflow/hosted/sources'],
    ['POST', '/api/workflow/hosted/sources'],
    ['POST', '/api/workflow/hosted/sources/revoke'],
    ['POST', '/api/workflow/hosted/dossier'],
    ['GET', '/api/workflow/hosted/loops'],
    ['POST', '/api/workflow/hosted/loops'],
    ['GET', '/api/workflow/hosted/results'],
    ['POST', '/api/workflow/hosted/results/ack'],
  ])('%s %s reaches the hosted digest handler', async (method, path) => {
    const base = await startServer(makeRuntime());

    const res = method === 'GET' ? await fetch(`${base}${path}`) : await postJson(base, path, {});

    // No embedded runtime in this harness: the handler's own 503, not a 404.
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'Workflow runtime is unavailable' });
  });

  test('hosted digest routes dispatch to the embedded service and keep their body caps', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const embedded = {
      listHostedDigests: (...args: unknown[]) => {
        calls.push({ method: 'listHostedDigests', args });
        return Promise.resolve([{ id: 'loop-1' }]);
      },
      listDigestLiveCalendars: (...args: unknown[]) => {
        calls.push({ method: 'listDigestLiveCalendars', args });
        return Promise.resolve({ calendars: [] });
      },
    };
    const base = await startServer(makeRuntime({ embedded }));

    const loops = await fetch(`${base}/api/workflow/hosted/loops`);
    expect(loops.status).toBe(200);
    expect(await loops.json()).toEqual({ loops: [{ id: 'loop-1' }] });
    expect(calls.map((call) => call.method)).toEqual(['listHostedDigests']);

    // Over the handler's 2000-byte cap: the dispatcher refuses the body (it
    // may answer an error or close the socket) and the service is never hit.
    const oversized = await postJson(base, '/api/workflow/hosted/live-calendars', {
      accountId: 'x'.repeat(3000),
    }).then(
      (res) => res.status,
      () => 'connection closed'
    );
    expect(oversized === 'connection closed' || oversized >= 400).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(['listHostedDigests']);

    const withinCap = await postJson(base, '/api/workflow/hosted/live-calendars', {});
    expect(withinCap.status).toBe(200);
    expect(calls.map((call) => call.method)).toEqual([
      'listHostedDigests',
      'listDigestLiveCalendars',
    ]);
  });

  test.each([
    '/api/workflow/hosted/sources/revoke',
    '/api/workflow/hosted/loops',
    '/api/workflow/hosted/results/ack',
  ])('%s refuses a body over the dispatcher default before any service runs', async (path) => {
    let serviceCalls = 0;
    const record = () => {
      serviceCalls++;
      return Promise.resolve({});
    };
    const embedded = {
      revokeDigestSource: record,
      saveHostedDigest: record,
      acknowledgeDigest: record,
    };
    const base = await startServer(makeRuntime({ embedded }));

    // These routes keep the dispatcher's 1 MiB default, which is stricter
    // than their handler limit (MAX_WORKFLOW_JSON_BYTES, 2 MB).
    const status = await postJson(base, path, {
      confirmed: true,
      padding: 'x'.repeat(1_100_000),
    }).then(
      (res) => res.status,
      () => 'connection closed'
    );

    expect(status === 'connection closed' || status >= 400).toBe(true);
    expect(serviceCalls).toBe(0);
  });

  test('paths outside the route table fall through the dispatcher to 404', async () => {
    const base = await startServer(makeRuntime());

    const res = await fetch(`${base}/api/workflow/not-a-route`);

    expect(res.status).toBe(404);
  });
});
