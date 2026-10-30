import { afterEach, expect, test } from 'bun:test';
import { phoneWorkflowLocalDay } from '@elizaos/contracts/phone-workflow';
import { compilePhoneWorkflowV3 } from '../../src/services/phone-workflow-compiler-v3';
import { generatePhoneSpec } from '../../src/services/phone-workflow-generation';
import {
  compilePhoneWorkflow,
  PHONE_CATALOG_REVISION,
  PHONE_COMPILER_REVISION,
  phoneWorkflowCatalog,
  validatePhoneSpec,
  verifyPhoneWorkflowSource,
} from '../../src/services/phone-workflow-spec';

const device = { installationId: 'install-1', enrollmentId: 'enroll-1' };
const scope = {
  window: 'open_and_completed_today' as const,
  timeZone: 'Pacific/Auckland',
  maximumItems: 20,
};
const spec = validatePhoneSpec({
  device,
  version: 1,
  name: 'Evening reminders',
  description: '',
  trigger: { kind: 'manual' },
  steps: [
    { id: 'reminders', kind: 'Read', operation: 'selected_reminders', scope },
    {
      id: 'notify',
      kind: 'Notify',
      operation: 'app_notification',
      source: 'reminders',
      title: 'Today',
    },
  ],
});

/** Runs the compiled fixed program's step loop with a fake host bridge. */
async function runCompiled(source: string, device: (request: unknown) => Promise<unknown>) {
  const start = source.indexOf('{async()=>{') + '{async()=>{'.length;
  const end = source.lastIndexOf('}}</Task>');
  const body = source.slice(start, end);
  const program = source.slice(source.indexOf('const spec='), source.indexOf('const {Workflow'));
  const host = globalThis as unknown as { __elizaSmithers?: unknown };
  host.__elizaSmithers = { device, agent: { generate: async () => ({ text: '' }) } };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  return new AsyncFunction(`${program}\n${body}`)();
}
afterEach(() => {
  delete (globalThis as { __elizaSmithers?: unknown }).__elizaSmithers;
});

test('the catalog offers the selected-reminders read only with the device bridge, at protocol 3', () => {
  const find = (available: boolean) =>
    phoneWorkflowCatalog(true, available)
      .palette.find((row) => row.kind === 'Read')
      ?.operations.find((op) => op.id === 'selected_reminders') as
      | { available: boolean; requiredDeviceProtocol?: number }
      | undefined;
  expect(find(true)).toMatchObject({ available: true, requiredDeviceProtocol: 3 });
  expect(find(false)?.available).toBe(false);
  expect(PHONE_CATALOG_REVISION).toBe('phone-workflow-catalog-5');
  expect(PHONE_COMPILER_REVISION).toBe('phone-workflow-compiler-4');
});

test('the current compiler asks the phone for the reviewed scope on the owner’s current day', async () => {
  const requests: unknown[] = [];
  const result = await runCompiled(compilePhoneWorkflow(spec), async (request) => {
    requests.push(request);
    const operation = (request as { operation: { type: string } }).operation;
    return operation.type === 'read_selected_reminders'
      ? { proposalId: 'p1', operationId: 'o1', result: { kind: 'reminders', reminders: [] } }
      : { proposalId: 'p2', operationId: 'o2' };
  });
  expect(requests[0]).toEqual({
    stepId: 'reminders',
    operation: {
      type: 'read_selected_reminders',
      window: 'open_and_completed_today',
      day: phoneWorkflowLocalDay(Date.now(), 'Pacific/Auckland'),
      timeZone: 'Pacific/Auckland',
      maximumItems: 20,
    },
  });
  expect(requests[1]).toEqual({
    stepId: 'notify',
    operation: {
      type: 'post_notification',
      title: 'Today',
      body: JSON.stringify({ kind: 'reminders', reminders: [] }),
    },
  });
  expect((result as { steps: unknown[] }).steps).toHaveLength(2);
});

test('pinned compiler-3 sources still verify; a reminder step needs the current compiler', () => {
  const notesOnly = validatePhoneSpec({
    version: 1,
    name: 'Draft',
    description: '',
    trigger: { kind: 'manual' },
    steps: [{ id: 'read', kind: 'Read', operation: 'supplied_text', text: 'x' }],
  });
  expect(
    verifyPhoneWorkflowSource(
      notesOnly,
      compilePhoneWorkflowV3(notesOnly),
      'phone-workflow-compiler-3'
    )
  ).toBe(true);
  expect(
    verifyPhoneWorkflowSource(notesOnly, compilePhoneWorkflow(notesOnly), PHONE_COMPILER_REVISION)
  ).toBe(true);
  expect(
    verifyPhoneWorkflowSource(
      notesOnly,
      compilePhoneWorkflow(notesOnly),
      'phone-workflow-compiler-3'
    )
  ).toBe(false);
  expect(compilePhoneWorkflowV3(spec).includes('read_selected_reminders')).toBe(false);
});

test('generation keeps a reviewed reminder scope and refuses a widened one', async () => {
  const operations = ['selected_reminders', 'app_notification'];
  const input = {
    prompt: 'Notify me about today',
    operations,
    device,
    existing: spec,
  };
  const reply = (maximumItems: number) => async () =>
    JSON.stringify({
      version: 1,
      name: 'Evening reminders',
      description: '',
      steps: [
        {
          id: 'reminders',
          kind: 'Read',
          operation: 'selected_reminders',
          scope: { ...scope, maximumItems },
        },
        {
          id: 'notify',
          kind: 'Notify',
          operation: 'app_notification',
          source: 'reminders',
          title: 'Today',
        },
      ],
    });
  expect((await generatePhoneSpec(input, reply(20))).steps[0]).toEqual(spec.steps[0]);
  await expect(generatePhoneSpec(input, reply(200))).rejects.toThrow(
    /changed a selected read scope/
  );
});
