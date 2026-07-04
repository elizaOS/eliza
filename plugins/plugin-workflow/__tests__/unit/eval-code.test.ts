// Exercises workflow engine unit behavior and credential handling.
import { describe, expect, test } from 'bun:test';
import { evalCodeAction } from '../../src/actions/eval-code';
import { evalQuickJsCode } from '../../src/services/embedded-workflow-service';

/**
 * Unit coverage for the EVAL_CODE action + its QuickJS sandbox wrapper (#8914).
 */
describe('evalQuickJsCode sandbox', () => {
  test('evaluates a return expression', async () => {
    expect(await evalQuickJsCode('return 1 + 1;')).toBe(2);
  });

  test('exposes inputJson as $json', async () => {
    expect(await evalQuickJsCode('return $json.x * 2;', { x: 21 })).toBe(42);
  });

  test('has no host access (console is a no-op, returns the value)', async () => {
    expect(await evalQuickJsCode('console.log("ignored"); return "ok";')).toBe('ok');
  });
});

describe('EVAL_CODE action', () => {
  test('is owner-gated', () => {
    expect(evalCodeAction.roleGate).toEqual({ minRole: 'OWNER' });
  });

  test('runs the snippet and returns the result via callback', async () => {
    let delivered: string | undefined;
    const result = await evalCodeAction.handler(
      {} as never,
      {} as never,
      undefined,
      { parameters: { jsCode: 'return 6 * 7;' } } as never,
      (async (content: { text?: string }) => {
        delivered = content.text;
      }) as never
    );
    expect(result?.success).toBe(true);
    expect(result?.text).toBe('42');
    expect(delivered).toBe('42');
  });

  test('fails clearly when no jsCode is provided', async () => {
    const result = await evalCodeAction.handler(
      {} as never,
      {} as never,
      undefined,
      { parameters: {} } as never,
      undefined
    );
    expect(result?.success).toBe(false);
    expect(result?.text).toContain('jsCode');
  });
});
