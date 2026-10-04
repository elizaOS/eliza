import { expect, test } from 'bun:test';
import { setCloudRuntimeRequestIdentity } from '@elizaos/core/contracts/cloud-runtime-request';
import { workflowRoutePlugin } from '../src/plugin-routes';

const endpoints = [
  ['GET', 'live-accounts'],
  ['POST', 'live-calendars'],
  ['GET', 'sources'],
  ['POST', 'sources'],
  ['POST', 'sources/revoke'],
  ['GET', 'loops'],
  ['POST', 'loops'],
  ['GET', 'results'],
  ['POST', 'results/ack'],
];
test('digest public route table includes every implemented method with raw paths', () => {
  for (const [method, suffix] of endpoints) {
    const matches = workflowRoutePlugin.routes!.filter(
      (r) => r.type === method && r.path === '/api/workflow/hosted/' + suffix
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].rawPath).toBe(true);
  }
});
test('registered source route dispatches to the verified owner service', async () => {
  const route = workflowRoutePlugin.routes!.find(
    (r) => r.type === 'GET' && r.path === '/api/workflow/hosted/sources'
  );
  expect(route).toBeDefined();
  const owners: string[] = [];
  const service = {
    listDigestSources: async (owner: string) => {
      owners.push(owner);
      return [{ id: 'synthetic-source' }];
    },
  };
  const request = { url: '/api/workflow/hosted/sources', method: 'GET' };
  setCloudRuntimeRequestIdentity(request, 'synthetic-owner');
  let body = '';
  const response = {
    headersSent: false,
    statusCode: 0,
    setHeader() {},
    end(value: string) {
      body = value;
    },
  };
  await route!.handler(request as any, response as any, { getService: () => service } as any);
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(body)).toEqual({ sources: [{ id: 'synthetic-source' }] });
  expect(owners).toEqual(['synthetic-owner']);
});
