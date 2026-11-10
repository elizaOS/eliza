import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { TYPED_SCHEDULE_INPUT } from '../../src/services/phone-workflow-spec';
import { resolveSmithersWorkflowDir } from '../../src/services/smithers-runtime';
import { readApprovalReceipts } from '../../src/services/workflow-approval-receipts';
import type { WorkflowExecution } from '../../src/types/index';

const scheduledAt = '2026-11-08T07:00:00.000Z';

function execution(overrides: Partial<WorkflowExecution>): WorkflowExecution {
  return {
    id: randomUUID(),
    workflowId: `wf-${randomUUID()}`,
    workflowVersionId: 'version-1',
    workflowName: 'Morning',
    mode: 'trigger',
    status: 'finished',
    finished: true,
    startedAt: scheduledAt,
    stoppedAt: scheduledAt,
    input: {},
    ...overrides,
  } as WorkflowExecution;
}

async function storeAbsent(tenantId: string, run: WorkflowExecution): Promise<boolean> {
  const dbPath = join(resolveSmithersWorkflowDir(tenantId, run.workflowId), 'runs.sqlite');
  return access(dbPath).then(
    () => false,
    () => true
  );
}

test('a missed first occurrence of a new typed schedule has no approvals, not a 503', async () => {
  const tenantId = `tenant-${randomUUID()}`;
  const run = execution({
    input: { [TYPED_SCHEDULE_INPUT]: { scheduledAt } },
    output: { status: 'missed', scheduledAt, text: 'Missed while the agent was off.' },
  });
  expect(await storeAbsent(tenantId, run)).toBe(true);

  expect(await readApprovalReceipts(tenantId, run)).toEqual([]);
});

test('a recorded missed occurrence of a plain schedule has no approvals', async () => {
  const tenantId = `tenant-${randomUUID()}`;
  const run = execution({
    missedOccurrenceAt: scheduledAt,
    output: { status: 'missed', scheduledAt, text: 'Missed while the agent was off.' },
  });
  expect(await storeAbsent(tenantId, run)).toBe(true);

  expect(await readApprovalReceipts(tenantId, run)).toEqual([]);
});

test('a finished real run with a missing approval store still reports 503', async () => {
  const tenantId = `tenant-${randomUUID()}`;
  const run = execution({ output: { value: 56 } });
  expect(await storeAbsent(tenantId, run)).toBe(true);

  await expect(readApprovalReceipts(tenantId, run)).rejects.toMatchObject({
    statusCode: 503,
    message: 'Approval store unavailable',
  });
});

test('a not-run output without schedule provenance still reports 503', async () => {
  const tenantId = `tenant-${randomUUID()}`;
  const run = execution({
    output: { status: 'missed', scheduledAt, text: 'Looks like a missed occurrence.' },
  });
  expect(await storeAbsent(tenantId, run)).toBe(true);

  await expect(readApprovalReceipts(tenantId, run)).rejects.toMatchObject({ statusCode: 503 });
});
