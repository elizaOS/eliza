/** Deterministic coverage for the bounded workflow JSON clone. */
import { describe, expect, test } from 'bun:test';
import {
  cloneJson,
  MAX_WORKFLOW_JSON_DEPTH,
  MAX_WORKFLOW_JSON_NODES,
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
    expectUnbounded(() => cloneJson(nestObject(8000)));
  });

  test('accepts a shared DAG while rejecting a true ancestor cycle', () => {
    const shared = { value: 1 };
    const cloned = cloneJson({ left: shared, right: shared });
    expect(cloned).toEqual({ left: { value: 1 }, right: { value: 1 } });
    expect(cloned.left).not.toBe(cloned.right);

    const cyclic: Record<string, unknown> = {};
    cyclic.child = { parent: cyclic };
    expectUnbounded(() => cloneJson(cyclic));
  });

  test('rejects sparse logical work and accessors before invoking them', () => {
    const sparse: unknown[] = [];
    sparse.length = MAX_WORKFLOW_JSON_NODES + 1;
    expectUnbounded(() => cloneJson(sparse));

    let calls = 0;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        calls += 1;
        return 'value';
      },
    });
    expectUnbounded(() => cloneJson(accessor));
    expect(calls).toBe(0);
  });

  test('never invokes custom or Proxy-synthesized JSON hooks', () => {
    let calls = 0;
    const custom = {
      toJSON() {
        calls += 1;
        return { expanded: 'x'.repeat(1_000_000) };
      },
    };
    expectUnbounded(() => cloneJson(custom));

    const proxy = new Proxy(
      { safe: true },
      {
        get(target, key, receiver) {
          calls += 1;
          return key === 'toJSON' ? () => ({ expanded: true }) : Reflect.get(target, key, receiver);
        },
      }
    );
    expect(cloneJson(proxy)).toEqual({ safe: true });
    expect(calls).toBe(0);
  });

  test('contains hostile reflection without inspecting the thrown value', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('secondary trap');
        },
      }
    );
    const value = new Proxy(
      {},
      {
        ownKeys() {
          throw hostile;
        },
      }
    );
    expectUnbounded(() => cloneJson(value));
  });

  test('does not traverse input prototypes and preserves __proto__ as data', () => {
    let prototypeReads = 0;
    const value = new Proxy(
      JSON.parse('{"__proto__":{"kept":true},"safe":1}') as Record<string, unknown>,
      {
        getPrototypeOf() {
          prototypeReads += 1;
          return Object.prototype;
        },
      }
    );
    const cloned = cloneJson(value) as Record<string, unknown>;

    expect(prototypeReads).toBe(0);
    expect(Object.hasOwn(cloned, '__proto__')).toBe(true);
    expect(JSON.parse(JSON.stringify(cloned))).toEqual(
      JSON.parse('{"__proto__":{"kept":true},"safe":1}')
    );
  });

  test('preserves ordinary JSON clone normalization', () => {
    const input = {
      omitted: undefined,
      nonFinite: Number.POSITIVE_INFINITY,
      date: new Date('2026-08-20T00:00:00.000Z'),
      array: [undefined, Number.NaN, -0],
    };
    expect(cloneJson(input)).toEqual({
      nonFinite: null,
      date: '2026-08-20T00:00:00.000Z',
      array: [null, null, 0],
    });
  });
});
