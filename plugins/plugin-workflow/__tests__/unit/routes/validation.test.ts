import { describe, expect, test } from 'bun:test';
import type { RouteRequest, RouteResponse } from '@elizaos/core';
import { validationRoutes } from '../../../src/routes/validation';
import {
  createInvalidWorkflow_duplicateNames,
  createInvalidWorkflow_noNodes,
  createValidWorkflow,
} from '../../fixtures/workflows';
import { createMockRuntime } from '../../helpers/mockRuntime';

function createRouteRequest(body: unknown): RouteRequest {
  return {
    body,
    params: {},
    query: {},
    headers: {},
    method: 'POST',
    path: '/workflows/validate',
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

const handler = validationRoutes[0].handler;
if (!handler) throw new Error('expected validation route handler');
const runtime = createMockRuntime();

describe('POST /workflows/validate', () => {
  test('returns valid for a correct workflow', async () => {
    const workflow = createValidWorkflow();
    const req = createRouteRequest(workflow);
    const { res, getResult } = createRouteResponse();

    await handler(req, res, runtime);

    const { status, body } = getResult();
    expect(status).toBe(200);
    const data = body as {
      valid: boolean;
      errors: string[];
      warnings: string[];
    };
    expect(data.valid).toBe(true);
    expect(data.errors).toEqual([]);
  });

  test('returns errors for workflow with no nodes', async () => {
    const workflow = createInvalidWorkflow_noNodes();
    const req = createRouteRequest(workflow);
    const { res, getResult } = createRouteResponse();

    await handler(req, res, runtime);

    const { status, body } = getResult();
    expect(status).toBe(200);
    const data = body as { valid: boolean; errors: string[] };
    expect(data.valid).toBe(false);
    expect(data.errors.length).toBeGreaterThan(0);
  });

  test('returns errors for workflow with duplicate node names', async () => {
    const workflow = createInvalidWorkflow_duplicateNames();
    const req = createRouteRequest(workflow);
    const { res, getResult } = createRouteResponse();

    await handler(req, res, runtime);

    const { body } = getResult();
    const data = body as { valid: boolean; errors: string[] };
    expect(data.valid).toBe(false);
    expect(data.errors.some((e) => e.toLowerCase().includes('duplicate'))).toBe(true);
  });

  test('returns 400 when body has no nodes', async () => {
    const req = createRouteRequest({ connections: {} });
    const { res, getResult } = createRouteResponse();

    await handler(req, res, runtime);

    const { status, body } = getResult();
    expect(status).toBe(400);
    expect((body as { success: boolean }).success).toBe(false);
  });

  test('returns 400 when body has no connections', async () => {
    const req = createRouteRequest({ nodes: [] });
    const { res, getResult } = createRouteResponse();

    await handler(req, res, runtime);

    const { status } = getResult();
    expect(status).toBe(400);
  });
});
