import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { IAgentRuntime } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/pglite';
import * as dbSchema from '../../src/db/schema';
import { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';

/**
 * n8n compatibility shim — verify upstream n8n workflow JSON loads + executes
 * without modification. The embedded engine's node lookup normalizes the
 * legacy `n8n-nodes-base.*` prefix to the internal `workflows-nodes-base.*`
 * registration key. Workflows authored against upstream n8n should work
 * as-is so users can drop in their existing libraries.
 */

function makeRuntime(db: unknown): IAgentRuntime {
  return {
    agentId: 'agent-n8n-compat',
    character: { settings: {} },
    db,
    getSetting: () => null,
    getService: () => null,
  } as unknown as IAgentRuntime;
}

async function withDb<T>(fn: (db: unknown) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'n8n-compat-shim-'));
  const client = new PGlite({ dataDir: join(dir, 'pglite') });
  const db = drizzle(client, { schema: dbSchema });
  try {
    return await fn(db);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe('n8n compatibility shim', () => {
  test('executes a workflow whose nodes use the upstream n8n-nodes-base.* prefix', async () => {
    await withDb(async (db) => {
      const runtime = makeRuntime(db);
      const service = await EmbeddedWorkflowService.start(runtime);

      // An n8n workflow as it would appear exported from upstream — every
      // `type` references the legacy `n8n-nodes-base.*` namespace.
      const upstreamWorkflow = {
        name: 'Hello from upstream n8n',
        active: false,
        nodes: [
          {
            id: 'trigger',
            name: 'When clicked',
            type: 'n8n-nodes-base.manualTrigger',
            typeVersion: 1,
            position: [100, 100] as [number, number],
            parameters: {},
          },
          {
            id: 'set',
            name: 'Set greeting',
            type: 'n8n-nodes-base.set',
            typeVersion: 3,
            position: [400, 100] as [number, number],
            parameters: {
              keepOnlySet: false,
              values: {
                string: [{ name: 'greeting', value: 'hello from n8n shim' }],
              },
              options: {},
            },
          },
        ],
        connections: {
          'When clicked': {
            main: [[{ node: 'Set greeting', type: 'main', index: 0 }]],
          },
        },
        settings: {},
      };

      const created = await service.createWorkflow(upstreamWorkflow);
      expect(created.id).toBeDefined();

      // The node-type strings on disk should be UNCHANGED — we only
      // normalize at lookup time, not at persistence.
      const reloaded = await service.getWorkflow(created.id);
      expect(reloaded?.nodes[0]?.type).toBe('n8n-nodes-base.manualTrigger');
      expect(reloaded?.nodes[1]?.type).toBe('n8n-nodes-base.set');

      // Execute and verify the Set node ran via the shim.
      const execution = await service.executeWorkflow(created.id, {
        mode: 'manual',
      });
      expect(execution.status).toBe('success');
      expect(execution.finished).toBe(true);

      const setRunData =
        execution.data?.resultData?.runData?.['Set greeting']?.[0] as
          | { data?: { main?: Array<Array<{ json: Record<string, unknown> }>> } }
          | undefined;
      const greeting = setRunData?.data?.main?.[0]?.[0]?.json?.greeting;
      expect(greeting).toBe('hello from n8n shim');

      await service.stop();
    });
  });

  test('reports node-type lookup misses with the original (unshimmed) name', async () => {
    await withDb(async (db) => {
      const runtime = makeRuntime(db);
      const service = await EmbeddedWorkflowService.start(runtime);

      const workflow = {
        name: 'Unsupported node',
        active: false,
        nodes: [
          {
            id: 'unknown',
            name: 'Unknown',
            type: 'n8n-nodes-base.thisDoesNotExist',
            typeVersion: 1,
            position: [0, 0] as [number, number],
            parameters: {},
          },
        ],
        connections: {},
        settings: {},
      };

      const created = await service.createWorkflow(workflow);
      const execution = await service.executeWorkflow(created.id, {
        mode: 'manual',
      });

      expect(execution.status === 'error' || execution.status === 'crashed').toBe(true);
      const message = execution.data?.resultData?.error?.message ?? '';
      expect(message).toMatch(/thisDoesNotExist/);

      await service.stop();
    });
  });
});
