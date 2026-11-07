import { expect, test } from 'bun:test';
import { createTestRuntime } from '@elizaos/testing/runtime';
import { workflowPlugin } from '../../src/index';
import {
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  type EmbeddedWorkflowService,
} from '../../src/services/embedded-workflow-service';

test('a timer after a signal that came before its timeout resumes when the timer is due', async () => {
  const { runtime, cleanup } = await createTestRuntime({ plugins: [workflowPlugin] });
  try {
    const embedded = (await runtime.getServiceLoadPromise(
      EMBEDDED_WORKFLOW_SERVICE_TYPE
    )) as EmbeddedWorkflowService;
    const workflow = await embedded.createWorkflow({
      name: 'Signal then timer fixture',
      language: 'tsx',
      active: false,
      metadata: { elizaOwnerEntityId: 'owner' },
      source: `/** @jsxImportSource smthrs */
import {createSmithers} from 'smthrs/create';import {z} from 'zod';
const {Workflow,Sequence,Signal,Timer,Task,smithers,outputs}=createSmithers({review:z.object({ok:z.boolean()}),output:z.object({value:z.number()})},{dbPath:process.env.ELIZA_SMTHRS_DB_PATH});
export default smithers(()=><Workflow name="signal-then-timer-fixture"><Sequence><Signal id="review-ready" schema={outputs.review} timeoutMs={60000} onTimeout="skip"/><Timer id="wait" duration="2s"/><Task id="calculate" output={outputs.output}>{{value:56}}</Task></Sequence></Workflow>);`,
    } as never);

    const started = await embedded.startWorkflow(String(workflow.id));
    let execution = await embedded.getExecution(started.id);
    const waitDeadline = Date.now() + 30_000;
    while (execution.status !== 'waiting-event' && Date.now() < waitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      execution = await embedded.getExecution(started.id);
    }
    expect(execution.status).toBe('waiting-event');
    // Let the first invocation return, so the Signal's 60s timeout wake-up is armed.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await embedded.signalExecution(started.id, 'review-ready', { ok: true });

    // The 2s Timer must resume the run when it is due, not at the old 60s
    // Signal deadline, so the run finishes inside the 30s polling window.
    const statuses = new Set<string>();
    const deadline = Date.now() + 30_000;
    execution = await embedded.getExecution(started.id);
    while (!execution.finished && Date.now() < deadline) {
      statuses.add(execution.status);
      await new Promise((resolve) => setTimeout(resolve, 250));
      execution = await embedded.getExecution(started.id);
    }
    expect(statuses.has('waiting-timer')).toBe(true);
    expect(execution.status).toBe('finished');
    expect(JSON.stringify(execution.output)).toContain('56');
  } finally {
    await cleanup();
  }
}, 120_000);
