import { describe, test, expect, mock } from 'bun:test';
import { activeWorkflowsProvider } from '../../../src/providers/activeWorkflows';
import { workflowStatusProvider } from '../../../src/providers/workflowStatus';
import { pendingDraftProvider } from '../../../src/providers/pendingDraft';
import { N8N_WORKFLOW_SERVICE_TYPE } from '../../../src/services/n8n-workflow-service';
import { createMockRuntime, createMockMessage, createMockState } from '../../helpers/mockRuntime';
import { createMockService } from '../../helpers/mockService';
import { createWorkflowResponse, createExecution } from '../../fixtures/workflows';

// ============================================================================
// activeWorkflowsProvider
// ============================================================================

describe('activeWorkflowsProvider', () => {
  test('returns empty when service not available', async () => {
    const runtime = createMockRuntime();
    const result = await activeWorkflowsProvider.get(
      runtime,
      createMockMessage(),
      createMockState()
    );

    expect(result.text).toBe('');
    expect(result.data).toEqual({});
  });

  test('returns empty workflows when user has none', async () => {
    const mockService = createMockService({
      listWorkflows: mock(() => Promise.resolve([])),
    });
    const runtime = createMockRuntime({
      services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
    });

    const result = await activeWorkflowsProvider.get(
      runtime,
      createMockMessage(),
      createMockState()
    );

    expect(result.data).toEqual({ workflows: [] });
    expect(result.values).toEqual({ hasWorkflows: false });
  });

  test('returns formatted workflow data', async () => {
    const mockService = createMockService({
      listWorkflows: mock(() =>
        Promise.resolve([
          createWorkflowResponse({
            id: 'wf-1',
            name: 'Stripe Payments',
            active: true,
            nodes: [{ name: 'n1' }, { name: 'n2' }, { name: 'n3' }] as any,
          }),
          createWorkflowResponse({
            id: 'wf-2',
            name: 'Gmail Automation',
            active: false,
          }),
        ])
      ),
    });
    const runtime = createMockRuntime({
      services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
    });

    const result = await activeWorkflowsProvider.get(
      runtime,
      createMockMessage(),
      createMockState()
    );

    expect(result.text).toContain('Stripe Payments');
    expect(result.text).toContain('Gmail Automation');
    expect(result.text).toContain('ACTIVE');
    expect(result.text).toContain('INACTIVE');
    expect(result.values).toEqual({ hasWorkflows: true, workflowCount: 2 });
    const workflows = result.data?.workflows as Array<Record<string, unknown>>;
    expect(workflows).toHaveLength(2);
    expect(workflows[0]).toEqual({
      id: 'wf-1',
      name: 'Stripe Payments',
      active: true,
      nodeCount: 3,
    });
  });

  test('passes userId from message', async () => {
    const mockService = createMockService();
    const runtime = createMockRuntime({
      services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
    });
    const message = createMockMessage({
      entityId: 'custom-user-0000-0000-000000000001',
    });

    await activeWorkflowsProvider.get(runtime, message, createMockState());

    expect(mockService.listWorkflows).toHaveBeenCalledWith('custom-user-0000-0000-000000000001');
  });

  test('handles service error gracefully', async () => {
    const mockService = createMockService({
      listWorkflows: mock(() => Promise.reject(new Error('Network error'))),
    });
    const runtime = createMockRuntime({
      services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
    });

    const result = await activeWorkflowsProvider.get(
      runtime,
      createMockMessage(),
      createMockState()
    );

    // Should return empty result, not throw
    expect(result.text).toBe('');
  });
});

// ============================================================================
// workflowStatusProvider
// ============================================================================

describe('workflowStatusProvider', () => {
  test('returns empty when service not available', async () => {
    const runtime = createMockRuntime();
    const result = await workflowStatusProvider.get(
      runtime,
      createMockMessage(),
      createMockState()
    );

    expect(result.text).toBe('');
  });

  test('returns message when no workflows', async () => {
    const mockService = createMockService({
      listWorkflows: mock(() => Promise.resolve([])),
    });
    const runtime = createMockRuntime({
      services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
    });

    const result = await workflowStatusProvider.get(
      runtime,
      createMockMessage(),
      createMockState()
    );

    expect(result.text).toContain('No n8n workflows');
  });

  test('includes workflow status and execution info', async () => {
    const mockService = createMockService({
      listWorkflows: mock(() =>
        Promise.resolve([
          createWorkflowResponse({
            id: 'wf-1',
            name: 'Active WF',
            active: true,
          }),
        ])
      ),
      getWorkflowExecutions: mock(() =>
        Promise.resolve([
          createExecution({
            status: 'success',
            startedAt: '2025-01-15T10:30:00.000Z',
          }),
        ])
      ),
    });
    const runtime = createMockRuntime({
      services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
    });

    const result = await workflowStatusProvider.get(
      runtime,
      createMockMessage(),
      createMockState()
    );

    expect(result.text).toContain('Active WF');
    expect(result.text).toContain('success');
    expect(result.values).toEqual({ workflowCount: 1 });
  });

  test('handles execution fetch error per workflow', async () => {
    const mockService = createMockService({
      listWorkflows: mock(() =>
        Promise.resolve([createWorkflowResponse({ id: 'wf-1', name: 'WF', active: true })])
      ),
      getWorkflowExecutions: mock(() => Promise.reject(new Error('Execution API error'))),
    });
    const runtime = createMockRuntime({
      services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
    });

    const result = await workflowStatusProvider.get(
      runtime,
      createMockMessage(),
      createMockState()
    );

    // Should still return workflow info even if executions fail
    expect(result.text).toContain('WF');
  });

  test('limits to 10 workflows', async () => {
    const mockService = createMockService({
      listWorkflows: mock(() =>
        Promise.resolve(
          Array.from({ length: 15 }, (_, i) =>
            createWorkflowResponse({ id: `wf-${i}`, name: `Workflow ${i}` })
          )
        )
      ),
    });
    const runtime = createMockRuntime({
      services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
    });

    const result = await workflowStatusProvider.get(
      runtime,
      createMockMessage(),
      createMockState()
    );

    expect(result.text).toContain('5 more workflows');
  });
});

// ============================================================================
// pendingDraftProvider
// ============================================================================

describe('pendingDraftProvider', () => {
  const draftWorkflow = {
    name: 'Gmail to Telegram',
    nodes: [
      {
        name: 'Gmail Trigger',
        type: 'n8n-nodes-base.gmailTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        name: 'Telegram Send',
        type: 'n8n-nodes-base.telegram',
        typeVersion: 1,
        position: [200, 0],
        parameters: {},
      },
    ],
    connections: {},
    settings: {},
  };

  test('returns empty when no draft in cache', async () => {
    const runtime = createMockRuntime();
    const result = await pendingDraftProvider.get(runtime, createMockMessage(), createMockState());

    expect(result.text).toBe('');
    expect(result.data).toEqual({});
  });

  test('returns draft info when draft exists', async () => {
    const runtime = createMockRuntime({
      cache: {
        'workflow_draft:user-001': {
          workflow: draftWorkflow,
          prompt: 'Send gmail to telegram',
          userId: 'user-001',
          createdAt: Date.now(),
        },
      },
    });

    const result = await pendingDraftProvider.get(
      runtime,
      createMockMessage({ entityId: 'user-001' }),
      createMockState()
    );

    expect(result.text).toContain('Gmail to Telegram');
    expect(result.text).toContain('CREATE_N8N_WORKFLOW');
    expect(result.data).toEqual({ hasPendingDraft: true });
    expect(result.values).toEqual({ hasPendingDraft: true });
  });

  test('returns empty for expired draft', async () => {
    const runtime = createMockRuntime({
      cache: {
        'workflow_draft:user-001': {
          workflow: draftWorkflow,
          prompt: 'test',
          userId: 'user-001',
          createdAt: Date.now() - 31 * 60 * 1000, // 31 min ago — expired
        },
      },
    });

    const result = await pendingDraftProvider.get(
      runtime,
      createMockMessage({ entityId: 'user-001' }),
      createMockState()
    );

    expect(result.text).toBe('');
    expect(result.data).toEqual({});
  });

  test('includes node names in text', async () => {
    const runtime = createMockRuntime({
      cache: {
        'workflow_draft:user-001': {
          workflow: draftWorkflow,
          prompt: 'test',
          userId: 'user-001',
          createdAt: Date.now(),
        },
      },
    });

    const result = await pendingDraftProvider.get(
      runtime,
      createMockMessage({ entityId: 'user-001' }),
      createMockState()
    );

    expect(result.text).toContain('Gmail Trigger');
    expect(result.text).toContain('Telegram Send');
  });

  test('scoped to user — no draft for other user', async () => {
    const runtime = createMockRuntime({
      cache: {
        'workflow_draft:user-001': {
          workflow: draftWorkflow,
          prompt: 'test',
          userId: 'user-001',
          createdAt: Date.now(),
        },
      },
    });

    const result = await pendingDraftProvider.get(
      runtime,
      createMockMessage({ entityId: 'other-user' }),
      createMockState()
    );

    expect(result.text).toBe('');
  });
});
