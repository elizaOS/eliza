/** Deterministic coverage for the bounded workflow JSON clone. */
import { describe, expect, test } from 'bun:test';
import {
  cloneJson,
  MAX_WORKFLOW_JSON_DEPTH,
  WORKFLOW_JSON_UNBOUNDED,
} from '../../src/services/workflow-json';
import { WorkflowApiError } from '../../src/types/index';

function nestObject(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let i = 0; i < depth; i++) {
    value = { child: value };
  }
  return value;
}

function expectUnbounded(fn: () => unknown): WorkflowApiError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowApiError);
    expect(error).not.toBeInstanceOf(RangeError);
    const typed = error as WorkflowApiError;
    expect(typed.statusCode).toBe(400);
    expect((typed.response as { code?: string } | undefined)?.code).toBe(WORKFLOW_JSON_UNBOUNDED);
    return typed;
  }
  throw new Error('expected WORKFLOW_JSON_UNBOUNDED');
}

describe('cloneJson', () => {
  test('clones honest workflow-shaped records', () => {
    const input = {
      name: 'Review',
      language: 'tsx',
      source: "import { createSmithers } from 'smthrs/create';",
      steps: [{ id: 'run', label: 'Run' }],
      inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
    };
    expect(cloneJson(input)).toEqual(input);
    expect(cloneJson(input)).not.toBe(input);
  });

  test(`accepts a ${MAX_WORKFLOW_JSON_DEPTH}-deep object nest`, () => {
    expect(cloneJson(nestObject(MAX_WORKFLOW_JSON_DEPTH))).toEqual(
      nestObject(MAX_WORKFLOW_JSON_DEPTH)
    );
  });

  test(`throws ${WORKFLOW_JSON_UNBOUNDED} one past depth ${MAX_WORKFLOW_JSON_DEPTH}`, () => {
    expectUnbounded(() => cloneJson(nestObject(MAX_WORKFLOW_JSON_DEPTH + 1)));
  });

  test('throws on cyclic objects instead of TypeError', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expectUnbounded(() => cloneJson(cyclic));
  });

  test('does not RangeError an 8k object nest', () => {
    const t0 = performance.now();
    expectUnbounded(() => cloneJson(nestObject(8000)));
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
