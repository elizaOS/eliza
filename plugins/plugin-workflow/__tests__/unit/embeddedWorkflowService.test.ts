import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { IAgentRuntime } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/pglite';
import * as dbSchema from '../../src/db/schema';
import { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';
import { WorkflowService } from '../../src/services/workflow-service';

function runtime(
  settings: Record<string, unknown> = {},
  services: Record<string, unknown> = {},
  db?: unknown
) {
  const mockRuntime = {
    agentId: 'agent-test',
    character: { settings: {} },
    db,
    getSetting: (key: string) => settings[key] ?? null,
    getService: (type: string) => services[type] ?? null,
  } satisfies Partial<IAgentRuntime> & { db?: unknown };

  return mockRuntime as IAgentRuntime;
}

async function persistentRuntime(
  settings: Record<string, unknown> = {},
  services: Record<string, unknown> = {}
) {
  const dir = await mkdtemp(join(tmpdir(), 'embedded-workflow-service-'));
  const client = new PGlite({ dataDir: join(dir, 'pglite') });
  const db = drizzle(client, { schema: dbSchema });
  return {
    runtime: runtime(settings, services, db),
    async close() {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function firstRunJson(
  execution: { data?: { resultData?: { runData?: Record<string, unknown[]> } } },
  nodeName: string
): Record<string, unknown> | undefined {
  const run = execution.data?.resultData?.runData?.[nodeName]?.[0] as
    | { data?: { main?: Array<Array<{ json?: Record<string, unknown> }>> } }
    | undefined;
  return run?.data?.main?.[0]?.[0]?.json;
}

describe('EmbeddedWorkflowService', () => {
  test('rejects workflows with unregistered nodes before activation', async () => {
    const service = await EmbeddedWorkflowService.start(runtime());

    await expect(
      service.createWorkflow({
        name: 'Unsupported',
        nodes: [
          {
            id: 'unknown',
            name: 'Unknown',
            type: 'workflows-nodes-base.unknown',
            typeVersion: 1,
            position: [0, 0],
            parameters: {},
          },
        ],
        connections: {},
      })
    ).rejects.toThrow('Embedded workflow runtime does not support node');
  });

  test('WorkflowService uses the embedded backend without external runtime settings', async () => {
    const harness = await persistentRuntime({ WORKFLOW_BACKEND: 'embedded' });
    const embedded = await EmbeddedWorkflowService.start(harness.runtime);
    const serviceRuntime = runtime(
      { WORKFLOW_BACKEND: 'embedded' },
      { embedded_workflow_service: embedded },
      harness.runtime.db
    );
    const service = await WorkflowService.start(serviceRuntime);

    const workflows = await service.listWorkflows();
    expect(workflows).toEqual([]);

    await service.stop();
    await embedded.stop();
    await harness.close();
  }, 60_000);

  test('runs a schedule -> HTTP Request -> Set workflow in a child process', async () => {
    const pluginRoot = join(import.meta.dir, '../..');
    const script = `
      import { mkdtemp, rm } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { PGlite } from '@electric-sql/pglite';
      import { drizzle } from 'drizzle-orm/pglite';
      import { EmbeddedWorkflowService } from './src/services/embedded-workflow-service.ts';
      import * as dbSchema from './src/db/schema.ts';
      const dir = await mkdtemp(join(tmpdir(), 'embedded-workflows-child-'));
      const client = new PGlite({ dataDir: join(dir, 'pglite') });
      const db = drizzle(client, { schema: dbSchema });
      const runtime = { db, getSetting: () => null, getService: () => null };
      const service = await EmbeddedWorkflowService.start(runtime);
      try {
        globalThis.fetch = async (url, options) =>
          new Response(JSON.stringify({ ok: true, url: String(url), method: options?.method ?? 'GET' }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
          });
        const created = await service.createWorkflow({
          name: 'P0 smoke',
          nodes: [
            { id: 'schedule', name: 'Schedule Trigger', type: 'workflows-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0], parameters: {} },
            { id: 'http', name: 'HTTP Request', type: 'workflows-nodes-base.httpRequest', typeVersion: 4.2, position: [200, 0], parameters: { url: 'https://example.test/ping', method: 'GET' } },
            { id: 'set', name: 'Set', type: 'workflows-nodes-base.set', typeVersion: 3.4, position: [400, 0], parameters: { assignments: { assignments: [{ name: 'source', value: 'embedded' }] } } },
          ],
          connections: {
            'Schedule Trigger': { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] },
            'HTTP Request': { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
          },
        });
        const execution = await service.executeWorkflow(created.id);
        const item = execution.data?.resultData?.runData?.Set?.[0]?.data?.main?.[0]?.[0]?.json;
        if (execution.status !== 'success') throw new Error('Expected successful embedded execution');
        if (item?.source !== 'embedded') throw new Error('Expected Set node to add source');
        if (item?.body?.ok !== true) throw new Error('Expected HTTP response body to be preserved');
        console.log('RESULT:' + JSON.stringify({ status: execution.status, item }));
      } finally {
        await service.stop();
        await client.close();
        await rm(dir, { recursive: true, force: true });
      }
    `;

    const proc = Bun.spawn([process.execPath, '-e', script], {
      cwd: pluginRoot,
      env: { ...process.env, WORKFLOW_DIAGNOSTICS_ENABLED: 'false' },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    expect(stderr).not.toContain('HTTP Request node requires');
    expect(exitCode).toBe(0);
  }, 60_000);

  test('persists workflows across embedded service restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'embedded-workflows-persist-'));
    const dataDir = join(dir, 'pglite');
    const firstClient = new PGlite({ dataDir });
    const firstDb = drizzle(firstClient, { schema: dbSchema });
    const first = await EmbeddedWorkflowService.start(runtime({}, {}, firstDb));
    const created = await first.createWorkflow({
      name: 'Persistent workflow',
      nodes: [
        {
          id: 'manual',
          name: 'Manual Trigger',
          type: 'workflows-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
      ],
      connections: {},
    });
    await first.stop();
    await firstClient.close();

    const secondClient = new PGlite({ dataDir });
    const secondDb = drizzle(secondClient, { schema: dbSchema });
    const second = await EmbeddedWorkflowService.start(runtime({}, {}, secondDb));
    const loaded = await second.getWorkflow(created.id);

    expect(loaded.name).toBe('Persistent workflow');
    expect(loaded.id).toBe(created.id);

    await second.stop();
    await secondClient.close();
    await rm(dir, { recursive: true, force: true });
  }, 60_000);

  test('runs Code node in the QuickJS sandbox', async () => {
    const harness = await persistentRuntime();
    const service = await EmbeddedWorkflowService.start(harness.runtime);
    try {
      const created = await service.createWorkflow({
        name: 'QuickJS code',
        nodes: [
          {
            id: 'manual',
            name: 'Manual Trigger',
            type: 'workflows-nodes-base.manualTrigger',
            typeVersion: 1,
            position: [0, 0],
            parameters: {},
          },
          {
            id: 'code',
            name: 'Code',
            type: 'workflows-nodes-base.code',
            typeVersion: 2,
            position: [200, 0],
            parameters: {
              jsCode:
                'return items.map((item) => ({ json: { ok: true, trigger: item.json.trigger } }));',
            },
          },
        ],
        connections: {
          'Manual Trigger': { main: [[{ node: 'Code', type: 'main', index: 0 }]] },
        },
      });
      const execution = await service.executeWorkflow(created.id);
      const item = firstRunJson(execution, 'Code');

      expect(execution.status).toBe('success');
      expect(item?.ok).toBe(true);
      expect(item?.trigger).toBe('manual');
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 60_000);

  test('executes active embedded webhooks through the plugin service', async () => {
    const harness = await persistentRuntime();
    const service = await EmbeddedWorkflowService.start(harness.runtime);
    try {
      const created = await service.createWorkflow({
        name: 'Webhook workflow',
        nodes: [
          {
            id: 'webhook',
            name: 'Webhook',
            type: 'workflows-nodes-base.webhook',
            typeVersion: 2,
            position: [0, 0],
            parameters: { path: 'incoming', httpMethod: 'POST' },
          },
          {
            id: 'set',
            name: 'Set',
            type: 'workflows-nodes-base.set',
            typeVersion: 3.4,
            position: [200, 0],
            parameters: { assignments: { assignments: [{ name: 'handled', value: true }] } },
          },
        ],
        connections: {
          Webhook: { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
        },
      });
      await service.activateWorkflow(created.id);
      const execution = await service.executeWebhook('incoming', { payload: 'ok' }, 'POST');
      const item = firstRunJson(execution, 'Set');

      expect(execution.status).toBe('success');
      expect(item?.payload).toBe('ok');
      expect(item?.handled).toBe(true);
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 60_000);
});
