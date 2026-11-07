import { expect, test } from 'bun:test';
import { ModelType } from '@elizaos/core';
import { createTestRuntime } from '@elizaos/testing/runtime';
import { workflowPlugin } from '../../src/index';
import {
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  type EmbeddedWorkflowService,
} from '../../src/services/embedded-workflow-service';

// PostgreSQL jsonb cannot store U+0000. Text a run carries can still contain
// one: a model reply that copies it from what it read, or an approval summary.
const NUL = String.fromCharCode(0);
const owner = '00000000-0000-4000-8000-0000000000aa';

async function waitFor(
  embedded: EmbeddedWorkflowService,
  runId: string,
  done: (execution: Awaited<ReturnType<EmbeddedWorkflowService['getExecution']>>) => boolean
) {
  const deadline = Date.now() + 30_000;
  let execution = await embedded.getExecution(runId);
  while (!done(execution) && Date.now() < deadline) {
    await Bun.sleep(100);
    execution = await embedded.getExecution(runId);
  }
  return execution;
}

test('a run whose model reply contains U+0000 is stored as finished', async () => {
  const { runtime, cleanup } = await createTestRuntime({ plugins: [workflowPlugin] });
  try {
    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async () => JSON.stringify({ message: `Invoice 42${NUL} paid` }),
      'nul-fixture',
      100
    );
    const embedded = (await runtime.getServiceLoadPromise(
      EMBEDDED_WORKFLOW_SERVICE_TYPE
    )) as unknown as EmbeddedWorkflowService;
    const workflow = await embedded.createWorkflow({
      name: 'Invoice summary',
      language: 'tsx',
      active: false,
      source: `/** @jsxImportSource smthrs */
import {createSmithers} from 'smthrs/create';import {z} from 'zod';
const {Workflow,Task,smithers,outputs}=createSmithers({output:z.object({message:z.string()})},{dbPath:process.env.ELIZA_SMTHRS_DB_PATH});
const agent=globalThis.__elizaSmithers.agent;
export default smithers(()=><Workflow name="invoice-summary"><Task id="summarize" output={outputs.output} agent={agent}>Summarize the invoice.</Task></Workflow>);`,
    } as never);

    const returned = await embedded.executeWorkflow(workflow.id, { throwOnError: false });
    const stored = await embedded.getExecution(returned.id);

    expect(stored.error?.message).toBeUndefined();
    expect(stored.status).toBe('finished');
    expect(stored.output).toEqual([expect.objectContaining({ message: 'Invoice 42 paid' })]);
    expect(returned.status).toBe('finished');
  } finally {
    await cleanup();
  }
}, 90_000);

test('an approval whose summary contains U+0000 waits for the owner and finishes after approval', async () => {
  const { runtime, cleanup } = await createTestRuntime({ plugins: [workflowPlugin] });
  try {
    const embedded = (await runtime.getServiceLoadPromise(
      EMBEDDED_WORKFLOW_SERVICE_TYPE
    )) as unknown as EmbeddedWorkflowService;
    const workflow = await embedded.createWorkflow({
      name: 'Send invoice',
      language: 'tsx',
      active: false,
      metadata: { elizaOwnerEntityId: owner },
      source: `/** @jsxImportSource smthrs */
import {createSmithers} from 'smthrs/create';import {z} from 'zod';import {approvalDecisionSchema} from 'smthrs';
const {Workflow,Sequence,Approval,Task,smithers,outputs}=createSmithers({decision:approvalDecisionSchema,output:z.object({sent:z.boolean()})},{dbPath:process.env.ELIZA_SMTHRS_DB_PATH});
export default smithers(()=><Workflow name="send-invoice"><Sequence><Approval id="review" mode="approve" output={outputs.decision} request={{title:"Send?",summary:"Invoice 42" + String.fromCharCode(0) + " to Acme",metadata:{approvalPresentation:{version:1,operation:"Send",target:"Acme",account:"Owner"}}}} /><Task id="send" output={outputs.output}>{{sent:true}}</Task></Sequence></Workflow>);`,
    } as never);

    const started = await embedded.startWorkflow(workflow.id);
    const waiting = await waitFor(
      embedded,
      started.id,
      (execution) => execution.finished || execution.status === 'waiting-approval'
    );
    expect(waiting.error?.message).toBeUndefined();
    expect(waiting.status).toBe('waiting-approval');
    expect(waiting.approvals?.[0]?.prompt).toBe('Invoice 42 to Acme');

    const [receipt] = (await embedded.approvalReceipts(started.id)).approvals;
    await embedded.decideReviewedApproval(
      started.id,
      'review',
      receipt.iteration,
      true,
      workflow.versionId,
      receipt.requestDigest,
      owner
    );
    const finished = await waitFor(embedded, started.id, (execution) => execution.finished);

    expect(finished.error?.message).toBeUndefined();
    expect(finished.status).toBe('finished');
    expect(finished.approvals?.[0]?.status).toBe('approved');
    expect(finished.output).toEqual(
      expect.arrayContaining([expect.objectContaining({ sent: true })])
    );
  } finally {
    await cleanup();
  }
}, 90_000);
