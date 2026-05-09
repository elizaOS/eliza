import { mock } from 'bun:test';
import type { WorkflowService } from '../../src/services/workflow-service';
import { createExecution, createWorkflowResponse } from '../fixtures/workflows';

export function createMockService(
  overrides?: Partial<Record<keyof WorkflowService, unknown>>
): WorkflowService {
  return {
    serviceType: 'workflow',
    generateWorkflowDraft: mock(() =>
      Promise.resolve({
        name: 'Generated Workflow',
        nodes: [
          {
            name: 'Schedule Trigger',
            type: 'workflows-nodes-base.scheduleTrigger',
            typeVersion: 1,
            position: [0, 0],
            parameters: {},
          },
          {
            name: 'Gmail',
            type: 'workflows-nodes-base.gmail',
            typeVersion: 2,
            position: [200, 0],
            parameters: { operation: 'send' },
            credentials: {
              gmailOAuth2Api: {
                id: '{{CREDENTIAL_ID}}',
                name: 'Gmail Account',
              },
            },
          },
        ],
        connections: {
          'Schedule Trigger': {
            main: [[{ node: 'Gmail', type: 'main', index: 0 }]],
          },
        },
        _meta: {
          assumptions: ['Using Gmail as email service'],
          suggestions: [],
          requiresClarification: [],
        },
      })
    ),
    modifyWorkflowDraft: mock(() =>
      Promise.resolve({
        name: 'Modified Workflow',
        nodes: [
          {
            name: 'Schedule Trigger',
            type: 'workflows-nodes-base.scheduleTrigger',
            typeVersion: 1,
            position: [0, 0],
            parameters: {},
          },
          {
            name: 'Outlook',
            type: 'workflows-nodes-base.microsoftOutlook',
            typeVersion: 2,
            position: [200, 0],
            parameters: { operation: 'send' },
            credentials: {
              microsoftOutlookOAuth2Api: {
                id: '{{CREDENTIAL_ID}}',
                name: 'Outlook Account',
              },
            },
          },
        ],
        connections: {
          'Schedule Trigger': {
            main: [[{ node: 'Outlook', type: 'main', index: 0 }]],
          },
        },
        _meta: {
          assumptions: ['Using Outlook as email service'],
          suggestions: [],
          requiresClarification: [],
        },
      })
    ),
    deployWorkflow: mock(() =>
      Promise.resolve({
        id: 'wf-001',
        name: 'Generated Workflow',
        active: true,
        nodeCount: 2,
        missingCredentials: [],
      })
    ),
    listWorkflows: mock(() =>
      Promise.resolve([
        createWorkflowResponse({
          id: 'wf-001',
          name: 'Workflow A',
          active: true,
        }),
        createWorkflowResponse({
          id: 'wf-002',
          name: 'Workflow B',
          active: false,
        }),
      ])
    ),
    activateWorkflow: mock(() => Promise.resolve()),
    deactivateWorkflow: mock(() => Promise.resolve()),
    deleteWorkflow: mock(() => Promise.resolve()),
    getWorkflowExecutions: mock(() =>
      Promise.resolve([
        createExecution({ id: 'exec-001', status: 'success' }),
        createExecution({ id: 'exec-002', status: 'error' }),
      ])
    ),
    getWorkflow: mock(() => Promise.resolve(createWorkflowResponse())),
    getExecutionDetail: mock(() => Promise.resolve(createExecution())),
    listExecutions: mock(() =>
      Promise.resolve({
        data: [
          createExecution({ id: 'exec-001', status: 'success' }),
          createExecution({ id: 'exec-002', status: 'error' }),
        ],
        nextCursor: undefined,
      })
    ),
    ...overrides,
  } as unknown as WorkflowService;
}
