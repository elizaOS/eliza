import { describe, expect, mock, test } from 'bun:test';
import type { HandlerCallback, HandlerOptions, IAgentRuntime, Memory } from '@elizaos/core';
import { workflowAction } from '../../src/actions/workflow';
import { WORKFLOW_SERVICE_TYPE, type WorkflowService } from '../../src/services/workflow-service';

function makeRuntime(service: Partial<WorkflowService>): IAgentRuntime {
  return {
    agentId: 'agent-test',
    getService: (type: string) => (type === WORKFLOW_SERVICE_TYPE ? service : null),
  } as IAgentRuntime;
}

const message = {
  entityId: 'user-test',
} as Memory;

async function runAction(
  service: Partial<WorkflowService>,
  parameters: Record<string, unknown>,
  callback?: HandlerCallback
) {
  if (!workflowAction.handler) throw new Error('workflow action missing handler');
  return workflowAction.handler(
    makeRuntime(service),
    message,
    undefined,
    { parameters } as HandlerOptions,
    callback
  );
}

describe('workflowAction chat operations', () => {
  test('runs a workflow immediately and returns execution details', async () => {
    const runWorkflow = mock(() =>
      Promise.resolve({
        id: 'exec-1',
        workflowId: 'wf-1',
        mode: 'manual',
        startedAt: '2026-06-20T12:00:00.000Z',
        stoppedAt: '2026-06-20T12:00:01.000Z',
        finished: true,
        status: 'success',
      })
    );
    const callback = mock(() => Promise.resolve());

    const result = await runAction(
      { runWorkflow } as Partial<WorkflowService>,
      { action: 'run', workflowId: 'wf-1' },
      callback as HandlerCallback
    );

    expect(runWorkflow).toHaveBeenCalledWith('wf-1', { throwOnError: false });
    expect(result.success).toBe(true);
    expect(result.values).toEqual({
      workflowId: 'wf-1',
      executionId: 'exec-1',
      status: 'success',
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ workflowId: 'wf-1', executionId: 'exec-1' }),
      })
    );
  });

  test('lists revisions so chat can offer rollback choices', async () => {
    const listWorkflowRevisions = mock(() =>
      Promise.resolve([
        {
          id: 'rev-1',
          workflowId: 'wf-1',
          versionId: 'v-1',
          name: 'Previous workflow',
          active: true,
          workflow: { name: 'Previous workflow', nodes: [], connections: {} },
          createdAt: '2026-06-20T12:00:00.000Z',
          updatedAt: '2026-06-20T12:00:00.000Z',
          capturedAt: '2026-06-20T12:01:00.000Z',
          operation: 'update' as const,
        },
      ])
    );

    const result = await runAction({ listWorkflowRevisions } as Partial<WorkflowService>, {
      action: 'revisions',
      workflowId: 'wf-1',
      limit: 5,
    });

    expect(listWorkflowRevisions).toHaveBeenCalledWith('wf-1', 5);
    expect(result.success).toBe(true);
    expect(result.values).toEqual({ workflowId: 'wf-1', count: 1 });
    expect(result.data).toEqual({
      revisions: expect.arrayContaining([expect.objectContaining({ versionId: 'v-1' })]),
    });
  });

  test('restores a selected workflow revision', async () => {
    const restoreWorkflowRevision = mock(() =>
      Promise.resolve({
        id: 'wf-1',
        versionId: 'v-restored',
        name: 'Restored workflow',
        active: true,
        nodes: [],
        connections: {},
        createdAt: '2026-06-20T12:00:00.000Z',
        updatedAt: '2026-06-20T12:02:00.000Z',
      })
    );

    const result = await runAction({ restoreWorkflowRevision } as Partial<WorkflowService>, {
      action: 'restore',
      workflowId: 'wf-1',
      versionId: 'v-old',
    });

    expect(restoreWorkflowRevision).toHaveBeenCalledWith('wf-1', 'v-old');
    expect(result.success).toBe(true);
    expect(result.values).toEqual({
      workflowId: 'wf-1',
      workflowName: 'Restored workflow',
      versionId: 'v-old',
    });
    expect(result.data).toEqual({
      workflow: { id: 'wf-1', name: 'Restored workflow', active: true },
    });
  });
});
