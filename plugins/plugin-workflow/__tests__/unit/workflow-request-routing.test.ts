import { expect, test } from 'bun:test';
import {
  getDirectActionRoutingRules,
  type IAgentRuntime,
  registerViewNavigationTargetResolver,
} from '@elizaos/core';
import {
  authoredWorkflowRequest,
  registerWorkflowRequestRouting,
  workflowRequestOwned,
} from '../../src/actions/workflow-request';

// v610 Pixel: "create a workflow called Alpha device test" failed with
// STAGE1_ROUTING_CONFLICT because no route owned it.
test.each([
  ['create a workflow called Alpha device test', { op: 'create', name: 'Alpha device test' }],
  ['Create a workflow called Alpha device test.', { op: 'create', name: 'Alpha device test' }],
  ['please make a new workflow named “Morning brief”', { op: 'create', name: 'Morning brief' }],
  ['can you create a workflow titled Q3 review?', { op: 'create', name: 'Q3 review' }],
  [
    'rename the workflow Alpha device test to Alpha check',
    { op: 'rename', workflowName: 'Alpha device test', name: 'Alpha check' },
  ],
  [
    'rename the Alpha device test workflow to Alpha check',
    { op: 'rename', workflowName: 'Alpha device test', name: 'Alpha check' },
  ],
  ['delete the Alpha check workflow', { op: 'remove', workflowName: 'Alpha check' }],
  ['remove workflow Alpha check', { op: 'remove', workflowName: 'Alpha check' }],
  ['list my workflows', { op: 'list', viewWording: false }],
  ['what workflows do I have?', { op: 'list', viewWording: false }],
  ['show my workflows', { op: 'list', viewWording: true }],
] as const)('%s', (text, expected) => {
  expect(authoredWorkflowRequest(text)).toEqual(expected as never);
});

test.each([
  'open workflows',
  'create a workflow',
  'create a workflow that texts me every morning',
  'create a workflow called Alpha that runs every morning',
  'create a workflow called Alpha and turn it on',
  'create a workflow called Alpha, then run it',
  "don't create a workflow called Alpha",
  'how do I create a workflow called Alpha?',
  'delete the workflow',
  'delete all my workflows',
  'rename the workflow to Alpha check',
  'delete the Alpha check note',
  'create a note called Alpha device test',
  'call Alpha device test',
  'go to Alpha check',
])('leaves the rest to the planner: %s', (text) => {
  expect(authoredWorkflowRequest(text)).toBeUndefined();
});

function runtimeStub(): IAgentRuntime {
  return {} as IAgentRuntime;
}

test('"show my workflows" stays view navigation where a Workflows view is registered', () => {
  const withView = runtimeStub();
  registerViewNavigationTargetResolver(withView, (target) => target === 'workflows');
  expect(workflowRequestOwned(withView, 'show my workflows')).toBe(false);
  expect(workflowRequestOwned(withView, 'list my workflows')).toBe(true);
  expect(workflowRequestOwned(withView, 'create a workflow called Alpha device test')).toBe(true);
  // Without a view registry nothing else could answer it.
  expect(workflowRequestOwned(runtimeStub(), 'show my workflows')).toBe(true);
});

test('registers one whole-request WORKFLOW route that replaces a view switch', () => {
  const runtime = runtimeStub();
  registerWorkflowRequestRouting(runtime);
  registerWorkflowRequestRouting(runtime);
  const rules = getDirectActionRoutingRules(runtime);
  expect(rules.map((rule) => rule.id)).toEqual(['workflow.authored-request']);
  const [rule] = rules;
  expect(rule.actionNames).toEqual(['WORKFLOW']);
  expect(rule.replacesActionNames).toEqual(['VIEWS', 'VIEWS_SHOW']);
  expect(rule.contexts).toEqual(['automation', 'general']);
  expect(rule.wholeRequest?.matches('delete the Alpha check workflow')).toBe(true);
  expect(rule.wholeRequest?.matches('open workflows')).toBe(false);
});
