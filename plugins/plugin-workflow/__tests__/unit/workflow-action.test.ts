/** Unit tests for the WORKFLOW action's op dispatch against a mocked WorkflowService (deterministic). */
import { describe, expect, mock, test } from 'bun:test';
import type { HandlerCallback, HandlerOptions, IAgentRuntime, Memory } from '@elizaos/core';
import { workflowAction } from '../../src/actions/workflow';
import { clearPendingWorkflowDraft } from '../../src/lib/pending-workflow-draft';
import { WORKFLOW_SERVICE_TYPE, type WorkflowService } from '../../src/services/workflow-service';
import { createValidWorkflow, createWorkflowResponse } from '../fixtures/workflows';

function makeRuntime(
  service: Partial<WorkflowService>,
  canonicalOwnerId = 'user-test',
  cache = new Map<string, unknown>(),
  cacheBoundary: {
    deleteCache?: IAgentRuntime['deleteCache'];
    reportError?: IAgentRuntime['reportError'];
  } = {}
): IAgentRuntime {
  return {
    agentId: 'agent-test',
    character: { name: 'Workflow Test Agent', settings: {} },
    getSetting: (key: string) => (key === 'ELIZA_ADMIN_ENTITY_ID' ? canonicalOwnerId : undefined),
    getService: (type: string) => (type === WORKFLOW_SERVICE_TYPE ? service : null),
    getCache: <T>(key: string) => Promise.resolve(cache.get(key) as T | undefined),
    setCache: <T>(key: string, value: T) => {
      cache.set(key, value);
      return Promise.resolve(true);
    },
    deleteCache: cacheBoundary.deleteCache ?? ((key: string) => Promise.resolve(cache.delete(key))),
    reportError: cacheBoundary.reportError ?? (() => {}),
  } as IAgentRuntime;
}

const message = {
  id: 'message-test',
  entityId: 'user-test',
  roomId: 'room-test',
  content: { text: 'Manage my workflows.' },
} as Memory;

async function runAction(
  service: Partial<WorkflowService>,
  parameters: Record<string, unknown>,
  callback?: HandlerCallback,
  identity: {
    canonicalOwnerId?: string;
    messageEntityId?: string;
    cache?: Map<string, unknown>;
    deleteCache?: IAgentRuntime['deleteCache'];
    reportError?: IAgentRuntime['reportError'];
  } = {}
) {
  if (!workflowAction.handler) throw new Error('workflow action missing handler');
  return workflowAction.handler(
    makeRuntime(service, identity.canonicalOwnerId, identity.cache, {
      deleteCache: identity.deleteCache,
      reportError: identity.reportError,
    }),
    {
      ...message,
      entityId: identity.messageEntityId ?? message.entityId,
    } as Memory,
    undefined,
    { parameters } as HandlerOptions,
    callback
  );
}

describe('workflowAction chat operations', () => {
  test('treats an already-absent pending draft delete as idempotent', async () => {
    const deleteCache = mock(() => Promise.resolve(false));

    await expect(
      clearPendingWorkflowDraft({ deleteCache } as IAgentRuntime, {
        ownerEntityId: 'user-test',
        roomId: 'room-test',
        cacheKey: 'workflow_draft:v2:user-test:room:room-test',
      })
    ).resolves.toBeUndefined();
    expect(deleteCache).toHaveBeenCalledTimes(1);
  });

  test('creates and lists a workflow under the same chat owner', async () => {
    const storedByOwner = new Map<string, ReturnType<typeof createWorkflowResponse>[]>();
    const draft = createValidWorkflow();
    const stored = createWorkflowResponse({ id: 'wf-created', name: draft.name });
    const generateWorkflowDraft = mock((_seedPrompt: string, _options: { userId: string }) =>
      Promise.resolve(draft)
    );
    const deployWorkflow = mock(
      (
        workflow: ReturnType<typeof createValidWorkflow>,
        ownerId: string,
        _options?: { activate?: boolean }
      ) => {
        storedByOwner.set(ownerId, [stored]);
        return Promise.resolve({
          id: stored.id,
          name: workflow.name,
          active: Boolean(stored.active),
          nodeCount: workflow.nodes.length,
          missingCredentials: [],
        });
      }
    );
    const listWorkflows = mock((ownerId: string) =>
      Promise.resolve(storedByOwner.get(ownerId) ?? [])
    );
    const service = {
      generateWorkflowDraft,
      deployWorkflow,
      listWorkflows,
    } as Partial<WorkflowService>;

    const created = await runAction(service, {
      action: 'create',
      seedPrompt: 'Send me a daily summary.',
    });
    const listed = await runAction(service, { action: 'list' });

    expect(generateWorkflowDraft).toHaveBeenCalledWith('Send me a daily summary.', {
      userId: 'user-test',
    });
    expect(deployWorkflow).toHaveBeenCalledWith(draft, 'user-test', {
      activate: undefined,
    });
    expect(listWorkflows).toHaveBeenCalledWith('user-test');
    expect(created.success).toBe(true);
    expect(created.values).toMatchObject({ active: false });
    expect(listed.success).toBe(true);
    expect(listed.data).toEqual({
      workflows: [{ id: 'wf-created', name: 'Test Workflow', active: false, nodeCount: 2 }],
      total: 1,
    });
  });

  test('stores a linked connector owner workflow under the canonical app identity', async () => {
    const storedByOwner = new Map<string, ReturnType<typeof createWorkflowResponse>[]>();
    const draft = createValidWorkflow();
    const stored = createWorkflowResponse({ id: 'wf-linked-owner', name: draft.name });
    const generateWorkflowDraft = mock((_prompt: string, _options: { userId: string }) =>
      Promise.resolve(draft)
    );
    const deployWorkflow = mock(
      (
        definition: ReturnType<typeof createValidWorkflow>,
        ownerId: string,
        _options?: { activate?: boolean }
      ) => {
        storedByOwner.set(ownerId, [stored]);
        return Promise.resolve({
          id: stored.id,
          name: definition.name,
          active: false,
          nodeCount: definition.nodes.length,
          missingCredentials: [],
        });
      }
    );
    const listWorkflows = mock((ownerId: string) =>
      Promise.resolve(storedByOwner.get(ownerId) ?? [])
    );
    const getWorkflow = mock((workflowId: string, ownerId: string) => {
      const owned = storedByOwner.get(ownerId)?.find((item) => item.id === workflowId);
      if (!owned) return Promise.reject(new Error(`Workflow not found: ${workflowId}`));
      return Promise.resolve(owned);
    });
    const service = {
      generateWorkflowDraft,
      deployWorkflow,
      listWorkflows,
      getWorkflow,
    } as Partial<WorkflowService>;
    const identity = {
      canonicalOwnerId: 'canonical-app-owner',
      messageEntityId: 'linked-slack-owner',
    };

    const created = await runAction(
      service,
      { action: 'create', seedPrompt: 'Post a recap to Slack.' },
      undefined,
      identity
    );
    const listed = await runAction(service, { action: 'list' }, undefined, {
      ...identity,
      messageEntityId: 'canonical-app-owner',
    });
    const opened = await runAction(
      service,
      { action: 'get', workflowId: 'wf-linked-owner' },
      undefined,
      { ...identity, messageEntityId: 'canonical-app-owner' }
    );

    expect(generateWorkflowDraft).toHaveBeenCalledWith('Post a recap to Slack.', {
      userId: 'canonical-app-owner',
    });
    expect(deployWorkflow).toHaveBeenCalledWith(draft, 'canonical-app-owner', {
      activate: undefined,
    });
    expect(listWorkflows).toHaveBeenCalledWith('canonical-app-owner');
    expect(getWorkflow).toHaveBeenCalledWith('wf-linked-owner', 'canonical-app-owner');
    expect(created.success).toBe(true);
    expect(listed.success).toBe(true);
    expect(opened.success).toBe(true);
  });

  test('returns unresolved creation questions without deploying or activating the draft', async () => {
    const draft = createValidWorkflow({
      _meta: {
        requiresClarification: [
          {
            kind: 'recipient',
            platform: 'gmail',
            question: 'Who should receive the summary?',
            paramPath: 'nodes["Gmail"].parameters.sendTo',
          },
        ],
      },
    });
    const generateWorkflowDraft = mock(() => Promise.resolve(draft));
    const deployWorkflow = mock(() =>
      Promise.resolve({
        id: 'must-not-exist',
        name: draft.name,
        active: true,
        nodeCount: draft.nodes.length,
        missingCredentials: [],
      })
    );
    const callback = mock(() => Promise.resolve());

    const result = await runAction(
      { generateWorkflowDraft, deployWorkflow } as Partial<WorkflowService>,
      {
        action: 'create',
        seedPrompt: 'Email a summary every day.',
        active: true,
      },
      callback as HandlerCallback
    );

    expect(deployWorkflow).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.values).toEqual({ status: 'needs_clarification', clarificationCount: 1 });
    expect(result.data).toEqual({
      status: 'needs_clarification',
      draft,
      clarifications: [
        expect.objectContaining({
          question: 'Who should receive the summary?',
          paramPath: 'nodes["Gmail"].parameters.sendTo',
        }),
      ],
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          status: 'needs_clarification',
          clarificationCount: 1,
        }),
      })
    );
  });

  test('resolves a pending chat draft and exposes the deployed workflow in the canonical feed', async () => {
    const ownerId = 'canonical-app-owner';
    const draft = createValidWorkflow({
      _meta: {
        requiresClarification: [
          {
            kind: 'recipient',
            platform: 'gmail',
            question: 'Who should receive the summary?',
            paramPath: 'nodes["Gmail"].parameters.sendTo',
          },
        ],
      },
    });
    const storedByOwner = new Map<string, ReturnType<typeof createWorkflowResponse>[]>();
    const deployWorkflow = mock(
      (resolved: ReturnType<typeof createValidWorkflow>, canonicalOwnerId: string) => {
        const recipient = resolved.nodes.find((node) => node.name === 'Gmail')?.parameters.sendTo;
        expect(recipient).toBe('owner@example.com');
        expect(resolved._meta?.requiresClarification).toBeUndefined();
        const stored = createWorkflowResponse({ id: 'wf-resolved', name: resolved.name });
        storedByOwner.set(canonicalOwnerId, [stored]);
        return Promise.resolve({
          id: stored.id,
          name: stored.name,
          active: false,
          nodeCount: stored.nodes.length,
          missingCredentials: [],
        });
      }
    );
    const listWorkflows = mock((canonicalOwnerId: string) =>
      Promise.resolve(storedByOwner.get(canonicalOwnerId) ?? [])
    );
    const service = { deployWorkflow, listWorkflows } as Partial<WorkflowService>;
    const identity = { canonicalOwnerId: ownerId, messageEntityId: 'linked-slack-owner' };

    const resolved = await runAction(
      service,
      {
        action: 'create',
        draft,
        resolutions: [
          { paramPath: 'nodes["Gmail"].parameters.sendTo', value: 'owner@example.com' },
        ],
      },
      undefined,
      identity
    );
    const listed = await runAction(service, { action: 'list' }, undefined, {
      canonicalOwnerId: ownerId,
      messageEntityId: ownerId,
    });

    expect(deployWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ name: draft.name }),
      ownerId,
      { activate: undefined }
    );
    expect(draft._meta?.requiresClarification).toHaveLength(1);
    expect(listWorkflows).toHaveBeenCalledWith(ownerId);
    expect(resolved.success).toBe(true);
    expect(listed.data).toEqual({
      workflows: [{ id: 'wf-resolved', name: 'Test Workflow', active: false, nodeCount: 2 }],
      total: 1,
    });
  });

  test('retains a resolved pending draft until deployment returns a verified id', async () => {
    const cache = new Map<string, unknown>();
    const draft = createValidWorkflow({
      _meta: {
        requiresClarification: [
          {
            kind: 'recipient',
            question: 'Who should receive the summary?',
            paramPath: 'nodes["Gmail"].parameters.sendTo',
          },
        ],
      },
    });
    let deployAttempts = 0;
    const deployWorkflow = mock(
      async (resolved: ReturnType<typeof createValidWorkflow>, _ownerId: string) => {
        expect(resolved.nodes.find((node) => node.name === 'Gmail')?.parameters.sendTo).toBe(
          'owner@example.com'
        );
        deployAttempts += 1;
        if (deployAttempts === 1) {
          return {
            id: '',
            name: resolved.name,
            active: false,
            nodeCount: resolved.nodes.length,
            missingCredentials: [],
          };
        }
        if (deployAttempts === 2) {
          throw new Error('temporary deployment failure');
        }
        return {
          id: 'wf-retried',
          name: resolved.name,
          active: false,
          nodeCount: resolved.nodes.length,
          missingCredentials: [],
        };
      }
    );
    const service = {
      generateWorkflowDraft: mock(() => Promise.resolve(draft)),
      deployWorkflow,
    } as Partial<WorkflowService>;
    const identity = { cache };

    const pending = await runAction(
      service,
      { action: 'create', seedPrompt: 'Email a summary every day.' },
      undefined,
      identity
    );
    expect(pending.values).toMatchObject({ status: 'needs_clarification' });
    expect(cache.size).toBe(1);

    const resolution = {
      action: 'create',
      resolutions: [{ paramPath: 'nodes["Gmail"].parameters.sendTo', value: 'owner@example.com' }],
    };
    const missingId = await runAction(service, resolution, undefined, identity);
    expect(missingId).toMatchObject({ success: false });
    expect(missingId.text).toContain('no deployable result');
    expect(cache.size).toBe(1);

    const transientFailure = await runAction(service, resolution, undefined, identity);
    expect(transientFailure).toMatchObject({ success: false });
    expect(transientFailure.text).toContain('temporary deployment failure');
    expect(cache.size).toBe(1);

    const retried = await runAction(service, resolution, undefined, identity);
    expect(retried).toMatchObject({ success: true, values: { workflowId: 'wf-retried' } });
    expect(deployWorkflow).toHaveBeenCalledTimes(3);
    expect(cache.size).toBe(0);
  });

  test('reports post-deploy cache failure without misreporting a committed workflow', async () => {
    const cache = new Map<string, unknown>();
    const draft = createValidWorkflow({
      _meta: {
        requiresClarification: [
          {
            kind: 'recipient',
            question: 'Who should receive the summary?',
            paramPath: 'nodes["Gmail"].parameters.sendTo',
          },
        ],
      },
    });
    const cacheFailure = new Error('cache backend unavailable');
    const reportError = mock(() => {});
    const service = {
      generateWorkflowDraft: mock(() => Promise.resolve(draft)),
      deployWorkflow: mock(() =>
        Promise.resolve({
          id: 'wf-committed',
          name: draft.name,
          active: false,
          nodeCount: draft.nodes.length,
          missingCredentials: [],
        })
      ),
    } as Partial<WorkflowService>;
    const identity = {
      cache,
      deleteCache: mock(() => Promise.reject(cacheFailure)),
      reportError,
    };

    await runAction(
      service,
      { action: 'create', seedPrompt: 'Email a summary every day.' },
      undefined,
      identity
    );
    const result = await runAction(
      service,
      {
        action: 'create',
        resolutions: [
          { paramPath: 'nodes["Gmail"].parameters.sendTo', value: 'owner@example.com' },
        ],
      },
      undefined,
      identity
    );

    expect(result).toMatchObject({
      success: true,
      values: { workflowId: 'wf-committed', warning: true },
      data: {
        warning: {
          code: 'WORKFLOW_PENDING_DRAFT_CLEAR_FAILED',
          message: expect.stringContaining('Do not retry creation'),
        },
      },
    });
    expect(result.text).toContain('Created draft workflow');
    expect(result.text).toContain('Do not retry creation');
    expect(cache.size).toBe(1);
    expect(reportError).toHaveBeenCalledWith(
      'WorkflowAction.pendingDraftClearAfterDeploy',
      cacheFailure,
      expect.objectContaining({ workflowId: 'wf-committed', ownerEntityId: 'user-test' })
    );
  });

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

    expect(getWorkflow).toHaveBeenCalledWith('wf-1', 'user-test');
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

    expect(runWorkflow).toHaveBeenCalledWith('wf-1', { throwOnError: false }, 'user-test');
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

    expect(listWorkflowRevisions).toHaveBeenCalledWith('wf-1', 5, 'user-test');
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

    expect(restoreWorkflowRevision).toHaveBeenCalledWith('wf-1', 'v-old', 'user-test');
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

    expect(listExecutions).toHaveBeenCalledWith({ workflowId: 'wf-1', limit: 10 }, 'user-test');
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

    expect(getExecutionDetail).toHaveBeenCalledWith('exec-1', 'user-test');
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

    expect(getWorkflowEvaluationSuite).toHaveBeenCalledWith('wf-1', 5, 'user-test');
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

describe('automation vocabulary (#16570)', () => {
  test('carries the automation simile family a live agent actually guessed', () => {
    const similes = new Set(workflowAction.similes ?? []);
    // The two exact names from the production repro must resolve, plus the
    // core family the "automations" UI vocabulary produces.
    for (const guessed of [
      'AUTOMATION_DELETE',
      'AUTOMATION_CANCEL',
      'DELETE_AUTOMATION',
      'CANCEL_AUTOMATION',
      'LIST_AUTOMATIONS',
      'CREATE_AUTOMATION',
      'DISABLE_AUTOMATION',
    ]) {
      expect(similes.has(guessed)).toBe(true);
    }
  });

  test('describes itself with the automation vocabulary so keyword retrieval matches', () => {
    expect(workflowAction.description.toLowerCase()).toContain('automation');
    expect(workflowAction.descriptionCompressed?.toLowerCase()).toContain('automation');
  });

  test('the delete op the vocabulary routes to actually exists', () => {
    const opParam = (workflowAction.parameters ?? []).find((p) => p.name === 'action');
    const allowed = (opParam?.schema as { enum?: string[] } | undefined)?.enum ?? [];
    expect(allowed).toContain('delete');
    expect(allowed).toContain('deactivate');
  });
});
