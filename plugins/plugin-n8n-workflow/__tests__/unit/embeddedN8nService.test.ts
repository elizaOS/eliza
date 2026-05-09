import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { EmbeddedN8nService } from '../../src/services/embedded-n8n-service';
import { N8nWorkflowService } from '../../src/services/n8n-workflow-service';
import * as dbSchema from '../../src/db/schema';
import type { IAgentRuntime } from '@elizaos/core';

function runtime(
  settings: Record<string, unknown> = {},
  services: Record<string, unknown> = {},
  db?: unknown
) {
  return {
    agentId: 'agent-test',
    character: { settings: {} },
    db,
    getSetting: (key: string) => settings[key] ?? null,
    getService: (type: string) => services[type] ?? null,
  } as unknown as IAgentRuntime;
}

async function persistentRuntime(
  settings: Record<string, unknown> = {},
  services: Record<string, unknown> = {}
) {
  const dir = await mkdtemp(join(tmpdir(), 'embedded-n8n-service-'));
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

describe('EmbeddedN8nService', () => {
  test('rejects workflows with unregistered nodes before activation', async () => {
    const service = await EmbeddedN8nService.start(runtime());

    await expect(
      service.createWorkflow({
        name: 'Unsupported',
        nodes: [
          {
            id: 'unknown',
            name: 'Unknown',
            type: 'n8n-nodes-base.unknown',
            typeVersion: 1,
            position: [0, 0],
            parameters: {},
          },
        ],
        connections: {},
      })
    ).rejects.toThrow('Embedded n8n runtime does not support node');
  });

  test('N8nWorkflowService can select embedded backend without N8N_HOST or N8N_API_KEY', async () => {
    const harness = await persistentRuntime({ N8N_BACKEND: 'embedded' });
    const embedded = await EmbeddedN8nService.start(harness.runtime);
    const serviceRuntime = runtime(
      { N8N_BACKEND: 'embedded' },
      { n8n_embedded_workflow: embedded },
      harness.runtime.db
    );
    const service = await N8nWorkflowService.start(serviceRuntime);

    const workflows = await service.listWorkflows();
    expect(workflows).toEqual([]);

    await service.stop();
    await embedded.stop();
    await harness.close();
  });

  test('runs a schedule -> HTTP Request -> Set workflow in a child process', async () => {
    const script = `
      import { mkdtemp, rm } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { PGlite } from '@electric-sql/pglite';
      import { drizzle } from 'drizzle-orm/pglite';
      import { EmbeddedN8nService } from './src/services/embedded-n8n-service.ts';
      import * as dbSchema from './src/db/schema.ts';
      const dir = await mkdtemp(join(tmpdir(), 'embedded-n8n-child-'));
      const client = new PGlite({ dataDir: join(dir, 'pglite') });
      const db = drizzle(client, { schema: dbSchema });
      const runtime = { db, getSetting: () => null, getService: () => null };
      const service = await EmbeddedN8nService.start(runtime);
      try {
        globalThis.fetch = async (url, options) =>
          new Response(JSON.stringify({ ok: true, url: String(url), method: options?.method ?? 'GET' }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
          });
        const created = await service.createWorkflow({
          name: 'P0 smoke',
          nodes: [
            { id: 'schedule', name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0], parameters: {} },
            { id: 'http', name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [200, 0], parameters: { url: 'https://example.test/ping', method: 'GET' } },
            { id: 'set', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [400, 0], parameters: { assignments: { assignments: [{ name: 'source', value: 'embedded' }] } } },
          ],
          connections: {
            'Schedule Trigger': { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] },
            'HTTP Request': { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
          },
        });
        const execution = await service.executeWorkflow(created.id);
        const item = execution.data?.resultData?.runData?.Set?.[0]?.data?.main?.[0]?.[0]?.json;
        console.log('RESULT:' + JSON.stringify({ status: execution.status, item }));
      } finally {
        await service.stop();
        await client.close();
        await rm(dir, { recursive: true, force: true });
      }
      process.exit(0);
    `;

    const proc = Bun.spawn([process.execPath, '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, N8N_DIAGNOSTICS_ENABLED: 'false' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(stderr).not.toContain('HTTP Request node requires');
    expect(exitCode).toBe(0);

    const resultLine = stdout
      .split('\n')
      .find((line) => line.startsWith('RESULT:'));
    expect(resultLine).toBeDefined();
    const result = JSON.parse(resultLine!.slice('RESULT:'.length));
    expect(result.status).toBe('success');
    expect(result.item.source).toBe('embedded');
    expect(result.item.body.ok).toBe(true);
  }, 20_000);
});
