/** Validation route coverage through a real AgentRuntime and the production validator. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { validationRoutes } from '../../../src/routes/validation';
import {
  createInvalidWorkflow_duplicateNames,
  createInvalidWorkflow_noNodes,
  createValidWorkflow,
} from '../../fixtures/workflows';
import { createRouteRequest, createRouteResponse } from '../../helpers/routeHarness';
import { type EmbeddedHarness, makeEmbeddedHarness } from '../../integration/embedded-harness';

const handler = validationRoutes[0].handler;
if (!handler) throw new Error('expected validation route handler');
let harness: EmbeddedHarness;

beforeAll(async () => {
  harness = await makeEmbeddedHarness('validation-route-runtime');
});

afterAll(async () => {
  await harness.close();
});

describe('POST /workflows/validate', () => {
  test('returns valid for a correct workflow', async () => {
    const workflow = createValidWorkflow();
    const req = createRouteRequest({ body: workflow, method: 'POST' });
    const { response, result } = createRouteResponse();

    await handler(req, response, harness.runtime);

    const { status, body } = result();
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
    const req = createRouteRequest({ body: workflow, method: 'POST' });
    const { response, result } = createRouteResponse();

    await handler(req, response, harness.runtime);

    const { status, body } = result();
    expect(status).toBe(200);
    const data = body as { valid: boolean; errors: string[] };
    expect(data.valid).toBe(false);
    expect(data.errors.length).toBeGreaterThan(0);
  });

  test('returns errors for workflow with duplicate node names', async () => {
    const workflow = createInvalidWorkflow_duplicateNames();
    const req = createRouteRequest({ body: workflow, method: 'POST' });
    const { response, result } = createRouteResponse();

    await handler(req, response, harness.runtime);

    const { body } = result();
    const data = body as { valid: boolean; errors: string[] };
    expect(data.valid).toBe(false);
    expect(data.errors.some((e) => e.toLowerCase().includes('duplicate'))).toBe(true);
  });

  test('returns 400 when body has no nodes', async () => {
    const req = createRouteRequest({ body: { connections: {} }, method: 'POST' });
    const { response, result } = createRouteResponse();

    await handler(req, response, harness.runtime);

    const { status, body } = result();
    expect(status).toBe(400);
    expect((body as { success: boolean }).success).toBe(false);
  });

  test('returns 400 when body has no connections', async () => {
    const req = createRouteRequest({ body: { nodes: [] }, method: 'POST' });
    const { response, result } = createRouteResponse();

    await handler(req, response, harness.runtime);

    const { status } = result();
    expect(status).toBe(400);
  });
});
