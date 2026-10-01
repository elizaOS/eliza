import { describe, expect, test } from 'bun:test';
import type { AgentRuntime } from '@elizaos/core';
import { buildAutomationListResponse } from '../../src/lib/automations-builder';
import { WORKFLOW_SERVICE_TYPE } from '../../src/services/workflow-service';

describe('Automations execution status', () => {
  test('distinguishes cancellation from failure and successful completion', async () => {
    const statuses = { cancelled: 'cancelled', failed: 'failed', finished: 'finished' };
    const service = {
      listWorkflows: async () =>
        Object.keys(statuses).map((id) => ({ id, name: id, active: false })),
      listExecutions: async ({ workflowId }: { workflowId: keyof typeof statuses }) => ({
        data: [{ id: workflowId, status: statuses[workflowId], startedAt: '2026-09-30T00:00:00Z' }],
      }),
    };
    const runtime = {
      agentId: '00000000-0000-4000-8000-000000000001',
      character: { name: 'QA' },
      getRooms: async () => [],
      getTasks: async () => [],
      getService: (name: string) => (name === WORKFLOW_SERVICE_TYPE ? service : null),
    } as unknown as AgentRuntime;
    const response = await buildAutomationListResponse(runtime, 'owner');
    expect(
      Object.fromEntries(
        response.automations.map((row) => [row.workflowId, row.lastExecution?.status])
      )
    ).toEqual({ cancelled: 'cancelled', failed: 'error', finished: 'success' });
    expect(response.executionFetchErrors).toEqual([]);
  });
});
