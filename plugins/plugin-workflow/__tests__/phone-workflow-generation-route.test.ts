import { expect, test } from 'bun:test';
import { setCloudRuntimeRequestIdentity } from '@elizaos/contracts';
import { workflowRoutePlugin } from '../src/plugin-routes';
import {
  PHONE_CATALOG_REVISION,
  PHONE_COMPILER_REVISION,
} from '../src/services/phone-workflow-spec';
import { WorkflowService } from '../src/services/workflow-service';

const spec = {
  version: 1,
  name: 'Generated review',
  description: '',
  trigger: { kind: 'manual' },
  steps: [{ id: 'read', kind: 'Read', operation: 'supplied_text', text: 'Synthetic text' }],
};
const device = { installationId: 'device-one', enrollmentId: 'enrollment-one' };
const requestBody = {
  prompt: 'Use synthetic text',
  operations: ['supplied_text'],
  catalogRevision: PHONE_CATALOG_REVISION,
  compilerRevision: PHONE_COMPILER_REVISION,
  device,
};
function fixture() {
  let modelCalls = 0;
  const validations: unknown[] = [];
  let permitted = true;
  let model = true;
  let response = JSON.stringify(spec);
  const runtime = {
    getModel: () => (model ? {} : null),
    useModel: async () => {
      modelCalls++;
      return response;
    },
    getService: (name: string) =>
      name === 'workflow'
        ? service
        : name === 'workflow_device_bridge'
          ? {
              validateTarget: async (...args: unknown[]) => {
                validations.push(args);
                if (!permitted) throw Error('Revoked');
              },
            }
          : null,
  };
  const service = new WorkflowService(runtime as any);
  return {
    runtime,
    service,
    validations,
    get modelCalls() {
      return modelCalls;
    },
    revoke() {
      permitted = false;
    },
    disableModel() {
      model = false;
    },
    reply(value: unknown) {
      response = JSON.stringify(value);
    },
  };
}
async function call(f: ReturnType<typeof fixture>, body: unknown, owner = 'owner-one') {
  const route = workflowRoutePlugin.routes!.find(
    (r) => r.type === 'POST' && r.path === '/api/workflow/phone/generate'
  );
  expect(route?.rawPath).toBe(true);
  const req = { url: '/api/workflow/phone/generate', method: 'POST', body };
  setCloudRuntimeRequestIdentity(req, owner);
  let text = '';
  const res = {
    headersSent: false,
    statusCode: 0,
    setHeader() {},
    end(value: string) {
      text = value;
    },
  };
  await route!.handler(req as any, res as any, f.runtime as any);
  return { status: res.statusCode, body: JSON.parse(text) };
}
test('registered generation route validates enrollment before and after model; returns unsaved paused spec', async () => {
  const f = fixture(),
    result = await call(f, requestBody);
  expect(result.status).toBe(200);
  expect(result.body.spec).toEqual({ ...spec, device });
  expect(result.body.active).toBe(false);
  expect(result.body.specDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(f.modelCalls).toBe(1);
  expect(f.validations).toEqual([
    ['owner-one', device, 1],
    ['owner-one', device, 1],
  ]);
  expect(f.service.phoneCatalog().generationProtocol).toBe(1);
});
test('invalid catalog, capability, bound, unknown field and revoked enrollment make no model calls', async () => {
  for (const body of [
    { ...requestBody, catalogRevision: 'old' },
    { ...requestBody, operations: ['send_email'] },
    { ...requestBody, prompt: 'x'.repeat(4001) },
    { ...requestBody, activate: true },
    { ...requestBody, prompt: 'x'.repeat(75001) },
  ]) {
    const f = fixture();
    expect((await call(f, body)).status).toBeGreaterThanOrEqual(400);
    expect(f.modelCalls).toBe(0);
  }
  for (const body of [requestBody, { ...requestBody, existing: spec }]) {
    const f = fixture();
    f.revoke();
    expect((await call(f, body)).status).toBe(409);
    expect(f.modelCalls).toBe(0);
  }
  const noModel = fixture();
  noModel.disableModel();
  expect((await call(noModel, requestBody)).status).toBe(409);
  expect(noModel.modelCalls).toBe(0);
});
test('presentation draft is revalidated against protocol 2 for the authenticated owner', async () => {
  const f = fixture();
  f.reply({
    ...spec,
    steps: [...spec.steps, { id: 'speak', kind: 'Speak', operation: 'read_aloud', source: 'read' }],
  });
  const result = await call(
    f,
    { ...requestBody, operations: ['supplied_text', 'read_aloud'] },
    'owner-two'
  );
  expect(result.status).toBe(200);
  expect(f.validations).toEqual([
    ['owner-two', device, 1],
    ['owner-two', device, 2],
  ]);
});
