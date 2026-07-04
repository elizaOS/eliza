/** Integration coverage for the three workflow providers against a mocked WorkflowService (deterministic, no live model). */
import { describe, expect, mock, test } from 'bun:test';
import { activeWorkflowsProvider } from '../../../src/providers/activeWorkflows';
import { pendingDraftProvider } from '../../../src/providers/pendingDraft';
import { workflowStatusProvider } from '../../../src/providers/workflowStatus';
import { WORKFLOW_SERVICE_TYPE, WorkflowService } from '../../../src/services/workflow-service';
import {
  createExecution,
  createSlackNode,
  createTriggerNode,
  createWorkflowResponse,
} from '../../fixtures/workflows';
import { createMockMessage, createMockRuntime, createMockState } from '../../helpers/mockRuntime';
import { createMockService } from '../../helpers/mockService';

// ============================================================================
// activeWorkflowsProvider
// ============================================================================

describe('activeWorkflowsProvider', () => {
  test('matches WORKFLOW action chat contexts and uses turn cache', () => {
    expect(activeWorkflowsProvider.contexts).toEqual([
      'general',
      'automation',
      'tasks',
      'connectors',
    ]);
    expect(activeWorkflowsProvider.contextGate).toEqual({
      anyOf: ['general', 'automation', 'tasks', 'connectors'],
    });
    expect(activeWorkflowsProvider.cacheScope).toBe('turn');
  });

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
      services: { [WORKFLOW_SERVICE_TYPE]: mockService },
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
            nodes: [
              createTriggerNode({ name: 'n1', position: [0, 0] }),
              createTriggerNode({ name: 'n2', position: [100, 0] }),
              createTriggerNode({ name: 'n3', position: [200, 0] }),
            ],
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
      services: { [WORKFLOW_SERVICE_TYPE]: mockService },
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

  test('searches workflows from workflow-related message text', async () => {
    const searchQuery = 'Find the workflow that posts to Slack';
    const mockService = createMockService({
      listWorkflows: mock(() => Promise.resolve([])),
      searchWorkflows: mock(() =>
        Promise.resolve([
          createWorkflowResponse({
            id: 'wf-slack',
            name: 'Slack Alerts',
            active: true,
            nodes: [createTriggerNode({ name: 'Slack', position: [0, 0] })],
          }),
        ])
      ),
    });
    const runtime = createMockRuntime({
      services: { [WORKFLOW_SERVICE_TYPE]: mockService },
    });
    const message = createMockMessage({
      entityId: 'user-123',
      content: { text: searchQuery },
    });

    const result = await activeWorkflowsProvider.get(runtime, message, createMockState());

    expect(mockService.searchWorkflows).toHaveBeenCalledWith(searchQuery, 'user-123');
    expect(mockService.listWorkflows).not.toHaveBeenCalled();
    expect(result.text).toContain('# Matching Workflows');
    expect(result.text).toContain('Slack Alerts');
    expect(result.data).toEqual({
      workflows: [
        {
          id: 'wf-slack',
          name: 'Slack Alerts',
          active: true,
          nodeCount: 1,
        },
      ],
      searchQuery,
    });
    expect(result.values).toEqual({
      hasWorkflows: true,
      workflowCount: 1,
      workflowSearchQuery: searchQuery,
    });
  });

  test('searches sentence text through the real workflow ranking path', async () => {
    const service = Object.assign(Object.create(WorkflowService.prototype), {
      serviceType: WORKFLOW_SERVICE_TYPE,
      listWorkflows: mock(() =>
        Promise.resolve([
          createWorkflowResponse({
            id: 'wf-gmail',
            name: 'Gmail digest',
          }),
          createWorkflowResponse({
            id: 'wf-slack',
            name: 'Team notifications',
            nodes: [createTriggerNode(), createSlackNode()],
          }),
        ])
      ),
    }) as WorkflowService;
    const runtime = createMockRuntime({
      services: { [WORKFLOW_SERVICE_TYPE]: service },
    });
    const message = createMockMessage({
      entityId: 'user-123',
      content: { text: 'find the workflow that posts to Slack' },
    });

    const result = await activeWorkflowsProvider.get(runtime, message, createMockState());

    expect(service.listWorkflows).toHaveBeenCalledWith('user-123');
    expect(result.text).toContain('# Matching Workflows');
    expect(result.text).toContain('Team notifications');
    expect(result.text).not.toContain('Gmail digest');
    expect(result.data).toEqual({
      workflows: [
        {
          id: 'wf-slack',
          name: 'Team notifications',
          active: false,
          nodeCount: 2,
        },
      ],
      searchQuery: 'find the workflow that posts to Slack',
    });
  });

  test('uses full workflow list for non-workflow chat text', async () => {
    const mockService = createMockService({
      listWorkflows: mock(() =>
        Promise.resolve([createWorkflowResponse({ id: 'wf-1', name: 'Daily Summary' })])
      ),
      searchWorkflows: mock(() => Promise.resolve([])),
    });
    const runtime = createMockRuntime({
      services: { [WORKFLOW_SERVICE_TYPE]: mockService },
    });
    const message = createMockMessage({
      content: { text: 'What happened this morning?' },
    });

    const result = await activeWorkflowsProvider.get(runtime, message, createMockState());

    expect(mockService.listWorkflows).toHaveBeenCalledWith('user-001');
    expect(mockService.searchWorkflows).not.toHaveBeenCalled();
    expect(result.text).toContain('# Available Workflows');
    expect(result.data).toEqual({
      workflows: [
        {
          id: 'wf-1',
          name: 'Daily Summary',
          active: false,
          nodeCount: 2,
        },
      ],
    });
  });

  test('returns explicit empty result when workflow search has no matches', async () => {
    const searchQuery = 'search workflows for calendar cleanup';
    const mockService = createMockService({
      searchWorkflows: mock(() => Promise.resolve([])),
    });
    const runtime = createMockRuntime({
      services: { [WORKFLOW_SERVICE_TYPE]: mockService },
    });
    const message = createMockMessage({
      content: { text: searchQuery },
    });

    const result = await activeWorkflowsProvider.get(runtime, message, createMockState());

    expect(result.text).toContain(`No workflows match "${searchQuery}".`);
    expect(result.data).toEqual({ workflows: [], searchQuery });
    expect(result.values).toEqual({
      hasWorkflows: false,
      workflowCount: 0,
      workflowSearchQuery: searchQuery,
    });
  });

  test('passes userId from message', async () => {
    const mockService = createMockService();
    const runtime = createMockRuntime({
      services: { [WORKFLOW_SERVICE_TYPE]: mockService },
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
      services: { [WORKFLOW_SERVICE_TYPE]: mockService },
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
      services: { [WORKFLOW_SERVICE_TYPE]: mockService },
    });

    const result = await workflowStatusProvider.get(
      runtime,
      createMockMessage(),
      createMockState()
    );

    expect(result.text).toContain('No workflows');
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
      services: { [WORKFLOW_SERVICE_TYPE]: mockService },
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
      services: { [WORKFLOW_SERVICE_TYPE]: mockService },
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
      services: { [WORKFLOW_SERVICE_TYPE]: mockService },
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
        type: 'workflows-nodes-base.gmailTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        name: 'Telegram Send',
        type: 'workflows-nodes-base.telegram',
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
    expect(result.text).toContain('WORKFLOW');
    expect(result.data).toEqual({ hasPendingDraft: true, truncated: false });
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
