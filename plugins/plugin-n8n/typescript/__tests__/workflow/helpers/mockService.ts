import { vi } from "vitest";
import type { N8nWorkflowService } from "../../../workflow/services/n8n-workflow-service";
import { createExecution, createWorkflowResponse } from "../fixtures/workflows";

export function createMockService(
  overrides?: Partial<Record<keyof N8nWorkflowService, unknown>>
): N8nWorkflowService {
  return {
    serviceType: "n8n_workflow",
    generateWorkflowDraft: vi.fn(() =>
      Promise.resolve({
        name: "Generated Workflow",
        nodes: [
          {
            name: "Schedule Trigger",
            type: "n8n-nodes-base.scheduleTrigger",
            typeVersion: 1,
            position: [0, 0],
            parameters: {},
          },
          {
            name: "Gmail",
            type: "n8n-nodes-base.gmail",
            typeVersion: 2,
            position: [200, 0],
            parameters: { operation: "send" },
            credentials: {
              gmailOAuth2Api: { id: "{{CREDENTIAL_ID}}", name: "Gmail Account" },
            },
          },
        ],
        connections: {
          "Schedule Trigger": {
            main: [[{ node: "Gmail", type: "main", index: 0 }]],
          },
        },
        _meta: {
          assumptions: ["Using Gmail as email service"],
          suggestions: [],
          requiresClarification: [],
        },
      })
    ),
    modifyWorkflowDraft: vi.fn(() =>
      Promise.resolve({
        name: "Modified Workflow",
        nodes: [
          {
            name: "Schedule Trigger",
            type: "n8n-nodes-base.scheduleTrigger",
            typeVersion: 1,
            position: [0, 0],
            parameters: {},
          },
          {
            name: "Outlook",
            type: "n8n-nodes-base.microsoftOutlook",
            typeVersion: 2,
            position: [200, 0],
            parameters: { operation: "send" },
            credentials: {
              microsoftOutlookOAuth2Api: { id: "{{CREDENTIAL_ID}}", name: "Outlook Account" },
            },
          },
        ],
        connections: {
          "Schedule Trigger": {
            main: [[{ node: "Outlook", type: "main", index: 0 }]],
          },
        },
        _meta: {
          assumptions: ["Using Outlook as email service"],
          suggestions: [],
          requiresClarification: [],
        },
      })
    ),
    deployWorkflow: vi.fn(() =>
      Promise.resolve({
        id: "wf-001",
        name: "Generated Workflow",
        active: true,
        nodeCount: 2,
        missingCredentials: [],
      })
    ),
    listWorkflows: vi.fn(() =>
      Promise.resolve([
        createWorkflowResponse({
          id: "wf-001",
          name: "Workflow A",
          active: true,
        }),
        createWorkflowResponse({
          id: "wf-002",
          name: "Workflow B",
          active: false,
        }),
      ])
    ),
    activateWorkflow: vi.fn(() => Promise.resolve()),
    deactivateWorkflow: vi.fn(() => Promise.resolve()),
    deleteWorkflow: vi.fn(() => Promise.resolve()),
    getWorkflowExecutions: vi.fn(() =>
      Promise.resolve([
        createExecution({ id: "exec-001", status: "success" }),
        createExecution({ id: "exec-002", status: "error" }),
      ])
    ),
    getExecutionDetail: vi.fn(() => Promise.resolve(createExecution())),
    ...overrides,
  } as unknown as N8nWorkflowService;
}
