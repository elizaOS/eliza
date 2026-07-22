/**
 * Route-level e2e for plugin-workflow (issue #8802).
 *
 * Boots the plugin's relative and raw route tables through the real production
 * dispatcher (`tryHandleRuntimePluginRoute`) over a loopback `http.createServer`
 * — exercising the real auth gate, JSON body parsing, query/param parsing, and
 * handler dispatch — with a faked `WorkflowService` standing in for the only
 * external dependency. No mocked `json`/`status`: every assertion is on a real
 * HTTP response (status + parsed body).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentRuntime } from '@elizaos/core';

import { tryHandleRuntimePluginRoute } from '../../../../packages/agent/src/api/runtime-plugin-routes';
import { workflowRoutePlugin } from '../../src/plugin-routes';
import { workflowRoutes } from '../../src/routes/index';
import { createValidWorkflow, createWorkflowResponse } from '../fixtures/workflows';

const servers: http.Server[] = [];
const OWNER_ENTITY_ID = 'route-owner-test';

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

interface ServiceCall {
  method: string;
  args: unknown[];
}

interface FakeServiceState {
  calls: ServiceCall[];
}

/**
 * Build a fake `WorkflowService` covering only the methods the routes call.
 * Returns deterministic, JSON-serializable fixtures so the real HTTP round-trip
 * can be asserted end to end.
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
      createWorkflowResponse({ id: 'wf-001', name: 'Workflow A', active: true }),
      createWorkflowResponse({ id: 'wf-002', name: 'Workflow B', active: false }),
    ]),
    getWorkflow: record('getWorkflow', createWorkflowResponse({ id: 'wf-001' })),
    deployWorkflow: record('deployWorkflow', {
      id: 'wf-001',
      name: 'Test Workflow',
      active: true,
      nodeCount: 2,
      missingCredentials: [],
    }),
    activateWorkflow: record('activateWorkflow', undefined),
    deactivateWorkflow: record('deactivateWorkflow', undefined),
    deleteWorkflow: record('deleteWorkflow', undefined),
    listExecutions: record('listExecutions', {
      data: [{ id: 'exec-001', status: 'success', workflowId: 'wf-001' }],
      nextCursor: undefined,
    }),
    getExecutionDetail: record('getExecutionDetail', {
      id: 'exec-001',
      status: 'success',
      workflowId: 'wf-001',
    }),
    runWorkflow: record('runWorkflow', {
      id: 'exec-001',
      finished: true,
      mode: 'manual',
      startedAt: '2025-01-01T12:00:00.000Z',
      stoppedAt: '2025-01-01T12:00:01.000Z',
      status: 'success',
      workflowId: 'wf-001',
    }),
    listWorkflowRevisions: record('listWorkflowRevisions', [
      {
        id: 'revision-001',
        workflowId: 'wf-001',
        versionId: 'version-old',
        name: 'Test Workflow',
        active: false,
        workflow: createValidWorkflow(),
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        capturedAt: '2025-01-01T01:00:00.000Z',
        operation: 'update',
      },
    ]),
    restoreWorkflowRevision: record(
      'restoreWorkflowRevision',
      createWorkflowResponse({ id: 'wf-001', versionId: 'version-restored' })
    ),
  };
}

function makeRuntime(
  options: { withService?: boolean; state?: FakeServiceState } = {}
): AgentRuntime {
  const { withService = true, state } = options;
  const service = state ? makeWorkflowService(state) : makeWorkflowService({ calls: [] });
  return {
    agentId: 'agent-test',
    character: {
      name: 'Route Test Agent',
      settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ENTITY_ID },
    },
    routes: [...workflowRoutes, ...(workflowRoutePlugin.routes ?? [])],
    getSetting: (key: string) => (key === 'ELIZA_ADMIN_ENTITY_ID' ? OWNER_ENTITY_ID : null),
    // The WorkflowService key is "workflow" (WORKFLOW_SERVICE_TYPE).
    getService: (key: string) => (withService && key === 'workflow' ? service : null),
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

describe('plugin-workflow routes (real dispatch)', () => {
  // Workflow CRUD is canonical on the rawPath `/api/workflow/*` surface; node
  // validation and the legacy execution readers remain plugin-relative.

  test('POST /api/workflow/workflows consumes the dispatcher-attached JSON body', async () => {
    const state: FakeServiceState = { calls: [] };
    const base = await startServer(makeRuntime({ state }));
    const workflow = createValidWorkflow();

    const res = await postJson(base, '/api/workflow/workflows', { workflow });

    expect(res.status).toBe(200);
    expect((await res.json()) as { id: string }).toMatchObject({ id: 'wf-001' });
    const call = state.calls.find((candidate) => candidate.method === 'deployWorkflow');
    expect(call?.args).toEqual([workflow, OWNER_ENTITY_ID, { activate: undefined }]);
  });

  test('POST /api/workflow/workflows/:id/run mounts the manual execution route', async () => {
    const state: FakeServiceState = { calls: [] };
    const base = await startServer(makeRuntime({ state }));

    const res = await fetch(`${base}/api/workflow/workflows/wf-001/run`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect((await res.json()) as { execution: { id: string } }).toMatchObject({
      execution: { id: 'exec-001' },
    });
    const call = state.calls.find((candidate) => candidate.method === 'runWorkflow');
    expect(call?.args).toEqual([
      'wf-001',
      { mode: 'manual', throwOnError: false },
      OWNER_ENTITY_ID,
    ]);
  });

  test('GET /api/workflow/executions/:id mounts execution detail', async () => {
    const state: FakeServiceState = { calls: [] };
    const base = await startServer(makeRuntime({ state }));

    const res = await fetch(`${base}/api/workflow/executions/exec-001`);

    expect(res.status).toBe(200);
    expect((await res.json()) as { execution: { id: string } }).toMatchObject({
      execution: { id: 'exec-001' },
    });
    const call = state.calls.find((candidate) => candidate.method === 'getExecutionDetail');
    expect(call?.args).toEqual(['exec-001', OWNER_ENTITY_ID]);
  });

  test('GET revisions and POST restore mount the revision lifecycle routes', async () => {
    const state: FakeServiceState = { calls: [] };
    const base = await startServer(makeRuntime({ state }));

    const revisions = await fetch(`${base}/api/workflow/workflows/wf-001/revisions?limit=5`);
    expect(revisions.status).toBe(200);
    expect(
      (await revisions.json()) as { currentVersionId: string; revisions: unknown[] }
    ).toMatchObject({
      currentVersionId: 'v1',
      revisions: [{ versionId: 'version-old' }],
    });
    const listCall = state.calls.find((candidate) => candidate.method === 'listWorkflowRevisions');
    expect(listCall?.args).toEqual(['wf-001', 5, OWNER_ENTITY_ID]);

    const restore = await fetch(
      `${base}/api/workflow/workflows/wf-001/revisions/version-old/restore`,
      { method: 'POST' }
    );
    expect(restore.status).toBe(200);
    expect((await restore.json()) as { versionId: string }).toMatchObject({
      versionId: 'version-restored',
    });
    const restoreCall = state.calls.find(
      (candidate) => candidate.method === 'restoreWorkflowRevision'
    );
    expect(restoreCall?.args).toEqual(['wf-001', 'version-old', OWNER_ENTITY_ID]);
  });

  test('GET /executions lists executions and forwards query params', async () => {
    const state: FakeServiceState = { calls: [] };
    const base = await startServer(makeRuntime({ state }));

    const res = await fetch(`${base}/executions?workflowId=wf-001&status=success&limit=10`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: Array<{ id: string }>;
    };
    expect(body.success).toBe(true);
    expect(body.data[0].id).toBe('exec-001');

    const call = state.calls.find((c) => c.method === 'listExecutions');
    expect(call?.args[0]).toMatchObject({ workflowId: 'wf-001', status: 'success', limit: 10 });
    expect(call?.args[1]).toBe(OWNER_ENTITY_ID);
  });

  test('GET /executions/:id returns execution detail', async () => {
    const state: FakeServiceState = { calls: [] };
    const base = await startServer(makeRuntime({ state }));

    const res = await fetch(`${base}/executions/exec-001`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string } };
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('exec-001');

    const call = state.calls.find((c) => c.method === 'getExecutionDetail');
    expect(call?.args).toEqual(['exec-001', OWNER_ENTITY_ID]);
  });

  test('POST /workflows/validate runs the real validator without a service', async () => {
    // The validate handler never touches WorkflowService, so it must succeed
    // even when the service is unavailable.
    const base = await startServer(makeRuntime({ withService: false }));

    const valid = await postJson(base, '/workflows/validate', createValidWorkflow());
    expect(valid.status).toBe(200);
    expect((await valid.json()) as { valid: boolean }).toMatchObject({ valid: true });

    const invalid = await postJson(base, '/workflows/validate', {
      name: 'Empty',
      nodes: [],
      connections: {},
    });
    expect(invalid.status).toBe(200);
    const invalidBody = (await invalid.json()) as { valid: boolean; errors: string[] };
    expect(invalidBody.valid).toBe(false);
    expect(invalidBody.errors.length).toBeGreaterThan(0);

    // Missing the required `nodes` field → 400 from the real handler guard.
    const malformed = await postJson(base, '/workflows/validate', { connections: {} });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()) as { success: boolean }).toMatchObject({ success: false });
  });

  test('enforces the auth gate on the non-public workflow routes', async () => {
    // Every plugin-workflow route is auth-gated (none declare `public: true`),
    // so a denied authorization yields 401 before any handler runs.
    const base = await startServer(makeRuntime(), () => false);

    const list = await fetch(`${base}/executions`);
    expect(list.status).toBe(401);
    expect((await list.json()) as { error: string }).toMatchObject({ error: 'Unauthorized' });
  });

  test('returns 404 for an unknown route path', async () => {
    const base = await startServer(makeRuntime());

    const res = await fetch(`${base}/nonexistent-workflow-subroute`);
    expect(res.status).toBe(404);
  });
});
