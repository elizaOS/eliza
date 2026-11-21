/**
 * WORKFLOW chat references, names and refusals against real PGlite persistence.
 * Only draft authoring is stubbed, except where the model reply itself is the
 * subject. Each case is a reviewed failure: a fragment of a word changed another
 * workflow, a described workflow could never be removed, same-named workflows
 * could not be told apart, a schedule refused before any write was reported as
 * an outcome to reconcile, a cut list hid its cut, and "start workflow named X"
 * was read as a create.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { ActionResult, HandlerOptions, IAgentRuntime, Memory } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/pglite';
import { workflowAction } from '../../src/actions/workflow';
import { authoredWorkflowRequest } from '../../src/actions/workflow-request';
import * as schema from '../../src/db/schema';
import { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';
import { WorkflowService } from '../../src/services/workflow-service';
import type { WorkflowDefinition } from '../../src/types/index';

const owner = '00000000-0000-4000-8000-000000000010';
const source = `/** @jsxImportSource smthrs */
import {createSmithers} from 'smthrs/create';import {z} from 'zod';
const {Workflow,Task,smithers,outputs}=createSmithers({output:z.object({value:z.number()})},{dbPath:process.env.ELIZA_SMTHRS_DB_PATH});
export default smithers(()=><Workflow name="receipt-proof"><Task id="calculate" output={outputs.output}>{{value:56}}</Task></Workflow>);`;
const definition: WorkflowDefinition = {
  name: 'Model name',
  steps: [{ id: 'calculate', kind: 'task', label: 'Calculate' }],
  active: false,
  language: 'tsx',
  source,
};

async function fixture(options: { stubAuthoring?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-chat-references-'));
  const db = new PGlite(directory);
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

 CREATE TABLE workflow.typed_mutations(agent_id text NOT NULL,owner_id text NOT NULL,mutation_id text NOT NULL,request_digest text NOT NULL,workflow_id text NOT NULL,receipt jsonb NOT NULL,PRIMARY KEY(agent_id,owner_id,mutation_id));
 CREATE TABLE workflow.lifecycle_mutations(agent_id text NOT NULL,workflow_id text NOT NULL,mutation_id text NOT NULL,owner_id text NOT NULL,expected_version_id text NOT NULL,operation text NOT NULL,receipt jsonb NOT NULL,PRIMARY KEY(agent_id,workflow_id,mutation_id));
 CREATE TABLE workflow.metadata_mutations(agent_id text NOT NULL,workflow_id text NOT NULL,mutation_id text NOT NULL,owner_id text NOT NULL,expected_version_id text NOT NULL,name text NOT NULL,description text NOT NULL,receipt jsonb NOT NULL,PRIMARY KEY(agent_id,workflow_id,mutation_id));
 CREATE TABLE workflow.manual_submissions(agent_id text NOT NULL,workflow_id text NOT NULL,submission_id text NOT NULL,owner_id text NOT NULL,version_id text NOT NULL,input jsonb NOT NULL,run_id text NOT NULL,PRIMARY KEY(agent_id,workflow_id,submission_id));`);
  let embedded: EmbeddedWorkflowService | undefined;
  let facade: WorkflowService | undefined;
  const runtime = {
    agentId: randomUUID(),
    db: drizzle(db, { schema }),
    character: { name: 'fixture' },
    getTasks: async () => [],
    emitEvent: async () => {},
    getSetting: (key: string) => (key === 'ELIZA_ADMIN_ENTITY_ID' ? owner : null),
    getService: (name: string) => (name === 'embedded_workflow_service' ? embedded : facade),
    logger: { warn() {}, error() {}, debug() {}, info() {} },
  } as unknown as IAgentRuntime & { useModel?: unknown };
  embedded = await EmbeddedWorkflowService.start(runtime);
  const service = new WorkflowService(runtime);
  facade = service;
  let draft: WorkflowDefinition = definition;
  if (options.stubAuthoring !== false) {
    service.generateWorkflowDraft = async () => draft;
    service.modifyWorkflowDraft = async () => draft;
  }
  const invoke = (parameters: Record<string, unknown>, text: string): Promise<ActionResult> =>
    workflowAction.handler(
      runtime,
      {
        id: randomUUID(),
        agentId: runtime.agentId,
        entityId: owner,
        roomId: randomUUID(),
        content: { text, metadata: { uiTimeZone: 'UTC' } },
        createdAt: 0,
      } as Memory,
      undefined,
      { parameters } as HandlerOptions,
      undefined
    ) as Promise<ActionResult>;
  const add = (name: string) =>
    service.deployWorkflowDefinition({ ...definition, name }, owner, { activate: false });
  const names = async () => (await service.listWorkflows(owner)).map((w) => w.name).sort();
  return {
    runtime,
    service,
    invoke,
    add,
    names,
    setDraft: (value: WorkflowDefinition) => {
      draft = value;
    },
    rowCount: async () =>
      (
        await db.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM workflow.embedded_workflows'
        )
      ).rows[0]?.count,
    close: async () => {
      await embedded?.stop();
      await db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('a word fragment never removes or renames another workflow', async () => {
  const f = await fixture();
  try {
    await f.add('Morning news');
    const alpha = await f.add('Alpha');
    // "new" describes the workflow; the planner's id, which names Alpha, is used.
    const removed = await f.invoke(
      { action: 'remove', workflowId: alpha.id },
      'delete the new workflow'
    );
    expect(removed.success).toBe(true);
    expect(removed.text).toBe('Removed “Alpha”. It no longer runs. You can restore it later.');
    expect(await f.names()).toEqual(['Morning news']);

    await f.add('Q3 review');
    await f.add('Backup');
    const numbered = await f.invoke(
      { action: 'remove', workflowName: 'Backup' },
      'delete workflow 3'
    );
    expect(numbered).toMatchObject({
      success: false,
      failureProvenance: { code: 'WORKFLOW_NOT_FOUND' },
    });
    expect(await f.names()).toEqual(['Backup', 'Morning news', 'Q3 review']);

    await f.add('Folder cleanup');
    const renamed = await f.invoke(
      { action: 'rename', workflowName: 'Folder cleanup', name: 'Archive' },
      'rename the old workflow to Archive'
    );
    // "old" stays with the planner, which named the workflow it meant.
    expect(renamed.text).toBe('Renamed “Folder cleanup” to “Archive”.');
    expect(await f.names()).toEqual(['Archive', 'Backup', 'Morning news', 'Q3 review']);

    // "new" is not "news": a short stem gets no plural, so a planner name "new"
    // neither removes nor turns on "Morning news".
    expect(await f.invoke({ action: 'remove', workflowName: 'new' }, 'go ahead')).toMatchObject({
      success: false,
      failureProvenance: { code: 'WORKFLOW_NOT_FOUND' },
    });
    expect(
      await f.invoke({ action: 'activate', workflowName: 'new' }, 'turn on the new one')
    ).toMatchObject({ success: false, failureProvenance: { code: 'WORKFLOW_NOT_FOUND' } });
    expect((await f.service.listWorkflows(owner)).every((w) => !w.active)).toBe(true);
    expect(await f.invoke({ action: 'remove', workflowName: 'morn' }, 'go ahead')).toMatchObject({
      success: false,
      failureProvenance: { code: 'WORKFLOW_NOT_FOUND' },
    });
    // Whole words of one name are only a guess for remove and rename: the owner is asked.
    const guess = await f.invoke({ action: 'remove' }, 'delete the news workflow');
    expect(guess).toMatchObject({
      success: false,
      failureProvenance: { code: 'WORKFLOW_CONFIRM_TARGET', retryable: false },
    });
    expect(guess.userFacingText).toBe('Do you mean “Morning news”? I left it unchanged.');
    // Reads still find it by those words.
    expect(
      (await f.invoke({ action: 'get', workflowName: 'news' }, 'show me the news one')).data
    ).toMatchObject({ workflow: { name: 'Morning news' } });
    expect(await f.names()).toEqual(['Archive', 'Backup', 'Morning news', 'Q3 review']);
  } finally {
    await f.close();
  }
}, 120000);

test('a described workflow is removed through the planner id', async () => {
  for (const text of [
    'delete the workflow I just created',
    'delete the last workflow',
    'remove this workflow',
    'delete the other workflow',
  ]) {
    expect(authoredWorkflowRequest(text)).toBeUndefined();
    const f = await fixture();
    try {
      await f.add('Keep me');
      const alpha = await f.add('Alpha');
      const result = await f.invoke({ action: 'remove', workflowId: alpha.id }, text);
      expect(result.success).toBe(true);
      expect(result.text).toBe('Removed “Alpha”. It no longer runs. You can restore it later.');
      expect(await f.names()).toEqual(['Keep me']);
    } finally {
      await f.close();
    }
  }
}, 120000);

test('names stay distinct, and the planner id settles same-named workflows', async () => {
  const f = await fixture();
  try {
    const one = await f.invoke({ action: 'create' }, 'create a workflow called Alpha');
    expect(one.text).toBe('Created “Alpha”. It is off until you turn it on.');
    const two = await f.invoke({ action: 'create' }, 'create a workflow called Alpha');
    expect(two).toMatchObject({
      success: false,
      effectReceipts: [],
      failureProvenance: { code: 'WORKFLOW_NAME_TAKEN', retryable: false },
    });
    expect(two.userFacingText).toContain('You already have a workflow called “Alpha”');
    expect(await f.names()).toEqual(['Alpha']);
    // A name the model wrote is numbered instead of refused.
    const model = await f.invoke({ action: 'create', seedPrompt: 'x' }, 'make something');
    const modelAgain = await f.invoke({ action: 'create', seedPrompt: 'y' }, 'make another');
    expect(model.text).toStartWith('Created “Model name”.');
    expect(modelAgain.text).toStartWith('Created “Model name 2”.');
    // Rename refuses a name another workflow has.
    const clash = await f.invoke(
      { action: 'rename', workflowName: 'Model name 2', name: 'alpha' },
      'rename the workflow Model name 2 to alpha'
    );
    expect(clash).toMatchObject({
      success: false,
      failureProvenance: { code: 'WORKFLOW_NAME_TAKEN' },
    });
    expect(await f.names()).toEqual(['Alpha', 'Model name', 'Model name 2']);

    // Same-named workflows written before this check (or by another surface).
    const twin = await f.add('Alpha');
    const first = (one.data as { workflow: { id: string } }).workflow.id;
    const asked = await f.invoke({ action: 'remove' }, 'delete the Alpha workflow');
    expect(asked).toMatchObject({ failureProvenance: { code: 'WORKFLOW_AMBIGUOUS' } });
    // The question tells them apart.
    expect(asked.userFacingText).toMatch(
      /^More than one workflow matches that: “Alpha” \(off, created [^)]+\), “Alpha” \(off, created [^)]+\)\. Which one\?$/
    );
    const renamed = await f.invoke(
      { action: 'rename', workflowId: twin.id, name: 'Beta' },
      'rename the Alpha workflow to Beta'
    );
    expect(renamed.text).toBe('Renamed “Alpha” to “Beta”.');
    expect((await f.service.getWorkflow(twin.id, owner)).name).toBe('Beta');
    const removed = await f.invoke(
      { action: 'remove', workflowId: first },
      'delete the Alpha workflow'
    );
    expect(removed.success).toBe(true);
    expect(await f.names()).toEqual(['Beta', 'Model name', 'Model name 2']);
  } finally {
    await f.close();
  }
}, 120000);

test('every wording that asks to be told gets the no-notification caveat, on create and edit', async () => {
  const f = await fixture();
  try {
    for (const text of [
      'Create a workflow that reminds me to stretch every hour',
      'Create a workflow that texts me the weather every morning',
      'Create a workflow that lets me know when it is 9am',
      'Create a workflow reminding me to drink water',
      'Create a workflow that messages me each morning',
      'Create a workflow that pings me at noon',
      'Create a workflow that sends me a push every day',
      'Create a workflow that emails me a summary',
      'Create a workflow that alerts me about rain',
    ]) {
      const result = await f.invoke({ action: 'create', seedPrompt: text }, text);
      expect(result.success).toBe(true);
      expect(result.text).toContain('It can’t send you a notification');
    }
    const quiet = await f.invoke(
      { action: 'create', seedPrompt: 'Summarize the news into the run history' },
      'Create a workflow that summarizes the news'
    );
    expect(quiet.text).not.toContain('notification');
    const id = (await f.service.listWorkflows(owner))[0].id;
    const edited = await f.invoke(
      { action: 'modify', workflowId: id, instruction: 'Remind me at 9am every day' },
      'Change it to remind me at 9am every day'
    );
    expect(edited.success).toBe(true);
    expect(edited.text).toContain('It can’t send you a notification');
    const plainEdit = await f.invoke(
      { action: 'modify', workflowId: id, instruction: 'Add a step' },
      'Add a step'
    );
    expect(plainEdit.text).not.toContain('notification');
  } finally {
    await f.close();
  }
}, 120000);

test('a definition refused before any write is a retryable not-applied result', async () => {
  const f = await fixture();
  try {
    f.setDraft({ ...definition, schedule: { cron: '0 9 * * *', timezone: 'PST', enabled: true } });
    const created = await f.invoke(
      { action: 'create', seedPrompt: 'Every morning at 9 summarize' },
      'Create a workflow that summarizes my day at 9'
    );
    expect(created).toMatchObject({
      success: false,
      failureProvenance: { code: 'WORKFLOW_DEFINITION_NOT_APPLIED', retryable: true },
    });
    expect(created.text).toBe('Invalid workflow schedule time zone: PST');
    expect(await f.rowCount()).toBe(0);

    f.setDraft(definition);
    const made = await f.invoke({ action: 'create', seedPrompt: 'x' }, 'make something');
    const id = (made.data as { workflow: { id: string; versionId: string } }).workflow;
    f.setDraft({ ...definition, schedule: { cron: 'every day', timezone: 'UTC', enabled: true } });
    const edit = await f.invoke(
      { action: 'modify', workflowId: id.id, instruction: 'run daily' },
      'make it run daily'
    );
    // modify saves the edit turned off, so its schedule is checked only when enabled
    // on the stored draft; a broken enabled cron is refused before the write.
    expect(edit).toMatchObject({
      success: false,
      failureProvenance: { code: 'WORKFLOW_DEFINITION_NOT_APPLIED', retryable: true },
    });
    expect((await f.service.getWorkflow(id.id, owner)).versionId).toBe(id.versionId);
    // A call refused for a missing parameter says so in the same shape.
    expect(
      await f.invoke({ action: 'rename', workflowId: id.id }, 'give it a better name')
    ).toMatchObject({
      success: false,
      effectReceipts: [],
      failureProvenance: { code: 'WORKFLOW_NAME_INVALID', retryable: true },
    });
  } finally {
    await f.close();
  }
}, 120000);

test('authoring repairs a schedule the model wrote with a zone the scheduler cannot use', async () => {
  const f = await fixture({ stubAuthoring: false });
  try {
    const zones = ['PST', 'America/Los_Angeles'];
    const prompts: string[] = [];
    (f.runtime as { useModel: unknown }).useModel = async (
      _type: unknown,
      args: { prompt: string }
    ) => {
      prompts.push(args.prompt);
      return JSON.stringify({
        ...definition,
        name: 'Morning summary',
        schedule: { cron: '0 9 * * *', timezone: zones[prompts.length - 1], enabled: true },
      });
    };
    const created = await f.invoke(
      { action: 'create', seedPrompt: 'Every morning at 9 summarize' },
      'Create a workflow that summarizes my day at 9'
    );
    expect(created.success).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Invalid workflow schedule time zone: PST');
    const [row] = await f.service.listWorkflows(owner);
    expect(row.schedule?.timezone).toBe('America/Los_Angeles');
    expect(row.active).toBe(false);
  } finally {
    await f.close();
  }
}, 240000);

test('a list that is cut says so', async () => {
  const f = await fixture();
  try {
    for (let i = 1; i <= 23; i++) await f.add(`Flow ${String(i).padStart(2, '0')}`);
    const listed = await f.invoke({ action: 'list' }, 'list my workflows');
    expect(listed.text).toStartWith('Found 23 workflows. Showing the first 20: ');
    expect(listed.data).toMatchObject({ total: 23, truncated: true });
    expect((listed.data as { workflows: unknown[] }).workflows).toHaveLength(20);
    const all = await f.invoke({ action: 'list', limit: 50 }, 'list my workflows');
    expect(all.text).toStartWith('Found 23 workflows: ');
    expect(all.data).toMatchObject({ total: 23, truncated: false });
  } finally {
    await f.close();
  }
}, 120000);

test('"start workflow named X" runs that workflow and creates nothing', async () => {
  expect(authoredWorkflowRequest('start workflow named Morning brief')).toBeUndefined();
  expect(authoredWorkflowRequest('start a new workflow called Morning brief')).toEqual({
    op: 'create',
    name: 'Morning brief',
  });
  const f = await fixture();
  try {
    const brief = await f.add('Morning brief');
    const run = await f.invoke(
      { action: 'run', workflowId: brief.id },
      'start workflow named Morning brief'
    );
    expect(run.success).toBe(true);
    expect(run.text).toStartWith('Submitted a run of “Morning brief”.');
    // A planner that chose create still cannot make a second "Morning brief".
    const again = await f.invoke(
      { action: 'create', name: 'Morning brief' },
      'start workflow named Morning brief'
    );
    expect(again).toMatchObject({ failureProvenance: { code: 'WORKFLOW_NAME_TAKEN' } });
    expect(await f.names()).toEqual(['Morning brief']);
  } finally {
    await f.close();
  }
}, 120000);
