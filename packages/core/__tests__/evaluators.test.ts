import { expect } from 'vitest';
import {
  formatEvaluatorExamples,
  formatEvaluatorNames,
  formatEvaluators,
} from '../src/providers/evaluators';
import type { Evaluator, HandlerCallback, IAgentRuntime, Memory, State } from '../src/types';

// Mock data for evaluators
/**
 * Array of mock evaluators.
 * @type {Evaluator[]}
 */
/**
 * Array of mock evaluators for testing purposes.
 * @type {Evaluator[]}
 */
const mockEvaluators: Evaluator[] = [
  {
    name: 'Evaluator1',
    description: 'This is the first evaluator.',
    examples: [
      {
        prompt: 'Context 1 with {{name1}}.',
        outcome: 'Outcome 1 with {{name1}}.',
        messages: [
          {
            name: 'name1',
            content: { text: 'Message 1', actions: ['action1'] },
          },
          { name: 'name2', content: { text: 'Message 2' } },
        ],
      },
    ],
    similes: [],
    handler: (
      _runtime: IAgentRuntime,
      _message: Memory,
      _state?: State,
      _options?: { [key: string]: unknown },
      _callback?: HandlerCallback
    ): Promise<unknown> => {
      throw new Error('Function not implemented.');
    },
    validate: (_runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
      throw new Error('Function not implemented.');
    },
  },
  {
    name: 'Evaluator2',
    description: 'This is the second evaluator.',
    examples: [
      {
        prompt: 'Context 2 with {{name1}} and {{name2}}.',
        outcome: 'Outcome 2 with {{name1}} and {{name2}}.',
        messages: [
          {
            name: 'name1',
            content: { text: 'Message 1', actions: ['action1'] },
          },
          { name: 'name2', content: { text: 'Message 2' } },
        ],
      },
    ],
    similes: [],
    handler: (
      _runtime: IAgentRuntime,
      _message: Memory,
      _state?: State,
      _options?: { [key: string]: unknown },
      _callback?: HandlerCallback
    ): Promise<unknown> => {
      throw new Error('Function not implemented.');
    },
    validate: (_runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
      throw new Error('Function not implemented.');
    },
  },
];

// Unit test for formatEvaluatorNames
test('formats evaluator names correctly', () => {
  const result = formatEvaluatorNames(mockEvaluators);
  expect(result).toBe("'Evaluator1',\n'Evaluator2'");
});

// Unit test for formatEvaluators
test('formats evaluators correctly', () => {
  const result = formatEvaluators(mockEvaluators);
  expect(result).toBe(
    "'Evaluator1: This is the first evaluator.',\n'Evaluator2: This is the second evaluator.'"
  );
});

// Unit test for formatEvaluatorExamples
test('formats evaluator examples correctly', () => {
  const result = formatEvaluatorExamples(mockEvaluators);
  expect(result).toContain('Prompt:\nContext 1 with');
  expect(result).toContain('Outcome:\nOutcome 1 with');
  expect(result).toContain('Messages:\nname1: Message 1 (action1)');
});
