/** Exercises the chat WORKFLOW action against a deterministic service boundary, including authoring, execution widgets, administration, validation, and visible failures. */

import { describe, expect, mock, test } from 'bun:test';
import type {
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from '@elizaos/core';
import { workflowAction } from '../../src/actions/workflow';
import { WORKFLOW_SERVICE_TYPE, type WorkflowService } from '../../src/services/workflow-service';

const ownerId = '00000000-0000-4000-8000-000000000010' as UUID;
const workflowId = 'workflow-1';
const executionId = 'execution-1';
const workflow = {
  id: workflowId,
  name: 'Daily brief',
  language: 'tsx' as const,
  source: "import 'smthrs'; export default {};",
  active: false,
  steps: [{ id: 'collect', label: 'Collect', kind: 'task' }],
  widgets: [{ id: 'summary', title: 'Summary', surface: 'status' as const }],
  createdAt: '2026-08-14T00:00:00.000Z',
  updatedAt: '2026-08-14T00:00:00.000Z',
  versionId: 'version-1',
};
const execution = {
  id: executionId,
  workflowId,
  workflowVersionId: 'version-1',
  workflowName: workflow.name,
  mode: 'chat' as const,
  status: 'queued' as const,
  finished: false,
  startedAt: '2026-08-14T00:00:00.000Z',
  input: {},
};

function serviceHarness() {
  const service = {
    generateWorkflowDraft: mock(async () => workflow),
    modifyWorkflowDraft: mock(async () => ({ ...workflow, name: 'Edited brief' })),
    deployWorkflow: mock(async () => ({
      id: workflowId,
      name: workflow.name,
      active: false,
      stepCount: 1,
    })),
    listWorkflows: mock(async () => [workflow]),
    searchWorkflows: mock(async () => [workflow]),
    getWorkflow: mock(async () => workflow),
    updateWorkflow: mock(async (_id: string, update: typeof workflow) => update),
    activateWorkflow: mock(async () => ({ ...workflow, active: true })),
    deactivateWorkflow: mock(async () => workflow),
    deleteWorkflow: mock(async () => undefined),
    startWorkflow: mock(async () => execution),
    cancelExecution: mock(async () => ({ ...execution, status: 'cancelled' as const })),
    getWorkflowExecutions: mock(async () => [execution]),
    getWorkflowRevisions: mock(async () => [{ id: 'revision-1' }]),
    restoreWorkflowRevision: mock(async () => workflow),
    getWorkflowEvaluationSuite: mock(async () => ({ samples: [] })),
  };
  return service as unknown as WorkflowService & typeof service;
}

function runtimeFor(service: WorkflowService | null): IAgentRuntime {
  return {
    agentId: '00000000-0000-4000-8000-000000000001' as UUID,
    character: { name: 'Workflow action test' },
    getSetting: (key: string) => (key === 'ELIZA_ADMIN_ENTITY_ID' ? ownerId : null),
    getService: (type: string) => (type === WORKFLOW_SERVICE_TYPE ? service : null),
  } as unknown as IAgentRuntime;
}

const message = {
  id: '00000000-0000-4000-8000-000000000020' as UUID,
  agentId: '00000000-0000-4000-8000-000000000001' as UUID,
  entityId: '00000000-0000-4000-8000-000000000021' as UUID,
  roomId: '00000000-0000-4000-8000-000000000022' as UUID,
  content: { text: 'Create a daily brief' },
  createdAt: 0,
} satisfies Memory;

async function run(
  service: WorkflowService,
  parameters: Record<string, unknown>,
  callback?: HandlerCallback
): Promise<ActionResult> {
  return (await workflowAction.handler?.(
    runtimeFor(service),
    message,
    undefined,
    { parameters } as HandlerOptions,
    callback
  )) as ActionResult;
}

describe('WORKFLOW chat action', () => {
  test('declares owner-only workflow routing and validates service availability', async () => {
    expect(workflowAction.roleGate).toEqual({ minRole: 'OWNER' });
    expect(workflowAction.contextGate).toEqual({
      anyOf: ['general', 'automation', 'tasks', 'agent_internal'],
    });
    expect(await workflowAction.validate?.(runtimeFor(serviceHarness()), message)).toBe(true);
    expect(await workflowAction.validate?.(runtimeFor(null), message)).toBe(false);
  });

  test('creates and modifies Smithers workflows for the canonical owner', async () => {
    const service = serviceHarness();
    const callback = mock(async () => undefined);
    const created = await run(service, { action: 'create', seedPrompt: 'Daily brief' }, callback);

    expect(created.success).toBe(true);
    expect(service.generateWorkflowDraft).toHaveBeenCalledWith('Daily brief', { userId: ownerId });
    expect(service.deployWorkflow).toHaveBeenCalledWith(workflow, ownerId, { activate: false });
    expect(created.data).toEqual({
      workflow,
      widget: { type: 'workflow', workflowId },
    });
    expect(callback).toHaveBeenCalledWith({
      text: 'Created “Daily brief” as an inactive Smithers workflow.',
      action: 'WORKFLOW',
      metadata: { workflowId },
    });

    const modified = await run(service, {
      action: 'modify',
      workflowId,
      instruction: 'Add approval',
    });
    expect(modified.success).toBe(true);
    expect(service.modifyWorkflowDraft).toHaveBeenCalledWith(workflow, 'Add approval', {
      userId: ownerId,
    });
    expect(service.updateWorkflow).toHaveBeenCalledWith(
      workflowId,
      expect.objectContaining({ name: 'Edited brief', active: false }),
      ownerId
    );
  });

  test('starts chat runs with a hydratable visual widget', async () => {
    const service = serviceHarness();
    const callback = mock(async () => undefined);
    const result = await run(
      service,
      { action: 'run', workflowId, input: { topic: 'release' } },
      callback
    );

    expect(service.startWorkflow).toHaveBeenCalledWith(
      workflowId,
      { mode: 'chat', input: { topic: 'release' } },
      ownerId
    );
    expect(result.success).toBe(true);
    expect(result.text).toContain('[WORKFLOW]');
    expect(result.text).toContain('"nodeId":"collect"');
    expect(result.data).toEqual({
      execution,
      widget: { type: 'workflow-run', workflowId, runId: executionId },
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'WORKFLOW',
        metadata: { workflowId, runId: executionId },
      })
    );
  });

  test('covers administration branches, bounded history, and explicit invalid input', async () => {
    const service = serviceHarness();
    for (const parameters of [
      { action: 'list' },
      { action: 'search', query: 'brief' },
      { action: 'get', workflowId },
      { action: 'activate', workflowId },
      { action: 'deactivate', workflowId },
      { action: 'delete', workflowId },
      { action: 'cancel_run', executionId },
      { action: 'executions', workflowId, limit: 999 },
      { action: 'revisions', workflowId, limit: 0 },
      { action: 'restore', workflowId, versionId: 'version-1' },
      { action: 'eval_samples', workflowId },
    ]) {
      expect((await run(service, parameters)).success).toBe(true);
    }
    expect(service.getWorkflowExecutions).toHaveBeenCalledWith(workflowId, 50, ownerId);
    expect(service.getWorkflowRevisions).toHaveBeenCalledWith(workflowId, 1, ownerId);

    expect((await run(service, {})).text).toContain('action is required');
    expect((await run(service, { action: 'get' })).text).toBe('workflowId is required.');
    expect((await run(service, { action: 'cancel_run' })).text).toBe('executionId is required.');
    expect((await run(service, { action: 'restore', workflowId })).text).toBe(
      'versionId is required.'
    );

    service.getWorkflow = mock(async () => {
      throw new Error('not found');
    });
    expect((await run(service, { action: 'get', workflowId })).text).toBe('not found');
  });
});
