/**
 * Verifies the generated-draft identity boundary with a deterministic model
 * and catalog-backed validation; no workflow backend or live model is used.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import { WorkflowService } from '../../src/services/workflow-service';
import { WORKFLOW_CREDENTIAL_PROVIDER_TYPE } from '../../src/types/index';

const MANUAL_TRIGGER = 'workflows-nodes-base.manualTrigger';
const WEBHOOK = 'workflows-nodes-base.webhook';

describe('WorkflowService generation boundary', () => {
  test('drops a model-invented workflow id while preserving graph node ids', async () => {
    const generatedWorkflow = {
      id: 'workflow-001',
      name: 'Chat-created Smithers proof',
      active: false,
      nodes: [
        {
          id: 'node-start',
          name: 'Start',
          type: MANUAL_TRIGGER,
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
      ],
      connections: {},
    };
    const useModel = mock(async (_modelType: unknown, params: { responseSchema?: unknown }) =>
      params.responseSchema
        ? { keywords: ['manual', 'trigger'] }
        : JSON.stringify(generatedWorkflow)
    );
    const runtime = {
      agentId: '00000000-0000-4000-8000-000000000001',
      character: { settings: {} },
      getSetting: () => undefined,
      getService: () => null,
      useModel,
    } as unknown as IAgentRuntime;
    const service = new WorkflowService(runtime);
    Object.assign(service, {
      apiClient: {
        getRegisteredNodeTypes: () => [MANUAL_TRIGGER],
        getRuntimeNodeTypeVersions: () => new Map([[MANUAL_TRIGGER, [1]]]),
      },
      serviceConfig: { apiKey: 'embedded', host: 'in-process', backend: 'embedded' },
    });

    const draft = await service.generateWorkflowDraft(
      'Create an inactive workflow with a manual trigger.'
    );

    expect(draft.id).toBeUndefined();
    expect(draft.nodes).toHaveLength(1);
    expect(draft.nodes[0]?.id).toBe('node-start');
    expect(useModel).toHaveBeenCalledTimes(2);
  });

  test('does not capability-gate Webhook when catalog defaults authentication to none', async () => {
    const checkCredentialTypes = mock((_credentialTypes: string[]) => ({
      supported: [],
      unsupported: ['httpBasicAuth', 'httpHeaderAuth', 'jwtAuth'],
    }));
    const credentialProvider = {
      resolve: mock(async () => null),
      checkCredentialTypes,
    };
    const generatedWorkflow = {
      name: 'Inbound proof',
      active: false,
      nodes: [
        {
          id: 'node-webhook',
          name: 'Inbound',
          type: WEBHOOK,
          typeVersion: 1,
          position: [0, 0],
          parameters: { path: 'smithers-proof', httpMethod: 'POST' },
        },
      ],
      connections: {},
    };
    const useModel = mock(async (_modelType: unknown, params: { responseSchema?: unknown }) =>
      params.responseSchema ? { keywords: ['webhook'] } : JSON.stringify(generatedWorkflow)
    );
    const runtime = {
      agentId: '00000000-0000-4000-8000-000000000001',
      character: { settings: {} },
      getSetting: () => undefined,
      getService: (serviceType: string) =>
        serviceType === WORKFLOW_CREDENTIAL_PROVIDER_TYPE ? credentialProvider : null,
      useModel,
    } as unknown as IAgentRuntime;
    const service = new WorkflowService(runtime);
    Object.assign(service, {
      apiClient: {
        getRegisteredNodeTypes: () => [WEBHOOK],
        getRuntimeNodeTypeVersions: () => new Map([[WEBHOOK, [1, 2]]]),
      },
      serviceConfig: { apiKey: 'embedded', host: 'in-process', backend: 'embedded' },
    });

    const draft = await service.generateWorkflowDraft('Create an unauthenticated webhook.');

    expect(draft.nodes[0]?.type).toBe(WEBHOOK);
    expect(checkCredentialTypes).not.toHaveBeenCalled();
    expect(useModel).toHaveBeenCalledTimes(2);
  });
});
