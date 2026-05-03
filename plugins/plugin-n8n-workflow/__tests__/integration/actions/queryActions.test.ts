import { describe, test, expect, mock } from 'bun:test';
import { getExecutionsAction } from '../../../src/actions/getExecutions';
import { N8N_WORKFLOW_SERVICE_TYPE } from '../../../src/services/n8n-workflow-service';
import {
  createMockRuntime,
  createMockMessage,
  createMockState,
  createMockCallback,
} from '../../helpers/mockRuntime';
import { createMockService } from '../../helpers/mockService';
import { createExecution, createMatchResult, createNoMatchResult } from '../../fixtures/workflows';

// ============================================================================
// GET_N8N_EXECUTIONS
// ============================================================================

function createRuntimeWithMatchingWorkflow(
  matchResult = createMatchResult(),
  serviceOverrides?: Record<string, unknown>
) {
  const mockService = createMockService(serviceOverrides);
  const useModel = mock(() => Promise.resolve(matchResult));
  return {
    runtime: createMockRuntime({
      services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
      useModel,
    }),
    service: mockService,
  };
}

describe('GET_N8N_EXECUTIONS action', () => {
  test('gets executions for matched workflow', async () => {
    const { runtime, service } = createRuntimeWithMatchingWorkflow();
    const callback = createMockCallback();

    const result = await getExecutionsAction.handler(
      runtime,
      createMockMessage(),
      createMockState(),
      {},
      callback
    );

    expect(result?.success).toBe(true);
    expect(service.getWorkflowExecutions).toHaveBeenCalledWith('wf-001', 10);
  });

  test('fails when no workflows exist', async () => {
    const mockService = createMockService({
      listWorkflows: mock(() => Promise.resolve([])),
    });
    const runtime = createMockRuntime({
      services: { [N8N_WORKFLOW_SERVICE_TYPE]: mockService },
    });
    const callback = createMockCallback();

    const result = await getExecutionsAction.handler(
      runtime,
      createMockMessage(),
      createMockState(),
      {},
      callback
    );

    expect(result?.success).toBe(false);
    const callText = (callback as any).mock.calls[0][0].text;
    expect(callText).toContain('No workflows available');
  });

  test('fails when no workflow matches', async () => {
    const { runtime } = createRuntimeWithMatchingWorkflow(createNoMatchResult());
    const callback = createMockCallback();

    const result = await getExecutionsAction.handler(
      runtime,
      createMockMessage(),
      createMockState(),
      {},
      callback
    );

    expect(result?.success).toBe(false);
    const callText = (callback as any).mock.calls[0][0].text;
    expect(callText).toContain('Could not identify');
  });

  test('handles empty execution list', async () => {
    const { runtime } = createRuntimeWithMatchingWorkflow(createMatchResult(), {
      getWorkflowExecutions: mock(() => Promise.resolve([])),
    });
    const callback = createMockCallback();

    await getExecutionsAction.handler(
      runtime,
      createMockMessage(),
      createMockState(),
      {},
      callback
    );

    const callText = (callback as any).mock.calls[0][0].text;
    expect(callText).toContain('No executions found');
  });

  test('formats execution status correctly', async () => {
    const { runtime } = createRuntimeWithMatchingWorkflow(createMatchResult(), {
      getWorkflowExecutions: mock(() =>
        Promise.resolve([
          createExecution({ status: 'success' }),
          createExecution({
            id: 'exec-002',
            status: 'error',
            data: { resultData: { error: { message: 'timeout' } } },
          }),
        ])
      ),
    });
    const callback = createMockCallback();

    await getExecutionsAction.handler(
      runtime,
      createMockMessage(),
      createMockState(),
      {},
      callback
    );

    const callText = (callback as any).mock.calls[0][0].text;
    expect(callText).toContain('SUCCESS');
    expect(callText).toContain('ERROR');
    expect(callText).toContain('timeout');
  });
});
