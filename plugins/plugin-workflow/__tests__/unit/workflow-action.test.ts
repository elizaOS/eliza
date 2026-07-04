/** Unit tests for the WORKFLOW action's op dispatch against a mocked WorkflowService (deterministic). */
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
  test('lists workflows for chat review and selection', async () => {
    const listWorkflows = mock(() =>
      Promise.resolve([
        {
          id: 'wf-1',
          versionId: 'v-1',
          name: 'Daily summary',
          active: true,
          nodes: [{ id: 'n1', name: 'Manual Trigger', type: 'manual', parameters: {} }],
          connections: {},
          createdAt: '2026-06-20T12:00:00.000Z',
          updatedAt: '2026-06-20T12:00:00.000Z',
        },
      ])
    );

    const result = await runAction({ listWorkflows } as Partial<WorkflowService>, {
      action: 'list',
      limit: 5,
    });

    expect(listWorkflows).toHaveBeenCalledWith('user-test');
    expect(result.success).toBe(true);
    expect(result.values).toEqual({ count: 1 });
    expect(result.data).toEqual({
      workflows: [{ id: 'wf-1', name: 'Daily summary', active: true, nodeCount: 1 }],
      total: 1,
    });
  });

  test('gets a workflow definition for chat review', async () => {
    const getWorkflow = mock(() =>
      Promise.resolve({
        id: 'wf-1',
        versionId: 'v-1',
        name: 'Daily summary',
        active: true,
        nodes: [
          { id: 'trigger', name: 'Manual Trigger', type: 'manual', parameters: {} },
          { id: 'set', name: 'Set Summary', type: 'set', parameters: {} },
        ],
        connections: {},
        createdAt: '2026-06-20T12:00:00.000Z',
        updatedAt: '2026-06-20T12:00:00.000Z',
      })
    );

    const result = await runAction({ getWorkflow } as Partial<WorkflowService>, {
      action: 'get',
      workflowId: 'wf-1',
    });

    expect(getWorkflow).toHaveBeenCalledWith('wf-1');
    expect(result.success).toBe(true);
    expect(result.values).toEqual({
      workflowId: 'wf-1',
      workflowName: 'Daily summary',
      active: true,
      nodeCount: 2,
    });
    expect(result.data).toEqual({
      workflow: expect.objectContaining({ id: 'wf-1', name: 'Daily summary' }),
    });
  });

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
      workflow: {
        id: 'wf-1',
        name: 'Restored workflow',
        active: true,
        nodeCount: 0,
      },
    });
  });

  test('diagnoses the latest failed execution for chat troubleshooting', async () => {
    const listExecutions = mock(() =>
      Promise.resolve({
        data: [
          {
            id: 'exec-failed',
            workflowId: 'wf-1',
            mode: 'manual' as const,
            startedAt: '2026-06-20T12:00:00.000Z',
            stoppedAt: '2026-06-20T12:00:01.000Z',
            finished: true,
            status: 'error' as const,
            data: {
              resultData: {
                lastNodeExecuted: 'Send Slack',
                engine: {
                  provider: 'smithers' as const,
                  nodes: 3,
                  levels: 2,
                  maxConcurrency: 2,
                  started: 3,
                  finished: 2,
                  failed: 1,
                  skipped: 0,
                  retries: 1,
                },
                error: { message: 'Missing Slack credential' },
                runData: {
                  'Send Slack': [
                    {
                      executionTime: 12,
                      error: { message: 'Missing Slack credential' },
                      data: { main: [] },
                    },
                  ],
                },
              },
            },
          },
        ],
      })
    );
    const callback = mock(() => Promise.resolve());

    const result = await runAction(
      { listExecutions } as Partial<WorkflowService>,
      { action: 'diagnose', workflowId: 'wf-1' },
      callback as HandlerCallback
    );

    expect(listExecutions).toHaveBeenCalledWith({ workflowId: 'wf-1', limit: 10 });
    expect(result.success).toBe(true);
    expect(result.values).toEqual({
      workflowId: 'wf-1',
      executionId: 'exec-failed',
      status: 'error',
      error: 'Missing Slack credential',
    });
    expect(result.text).toContain('Missing Slack credential');
    expect(result.data).toEqual({
      execution: expect.objectContaining({ id: 'exec-failed' }),
      summary: expect.objectContaining({ statusLabel: 'Failed' }),
      diagnostics: expect.stringContaining('Engine: 3 nodes / 2 levels / 2 max parallel'),
    });
    expect(String((result.data as { diagnostics: string }).diagnostics)).toContain(
      'Send Slack: error; 0 items; 12 ms; error=Missing Slack credential'
    );
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          workflowId: 'wf-1',
          executionId: 'exec-failed',
          status: 'error',
        }),
      })
    );
  });

  test('diagnoses an execution directly by id', async () => {
    const getExecutionDetail = mock(() =>
      Promise.resolve({
        id: 'exec-1',
        workflowId: 'wf-1',
        mode: 'manual' as const,
        startedAt: '2026-06-20T12:00:00.000Z',
        stoppedAt: '2026-06-20T12:00:01.000Z',
        finished: true,
        status: 'success' as const,
        data: { resultData: { runData: {} } },
      })
    );

    const result = await runAction({ getExecutionDetail } as Partial<WorkflowService>, {
      action: 'diagnose',
      executionId: 'exec-1',
    });

    expect(getExecutionDetail).toHaveBeenCalledWith('exec-1');
    expect(result.success).toBe(true);
    expect(result.values).toEqual({
      workflowId: 'wf-1',
      executionId: 'exec-1',
      status: 'success',
    });
    expect(result.data).toEqual({
      execution: expect.objectContaining({ id: 'exec-1' }),
      summary: expect.objectContaining({ statusLabel: 'Succeeded' }),
      diagnostics: expect.stringContaining('Nodes: none recorded'),
    });
  });

  test('generates evaluation samples from workflow executions for chat optimization', async () => {
    const getWorkflowEvaluationSuite = mock(() =>
      Promise.resolve({
        workflowId: 'wf-1',
        workflowName: 'Daily summary',
        workflowVersionId: 'v-1',
        generatedAt: '2026-06-20T12:00:00.000Z',
        sampleCount: 1,
        samples: [
          {
            id: 'wf-1:exec-1',
            workflowId: 'wf-1',
            workflowName: 'Daily summary',
            workflowVersionId: 'v-1',
            executionId: 'exec-1',
            createdAt: '2026-06-20T12:00:00.000Z',
            input: { mode: 'manual' as const },
            expected: { status: 'success' as const, passed: true, nodes: [] },
            score: { pass: true, value: 1, reason: 'Execution completed successfully.' },
            tags: ['smithers'],
          },
        ],
        jsonl: '{"id":"wf-1:exec-1"}',
        optimizer: {
          engine: 'smithers-gepa' as const,
          target: 'workflow-generation' as const,
          suiteName: 'daily-summary',
          caseFile: 'evals/daily-summary.jsonl',
          recommendedCommand:
            'bunx smithers-orchestrator eval <workflow.tsx> --cases evals/daily-summary.jsonl --suite daily-summary',
          recommendedEvalCommand:
            'bunx smithers-orchestrator eval <workflow.tsx> --cases evals/daily-summary.jsonl --suite daily-summary',
          recommendedOptimizeCommand: 'bunx smithers-orchestrator optimize',
          recommendedObservabilityCommand: 'bunx smithers-orchestrator observability --detach',
          recommendedMetricsCommand:
            'bunx smithers-orchestrator up <workflow.tsx> --serve --metrics',
          notes: [],
        },
      })
    );

    const result = await runAction({ getWorkflowEvaluationSuite } as Partial<WorkflowService>, {
      action: 'eval_samples',
      workflowId: 'wf-1',
      limit: 5,
    });

    expect(getWorkflowEvaluationSuite).toHaveBeenCalledWith('wf-1', 5);
    expect(result.success).toBe(true);
    expect(result.values).toEqual({
      workflowId: 'wf-1',
      count: 1,
      caseFile: 'evals/daily-summary.jsonl',
      suiteName: 'daily-summary',
    });
    expect(result.text).toContain('Save cases to evals/daily-summary.jsonl.');
    expect(result.text).toContain('Optimize: bunx smithers-orchestrator optimize');
    expect(result.data).toEqual({
      suite: expect.objectContaining({
        workflowId: 'wf-1',
        sampleCount: 1,
        jsonl: '{"id":"wf-1:exec-1"}',
      }),
    });
  });
});
