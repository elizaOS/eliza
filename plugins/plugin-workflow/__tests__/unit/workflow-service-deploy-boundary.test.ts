/**
 * Verifies deployment ownership and compensation at the WorkflowService facade.
 * The embedded client is a deterministic protocol peer; no model is involved.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import { DEVICE_HEALTH_CHECK_WORKFLOW_ID } from '../../src/services/embedded-workflow-service';
import { WorkflowService } from '../../src/services/workflow-service';
import { WorkflowApiError, type WorkflowDefinition } from '../../src/types/index';
import { getLocalOwnerEntityId, getUserTagName } from '../../src/utils/context';

const USER_ID = '00000000-0000-4000-8000-000000000002';

function workflow(id?: string): WorkflowDefinition {
  return {
    ...(id ? { id } : {}),
    name: 'Owned workflow',
    nodes: [],
    connections: {},
  };
}

function setWorkflow(assignments: Array<Record<string, unknown>>): WorkflowDefinition {
  return {
    name: 'Set workflow',
    nodes: [
      {
        name: 'Set Result',
        type: 'workflows-nodes-base.set',
        typeVersion: 3.4,
        position: [0, 0],
        parameters: { assignments: { assignments } },
      },
    ],
    connections: {},
  };
}

function runtime(): IAgentRuntime {
  return {
    agentId: '00000000-0000-4000-8000-000000000001',
    character: { settings: {} },
    getService: () => null,
    getEntityById: async () => null,
  } as unknown as IAgentRuntime;
}

async function harness(overrides: Record<string, unknown> = {}) {
  const ownerTagName = await getUserTagName(runtime(), USER_ID);
  const ownerTag = {
    id: 'tag-owner',
    name: ownerTagName,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const client = {
    createWorkflow: mock(async (definition: WorkflowDefinition) => ({
      ...definition,
      id: 'workflow-created',
      active: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      versionId: 'version-created',
    })),
    updateWorkflow: mock(async (_id: string, definition: WorkflowDefinition) => ({
      ...definition,
      id: 'workflow-owned',
      active: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      versionId: 'version-updated',
    })),
    deleteWorkflow: mock(async () => undefined),
    activateWorkflow: mock(async () => undefined),
    deactivateWorkflow: mock(async () => undefined),
    getOrCreateTag: mock(async () => ownerTag),
    updateWorkflowTags: mock(async () => [ownerTag]),
    listTags: mock(async () => ({ data: [ownerTag] })),
    listWorkflows: mock(async () => ({
      data: [
        {
          ...workflow('workflow-owned'),
          active: false,
          tags: [ownerTag],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          versionId: 'version-owned',
        },
      ],
    })),
    getWorkflow: mock(async () => ({
      ...workflow('workflow-owned'),
      active: false,
      tags: [ownerTag],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      versionId: 'version-owned',
    })),
    getRuntimeNodeTypeVersions: () => new Map(),
    ...overrides,
  };
  const service = new WorkflowService(runtime());
  Object.assign(service, {
    apiClient: client,
    serviceConfig: { apiKey: 'embedded', host: 'in-process', backend: 'embedded' },
  });
  return { service, client };
}

describe('WorkflowService deployment boundary', () => {
  test('shows only the untagged fixed system default to the canonical local owner', async () => {
    const untaggedDefault = {
      ...workflow(DEVICE_HEALTH_CHECK_WORKFLOW_ID),
      active: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      versionId: 'version-default',
    };
    const arbitraryUntagged = {
      ...workflow('untagged-arbitrary'),
      active: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      versionId: 'version-arbitrary',
    };
    const { service } = await harness({
      listTags: mock(async () => ({ data: [] })),
      listWorkflows: mock(async () => ({ data: [untaggedDefault, arbitraryUntagged] })),
    });

    const visible = await service.listWorkflows(getLocalOwnerEntityId(runtime()));

    expect(visible.map((item) => item.id)).toEqual([DEVICE_HEALTH_CHECK_WORKFLOW_ID]);
  });

  test('does not claim a foreign-tagged workflow that uses the reserved system id', async () => {
    const foreignTag = {
      id: 'tag-foreign',
      name: await getUserTagName(runtime(), '00000000-0000-4000-8000-000000000099'),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const foreignTaggedDefault = {
      ...workflow(DEVICE_HEALTH_CHECK_WORKFLOW_ID),
      active: true,
      tags: [foreignTag],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      versionId: 'version-foreign-default',
    };
    const { service } = await harness({
      listTags: mock(async () => ({ data: [foreignTag] })),
      listWorkflows: mock(async () => ({ data: [foreignTaggedDefault] })),
    });

    const visible = await service.listWorkflows(getLocalOwnerEntityId(runtime()));

    expect(visible).toEqual([]);
  });

  test('fills an owner execution page across foreign-only backend pages', async () => {
    const listExecutions = mock(async (params?: { limit?: number; cursor?: string }) => {
      if (!params?.cursor) {
        return {
          data: [
            { id: 'foreign-1', workflowId: 'workflow-foreign', status: 'success' },
            { id: 'foreign-2', workflowId: 'workflow-foreign', status: 'success' },
          ],
          nextCursor: 'page-2',
        };
      }
      return {
        data: [
          { id: 'owned-1', workflowId: 'workflow-owned', status: 'success' },
          { id: 'owned-2', workflowId: 'workflow-owned', status: 'success' },
        ],
      };
    });
    const { service } = await harness({ listExecutions });

    const page = await service.listExecutions({ limit: 2 }, USER_ID);

    expect(page.data.map((execution) => execution.id)).toEqual(['owned-1', 'owned-2']);
    expect(page.nextCursor).toBeUndefined();
    expect(listExecutions).toHaveBeenNthCalledWith(1, { limit: 2 });
    expect(listExecutions).toHaveBeenNthCalledWith(2, {
      limit: 2,
      cursor: 'page-2',
    });
  });

  test('removes a new workflow and fails when ownership tagging does not persist', async () => {
    const updateWorkflowTags = mock(async () => {
      throw new Error('tag store unavailable');
    });
    const { service, client } = await harness({ updateWorkflowTags });

    await expect(service.deployWorkflow(workflow(), USER_ID)).rejects.toMatchObject({
      name: 'ElizaError',
      code: 'WORKFLOW_OWNERSHIP_PERSIST_FAILED',
    });

    expect(client.deleteWorkflow).toHaveBeenCalledWith('workflow-created');
    expect(client.activateWorkflow).not.toHaveBeenCalled();
  });

  test('removes a new tagged workflow when activation fails', async () => {
    const activateWorkflow = mock(async () => {
      throw new Error('scheduler unavailable');
    });
    const { service, client } = await harness({ activateWorkflow });

    await expect(
      service.deployWorkflow(workflow(), USER_ID, { activate: true })
    ).rejects.toMatchObject({
      name: 'ElizaError',
      code: 'WORKFLOW_ACTIVATION_FAILED',
    });

    expect(client.updateWorkflowTags).toHaveBeenCalledTimes(1);
    expect(client.deleteWorkflow).toHaveBeenCalledWith('workflow-created');
  });

  test('keeps a new workflow inactive unless activation is explicit', async () => {
    const { service, client } = await harness();

    const deployed = await service.deployWorkflow(workflow(), USER_ID);

    expect(deployed.active).toBe(false);
    expect(client.activateWorkflow).not.toHaveBeenCalled();
    expect(client.deactivateWorkflow).not.toHaveBeenCalled();
  });

  test('preserves a paused workflow state when updating without a lifecycle instruction', async () => {
    const { service, client } = await harness();

    const deployed = await service.deployWorkflow(workflow('workflow-owned'), USER_ID);

    expect(deployed.active).toBe(false);
    expect(client.updateWorkflow).toHaveBeenCalledWith(
      'workflow-owned',
      expect.objectContaining({ tags: [expect.objectContaining({ id: 'tag-owner' })] })
    );
    expect(client.activateWorkflow).not.toHaveBeenCalled();
    expect(client.deactivateWorkflow).not.toHaveBeenCalled();
  });

  test('repairs a backend state drift so an active workflow stays active on save', async () => {
    const activeOwned = {
      ...workflow('workflow-owned'),
      active: true,
      tags: [
        {
          id: 'tag-owner',
          name: await getUserTagName(runtime(), USER_ID),
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      versionId: 'version-owned',
    };
    const { service, client } = await harness({
      listWorkflows: mock(async () => ({ data: [activeOwned] })),
      getWorkflow: mock(async () => activeOwned),
    });

    const deployed = await service.deployWorkflow(workflow('workflow-owned'), USER_ID);

    expect(deployed.active).toBe(true);
    expect(client.activateWorkflow).toHaveBeenCalledWith('workflow-owned');
    expect(client.deactivateWorkflow).not.toHaveBeenCalled();
  });

  test('rejects an update that is not in the caller ownership scope', async () => {
    const { service, client } = await harness({
      listTags: mock(async () => ({ data: [] })),
    });

    await expect(
      service.deployWorkflow(workflow('workflow-foreign'), USER_ID)
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(client.updateWorkflow).not.toHaveBeenCalled();
    expect(client.createWorkflow).not.toHaveBeenCalled();
  });

  test('surfaces an owned update failure without creating a replacement', async () => {
    const updateWorkflow = mock(async () => {
      throw new WorkflowApiError('database unavailable', 503);
    });
    const { service, client } = await harness({ updateWorkflow });

    await expect(service.deployWorkflow(workflow('workflow-owned'), USER_ID)).rejects.toThrow(
      'database unavailable'
    );

    expect(client.createWorkflow).not.toHaveBeenCalled();
  });

  test('normalizes a typed legacy assignment before persistence', async () => {
    const { service, client } = await harness();

    await service.deployWorkflow(
      setWorkflow([
        {
          name: 'message',
          type: 'stringValue',
          stringValue: 'smithers-final-20260717',
        },
      ]),
      USER_ID
    );

    expect(client.createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: [
          expect.objectContaining({
            parameters: {
              assignments: {
                assignments: [
                  {
                    name: 'message',
                    type: 'string',
                    value: 'smithers-final-20260717',
                  },
                ],
              },
            },
          }),
        ],
      })
    );
  });

  test('persists an explicit empty-string assignment', async () => {
    const { service, client } = await harness();

    await service.deployWorkflow(
      setWorkflow([{ name: 'message', type: 'string', value: '' }]),
      USER_ID
    );

    expect(client.createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: [
          expect.objectContaining({
            parameters: {
              assignments: {
                assignments: [{ name: 'message', type: 'string', value: '' }],
              },
            },
          }),
        ],
      })
    );
  });

  test('rejects a value-less assignment before persistence', async () => {
    const { service, client } = await harness();

    await expect(
      service.deployWorkflow(setWorkflow([{ name: 'message', type: 'stringValue' }]), USER_ID)
    ).rejects.toMatchObject({
      name: 'ElizaError',
      code: 'WORKFLOW_SET_PARAMETERS_INVALID',
    });

    expect(client.createWorkflow).not.toHaveBeenCalled();
    expect(client.updateWorkflow).not.toHaveBeenCalled();
  });
});
