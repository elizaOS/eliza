/** Actual persistence -> WORKFLOW handler -> canonical settlement -> evaluator. */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type {
  ActionResult,
  Content,
  ContextObject,
  IAgentRuntime,
  Memory,
  PlannerTrajectory,
} from '@elizaos/core';
import { effectDeliveryBindingProvesApplication, settleActionHandler } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/pglite';
import { parseWorkflowBody } from '../../../../packages/ui/src/components/chat/message-workflow-parser';
import { runEvaluator } from '../../../plugin-assistant/src/runtime/evaluator';
import { workflowAction } from '../../src/actions/workflow';
import * as schema from '../../src/db/schema';
import { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';
import { resolveSmithersWorkflowDir } from '../../src/services/smithers-runtime';
import { WorkflowService } from '../../src/services/workflow-service';

test('persisted WORKFLOW mutation receipts finish; read observations deliver without fabricated effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-action-effects-'));
  const db = new PGlite(directory);
  let embedded: EmbeddedWorkflowService | undefined;
  const workflowDirectories: string[] = [];
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
    const owner = '00000000-0000-4000-8000-000000000010';
    let facade: WorkflowService;
    const runtime = {
      agentId: randomUUID(),
      db: drizzle(db, { schema }),
      character: { name: 'Effects fixture' },
      getTasks: async () => [],
      emitEvent: async () => {},
      getSetting: (key: string) => (key === 'ELIZA_ADMIN_ENTITY_ID' ? owner : null),
      getService: (name: string) => (name === 'embedded_workflow_service' ? embedded : facade),
      logger: { warn: () => {}, error: () => {}, debug: () => {}, info: () => {} },
    } as unknown as IAgentRuntime;
    embedded = await EmbeddedWorkflowService.start(runtime);
    facade = new WorkflowService(runtime);
    const definition = {
      name: 'Synthetic reviewed definition',
      steps: [{ id: 'calculate', kind: 'task' as const, label: 'Calculate' }],
      active: false,
      language: 'tsx' as const,
      source: `/** @jsxImportSource smthrs */
import {createSmithers} from 'smthrs/create';import {z} from 'zod';
const {Workflow,Task,smithers,outputs}=createSmithers({output:z.object({value:z.number()})},{dbPath:process.env.ELIZA_SMTHRS_DB_PATH});
export default smithers(()=><Workflow name="receipt-proof"><Task id="calculate" output={outputs.output}>{{value:56}}</Task></Workflow>);`,
    };
    // Only generation is deterministic; owner authorization, SQL and settlement are production.
    facade.generateWorkflowDraft = async () => definition;
    const message = {
      id: '00000000-0000-4000-8000-000000000020',
      agentId: runtime.agentId,
      entityId: owner,
      roomId: '00000000-0000-4000-8000-000000000022',
      content: { text: 'Create inactive synthetic workflow' },
      createdAt: 0,
    } as Memory;
    const delivered: Content[] = [];
    const invoke = async (parameters: Record<string, unknown>) => {
      delivered.length = 0;
      return settleActionHandler({
        runtime,
        action: workflowAction,
        callback: async (content) => {
          delivered.push(content);
          return [];
        },
        invoke: (callback) =>
          workflowAction.handler(runtime, message, undefined, { parameters }, callback),
      });
    };
    const created = await invoke({ action: 'create', seedPrompt: 'Synthetic fixture' });
    expect(created.success).toBe(true);
    expect(created.effectReceipts).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toBe(created.userFacingText);
    expect(delivered[0].effectReceiptIds).toEqual(created.userFacingEffectReceiptIds);
    const rows = await facade.listWorkflows(owner);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.active).toBe(false);
    expect(await facade.getWorkflowExecutions(row.id, 20, owner)).toEqual([]);
    expect(created.effectReceipts![0]).toMatchObject({
      operation: 'workflow.create',
      resource: { id: row.id, version: row.versionId },
      outcome: 'applied',
      commit: { kind: 'durable', committedAt: row.updatedAt },
      idempotency: { key: null, replayed: false },
    });
    const context: ContextObject = {
      id: 'workflow-proof',
      events: [
        {
          id: 'handler',
          type: 'message_handler',
          metadata: { plan: { intents: ['Create inactive synthetic workflow'] } },
        },
      ],
    };
    const evaluate = async (
      result: ActionResult,
      receiptIds: string[],
      messageToUser = created.userFacingText
    ) => {
      const trajectory: PlannerTrajectory = {
        context,
        modelBaseContext: context,
        archivedSteps: [],
        steps: [
          {
            iteration: 1,
            toolCall: { id: 'create-call', name: 'WORKFLOW', params: { action: 'create' } },
            result,
          },
        ],
        plannedQueue: [],
        evaluatorOutputs: [],
      };
      const output = {
        success: true,
        decision: 'FINISH',
        thought: 'Recorded durable definition proves the request.',
        messageToUser,
        replyEffectStatus: 'applied',
        effectReceiptIds: receiptIds,
        requestFullyCovered: true,
        outcomeCoverage: [
          { intentId: 'intent:1', status: 'completed', evidenceStepIds: ['step:1'] },
        ],
      };
      return runEvaluator({
        context,
        trajectory,
        runtime: { useModel: async () => JSON.stringify(output) },
      });
    };
    expect((await evaluate(created, [created.effectReceipts![0].receiptId])).decision).toBe(
      'FINISH'
    );
    expect((await evaluate(created, ['step:1'])).decision).toBe('CONTINUE');
    expect(
      (await evaluate({ ...created, effectReceipts: [] }, [created.effectReceipts![0].receiptId]))
        .decision
    ).toBe('CONTINUE');
    for (const action of ['list', 'get', 'executions', 'revisions']) {
      const read = await invoke({ action, workflowId: row.id });
      expect(read.success).toBe(true);
      expect(read.effectReceipts).toBeUndefined();
      expect(delivered).toHaveLength(1);
      expect(delivered[0].text).toBe(read.text);
      expect(delivered[0].effectReceiptIds).toBeUndefined();
    }
    facade.modifyWorkflowDraft = async () => ({
      ...definition,
      name: 'Edited synthetic definition',
    });
    const modified = await invoke({
      action: 'modify',
      workflowId: row.id,
      instruction: 'Edit name',
    });
    const modifiedRow = await facade.getWorkflow(row.id, owner);
    expect(modified.success).toBe(true);
    expect(modifiedRow.name).toBe('Edited synthetic definition');
    expect(modified.effectReceipts![0]).toMatchObject({
      operation: 'workflow.modify',
      resource: { id: row.id, version: modifiedRow.versionId },
    });
    expect(modifiedRow.versionId).not.toBe(row.versionId);
    const restored = await invoke({
      action: 'restore',
      workflowId: row.id,
      versionId: row.versionId,
    });
    const restoredRow = await facade.getWorkflow(row.id, owner);
    expect(restored.success).toBe(true);
    expect(restoredRow.name).toBe(row.name);
    expect(restored.effectReceipts![0]).toMatchObject({
      operation: 'workflow.restore',
      resource: { id: row.id, version: restoredRow.versionId },
    });
    expect(restoredRow.versionId).not.toBe(row.versionId);
    for (const action of ['activate', 'deactivate']) {
      const changed = await invoke({ action, workflowId: row.id });
      expect(changed.success).toBe(true);
      const actual = await facade.getWorkflow(row.id, owner);
      expect(actual.active).toBe(action === 'activate');
      expect(changed.effectReceipts![0]).toMatchObject({
        operation: 'workflow.' + action,
        resource: { id: row.id, version: actual.versionId },
      });
      expect(delivered).toHaveLength(1);
    }
    const denied = await invoke({ action: 'delete', workflowId: row.id });
    expect(denied.success).toBe(false);
    expect(denied.effectReceipts).toEqual([]);
    expect(delivered).toHaveLength(0);
    expect(await facade.listWorkflows(owner)).toHaveLength(1);
    // A concurrent mutation after the create transaction must not replace its receipt version.
    const deploy = facade.deployWorkflowDefinition.bind(facade);
    let committedVersion: string | undefined;
    facade.deployWorkflowDefinition = async (...args) => {
      const committed = await deploy(...args);
      committedVersion = committed.versionId;
      await facade.updateWorkflow(committed.id, { ...committed, name: 'Concurrent edit' }, owner);
      return committed;
    };
    const concurrent = await invoke({
      action: 'create',
      seedPrompt: 'Create with concurrent edit',
    });
    expect(concurrent.success).toBe(true);
    const committed = concurrent.effectReceipts![0];
    expect(committed.resource.version).toBe(committedVersion);
    expect((await facade.getWorkflow(committed.resource.id, owner)).versionId).not.toBe(
      committedVersion
    );
    expect(concurrent.data?.workflow).toMatchObject({ name: definition.name });
    facade.deployWorkflowDefinition = deploy;
    // Generated IDs must never turn create into a hidden update.
    facade.generateWorkflowDraft = async () => ({ ...definition, id: row.id });
    const updateDenied = await invoke({ action: 'create', seedPrompt: 'Must not update' });
    expect(updateDenied.success).toBe(false);
    expect(updateDenied.effectReceipts).toEqual([]);
    expect(await facade.listWorkflows(owner)).toHaveLength(2);
    facade.generateWorkflowDraft = async () => definition;
    // Real queued worker admission remains a preview of execution completion.
    workflowDirectories.push(resolveSmithersWorkflowDir(runtime.agentId, row.id));
    const submitted = await invoke({ action: 'run', workflowId: row.id });
    expect(submitted.success).toBe(true);
    expect(submitted.effectReceipts![0].outcome).toBe('preview');
    expect(delivered).toHaveLength(1);
    expect(effectDeliveryBindingProvesApplication(delivered[0])).toBe(false);
    const body = String(delivered[0].text).split('[WORKFLOW]\n')[1].split('\n[/WORKFLOW]')[0];
    const submittedIdentity = submitted.data?.execution as { id: string };
    expect(parseWorkflowBody(body)?.runId).toBe(submittedIdentity.id);
    expect(submitted.data?.submissionReceipt).toMatchObject({
      operation: 'workflow.run.submit',
      outcome: 'applied',
    });
    expect(
      (
        await evaluate(
          submitted,
          [submitted.effectReceipts![0].receiptId],
          'The arithmetic finished with result 56.'
        )
      ).decision
    ).toBe('CONTINUE');
    const submittedRun = submitted.data?.execution as { id: string };
    const deadline = Date.now() + 30000;
    while (
      !(await facade.getExecutionDetail(submittedRun.id, owner)).finished &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await facade.getExecutionDetail(submittedRun.id, owner)).status).toBe('finished');
    // Race two real cancellation transactions against one unstarted persisted execution.
    const executionId = randomUUID(),
      at = new Date().toISOString();
    const execution = {
      id: executionId,
      workflowId: row.id,
      workflowVersionId: restoredRow.versionId,
      workflowName: row.name,
      mode: 'chat',
      status: 'queued',
      finished: false,
      startedAt: at,
      input: {},
      events: [],
      approvals: [],
    };
    await db.query(
      'INSERT INTO workflow.embedded_executions(agent_id,id,workflow_id,status,mode,finished,started_at,execution) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [runtime.agentId, executionId, row.id, 'queued', 'chat', false, at, JSON.stringify(execution)]
    );
    const raced = await Promise.all([
      facade.cancelExecutionWithReceipt(executionId, owner),
      facade.cancelExecutionWithReceipt(executionId, owner),
    ]);
    expect(raced.map((x) => x.request?.replayed).sort()).toEqual([false, true]);
    expect(raced[0].request?.requestedAt).toBe(raced[1].request?.requestedAt);
    const cancellation = await invoke({ action: 'cancel_run', executionId });
    expect(cancellation.success).toBe(true);
    expect(cancellation.effectReceipts![0].outcome).toBe('preview');
    expect(delivered).toHaveLength(1);
    expect(effectDeliveryBindingProvesApplication(delivered[0])).toBe(false);
    expect(cancellation.data?.cancellationRequestReceipt).toMatchObject({
      outcome: 'noop',
      idempotency: { replayed: true },
    });
    expect(
      (
        await evaluate(
          cancellation,
          [cancellation.effectReceipts![0].receiptId],
          'The workflow was cancelled.'
        )
      ).decision
    ).toBe('CONTINUE');
  } finally {
    await embedded?.stop();
    for (const directory of workflowDirectories)
      await rm(directory, { recursive: true, force: true });
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
