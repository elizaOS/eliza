/** Node-catalog route coverage through the registered embedded runtime catalog. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { nodeRoutes } from '../../../src/routes/nodes';
import { createRouteRequest, createRouteResponse } from '../../helpers/routeHarness';
import { type EmbeddedHarness, makeEmbeddedHarness } from '../../integration/embedded-harness';

// Routes: [0] = /nodes/available, [1] = /nodes/:type, [2] = /nodes
const availableHandler = nodeRoutes[0].handler;
const getNodeHandler = nodeRoutes[1].handler;
const searchHandler = nodeRoutes[2].handler;
if (!availableHandler || !getNodeHandler || !searchHandler) {
  throw new Error('expected node route handlers');
}

let harness: EmbeddedHarness;

beforeAll(async () => {
  harness = await makeEmbeddedHarness('node-route-runtime');
});

afterAll(async () => {
  await harness.close();
});

describe('GET /nodes', () => {
  test('returns 400 when q parameter is missing', async () => {
    const req = createRouteRequest({ query: {} });
    const { response, result } = createRouteResponse();

    await searchHandler(req, response, harness.runtime);

    expect(result().status).toBe(400);
  });

  test('returns search results for supported HTTP keyword', async () => {
    const req = createRouteRequest({ query: { q: 'http' } });
    const { response, result } = createRouteResponse();

    await searchHandler(req, response, harness.runtime);

    const { status, body } = result();
    expect(status).toBe(200);
    const data = body as {
      success: boolean;
      data: Array<{ name: string; score: number; matchReason: string }>;
    };
    expect(data.success).toBe(true);
    expect(data.data.length).toBeGreaterThan(0);
    expect(data.data[0].name).toBe('workflows-nodes-base.httpRequest');
    // Search results include score and matchReason
    expect(typeof data.data[0].score).toBe('number');
    expect(typeof data.data[0].matchReason).toBe('string');
  });

  test('respects limit parameter', async () => {
    const req = createRouteRequest({ query: { q: 'send', limit: '3' } });
    const { response, result } = createRouteResponse();

    await searchHandler(req, response, harness.runtime);

    const data = result().body as { data: unknown[] };
    expect(data.data.length).toBeLessThanOrEqual(3);
  });

  test('handles comma-separated keywords', async () => {
    const req = createRouteRequest({ query: { q: 'http,set' } });
    const { response, result } = createRouteResponse();

    await searchHandler(req, response, harness.runtime);

    const data = result().body as { success: boolean; data: unknown[] };
    expect(data.success).toBe(true);
    expect(data.data.length).toBeGreaterThan(0);
  });
});

describe('GET /nodes/:type', () => {
  test('returns node definition for valid type', async () => {
    const req = createRouteRequest({
      params: { type: 'workflows-nodes-base.httpRequest' },
    });
    const { response, result } = createRouteResponse();

    await getNodeHandler(req, response, harness.runtime);

    const { status, body } = result();
    expect(status).toBe(200);
    const data = body as {
      success: boolean;
      data: { name: string; properties: unknown[] };
    };
    expect(data.success).toBe(true);
    expect(data.data.name).toBe('workflows-nodes-base.httpRequest');
    expect(data.data.properties.length).toBeGreaterThan(0);
  });

  test('returns 404 for unknown node type', async () => {
    const req = createRouteRequest({
      params: { type: 'workflows-nodes-base.nonexistentNode12345' },
    });
    const { response, result } = createRouteResponse();

    await getNodeHandler(req, response, harness.runtime);

    expect(result().status).toBe(404);
  });

  test('returns 400 when type param is missing', async () => {
    const req = createRouteRequest({ params: {} });
    const { response, result } = createRouteResponse();

    await getNodeHandler(req, response, harness.runtime);

    expect(result().status).toBe(400);
  });
});

describe('GET /nodes/available', () => {
  test('returns categorized nodes without credential bridge', async () => {
    const req = createRouteRequest();
    const { response, result } = createRouteResponse();

    await availableHandler(req, response, harness.runtime);

    const { status, body } = result();
    expect(status).toBe(200);
    const data = body as {
      success: boolean;
      data: {
        supported: Array<{ name: string }>;
        unsupported: unknown[];
        utility: Array<{ name: string }>;
      };
    };
    expect(data.success).toBe(true);
    expect(data.data.supported.length).toBeGreaterThan(0);
    expect(data.data.utility.length).toBeGreaterThan(0);
    // Catalog nodes should NOT have score/matchReason
    const first = data.data.utility[0] as Record<string, unknown>;
    expect(first.score).toBeUndefined();
    expect(first.matchReason).toBeUndefined();
  });
});
