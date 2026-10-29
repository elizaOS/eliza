import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Memory, State, UUID } from '@elizaos/core';
import { createTestRuntime } from '@elizaos/testing/runtime';
import { workflowPlugin } from '../../src/index';
import { buildAutomationListResponse } from '../../src/lib/automations-builder';
import { workflowStatusProvider } from '../../src/providers/workflowStatus';
import {
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  notRunOccurrence,
} from '../../src/services/embedded-workflow-service';
import {
  WORKFLOW_DISPATCH_SERVICE_TYPE,
  type WorkflowDispatchService,
} from '../../src/services/workflow-dispatch';
import { WORKFLOW_SERVICE_TYPE, type WorkflowService } from '../../src/services/workflow-service';

const source = (name: string) => `/** @jsxImportSource smthrs */
import {createSmithers} from 'smthrs/create';import {z} from 'zod';
const {Workflow,Task,smithers,outputs}=createSmithers({output:z.object({value:z.number()})},{dbPath:process.env.ELIZA_SMTHRS_DB_PATH});
export default smithers(()=><Workflow name="${name}"><Task id="calculate" output={outputs.output}>{{value:56}}</Task></Workflow>);`;

test('only an engine-recorded settlement reads as an occurrence that did not run', () => {
  const scheduledAt = '2026-10-27T09:00:00.000Z';
  const output = { status: 'missed', scheduledAt, text: 'This occurrence did not run.' };
  const recorded = { status: 'finished', finished: true, input: {}, output } as const;
  expect(notRunOccurrence({ ...recorded, missedOccurrenceAt: scheduledAt })).toMatchObject({
    status: 'missed',
    scheduledAt,
  });
  // A workflow's own output with the same shape ran: no engine marker, no admission.
  expect(notRunOccurrence(recorded)).toBeUndefined();
  // A typed admission records its overlap in the run input.
  expect(
    notRunOccurrence({
      ...recorded,
      input: { typedSchedule: { scheduledAt, status: 'overlap' } },
      output: { ...output, status: 'overlap' },
    })?.status
  ).toBe('overlap');
  // A run that has not finished is not a settlement.
  expect(
    notRunOccurrence({
      ...recorded,
      status: 'running',
      finished: false,
      missedOccurrenceAt: scheduledAt,
    })
  ).toBeUndefined();
});

test('a missed scheduled occurrence is shown as missed, not as a successful run', async () => {
  const { runtime, cleanup } = await createTestRuntime({
    plugins: [workflowPlugin],
    // Powered-on scheduling (a phone resident): an occurrence that passed while
    // the agent was not running is recorded once and never run.
    settings: { ELIZA_MISSED_SCHEDULED_OCCURRENCES: 'record' },
  });
  try {
    await runtime.getServiceLoadPromise(EMBEDDED_WORKFLOW_SERVICE_TYPE);
    const service = (await runtime.getServiceLoadPromise(
      WORKFLOW_SERVICE_TYPE
    )) as unknown as WorkflowService;
    const owner = randomUUID() as UUID;
    const missed = await service.deployWorkflowDefinition(
      { name: 'Morning summary', language: 'tsx', source: source('morning') } as never,
      owner,
      { activate: true }
    );
    const ran = await service.deployWorkflowDefinition(
      { name: 'Evening summary', language: 'tsx', source: source('evening') } as never,
      owner,
      { activate: true }
    );

    // The scheduler fires an occurrence that came due an hour before the agent started.
    const dispatch = runtime.getService(
      WORKFLOW_DISPATCH_SERVICE_TYPE
    ) as unknown as WorkflowDispatchService;
    const scheduledAtMs = Date.now() - 3_600_000;
    expect(
      await dispatch.execute(
        missed.id,
        {},
        { scheduledAtMs, idempotencyKey: `${missed.id}:${Math.floor(scheduledAtMs / 60000)}` }
      )
    ).toMatchObject({ ok: true, missed: true });
    expect(await service.executeWorkflow(ran.id, {}, owner)).toMatchObject({ status: 'finished' });

    // GET /api/automations: the missed occurrence must not render as a green success chip.
    const feed = await buildAutomationListResponse(runtime, owner);
    const lastStatus = (workflowId: string) =>
      feed.automations.find((item) => item.workflowId === workflowId)?.lastExecution?.status;
    expect(lastStatus(missed.id)).toBe('missed');
    expect(lastStatus(ran.id)).toBe('success');

    // The workflow_status provider must not tell the agent that the missed workflow ran.
    const provided = await workflowStatusProvider.get(
      runtime,
      {
        id: randomUUID(),
        entityId: owner,
        agentId: runtime.agentId,
        roomId: randomUUID(),
        content: { text: 'Did my morning summary run today?' },
      } as Memory,
      { values: {}, data: {}, text: '' } as State
    );
    const block = (name: string) =>
      (provided.text ?? '').split('\n\n').find((entry) => entry.includes(name)) ?? '';
    expect(block('Morning summary')).toContain(
      `Last run: ⏭️ missed — scheduled for ${new Date(scheduledAtMs).toLocaleString()}, did not run`
    );
    expect(block('Morning summary')).not.toContain('finished');
    expect(block('Evening summary')).toContain('Last run: ✅ finished');
  } finally {
    await cleanup();
  }
}, 120_000);
