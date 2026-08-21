/** Verifies typed, idempotent dispatch from elizaOS triggers into the native Smithers service. */

import { describe, expect, mock, test } from 'bun:test';
import { EMBEDDED_WORKFLOW_SERVICE_TYPE } from '../../src/services/embedded-workflow-service';
import {
  createWorkflowDispatchService,
  registerWorkflowDispatchService,
  WORKFLOW_DISPATCH_SERVICE_TYPE,
} from '../../src/services/workflow-dispatch';

function makeEmbeddedService() {
  return {
    executeWorkflow: mock(
      async (
        workflowId: string,
        options: {
          triggerData: Record<string, unknown>;
          idempotencyKey?: string;
          triggerChainDepth?: number;
        }
      ) => ({ id: `${workflowId}:${options.idempotencyKey ?? 'fresh'}` })
    ),
    findExecutionByIdempotencyKey: mock(async () => null as { id?: string } | null),
  };
}

function makeRuntime(embedded: ReturnType<typeof makeEmbeddedService> | null = null) {
  const services = new Map<string, unknown>();
  return {
    services,
    getService: mock((type: string) => (type === EMBEDDED_WORKFLOW_SERVICE_TYPE ? embedded : null)),
  };
}

describe('workflow dispatch service', () => {
  test('requires a workflow id and the native Smithers service', async () => {
    const runtime = makeRuntime();
    const dispatch = createWorkflowDispatchService(runtime as never);

    await expect(dispatch.execute('  ')).resolves.toEqual({
      ok: false,
      error: 'workflow id required',
    });
    expect(runtime.getService).not.toHaveBeenCalled();
    await expect(dispatch.execute('workflow-1')).resolves.toEqual({
      ok: false,
      error: 'embedded workflow service not registered',
    });
  });

  test('passes trigger data and idempotency through typed arguments', async () => {
    const embedded = makeEmbeddedService();
    const dispatch = createWorkflowDispatchService(makeRuntime(embedded) as never);

    await expect(
      dispatch.execute(
        ' workflow-1 ',
        { source: 'schedule' },
        { idempotencyKey: 'tick-1', triggerChainDepth: 3 }
      )
    ).resolves.toEqual({ ok: true, executionId: 'workflow-1:tick-1' });
    expect(embedded.findExecutionByIdempotencyKey).toHaveBeenCalledWith('workflow-1', 'tick-1');
    expect(embedded.executeWorkflow).toHaveBeenCalledWith('workflow-1', {
      mode: 'trigger',
      triggerData: { source: 'schedule' },
      idempotencyKey: 'tick-1',
      triggerChainDepth: 3,
    });
  });

  test('deduplicates persisted and concurrent executions', async () => {
    const persisted = makeEmbeddedService();
    persisted.findExecutionByIdempotencyKey.mockImplementation(async () => ({ id: 'existing' }));
    const persistedDispatch = createWorkflowDispatchService(makeRuntime(persisted) as never);
    await expect(
      persistedDispatch.execute('workflow-1', {}, { idempotencyKey: 'tick-1' })
    ).resolves.toEqual({ ok: true, executionId: 'existing', dedup: true });
    expect(persisted.executeWorkflow).not.toHaveBeenCalled();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const concurrent = makeEmbeddedService();
    concurrent.executeWorkflow.mockImplementation(async () => {
      await gate;
      return { id: 'single-run' };
    });
    const concurrentDispatch = createWorkflowDispatchService(makeRuntime(concurrent) as never);
    const first = concurrentDispatch.execute('workflow-1', {}, { idempotencyKey: 'tick-1' });
    const second = concurrentDispatch.execute('workflow-1', {}, { idempotencyKey: 'tick-1' });
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, executionId: 'single-run' },
      { ok: true, executionId: 'single-run', dedup: true },
    ]);
    expect(concurrent.executeWorkflow).toHaveBeenCalledTimes(1);
  });

  test('registers one stoppable runtime service entry', async () => {
    const runtime = makeRuntime(makeEmbeddedService());
    registerWorkflowDispatchService(runtime as never);

    const entries = runtime.services.get(WORKFLOW_DISPATCH_SERVICE_TYPE) as Array<{
      execute(workflowId: string): Promise<unknown>;
      stop(): Promise<void>;
    }>;
    expect(entries).toHaveLength(1);
    await expect(entries[0]?.execute('workflow-1')).resolves.toEqual({
      ok: true,
      executionId: 'workflow-1:fresh',
    });
    await expect(entries[0]?.stop()).resolves.toBeUndefined();
  });
});
