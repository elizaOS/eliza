import { ElizaError } from '@elizaos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeWorkflowsProvider } from './activeWorkflows';

function makeMessage(text: unknown): { content: { text: unknown }; entityId: string } {
  return { content: { text }, entityId: 'user-1' };
}

describe('activeWorkflowsProvider', () => {
  let runtime: {
    getService: ReturnType<typeof vi.fn>;
    reportError: ReturnType<typeof vi.fn>;
  };
  let service: {
    searchWorkflows: ReturnType<typeof vi.fn>;
    listWorkflows: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    service = {
      searchWorkflows: vi.fn().mockResolvedValue([]),
      listWorkflows: vi.fn().mockResolvedValue([]),
    };
    runtime = {
      getService: vi.fn().mockReturnValue(service),
      reportError: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an empty payload when the workflow service is absent', async () => {
    runtime.getService.mockReturnValue(undefined);
    const result = await activeWorkflowsProvider.get(
      runtime as never,
      makeMessage('run workflow') as never,
      {} as never
    );
    expect(result).toEqual({ text: '', data: {}, values: {} });
    expect(service.searchWorkflows).not.toHaveBeenCalled();
    expect(service.listWorkflows).not.toHaveBeenCalled();
  });

  it('routes workflow-mentioning messages to searchWorkflows', async () => {
    service.searchWorkflows.mockResolvedValue([{ id: 'wf-1', name: 'Stripe sync', active: true }]);
    const result = await activeWorkflowsProvider.get(
      runtime as never,
      makeMessage('  run my Stripe workflow  ') as never,
      {} as never
    );
    expect(service.searchWorkflows).toHaveBeenCalledWith('run my Stripe workflow', 'user-1');
    expect(service.listWorkflows).not.toHaveBeenCalled();
    expect(result.text).toContain('# Matching Workflows');
    expect(result.text).toContain('Stripe sync');
    expect(result.values).toMatchObject({
      hasWorkflows: true,
      workflowCount: 1,
      workflowSearchQuery: 'run my Stripe workflow',
    });
  });

  it('matches the automation keyword and trims surrounding whitespace', async () => {
    await activeWorkflowsProvider.get(
      runtime as never,
      makeMessage('automations status') as never,
      {} as never
    );
    expect(service.searchWorkflows).toHaveBeenCalledWith('automations status', 'user-1');
  });

  it('does not treat partial-word mentions as search queries', async () => {
    // "workflowx" contains "workflow" but the \b boundary must not match,
    // so this message goes to the full list instead of a narrowed search.
    await activeWorkflowsProvider.get(
      runtime as never,
      makeMessage('check workflowx docs') as never,
      {} as never
    );
    expect(service.searchWorkflows).not.toHaveBeenCalled();
    expect(service.listWorkflows).toHaveBeenCalledWith('user-1');
  });

  it('lists workflows when the message has no workflow mention', async () => {
    service.listWorkflows.mockResolvedValue([{ id: 'wf-1', name: 'Stripe sync', active: false }]);
    const result = await activeWorkflowsProvider.get(
      runtime as never,
      makeMessage('what can you do') as never,
      {} as never
    );
    expect(service.listWorkflows).toHaveBeenCalledWith('user-1');
    expect(service.searchWorkflows).not.toHaveBeenCalled();
    expect(result.text).toContain('# Available Workflows');
    expect(result.text).toContain('Status: INACTIVE');
    expect(result.values).toEqual({
      hasWorkflows: true,
      workflowCount: 1,
    });
  });

  it('handles a non-string content text as an empty message', async () => {
    await activeWorkflowsProvider.get(runtime as never, makeMessage(42) as never, {} as never);
    expect(service.searchWorkflows).not.toHaveBeenCalled();
    expect(service.listWorkflows).toHaveBeenCalledWith('user-1');
  });

  it('returns a no-match payload for empty search results', async () => {
    service.searchWorkflows.mockResolvedValue([]);
    const result = await activeWorkflowsProvider.get(
      runtime as never,
      makeMessage('run workflow') as never,
      {} as never
    );
    expect(result.text).toBe('# Matching Workflows\n\nNo workflows match "run workflow".');
    expect(result.data).toEqual({ workflows: [], searchQuery: 'run workflow' });
    expect(result.values).toEqual({
      hasWorkflows: false,
      workflowCount: 0,
      workflowSearchQuery: 'run workflow',
    });
  });

  it('returns an empty payload for an empty workflow list', async () => {
    const result = await activeWorkflowsProvider.get(
      runtime as never,
      makeMessage('hello') as never,
      {} as never
    );
    expect(result.text).toBe('');
    expect(result.data).toEqual({ workflows: [] });
    expect(result.values).toEqual({ hasWorkflows: false });
  });

  it('defaults missing step counts to zero and coerces active state', async () => {
    service.listWorkflows.mockResolvedValue([
      { id: 'wf-1', name: 'No steps', active: undefined },
      { id: 'wf-2', name: 'Has steps', active: true, steps: [{ id: 's1' }] },
    ]);
    const result = await activeWorkflowsProvider.get(
      runtime as never,
      makeMessage('hello') as never,
      {} as never
    );
    expect(result.text).toContain('Smithers steps: 0');
    expect(result.text).toContain('Smithers steps: 1');
    expect(result.data.workflows).toEqual([
      { id: 'wf-1', name: 'No steps', active: false, stepCount: 0 },
      { id: 'wf-2', name: 'Has steps', active: true, stepCount: 1 },
    ]);
  });

  it('wraps service failures in an ephemeral ElizaError and reports them', async () => {
    const boom = new Error('search backend down');
    service.searchWorkflows.mockRejectedValue(boom);
    runtime.reportError.mockResolvedValue(undefined);

    const err = await activeWorkflowsProvider
      .get(runtime as never, makeMessage('run workflow') as never, {} as never)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ElizaError);
    expect((err as ElizaError).code).toBe('WORKFLOW_PROVIDER_ACTIVE_LOAD_FAILED');
    expect((err as ElizaError).context).toEqual({ entityId: 'user-1' });
    expect((err as ElizaError).cause).toBe(boom);
    expect(runtime.reportError).toHaveBeenCalledWith('WorkflowProvider.active', err);
  });

  it('does not leak the raw error to the caller without wrapping', async () => {
    service.listWorkflows.mockRejectedValue(new Error('list failed'));
    const err = await activeWorkflowsProvider
      .get(runtime as never, makeMessage('hello') as never, {} as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ElizaError);
    expect((err as ElizaError).code).toBe('WORKFLOW_PROVIDER_ACTIVE_LOAD_FAILED');
  });
});
