import { describe, expect, mock, test } from 'bun:test';
import type { RouteRequest, RouteResponse } from '@elizaos/core';
import { executionRoutes } from '../../../src/routes/executions';
import { createExecution } from '../../fixtures/workflows';
import { createMockRuntime } from '../../helpers/mockRuntime';
import { createMockService } from '../../helpers/mockService';

function createRouteRequest(overrides?: Partial<RouteRequest>): RouteRequest {
  return {
    body: undefined,
    params: {},
    query: {},
    headers: {},
    method: 'GET',
    ...overrides,
  };
}

function createRouteResponse(): {
  res: RouteResponse;
  getResult: () => { status: number; body: unknown };
} {
  let status = 200;
  let body: unknown;
  const res: RouteResponse = {
    status(code: number) {
      status = code;
      return res;
    },
    json(data: unknown) {
      body = data;
      return res;
    },
    send(data: unknown) {
      body = data;
      return res;
    },
    end() {
      return res;
    },
  };
  return { res, getResult: () => ({ status, body }) };
}

// Routes: [0]=GET /executions, [1]=GET /executions/:id
const listHandler = executionRoutes[0].handler;
const getHandler = executionRoutes[1].handler;
if (!listHandler || !getHandler) throw new Error('expected execution route handlers');

function runtimeWithService(serviceOverrides?: Record<string, unknown>) {
  const service = createMockService(serviceOverrides);
  return {
    runtime: createMockRuntime({ services: { workflow: service } }),
    service,
  };
}

describe('GET /executions', () => {
  test('returns list of executions', async () => {
    const { runtime } = runtimeWithService();
    const req = createRouteRequest();
    const { res, getResult } = createRouteResponse();

    await listHandler(req, res, runtime);

    const { body } = getResult();
    const data = body as { success: boolean; data: Array<{ id: string }> };
    expect(data.success).toBe(true);
    expect(data.data.length).toBe(2);
    expect(data.data[0].id).toBe('exec-001');
  });

  test('passes filter params to service', async () => {
    const listMock = mock(() =>
      Promise.resolve({ data: [createExecution()], nextCursor: 'cur-1' })
    );
    const { runtime } = runtimeWithService({ listExecutions: listMock });
    const req = createRouteRequest({
      query: { workflowId: 'wf-001', status: 'error', limit: '5' },
    });
    const { res, getResult } = createRouteResponse();

    await listHandler(req, res, runtime);

    const callArgs = listMock.mock.calls[0][0] as {
      workflowId?: string;
      status?: string;
      limit?: number;
    };
    expect(callArgs.workflowId).toBe('wf-001');
    expect(callArgs.status).toBe('error');
    expect(callArgs.limit).toBe(5);

    const { body } = getResult();
    expect((body as { nextCursor: string }).nextCursor).toBe('cur-1');
  });
});

describe('GET /executions/:id', () => {
  test('returns execution detail', async () => {
    const { runtime } = runtimeWithService();
    const req = createRouteRequest({ params: { id: 'exec-001' } });
    const { res, getResult } = createRouteResponse();

    await getHandler(req, res, runtime);

    const { body } = getResult();
    const data = body as { success: boolean; data: { id: string } };
    expect(data.success).toBe(true);
    expect(data.data.id).toBe('exec-001');
  });

  test('returns 400 when id is missing', async () => {
    const { runtime } = runtimeWithService();
    const req = createRouteRequest({ params: {} });
    const { res, getResult } = createRouteResponse();

    await getHandler(req, res, runtime);

    expect(getResult().status).toBe(400);
  });
});
