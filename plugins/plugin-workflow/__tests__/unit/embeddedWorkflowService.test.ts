/** Unit tests for EmbeddedWorkflowService CRUD and persistence against a real PGlite-backed Drizzle store. */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { IAgentRuntime } from '@elizaos/core';
import { eq } from 'drizzle-orm';
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
    runtime: runtime({ WORKFLOW_SEED_DEFAULTS: false, ...settings }, services, db),
    async close() {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A seeding harness with the pieces the default-workflow seed needs: a
 * persistent PGlite DB that survives service restarts, an in-memory task queue
 * (so `armSchedules` has `createTask`/`getTasks`/`deleteTask`), and a
 * persistent in-memory cache backing `getCache`/`setCache` so the once-per
 * install seed marker survives a restart. `restart()` starts a fresh service
 * against the SAME db + cache, simulating a process reboot.
 */
async function seedingHarness(settings: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'embedded-workflow-seed-'));
  const client = new PGlite({ dataDir: join(dir, 'pglite') });
  const db = drizzle(client, { schema: dbSchema });
  const tasks: Array<Record<string, unknown>> = [];
  const cache = new Map<string, unknown>();
  const reports: Array<{ scope: string; error: unknown; context?: Record<string, unknown> }> = [];
  const settingsMap: Record<string, unknown> = {
    WORKFLOW_SEED_DEFAULTS: true,
    ...settings,
  };
  // When true, the next getCache/setCache call throws to simulate a transient
  // cache outage (used to prove the fail-closed no-zombie-re-seed guarantee).
  const control = {
    failNextCacheRead: false,
    failCacheWrite: false,
    cacheWriteReturnsFalse: false,
    failPriorDeletionCheck: false,
  };
  const runtimeDb = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'select') return Reflect.get(target, prop, receiver);
      return (...args: unknown[]) => {
        const builder = Reflect.apply(target.select, target, args);
        return new Proxy(builder, {
          get(selectTarget, selectProp, selectReceiver) {
            if (selectProp !== 'from') {
              return Reflect.get(selectTarget, selectProp, selectReceiver);
            }
            return (table: unknown) => {
              if (control.failPriorDeletionCheck && table === dbSchema.workflowRevisions) {
                throw new Error('workflow revision query unavailable');
              }
              return Reflect.apply(selectTarget.from, selectTarget, [table]);
            };
          },
        });
      };
    },
  });
  let taskSeq = 0;
  const buildRuntime = () =>
    ({
      agentId: 'agent-test',
      character: { settings: {} },
      db: runtimeDb,
      getSetting: (key: string) => settingsMap[key] ?? null,
      getService: () => null,
      reportError: (scope: string, error: unknown, context?: Record<string, unknown>) => {
        reports.push({ scope, error, context });
      },
      createTask: async (task: Record<string, unknown>) => {
        taskSeq += 1;
        tasks.push({ id: `task-${taskSeq}`, ...task });
      },
      getTasks: async () => tasks,
      deleteTask: async (id: string) => {
        const index = tasks.findIndex((task) => task.id === id);
        if (index >= 0) tasks.splice(index, 1);
      },
      getCache: async <T>(key: string): Promise<T | undefined> => {
        if (control.failNextCacheRead) {
          throw new Error('cache unavailable');
        }
        return cache.has(key) ? (cache.get(key) as T) : undefined;
      },
      setCache: async <T>(key: string, value: T): Promise<boolean> => {
        if (control.failCacheWrite) {
          throw new Error('cache write unavailable');
        }
        // Simulate a cache backend that reports a non-persisted write via its
        // boolean return rather than by throwing.
        if (control.cacheWriteReturnsFalse) {
          return false;
        }
        cache.set(key, value);
        return true;
      },
    }) as unknown as IAgentRuntime;

  return {
    tasks,
    cache,
    control,
    reports,
    setSetting(key: string, value: unknown) {
      settingsMap[key] = value;
    },
    async start() {
      return EmbeddedWorkflowService.start(buildRuntime());
    },
    async listDefaultRows() {
      return db
        .select({ id: dbSchema.embeddedWorkflows.id })
        .from(dbSchema.embeddedWorkflows)
        .where(eq(dbSchema.embeddedWorkflows.id, DEFAULT_WORKFLOW_ID));
    },
    async close() {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const DEFAULT_WORKFLOW_ID = 'system-device-health-check';
const SEED_MARKER_KEY = 'eliza:workflow:seeded-defaults:v1';

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

  test('seeds and runs the no-LLM device health check workflow by default', async () => {
    const tasks: Array<Record<string, unknown>> = [];
    const harness = await persistentRuntime({ WORKFLOW_SEED_DEFAULTS: true });
    const runtimeWithTasks = {
      ...harness.runtime,
      agentId: 'agent-test',
      createTask: async (task: Record<string, unknown>) => {
        tasks.push({ id: `task-${tasks.length + 1}`, ...task });
      },
      getTasks: async () => tasks,
      deleteTask: async (id: string) => {
        const index = tasks.findIndex((task) => task.id === id);
        if (index >= 0) tasks.splice(index, 1);
      },
    } as unknown as IAgentRuntime;

    const service = await EmbeddedWorkflowService.start(runtimeWithTasks);
    try {
      const workflows = await service.listWorkflows();
      const healthCheck = workflows.data.find(
        (workflow) => workflow.id === 'system-device-health-check'
      );
      expect(healthCheck?.active).toBe(true);
      expect(healthCheck?.nodes.map((node) => node.type)).toContain(
        'workflows-nodes-base.deviceStatus'
      );
      expect(tasks).toHaveLength(1);
      expect((tasks[0].metadata as { workflowId?: string }).workflowId).toBe(
        'system-device-health-check'
      );

      const executions = await service.listExecutions({
        workflowId: 'system-device-health-check',
        limit: 1,
      });
      expect(executions.data).toHaveLength(1);
      expect(executions.data[0].status).toBe('success');
      const item =
        executions.data[0].data?.resultData?.runData?.['Device Status']?.[0]?.data?.main?.[0]?.[0]
          ?.json;
      expect(item?.memory).toMatchObject({
        totalBytes: expect.any(Number),
        freeBytes: expect.any(Number),
      });
      expect(item?.disk).toMatchObject({
        mount: '/',
        availableBytes: expect.any(Number),
      });
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 90_000);

  test('seeds exactly one default workflow on first run and records the marker', async () => {
    const harness = await seedingHarness();
    const service = await harness.start();
    try {
      const workflows = await service.listWorkflows();
      const defaults = workflows.data.filter((w) => w.id === DEFAULT_WORKFLOW_ID);
      // Exactly one default, and it is the only workflow present on a fresh install.
      expect(defaults).toHaveLength(1);
      expect(workflows.data).toHaveLength(1);
      expect(defaults[0].active).toBe(true);
      // Routed through the ONE scheduler: a single TRIGGER_DISPATCH core Task.
      expect(harness.tasks).toHaveLength(1);
      expect((harness.tasks[0].metadata as { workflowId?: string }).workflowId).toBe(
        DEFAULT_WORKFLOW_ID
      );
      // Once-per-install marker was recorded.
      expect(harness.cache.get(SEED_MARKER_KEY)).toMatchObject({
        workflowId: DEFAULT_WORKFLOW_ID,
        seededAt: expect.any(String),
      });
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 90_000);

  test('is idempotent across restarts — never re-seeds a second default', async () => {
    const harness = await seedingHarness();
    const first = await harness.start();
    await first.stop();

    // Reboot against the same db + cache. The marker + existing row must both
    // suppress a second seed.
    const second = await harness.start();
    try {
      const workflows = await second.listWorkflows();
      expect(workflows.data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)).toHaveLength(1);
      expect(workflows.data).toHaveLength(1);
    } finally {
      await second.stop();
      await harness.close();
    }
  }, 90_000);

  test('respects a user deletion — no zombie re-seed after restart', async () => {
    const harness = await seedingHarness();
    const first = await harness.start();
    // Simulate the user deleting the seeded default.
    await first.deleteWorkflow(DEFAULT_WORKFLOW_ID);
    let afterDelete = await first.listWorkflows();
    expect(afterDelete.data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)).toHaveLength(0);
    await first.stop();

    // Reboot: the persistent marker must stop the deleted default from coming back.
    const second = await harness.start();
    try {
      afterDelete = await second.listWorkflows();
      expect(afterDelete.data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)).toHaveLength(0);
    } finally {
      await second.stop();
      await harness.close();
    }
  }, 90_000);

  test('fails closed on a cache-read outage — a deleted default is not resurrected', async () => {
    const harness = await seedingHarness();
    const first = await harness.start();
    await first.deleteWorkflow(DEFAULT_WORKFLOW_ID);
    await first.stop();

    // The marker persists in the cache, but the cache read throws on this boot.
    // We must NOT fall back to the row check and re-seed the deleted default.
    harness.control.failNextCacheRead = true;
    const second = await harness.start();
    try {
      const workflows = await second.listWorkflows();
      expect(workflows.data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)).toHaveLength(0);
    } finally {
      await second.stop();
      await harness.close();
    }
  }, 90_000);

  test('aborts seeding when the marker cannot be persisted — no orphan default', async () => {
    const harness = await seedingHarness();
    // The marker write fails on first boot: seeding must abort with NO row
    // inserted, so there is never an active default that lacks its marker.
    harness.control.failCacheWrite = true;
    const first = await harness.start();
    let workflows = await first.listWorkflows();
    expect(workflows.data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)).toHaveLength(0);
    expect(harness.tasks).toHaveLength(0);
    expect(harness.cache.get(SEED_MARKER_KEY)).toBeUndefined();
    await first.stop();

    // Cache recovers on the next boot: seeding retries cleanly and records the
    // marker exactly once.
    harness.control.failCacheWrite = false;
    const second = await harness.start();
    try {
      workflows = await second.listWorkflows();
      expect(workflows.data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)).toHaveLength(1);
      expect(harness.cache.get(SEED_MARKER_KEY)).toMatchObject({
        workflowId: DEFAULT_WORKFLOW_ID,
      });
    } finally {
      await second.stop();
      await harness.close();
    }
  }, 90_000);

  test('treats a false setCache result as a failed marker write — no orphan default', async () => {
    const harness = await seedingHarness();
    // The cache reports the marker write as not-persisted (returns false).
    // Seeding must roll the row back, leaving neither row nor marker.
    harness.control.cacheWriteReturnsFalse = true;
    const first = await harness.start();
    let workflows = await first.listWorkflows();
    expect(workflows.data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)).toHaveLength(0);
    expect(harness.cache.get(SEED_MARKER_KEY)).toBeUndefined();
    await first.stop();

    // Cache recovers: seeding retries and completes exactly once.
    harness.control.cacheWriteReturnsFalse = false;
    const second = await harness.start();
    try {
      workflows = await second.listWorkflows();
      expect(workflows.data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)).toHaveLength(1);
      expect(harness.cache.get(SEED_MARKER_KEY)).toMatchObject({
        workflowId: DEFAULT_WORKFLOW_ID,
      });
    } finally {
      await second.stop();
      await harness.close();
    }
  }, 90_000);

  test('backfills the seed marker for a pre-marker existing default row', async () => {
    // Simulate an install upgraded from the old row-existence-only seeding:
    // seed once while pretending the cache has no setCache (so no marker is
    // written), then reboot with a healthy cache and confirm the marker is
    // backfilled without duplicating or re-seeding the row.
    const harness = await seedingHarness();
    // First boot writes the row but the marker write reports not-persisted, so
    // the row exists with NO marker — the pre-marker upgrade state. We use the
    // false-return path and then keep the row by writing it directly is complex;
    // instead seed normally, then clear the marker to emulate the upgrade.
    const first = await harness.start();
    expect(
      (await first.listWorkflows()).data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)
    ).toHaveLength(1);
    await first.stop();
    // Emulate a pre-marker upgrade: the row exists but the marker is absent.
    harness.cache.delete(SEED_MARKER_KEY);
    expect(harness.cache.get(SEED_MARKER_KEY)).toBeUndefined();

    const second = await harness.start();
    try {
      // Row is untouched (not duplicated, not re-seeded) and the marker is back.
      expect(
        (await second.listWorkflows()).data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)
      ).toHaveLength(1);
      expect(harness.cache.get(SEED_MARKER_KEY)).toMatchObject({
        workflowId: DEFAULT_WORKFLOW_ID,
      });
    } finally {
      await second.stop();
      await harness.close();
    }
  }, 90_000);

  test('does not seed the default into an existing non-default workflow store', async () => {
    const harness = await seedingHarness({ WORKFLOW_SEED_DEFAULTS: false });
    const first = await harness.start();
    await first.createWorkflow({
      id: 'user-nightly-summary',
      name: 'User nightly summary',
      active: false,
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
    harness.setSetting('WORKFLOW_SEED_DEFAULTS', true);

    const second = await harness.start();
    try {
      const workflows = await second.listWorkflows();
      expect(workflows.data.map((workflow) => workflow.id)).toEqual(['user-nightly-summary']);
      expect(workflows.data.filter((workflow) => workflow.id === DEFAULT_WORKFLOW_ID)).toHaveLength(
        0
      );
      expect(harness.tasks).toHaveLength(0);
      expect(harness.cache.get(SEED_MARKER_KEY)).toMatchObject({
        workflowId: DEFAULT_WORKFLOW_ID,
      });
    } finally {
      await second.stop();
      await harness.close();
    }
  }, 90_000);

  test('preserves a pre-marker deletion via the delete revision on upgrade', async () => {
    // Simulate an install upgraded from a pre-marker build where the user had
    // ALREADY deleted the default: seed, delete (leaving a `delete` revision),
    // then clear the marker to emulate the pre-marker era. On reboot, neither a
    // marker nor a row exists, but the delete revision must stop a re-seed.
    const harness = await seedingHarness();
    const first = await harness.start();
    await first.deleteWorkflow(DEFAULT_WORKFLOW_ID);
    await first.stop();
    harness.cache.delete(SEED_MARKER_KEY);
    expect(harness.cache.get(SEED_MARKER_KEY)).toBeUndefined();

    const second = await harness.start();
    try {
      const workflows = await second.listWorkflows();
      expect(workflows.data.filter((w) => w.id === DEFAULT_WORKFLOW_ID)).toHaveLength(0);
      // The marker is backfilled so subsequent boots skip the revision query.
      expect(harness.cache.get(SEED_MARKER_KEY)).toMatchObject({
        workflowId: DEFAULT_WORKFLOW_ID,
      });
    } finally {
      await second.stop();
      await harness.close();
    }
  }, 90_000);

  test('fails closed when the prior default deletion check fails', async () => {
    const harness = await seedingHarness({ WORKFLOW_SEED_DEFAULTS: false });
    const first = await harness.start();
    await first.createWorkflow({
      id: DEFAULT_WORKFLOW_ID,
      name: 'Pre-marker default',
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
    await first.deleteWorkflow(DEFAULT_WORKFLOW_ID);
    await first.stop();
    harness.setSetting('WORKFLOW_SEED_DEFAULTS', true);
    harness.control.failPriorDeletionCheck = true;

    try {
      await expect(harness.start()).rejects.toMatchObject({
        code: 'WORKFLOW_DEFAULT_SEED_DELETION_CHECK_FAILED',
        context: { workflowId: DEFAULT_WORKFLOW_ID },
      });
      expect(await harness.listDefaultRows()).toHaveLength(0);
      expect(harness.tasks).toHaveLength(0);
      expect(harness.reports).toHaveLength(1);
      expect(harness.reports[0]).toMatchObject({
        scope: 'EmbeddedWorkflowService.seedDefaultWorkflows',
        context: { workflowId: DEFAULT_WORKFLOW_ID },
      });
    } finally {
      await harness.close();
    }
  }, 90_000);

  test('WORKFLOW_SEED_DEFAULTS=false disables seeding entirely', async () => {
    const harness = await seedingHarness({ WORKFLOW_SEED_DEFAULTS: false });
    const service = await harness.start();
    try {
      const workflows = await service.listWorkflows();
      expect(workflows.data).toHaveLength(0);
      expect(harness.cache.get(SEED_MARKER_KEY)).toBeUndefined();
    } finally {
      await service.stop();
      await harness.close();
    }
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

  test('captures workflow revisions and restores a previous version', async () => {
    const harness = await persistentRuntime();
    const service = await EmbeddedWorkflowService.start(harness.runtime);
    try {
      const created = await service.createWorkflow({
        name: 'Revision base',
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
      const updated = await service.updateWorkflow(created.id, {
        ...created,
        name: 'Revision updated',
        nodes: [
          ...(created.nodes ?? []),
          {
            id: 'set',
            name: 'Set',
            type: 'workflows-nodes-base.set',
            typeVersion: 3.4,
            position: [200, 0],
            parameters: {
              assignments: { assignments: [{ name: 'restored', value: false }] },
            },
          },
        ],
        connections: {
          'Manual Trigger': { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
        },
      });

      const beforeRestore = await service.listWorkflowRevisions(created.id);
      expect(beforeRestore.data).toHaveLength(1);
      expect(beforeRestore.data[0].name).toBe('Revision base');
      expect(beforeRestore.data[0].versionId).toBe(created.versionId);
      expect(beforeRestore.data[0].operation).toBe('update');

      const restored = await service.restoreWorkflowRevision(created.id, created.versionId);
      expect(restored.name).toBe('Revision base');
      expect(restored.nodes.map((node) => node.name)).toEqual(['Manual Trigger']);
      expect(restored.versionId).not.toBe(created.versionId);
      expect(restored.versionId).not.toBe(updated.versionId);

      const afterRestore = await service.listWorkflowRevisions(created.id);
      expect(afterRestore.data[0].name).toBe('Revision updated');
      expect(afterRestore.data[0].operation).toBe('restore');
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 60_000);

  test('runs Code node in the QuickJS sandbox', async () => {
    const pluginRoot = join(import.meta.dir, '../..');
    const resultDir = await mkdtemp(join(tmpdir(), 'embedded-workflows-code-result-'));
    const resultPath = join(resultDir, 'result.json');
    const script = `
      import { mkdtemp, rm, writeFile } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { PGlite } from '@electric-sql/pglite';
      import { drizzle } from 'drizzle-orm/pglite';
      import { EmbeddedWorkflowService } from './src/services/embedded-workflow-service.ts';
      import * as dbSchema from './src/db/schema.ts';
      const dir = await mkdtemp(join(tmpdir(), 'embedded-workflows-code-'));
      const client = new PGlite({ dataDir: join(dir, 'pglite') });
      const db = drizzle(client, { schema: dbSchema });
      const runtime = { agentId: 'agent-test', character: { settings: {} }, db, getSetting: () => null, getService: () => null };
      const service = await EmbeddedWorkflowService.start(runtime);
      try {
        const created = await service.createWorkflow({
          name: 'QuickJS code',
          nodes: [
            { id: 'manual', name: 'Manual Trigger', type: 'workflows-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
            { id: 'code', name: 'Code', type: 'workflows-nodes-base.code', typeVersion: 2, position: [200, 0], parameters: { jsCode: 'return items.map((item) => ({ json: { ok: true, trigger: item.json.trigger } }));' } },
          ],
          connections: {
            'Manual Trigger': { main: [[{ node: 'Code', type: 'main', index: 0 }]] },
          },
        });
        const execution = await service.executeWorkflow(created.id);
        const item = execution.data?.resultData?.runData?.Code?.[0]?.data?.main?.[0]?.[0]?.json;
        if (execution.status !== 'success') throw new Error('Expected successful Code execution');
        if (item?.ok !== true) throw new Error('Expected Code node to set ok=true');
        if (item?.trigger !== 'manual') throw new Error('Expected manual trigger data to reach Code node');
        await writeFile(process.env.WORKFLOW_CODE_RESULT_PATH, JSON.stringify({ status: execution.status, item }));
      } finally {
        await service.stop();
        await client.close();
        await rm(dir, { recursive: true, force: true });
      }
    `;

    try {
      const proc = Bun.spawn([process.execPath, '-e', script], {
        cwd: pluginRoot,
        env: {
          ...process.env,
          WORKFLOW_CODE_RESULT_PATH: resultPath,
          WORKFLOW_DIAGNOSTICS_ENABLED: 'false',
        },
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      const result = JSON.parse(await readFile(resultPath, 'utf8')) as {
        status?: string;
        item?: { ok?: boolean; trigger?: string };
      };
      expect(result.status).toBe('success');
      expect(result.item?.ok).toBe(true);
      expect(result.item?.trigger).toBe('manual');
    } finally {
      await rm(resultDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('returns persisted error executions for non-throwing planning failures', async () => {
    const harness = await persistentRuntime();
    const service = await EmbeddedWorkflowService.start(harness.runtime);
    try {
      const created = await service.createWorkflow({
        name: 'Cyclic graph',
        nodes: [
          {
            id: 'set-a',
            name: 'Set A',
            type: 'workflows-nodes-base.set',
            typeVersion: 3.4,
            position: [0, 0],
            parameters: { assignments: { assignments: [{ name: 'a', value: true }] } },
          },
          {
            id: 'set-b',
            name: 'Set B',
            type: 'workflows-nodes-base.set',
            typeVersion: 3.4,
            position: [200, 0],
            parameters: { assignments: { assignments: [{ name: 'b', value: true }] } },
          },
        ],
        connections: {
          'Set A': { main: [[{ node: 'Set B', type: 'main', index: 0 }]] },
          'Set B': { main: [[{ node: 'Set A', type: 'main', index: 0 }]] },
        },
      });

      const execution = await service.executeWorkflow(created.id, { throwOnError: false });
      const persisted = await service.getExecution(execution.id);

      expect(execution.status).toBe('error');
      expect(execution.finished).toBe(true);
      expect(execution.data?.resultData?.error?.message).toContain(
        'Unable to resolve workflow execution order'
      );
      expect(persisted.status).toBe('error');
      expect(persisted.data?.resultData?.error?.message).toContain(
        'Unable to resolve workflow execution order'
      );
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 60_000);

  test('persists node execution through Smithers step storage', async () => {
    const pluginRoot = join(import.meta.dir, '../..');
    const resultDir = await mkdtemp(join(tmpdir(), 'embedded-workflows-smithers-result-'));
    const resultPath = join(resultDir, 'result.json');
    const script = `
      import { Database } from 'bun:sqlite';
      import { mkdtemp, rm, writeFile } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { PGlite } from '@electric-sql/pglite';
      import { drizzle } from 'drizzle-orm/pglite';
      import { EmbeddedWorkflowService } from './src/services/embedded-workflow-service.ts';
      import * as dbSchema from './src/db/schema.ts';
      const dir = await mkdtemp(join(tmpdir(), 'embedded-workflows-smithers-'));
      const client = new PGlite({ dataDir: join(dir, 'pglite') });
      const db = drizzle(client, { schema: dbSchema });
      const runtime = { agentId: 'agent-test', character: { settings: {} }, db, getSetting: () => null, getService: () => null };
      const service = await EmbeddedWorkflowService.start(runtime);
      let smithersDbPath = null;
      try {
        const created = await service.createWorkflow({
          name: 'Smithers persistence',
          nodes: [
            { id: 'manual', name: 'Manual Trigger', type: 'workflows-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
            { id: 'set', name: 'Set', type: 'workflows-nodes-base.set', typeVersion: 3.4, position: [200, 0], parameters: { assignments: { assignments: [{ name: 'smithersRecorded', value: true }] } } },
          ],
          connections: {
            'Manual Trigger': { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
          },
        });

        const execution = await service.executeWorkflow(created.id);
        const item = execution.data?.resultData?.runData?.Set?.[0]?.data?.main?.[0]?.[0]?.json;
        const engine = execution.data?.resultData?.engine;
        smithersDbPath = join(process.cwd(), '.eliza', 'smithers', created.id + '.sqlite');
        const smithersDb = new Database(smithersDbPath, { readonly: true });
        try {
          const tables = smithersDb
            .query("select name from sqlite_master where type = 'table' and name like 'smithers_%' order by name")
            .all()
            .map((row) => row.name);
          const persistedSetRows = smithersDb
            .query('select payload from smithers_0001_set where node_id = ? order by iteration')
            .all('0001-set');
          await writeFile(
            process.env.WORKFLOW_SMITHERS_RESULT_PATH,
            JSON.stringify({
              status: execution.status,
              item,
              engine,
              tables,
              persistedSetRowsLength: persistedSetRows.length,
            })
          );
        } finally {
          smithersDb.close();
        }
      } finally {
        await service.stop();
        await client.close();
        await rm(dir, { recursive: true, force: true });
        if (smithersDbPath) {
          await Promise.all([
            rm(smithersDbPath, { force: true }),
            rm(smithersDbPath + '-wal', { force: true }),
            rm(smithersDbPath + '-shm', { force: true }),
          ]);
        }
      }
    `;
    try {
      const proc = Bun.spawn([process.execPath, '-e', script], {
        cwd: pluginRoot,
        env: {
          ...process.env,
          WORKFLOW_SMITHERS_RESULT_PATH: resultPath,
          WORKFLOW_DIAGNOSTICS_ENABLED: 'false',
        },
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      const result = JSON.parse(await readFile(resultPath, 'utf8')) as {
        status?: string;
        item?: { smithersRecorded?: boolean };
        engine?: { provider?: string; nodes?: number; levels?: number; maxConcurrency?: number };
        tables?: string[];
        persistedSetRowsLength?: number;
      };
      expect(result.status).toBe('success');
      expect(result.item?.smithersRecorded).toBe(true);
      expect(result.engine).toMatchObject({
        provider: 'smithers',
        nodes: 2,
        levels: 2,
        maxConcurrency: 1,
      });
      expect(result.tables).toContain('smithers_0000_manual');
      expect(result.tables).toContain('smithers_0001_set');
      expect(result.tables).toContain('smithers_eliza_workflow_result');
      expect(result.persistedSetRowsLength).toBe(1);
    } finally {
      await rm(resultDir, { recursive: true, force: true });
    }
  }, 60_000);

  test('executes active embedded webhooks through the plugin service', async () => {
    const pluginRoot = join(import.meta.dir, '../..');
    const resultDir = await mkdtemp(join(tmpdir(), 'embedded-workflows-webhook-result-'));
    const resultPath = join(resultDir, 'result.json');
    const script = `
      import { mkdtemp, rm, writeFile } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { PGlite } from '@electric-sql/pglite';
      import { drizzle } from 'drizzle-orm/pglite';
      import { EmbeddedWorkflowService } from './src/services/embedded-workflow-service.ts';
      import * as dbSchema from './src/db/schema.ts';
      const dir = await mkdtemp(join(tmpdir(), 'embedded-workflows-webhook-'));
      const client = new PGlite({ dataDir: join(dir, 'pglite') });
      const db = drizzle(client, { schema: dbSchema });
      const runtime = { agentId: 'agent-test', character: { settings: {} }, db, getSetting: () => null, getService: () => null };
      const service = await EmbeddedWorkflowService.start(runtime);
      try {
        const created = await service.createWorkflow({
          name: 'Webhook workflow',
          nodes: [
            { id: 'webhook', name: 'Webhook', type: 'workflows-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: 'incoming', httpMethod: 'POST' } },
            { id: 'set', name: 'Set', type: 'workflows-nodes-base.set', typeVersion: 3.4, position: [200, 0], parameters: { assignments: { assignments: [{ name: 'handled', value: true }] } } },
          ],
          connections: {
            Webhook: { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
          },
        });
        await service.activateWorkflow(created.id);
        const execution = await service.executeWebhook('incoming', { payload: 'ok' }, 'POST');
        const item = execution.data?.resultData?.runData?.Set?.[0]?.data?.main?.[0]?.[0]?.json;
        await writeFile(process.env.WORKFLOW_WEBHOOK_RESULT_PATH, JSON.stringify({ status: execution.status, item }));
      } finally {
        await service.stop();
        await client.close();
        await rm(dir, { recursive: true, force: true });
      }
    `;
    try {
      const proc = Bun.spawn([process.execPath, '-e', script], {
        cwd: pluginRoot,
        env: {
          ...process.env,
          WORKFLOW_WEBHOOK_RESULT_PATH: resultPath,
          WORKFLOW_DIAGNOSTICS_ENABLED: 'false',
        },
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      const result = JSON.parse(await readFile(resultPath, 'utf8')) as {
        status?: string;
        item?: { payload?: string; handled?: boolean };
      };
      expect(result.status).toBe('success');
      expect(result.item?.payload).toBe('ok');
      expect(result.item?.handled).toBe(true);
    } finally {
      await rm(resultDir, { recursive: true, force: true });
    }
  }, 60_000);
});
