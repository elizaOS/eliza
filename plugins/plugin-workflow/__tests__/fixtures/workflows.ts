import type {
  WorkflowDefinition,
  WorkflowDefinitionResponse,
  WorkflowExecution,
  WorkflowNode,
} from '../../src/types/index';

// ============================================================================
// NODES
// ============================================================================

export function createTriggerNode(overrides?: Partial<WorkflowNode>): WorkflowNode {
  return {
    name: 'Schedule Trigger',
    type: 'workflows-nodes-base.scheduleTrigger',
    typeVersion: 1,
    position: [250, 300],
    parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 1 }] } },
    ...overrides,
  };
}

export function createGmailNode(overrides?: Partial<WorkflowNode>): WorkflowNode {
  return {
    name: 'Gmail',
    type: 'workflows-nodes-base.gmail',
    typeVersion: 2,
    position: [500, 300],
    parameters: {
      resource: 'message',
      operation: 'send',
      sendTo: 'test@example.com',
      subject: 'Test',
      message: 'Hello',
    },
    credentials: {
      gmailOAuth2Api: { id: 'cred-123', name: 'Gmail account' },
    },
    ...overrides,
  };
}

export function createSlackNode(overrides?: Partial<WorkflowNode>): WorkflowNode {
  return {
    name: 'Slack',
    type: 'workflows-nodes-base.slack',
    typeVersion: 2,
    position: [750, 300],
    parameters: {
      resource: 'message',
      operation: 'post',
      channel: '#general',
      text: 'Hello from workflows',
    },
    credentials: {
      slackApi: { id: 'cred-456', name: 'Slack Bot' },
    },
    ...overrides,
  };
}

// ============================================================================
// WORKFLOWS
// ============================================================================

export function createValidWorkflow(overrides?: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    name: 'Test Workflow',
    nodes: [createTriggerNode(), createGmailNode()],
    connections: {
      'Schedule Trigger': {
        main: [[{ node: 'Gmail', type: 'main', index: 0 }]],
      },
    },
    ...overrides,
  };
}

export function createInvalidWorkflow_noNodes(): WorkflowDefinition {
  return {
    name: 'Invalid',
    nodes: [],
    connections: {},
  };
}

export function createInvalidWorkflow_duplicateNames(): WorkflowDefinition {
  return {
    name: 'Duplicate Names',
    nodes: [createTriggerNode({ name: 'Node A' }), createGmailNode({ name: 'Node A' })],
    connections: {},
  };
}

// ============================================================================
// API RESPONSES
// ============================================================================

export function createWorkflowResponse(
  overrides?: Partial<WorkflowDefinitionResponse>
): WorkflowDefinitionResponse {
  return {
    ...createValidWorkflow(),
    id: 'wf-001',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    versionId: 'v1',
    active: false,
    ...overrides,
  };
}

export function createExecution(overrides?: Partial<WorkflowExecution>): WorkflowExecution {
  return {
    id: 'exec-001',
    finished: true,
    mode: 'manual',
    startedAt: '2025-01-01T12:00:00.000Z',
    stoppedAt: '2025-01-01T12:00:05.000Z',
    workflowId: 'wf-001',
    status: 'success',
    ...overrides,
  };
}
