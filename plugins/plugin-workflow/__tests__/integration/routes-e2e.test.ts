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

import { tryHandleRuntimePluginRoute } from '../../../../packages/agent/src/api/runtime-plugin-routes';
import { workflowRoutePlugin } from '../../src/plugin-routes';
import { workflowRoutes } from '../../src/routes/index';
import { WORKFLOW_SERVICE_TYPE } from '../../src/services/workflow-service';

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
  };
}

function makeRuntime(
  options: { withService?: boolean; state?: FakeServiceState } = {}
): AgentRuntime {
  const { withService = true, state = { calls: [] } } = options;
  const service = makeWorkflowService(state);
  return {
    agentId: 'agent-route-test',
    character: { name: 'Route Test Agent', settings: {} },
    routes: [...workflowRoutes, ...(workflowRoutePlugin.routes ?? [])],
    getSetting: () => null,
    getService: (key: string) => (withService && key === WORKFLOW_SERVICE_TYPE ? service : null),
  } as unknown as AgentRuntime;
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
    const base = await startServer(makeRuntime());

    const res = await fetch(`${base}/api/workflow/status`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      mode: 'cloud',
      status: 'ready',
      platform: 'cloud',
      engine: 'smthrs',
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

  test('GET /api/workflow/workflows/:id dispatches the decoded id parameter', async () => {
    const state: FakeServiceState = { calls: [] };
    const base = await startServer(makeRuntime({ state }));

    const res = await fetch(`${base}/api/workflow/workflows/wf-001`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'wf-001' });
    const call = state.calls.find((c) => c.method === 'getWorkflow');
    expect(call?.args[0]).toBe('wf-001');
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

  test('paths outside the route table fall through the dispatcher to 404', async () => {
    const base = await startServer(makeRuntime());

    const res = await fetch(`${base}/api/workflow/not-a-route`);

    expect(res.status).toBe(404);
  });
});
