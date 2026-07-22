/**
 * Full AgentRuntime/PGlite regression for workflow-service dependency ordering.
 * Boots the production plugin with default seeding and the real service implementations.
 */
import { expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { AgentRuntime, createCharacter, stringToUuid } from '@elizaos/core';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { InMemoryDatabaseAdapter } from '../../../../packages/core/src/database/inMemoryAdapter.ts';
import * as dbSchema from '../../src/db/schema';
import { workflowPlugin } from '../../src/index';
import { workflowRoutePlugin } from '../../src/plugin-routes';
import {
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  EmbeddedWorkflowService,
} from '../../src/services/embedded-workflow-service';
import { WORKFLOW_SERVICE_TYPE, WorkflowService } from '../../src/services/workflow-service';

setDefaultTimeout(120_000);

const DEFAULT_WORKFLOW_ID = 'system-device-health-check';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readWorkflowStatus(runtime: AgentRuntime): Promise<Record<string, unknown>> {
  const route = workflowRoutePlugin.routes?.find(
    (candidate) => candidate.type === 'GET' && candidate.path === '/api/workflow/status'
  );
  if (!route?.handler) {
    throw new Error('Workflow status route is not registered');
  }
  const handler = route.handler;

  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res, runtime)).catch((error: unknown) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Workflow status test server did not bind a TCP port');
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/api/workflow/status`);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    if (!isRecord(body)) {
      throw new Error('Workflow status response was not a JSON object');
    }
    return body;
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

test('full plugin boot shares one embedded engine and exposes a runnable ready workflow service', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-service-startup-'));
  const client = new PGlite({ dataDir: join(dir, 'pglite') });
  const db = drizzle(client, { schema: dbSchema });
  const adapter = new InMemoryDatabaseAdapter();
  Reflect.set(adapter, 'db', db);
  const agentId = stringToUuid('workflow-service-startup-agent');
  const originalEmbeddedStart = EmbeddedWorkflowService.start;
  let embeddedStartCount = 0;
  // Holding the runtime-owned start open guarantees the sibling service sees
  // an in-flight dependency, while still executing the production start method.
  const embeddedStartSpy = spyOn(EmbeddedWorkflowService, 'start').mockImplementation(
    async (serviceRuntime) => {
      embeddedStartCount += 1;
      if (embeddedStartCount === 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      return originalEmbeddedStart(serviceRuntime);
    }
  );
  const runtime = Object.assign(
    new AgentRuntime({
      character: createCharacter({
        id: agentId,
        name: 'WorkflowServiceStartupAgent',
        settings: { WORKFLOW_SEED_DEFAULTS: 'true' },
      }),
      plugins: [workflowPlugin],
      adapter,
      logLevel: 'fatal',
      enableAutonomy: false,
    }),
    { serverless: true }
  );

  try {
    await runtime.initialize();

    const [embedded, workflow] = await Promise.all([
      runtime.getServiceLoadPromise(EMBEDDED_WORKFLOW_SERVICE_TYPE),
      runtime.getServiceLoadPromise(WORKFLOW_SERVICE_TYPE),
    ]);
    expect(embedded).toBeInstanceOf(EmbeddedWorkflowService);
    expect(workflow).toBeInstanceOf(WorkflowService);
    expect(embeddedStartCount).toBe(1);
    expect(runtime.getServicesByType(EMBEDDED_WORKFLOW_SERVICE_TYPE)).toHaveLength(1);
    expect(runtime.getServicesByType(WORKFLOW_SERVICE_TYPE)).toHaveLength(1);
    expect(runtime.getServiceRegistrationStatus(EMBEDDED_WORKFLOW_SERVICE_TYPE)).toBe('registered');
    expect(runtime.getServiceRegistrationStatus(WORKFLOW_SERVICE_TYPE)).toBe('registered');
    if (!(workflow instanceof WorkflowService)) {
      throw new Error('Runtime registered an incompatible workflow service');
    }

    const defaultRows = await db
      .select({ id: dbSchema.embeddedWorkflows.id })
      .from(dbSchema.embeddedWorkflows)
      .where(
        and(
          eq(dbSchema.embeddedWorkflows.agentId, agentId),
          eq(dbSchema.embeddedWorkflows.id, DEFAULT_WORKFLOW_ID)
        )
      );
    expect(defaultRows).toEqual([{ id: DEFAULT_WORKFLOW_ID }]);

    const execution = await workflow.runWorkflow(DEFAULT_WORKFLOW_ID, {
      mode: 'manual',
      throwOnError: true,
    });
    expect(execution).toMatchObject({
      workflowId: DEFAULT_WORKFLOW_ID,
      status: 'success',
      finished: true,
    });

    const status = await readWorkflowStatus(runtime);
    expect(status).toMatchObject({
      mode: 'local',
      host: 'in-process',
      status: 'ready',
      localEnabled: true,
      errorMessage: null,
    });
  } finally {
    embeddedStartSpy.mockRestore();
    await runtime.stop();
    await runtime.close();
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
