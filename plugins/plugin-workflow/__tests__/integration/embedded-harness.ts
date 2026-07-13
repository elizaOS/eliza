/**
 * Shared PGlite-backed AgentRuntime harness for workflow integration suites.
 * Core tasks and services use the real runtime; only external systems are absent.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { AgentRuntime, createCharacter, stringToUuid } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/pglite';
import { InMemoryDatabaseAdapter } from '../../../../packages/core/src/database/inMemoryAdapter.ts';
import * as dbSchema from '../../src/db/schema';
import {
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  EmbeddedWorkflowService,
} from '../../src/services/embedded-workflow-service';

export interface EmbeddedHarness {
  runtime: AgentRuntime;
  workflow: EmbeddedWorkflowService;
  close: () => Promise<void>;
}

export async function makeEmbeddedHarness(agentSeed: string): Promise<EmbeddedHarness> {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-e2e-'));
  const client = new PGlite({ dataDir: join(dir, 'pglite') });
  const db = drizzle(client, { schema: dbSchema });
  const adapter = new InMemoryDatabaseAdapter();
  Reflect.set(adapter, 'db', db);
  const runtime = Object.assign(
    new AgentRuntime({
      character: createCharacter({
        id: stringToUuid(agentSeed),
        name: `WorkflowIntegrationAgent-${agentSeed}`,
        settings: { WORKFLOW_SEED_DEFAULTS: 'false' },
      }),
      adapter,
      logLevel: 'fatal',
      enableAutonomy: false,
    }),
    { serverless: true }
  );

  await runtime.initialize();
  await runtime.registerPlugin({
    name: 'workflow-embedded-integration-harness',
    description: 'Real embedded workflow service for integration coverage',
    services: [EmbeddedWorkflowService],
  });
  const workflow = (await runtime.getServiceLoadPromise(
    EMBEDDED_WORKFLOW_SERVICE_TYPE
  )) as EmbeddedWorkflowService;

  return {
    runtime,
    workflow,
    async close() {
      await runtime.stop();
      await runtime.close();
      await client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
