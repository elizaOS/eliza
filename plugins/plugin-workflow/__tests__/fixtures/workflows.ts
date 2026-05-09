import type {
  WorkflowCredential,
  WorkflowDefinition,
  WorkflowDefinitionResponse,
  WorkflowExecution,
  WorkflowMatchResult,
  WorkflowNode,
  WorkflowTag,
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

export function createGmailTriggerNode(overrides?: Partial<WorkflowNode>): WorkflowNode {
  return {
    name: 'Gmail Trigger',
    type: 'workflows-nodes-base.gmailTrigger',
    typeVersion: 1,
    position: [250, 300],
    parameters: {},
    ...overrides,
  };
}

export function createGithubTriggerNode(overrides?: Partial<WorkflowNode>): WorkflowNode {
  return {
    name: 'GitHub Trigger',
    type: 'workflows-nodes-base.githubTrigger',
    typeVersion: 1,
    position: [250, 300],
    parameters: {},
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

export function createWorkflowWithoutPositions(): WorkflowDefinition {
  return {
    name: 'No Positions Workflow',
    nodes: [
      {
        ...createTriggerNode(),
        position: undefined as unknown as [number, number],
      },
      {
        ...createGmailNode(),
        position: undefined as unknown as [number, number],
      },
    ],
    connections: {
      'Schedule Trigger': {
        main: [[{ node: 'Gmail', type: 'main', index: 0 }]],
      },
    },
  };
}

export function createWorkflowWithBranching(): WorkflowDefinition {
  return {
    name: 'Branching Workflow',
    nodes: [createTriggerNode(), createGmailNode(), createSlackNode()],
    connections: {
      'Schedule Trigger': {
        main: [
          [
            { node: 'Gmail', type: 'main', index: 0 },
            { node: 'Slack', type: 'main', index: 0 },
          ],
        ],
      },
    },
  };
}

export function createWorkflowWithPlaceholderCreds(): WorkflowDefinition {
  return {
    name: 'Placeholder Creds Workflow',
    nodes: [
      createTriggerNode(),
      {
        ...createGmailNode(),
        credentials: {
          gmailOAuth2Api: { id: 'PLACEHOLDER', name: 'Gmail account' },
        },
      },
    ],
    connections: {
      'Schedule Trigger': {
        main: [[{ node: 'Gmail', type: 'main', index: 0 }]],
      },
    },
  };
}

export function createInvalidWorkflow_noNodes(): WorkflowDefinition {
  return {
    name: 'Invalid',
    nodes: [],
    connections: {},
  };
}

export function createInvalidWorkflow_brokenConnection(): WorkflowDefinition {
  return {
    name: 'Broken Connection',
    nodes: [createTriggerNode()],
    connections: {
      'Schedule Trigger': {
        main: [[{ node: 'NonExistent', type: 'main', index: 0 }]],
      },
    },
  };
}

export function createInvalidWorkflow_duplicateNames(): WorkflowDefinition {
  return {
    name: 'Duplicate Names',
    nodes: [createTriggerNode({ name: 'Node A' }), createGmailNode({ name: 'Node A' })],
    connections: {},
  };
}

export function createSimpleWorkflowNoCredentials(
  overrides?: Partial<WorkflowDefinition>
): WorkflowDefinition {
  return {
    name: 'Simple No-Creds Workflow',
    nodes: [
      createTriggerNode(),
      {
        name: 'Set',
        type: 'workflows-nodes-base.set',
        typeVersion: 3,
        position: [500, 300],
        parameters: {
          assignments: {
            assignments: [{ name: 'message', value: 'Hello World', type: 'string' }],
          },
          options: {},
        },
      },
    ],
    connections: {
      'Schedule Trigger': {
        main: [[{ node: 'Set', type: 'main', index: 0 }]],
      },
    },
    ...overrides,
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

export function createCredential(overrides?: Partial<WorkflowCredential>): WorkflowCredential {
  return {
    id: 'cred-001',
    name: 'Gmail OAuth2',
    type: 'gmailOAuth2Api',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function createTag(overrides?: Partial<WorkflowTag>): WorkflowTag {
  return {
    id: 'tag-001',
    name: 'user:test-user',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ============================================================================
// LLM OUTPUTS
// ============================================================================

export function createMatchResult(overrides?: Partial<WorkflowMatchResult>): WorkflowMatchResult {
  return {
    matchedWorkflowId: 'wf-001',
    confidence: 'high',
    matches: [{ id: 'wf-001', name: 'Test Workflow', score: 0.95 }],
    reason: 'Exact name match',
    ...overrides,
  };
}

export function createNoMatchResult(): WorkflowMatchResult {
  return {
    matchedWorkflowId: null,
    confidence: 'none',
    matches: [],
    reason: 'No matching workflow found',
  };
}
