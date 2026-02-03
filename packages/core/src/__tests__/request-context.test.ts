import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  runWithRequestContext,
  getRequestContext,
  setRequestContextManager,
  getRequestContextManager,
  type RequestContext,
  type IRequestContextManager,
  type EntitySettingValue,
} from '../request-context';
import { createNodeRequestContextManager } from '../request-context.node';
import type { UUID } from '../types';
import { v4 as uuidv4 } from 'uuid';

const uuid = (): UUID => uuidv4() as UUID;

describe('Request Context', () => {
  let originalManager: IRequestContextManager;

  beforeEach(() => {
    originalManager = getRequestContextManager();
    setRequestContextManager(createNodeRequestContextManager());
  });

  afterEach(() => {
    setRequestContextManager(originalManager);
  });

  describe('runWithRequestContext', () => {
    it('makes context available within callback', () => {
      const entityId = uuid();
      const agentId = uuid();
      const context: RequestContext = {
        entityId,
        agentId,
        entitySettings: new Map([['API_KEY', 'test-key']]),
        requestStartTime: Date.now(),
      };

      let captured: RequestContext | undefined;
      runWithRequestContext(context, () => {
        captured = getRequestContext();
      });

      expect(captured).toBeDefined();
      expect(captured?.entityId).toBe(entityId);
      expect(captured?.entitySettings.get('API_KEY')).toBe('test-key');
    });

    it('returns undefined outside of context', () => {
      expect(getRequestContext()).toBeUndefined();
    });

    it('handles undefined context', () => {
      runWithRequestContext(undefined, () => {
        expect(getRequestContext()).toBeUndefined();
      });
    });

    it('returns callback result', () => {
      const context: RequestContext = {
        entityId: uuid(),
        agentId: uuid(),
        entitySettings: new Map(),
        requestStartTime: Date.now(),
      };

      const result = runWithRequestContext(context, () => 'test-result');
      expect(result).toBe('test-result');
    });

    it('propagates errors', () => {
      const context: RequestContext = {
        entityId: uuid(),
        agentId: uuid(),
        entitySettings: new Map(),
        requestStartTime: Date.now(),
      };

      expect(() => {
        runWithRequestContext(context, () => {
          throw new Error('Test error');
        });
      }).toThrow('Test error');
    });

    it('works with async callbacks', async () => {
      const context: RequestContext = {
        entityId: uuid(),
        agentId: uuid(),
        entitySettings: new Map([['KEY', 'async-value']]),
        requestStartTime: Date.now(),
      };

      const result = await runWithRequestContext(context, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return getRequestContext()?.entitySettings.get('KEY');
      });

      expect(result).toBe('async-value');
    });

    it('isolates parallel contexts', async () => {
      const agentId = uuid();
      const entityId1 = uuid();
      const entityId2 = uuid();

      const [result1, result2] = await Promise.all([
        runWithRequestContext(
          {
            entityId: entityId1,
            agentId,
            entitySettings: new Map([['KEY', 'value1']]),
            requestStartTime: Date.now(),
          },
          async () => {
            await new Promise((r) => setTimeout(r, 10));
            return getRequestContext()?.entitySettings.get('KEY');
          }
        ),
        runWithRequestContext(
          {
            entityId: entityId2,
            agentId,
            entitySettings: new Map([['KEY', 'value2']]),
            requestStartTime: Date.now(),
          },
          async () => {
            await new Promise((r) => setTimeout(r, 5));
            return getRequestContext()?.entitySettings.get('KEY');
          }
        ),
      ]);

      expect(result1).toBe('value1');
      expect(result2).toBe('value2');
    });

    it('supports nested contexts', () => {
      const agentId = uuid();
      const outerEntityId = uuid();
      const innerEntityId = uuid();

      runWithRequestContext(
        {
          entityId: outerEntityId,
          agentId,
          entitySettings: new Map([['KEY', 'outer']]),
          requestStartTime: Date.now(),
        },
        () => {
          expect(getRequestContext()?.entitySettings.get('KEY')).toBe('outer');

          runWithRequestContext(
            {
              entityId: innerEntityId,
              agentId,
              entitySettings: new Map([['KEY', 'inner']]),
              requestStartTime: Date.now(),
            },
            () => {
              expect(getRequestContext()?.entitySettings.get('KEY')).toBe('inner');
            }
          );

          expect(getRequestContext()?.entitySettings.get('KEY')).toBe('outer');
        }
      );
    });
  });

  describe('EntitySettings Map', () => {
    it('distinguishes undefined vs null', () => {
      const context: RequestContext = {
        entityId: uuid(),
        agentId: uuid(),
        entitySettings: new Map<string, EntitySettingValue>([
          ['EXPLICIT_NULL', null],
          ['STRING_VALUE', 'test'],
        ]),
        requestStartTime: Date.now(),
      };

      runWithRequestContext(context, () => {
        const ctx = getRequestContext()!;
        expect(ctx.entitySettings.get('EXPLICIT_NULL')).toBeNull();
        expect(ctx.entitySettings.get('STRING_VALUE')).toBe('test');
        expect(ctx.entitySettings.get('MISSING')).toBeUndefined();
      });
    });

    it('supports all value types', () => {
      const context: RequestContext = {
        entityId: uuid(),
        agentId: uuid(),
        entitySettings: new Map<string, EntitySettingValue>([
          ['STRING', 'str'],
          ['NUMBER', 42],
          ['BOOL_TRUE', true],
          ['BOOL_FALSE', false],
          ['NULL', null],
        ]),
        requestStartTime: Date.now(),
      };

      runWithRequestContext(context, () => {
        const settings = getRequestContext()!.entitySettings;
        expect(settings.get('STRING')).toBe('str');
        expect(settings.get('NUMBER')).toBe(42);
        expect(settings.get('BOOL_TRUE')).toBe(true);
        expect(settings.get('BOOL_FALSE')).toBe(false);
        expect(settings.get('NULL')).toBeNull();
      });
    });
  });

  describe('NoopContextManager', () => {
    it('returns undefined for context', () => {
      const noopManager: IRequestContextManager = {
        run: <T>(_ctx: RequestContext | undefined, fn: () => T) => fn(),
        active: () => undefined,
      };
      setRequestContextManager(noopManager);

      const context: RequestContext = {
        entityId: uuid(),
        agentId: uuid(),
        entitySettings: new Map([['KEY', 'value']]),
        requestStartTime: Date.now(),
      };

      runWithRequestContext(context, () => {
        expect(getRequestContext()).toBeUndefined();
      });
    });
  });

  describe('Concurrent Isolation', () => {
    it('isolates 10 concurrent requests', async () => {
      const agentId = uuid();
      const contexts = Array.from({ length: 10 }, (_, i) => ({
        entityId: uuid(),
        agentId,
        entitySettings: new Map([['KEY', `value-${i}`]]),
        requestStartTime: Date.now(),
      }));

      const results = await Promise.all(
        contexts.map((ctx, i) =>
          runWithRequestContext(ctx, async () => {
            await new Promise((r) => setTimeout(r, Math.random() * 20));
            return { index: i, value: getRequestContext()?.entitySettings.get('KEY') };
          })
        )
      );

      for (let i = 0; i < 10; i++) {
        const result = results.find((r) => r.index === i);
        expect(result?.value).toBe(`value-${i}`);
      }
    });

    it('maintains context across async operations', async () => {
      const context: RequestContext = {
        entityId: uuid(),
        agentId: uuid(),
        entitySettings: new Map([['SECRET', 'my-secret']]),
        requestStartTime: Date.now(),
      };

      const values: string[] = [];
      await runWithRequestContext(context, async () => {
        for (let i = 0; i < 3; i++) {
          await new Promise((r) => setTimeout(r, 5));
          values.push(getRequestContext()?.entitySettings.get('SECRET') as string);
        }
      });

      expect(values).toEqual(['my-secret', 'my-secret', 'my-secret']);
    });
  });

  describe('Edge Cases', () => {
    it('handles special key characters', () => {
      const context: RequestContext = {
        entityId: uuid(),
        agentId: uuid(),
        entitySettings: new Map([
          ['KEY.DOTS', 'a'],
          ['KEY-DASHES', 'b'],
          ['', 'empty-key'],
        ]),
        requestStartTime: Date.now(),
      };

      runWithRequestContext(context, () => {
        const settings = getRequestContext()!.entitySettings;
        expect(settings.get('KEY.DOTS')).toBe('a');
        expect(settings.get('KEY-DASHES')).toBe('b');
        expect(settings.get('')).toBe('empty-key');
      });
    });

    it('handles edge values', () => {
      const context: RequestContext = {
        entityId: uuid(),
        agentId: uuid(),
        entitySettings: new Map<string, EntitySettingValue>([
          ['EMPTY', ''],
          ['ZERO', 0],
          ['NEGATIVE', -1],
        ]),
        requestStartTime: Date.now(),
      };

      runWithRequestContext(context, () => {
        const settings = getRequestContext()!.entitySettings;
        expect(settings.get('EMPTY')).toBe('');
        expect(settings.get('ZERO')).toBe(0);
        expect(settings.get('NEGATIVE')).toBe(-1);
      });
    });
  });
});
