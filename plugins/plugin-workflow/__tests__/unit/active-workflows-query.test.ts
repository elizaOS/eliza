import { expect, test } from 'bun:test';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import { activeWorkflowsProvider } from '../../src/providers/activeWorkflows';

// content.text as packages/agent/src/api/chat-augmentation.ts rewrites it. The
// help fragment mentions workflows; the request does not (live :5325
// 2026-10-30, "Open my calendar, please." planner and evaluator prompts got
// `No workflows match "<whole envelope>"`).
const augmented = [
  'Answer the user request using the contextual documents below as the source of truth when they contain the answer.',
  'If the answer appears verbatim in the contextual documents, repeat it exactly.',
  'Do not ask follow-up questions or invoke tools/actions when the contextual documents already answer the request.',
  '',
  '<contextual_documents>',
  '<source title="source-1" similarity="0.790">',
  'Eliza is an autonomous agent powered by elizaOS, the agent framework. Users can ask Eliza to write code, add new skills, and run recurring workflows on scheduled triggers.',
  '</source>',
  '</contextual_documents>',
  '',
  '<user_request>',
  'Open my calendar, please.',
  '</user_request>',
].join('\n');

function run(text: string) {
  const calls: Array<[string, string?]> = [];
  const service = {
    listWorkflows: async () => {
      calls.push(['list']);
      return [];
    },
    searchWorkflows: async (query: string) => {
      calls.push(['search', query]);
      return [];
    },
  };
  const runtime = { getService: () => service } as unknown as IAgentRuntime;
  const message = {
    entityId: '33333333-3333-4333-8333-333333333333',
    content: { text },
  } as Memory;
  return activeWorkflowsProvider
    .get(runtime, message, {} as State)
    .then((result) => ({ calls, text: result.text }));
}

test('an augmented request that never names workflows lists them instead of searching the envelope', async () => {
  const { calls, text } = await run(augmented);
  expect(calls).toEqual([['list']]);
  expect(text).toBe('');
});

test('a request that names workflows still searches by the request alone', async () => {
  const { calls } = await run(
    augmented.replace('Open my calendar, please.', 'run my morning workflow')
  );
  expect(calls).toEqual([['search', 'run my morning workflow']]);
});
