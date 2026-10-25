import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../../src/db/schema';
import { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';

test('a run waiting on a Smithers timer resumes and finishes when the timer is due', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-timer-'));
  const db = new PGlite(directory);
  let embedded: EmbeddedWorkflowService | undefined;
  try {
    await db.exec(`
    CREATE SCHEMA workflow;
    CREATE TABLE workflow.embedded_workflows (
      agent_id text NOT NULL,
      id text NOT NULL,
      name text NOT NULL,
      active boolean NOT NULL DEFAULT false,
      workflow jsonb NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      version_id text NOT NULL,
      PRIMARY KEY (agent_id, id)
    );
    CREATE TABLE workflow.workflow_revisions (
      agent_id text NOT NULL,
      id text NOT NULL,
      workflow_id text NOT NULL,
      version_id text NOT NULL,
      name text NOT NULL,
      active boolean NOT NULL DEFAULT false,
      workflow jsonb NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      captured_at text NOT NULL,
      operation text NOT NULL,
      PRIMARY KEY (agent_id, id),
      UNIQUE (agent_id, workflow_id, version_id)
    );
    CREATE TABLE workflow.embedded_executions (
      agent_id text NOT NULL,
      id text NOT NULL,
      workflow_id text NOT NULL,
      status text NOT NULL,
      mode text NOT NULL,
      finished boolean NOT NULL DEFAULT false,
      started_at text NOT NULL,
      stopped_at text,
      execution jsonb NOT NULL,
      idempotency_key text,
      PRIMARY KEY (agent_id, id)
    );
    CREATE TABLE workflow.embedded_tags (
      agent_id text NOT NULL,
      id text NOT NULL,
      name text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      PRIMARY KEY (agent_id, id),
      UNIQUE (agent_id, name)
    );

 CREATE TABLE workflow.manual_submissions(agent_id text NOT NULL,workflow_id text NOT NULL,submission_id text NOT NULL,owner_id text NOT NULL,version_id text NOT NULL,input jsonb NOT NULL,run_id text NOT NULL,PRIMARY KEY(agent_id,workflow_id,submission_id));`);
    const runtime = {
      agentId: '00000000-0000-4000-8000-000000000001',
      db: drizzle(db, { schema }),
      getTasks: async () => [],
      emitEvent: async () => {},
      getService: () => embedded,
    };
    embedded = await EmbeddedWorkflowService.start(runtime as never);
    const workflow = await embedded.createWorkflow({
      name: 'Timer fixture',
      language: 'tsx',
      active: false,
      metadata: { elizaOwnerEntityId: 'owner' },
      source: `/** @jsxImportSource smthrs */
import {createSmithers} from 'smthrs/create';import {z} from 'zod';
const {Workflow,Sequence,Timer,Task,smithers,outputs}=createSmithers({output:z.object({value:z.number()})},{dbPath:process.env.ELIZA_SMTHRS_DB_PATH});
export default smithers(()=><Workflow name="timer-fixture"><Sequence><Timer id="wait" duration="2s"/><Task id="calculate" output={outputs.output}>{{value:56}}</Task></Sequence></Workflow>);`,
    } as never);

    const started = await embedded.startWorkflow(String(workflow.id));
    const statuses = new Set<string>();
    const deadline = Date.now() + 30_000;
    let execution = await embedded.getExecution(started.id);
    while (!execution.finished && Date.now() < deadline) {
      statuses.add(execution.status);
      await new Promise((resolve) => setTimeout(resolve, 250));
      execution = await embedded.getExecution(started.id);
    }
    expect(statuses.has('waiting-timer')).toBe(true);
    expect(execution.status).toBe('finished');
    expect(JSON.stringify(execution.output)).toContain('56');
  } finally {
    await embedded?.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
