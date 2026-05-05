import { describe, expect, it } from 'bun:test';
import type { DrizzleClient } from '@babylon/db';
import { tryUseTick, useEngine, useTick } from '../core/composables';
import { BabylonEngine } from '../core/engine';
import {
  CircularDependencyError,
  FrameworkError,
  SystemNotFoundError,
} from '../core/errors';
import type { BabylonSystem } from '../core/types';
import { TickPhase } from '../core/types';

function makeSystem(
  overrides: Partial<BabylonSystem> & { id: string; phase: TickPhase }
): BabylonSystem {
  return {
    name: overrides.id,
    onTick: async () => ({}),
    ...overrides,
  };
}

function makeTestEngine() {
  return new BabylonEngine({
    db: {} as DrizzleClient,
    llm: {
      execute: async () => ({}) as never,
      getClient: () => ({}),
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as import('@babylon/shared').Logger,
    config: { budgetMs: 60000 },
  });
}

describe('BabylonEngine', () => {
  it('boots and runs a tick with systems in phase order', async () => {
    const order: string[] = [];

    const engine = makeTestEngine();
    engine
      .use(
        makeSystem({
          id: 'social',
          phase: TickPhase.Social,
          onTick: async () => {
            order.push('social');
            return { metrics: { socialDone: true } };
          },
        })
      )
      .use(
        makeSystem({
          id: 'bootstrap',
          phase: TickPhase.Bootstrap,
          onTick: async () => {
            order.push('bootstrap');
            return { metrics: { bootstrapDone: true } };
          },
        })
      );

    await engine.boot();
    const result = await engine.tick();

    expect(order).toEqual(['bootstrap', 'social']);
    expect(result.bootstrapDone).toBe(true);
    expect(result.socialDone).toBe(true);
    await engine.shutdown();
  });

  it('sorts dependencies within a phase', async () => {
    const order: string[] = [];
    const engine = makeTestEngine();

    engine
      .use(
        makeSystem({
          id: 'b',
          phase: TickPhase.Markets,
          dependencies: ['a'],
          onTick: async () => {
            order.push('b');
            return {};
          },
        })
      )
      .use(
        makeSystem({
          id: 'a',
          phase: TickPhase.Markets,
          onTick: async () => {
            order.push('a');
            return {};
          },
        })
      );

    await engine.boot();
    await engine.tick();

    expect(order).toEqual(['a', 'b']);
    await engine.shutdown();
  });

  it('throws on missing dependency', () => {
    const engine = makeTestEngine();
    engine.use(
      makeSystem({
        id: 'x',
        phase: TickPhase.Bootstrap,
        dependencies: ['nonexistent'],
      })
    );

    expect(engine.boot()).rejects.toThrow(SystemNotFoundError);
  });

  it('throws on circular dependency', () => {
    const engine = makeTestEngine();
    engine
      .use(
        makeSystem({
          id: 'c1',
          phase: TickPhase.Events,
          dependencies: ['c2'],
        })
      )
      .use(
        makeSystem({
          id: 'c2',
          phase: TickPhase.Events,
          dependencies: ['c1'],
        })
      );

    expect(engine.boot()).rejects.toThrow(CircularDependencyError);
  });

  it('skips systems past deadline except Finalize and skipDeadlineCheck', async () => {
    const order: string[] = [];
    const engine = new BabylonEngine({
      db: {} as DrizzleClient,
      llm: {
        execute: async () => ({}) as never,
        getClient: () => ({}),
      },
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      } as unknown as import('@babylon/shared').Logger,
      config: { budgetMs: -1 }, // negative budget = immediately past deadline
    });

    engine
      .use(
        makeSystem({
          id: 'skipped',
          phase: TickPhase.Bootstrap,
          onTick: async () => {
            order.push('skipped');
            return {};
          },
        })
      )
      .use(
        makeSystem({
          id: 'critical',
          phase: TickPhase.Markets,
          skipDeadlineCheck: true,
          onTick: async () => {
            order.push('critical');
            return {};
          },
        })
      )
      .use(
        makeSystem({
          id: 'final',
          phase: TickPhase.Finalize,
          onTick: async () => {
            order.push('final');
            return {};
          },
        })
      );

    await engine.boot();
    await engine.tick();

    expect(order).toEqual(['critical', 'final']);
    await engine.shutdown();
  });

  it('merges shared data between systems', async () => {
    let receivedValue: unknown;
    const engine = makeTestEngine();

    engine
      .use(
        makeSystem({
          id: 'producer',
          phase: TickPhase.Bootstrap,
          onTick: async () => ({
            sharedData: { greeting: 'hello' },
          }),
        })
      )
      .use(
        makeSystem({
          id: 'consumer',
          phase: TickPhase.Questions,
          onTick: async (ctx) => {
            receivedValue = ctx.shared.get('greeting');
            return {};
          },
        })
      );

    await engine.boot();
    await engine.tick();

    expect(receivedValue).toBe('hello');
    await engine.shutdown();
  });

  it('catches system errors without crashing the tick', async () => {
    const engine = makeTestEngine();

    engine
      .use(
        makeSystem({
          id: 'bad',
          phase: TickPhase.Bootstrap,
          onTick: async () => {
            throw new Error('boom');
          },
        })
      )
      .use(
        makeSystem({
          id: 'good',
          phase: TickPhase.Questions,
          onTick: async () => ({ metrics: { ok: true } }),
        })
      );

    await engine.boot();
    const result = await engine.tick();

    expect(result.ok).toBe(true);
    await engine.shutdown();
  });

  it('runs interval handlers when tick number matches', async () => {
    const engine = makeTestEngine();
    let intervalRan = false;

    engine.use(
      makeSystem({
        id: 'with-interval',
        phase: TickPhase.Bootstrap,
        intervals: {
          cleanup: {
            every: 3,
            handler: async () => {
              intervalRan = true;
              return { metrics: { cleaned: true } };
            },
          },
        },
        onTick: async () => ({}),
      })
    );

    await engine.boot();

    // Tick 1, 2 — interval should NOT run
    await engine.tick();
    expect(intervalRan).toBe(false);
    await engine.tick();
    expect(intervalRan).toBe(false);

    // Tick 3 — interval SHOULD run
    const result = await engine.tick();
    expect(intervalRan).toBe(true);
    expect(result.cleaned).toBe(true);

    await engine.shutdown();
  });

  it('runs time-based interval handlers when everyMs elapsed', async () => {
    const engine = makeTestEngine();
    let intervalRan = false;

    engine.use(
      makeSystem({
        id: 'with-time-interval',
        phase: TickPhase.Bootstrap,
        intervals: {
          cleanup: {
            everyMs: 50,
            handler: async () => {
              intervalRan = true;
              return { metrics: { timeCleaned: true } };
            },
          },
        },
        onTick: async () => ({}),
      })
    );

    await engine.boot();

    // First tick always fires (lastRun = 0, so elapsed >= everyMs)
    await engine.tick();
    expect(intervalRan).toBe(true);

    // Reset and tick immediately — should NOT fire (< 50ms elapsed)
    intervalRan = false;
    await engine.tick();
    expect(intervalRan).toBe(false);

    // Wait 60ms and tick again — should fire
    await new Promise((r) => setTimeout(r, 60));
    await engine.tick();
    expect(intervalRan).toBe(true);

    await engine.shutdown();
  });

  it('throws when use() is called after boot()', async () => {
    const engine = makeTestEngine();
    engine.use(makeSystem({ id: 'a', phase: TickPhase.Bootstrap }));
    await engine.boot();

    expect(() =>
      engine.use(makeSystem({ id: 'b', phase: TickPhase.Bootstrap }))
    ).toThrow(FrameworkError);

    await engine.shutdown();
  });

  it('increments numeric metrics across systems', async () => {
    const engine = makeTestEngine();

    engine
      .use(
        makeSystem({
          id: 'a',
          phase: TickPhase.Bootstrap,
          onTick: async () => ({ metrics: { postsCreated: 3 } }),
        })
      )
      .use(
        makeSystem({
          id: 'b',
          phase: TickPhase.Questions,
          onTick: async () => ({ metrics: { postsCreated: 5 } }),
        })
      );

    await engine.boot();
    const result = await engine.tick();

    expect(result.postsCreated).toBe(8);
    await engine.shutdown();
  });

  it('tracks tick and per-system duration', async () => {
    const engine = makeTestEngine();

    engine.use(
      makeSystem({
        id: 'slow',
        phase: TickPhase.Bootstrap,
        onTick: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return {};
        },
      })
    );

    await engine.boot();
    const result = await engine.tick();

    expect(typeof result._tickDurationMs).toBe('number');
    expect(result._tickDurationMs as number).toBeGreaterThanOrEqual(10);
    expect(typeof result['_system.slow.durationMs']).toBe('number');
    expect(result['_system.slow.durationMs'] as number).toBeGreaterThanOrEqual(
      10
    );
    await engine.shutdown();
  });

  it('calls register and destroy in correct order', async () => {
    const order: string[] = [];
    const engine = makeTestEngine();

    engine
      .use(
        makeSystem({
          id: 'first',
          phase: TickPhase.Bootstrap,
          register: async () => {
            order.push('register:first');
          },
          destroy: async () => {
            order.push('destroy:first');
          },
          onTick: async () => ({}),
        })
      )
      .use(
        makeSystem({
          id: 'second',
          phase: TickPhase.Questions,
          register: async () => {
            order.push('register:second');
          },
          destroy: async () => {
            order.push('destroy:second');
          },
          onTick: async () => ({}),
        })
      );

    await engine.boot();
    await engine.shutdown();

    expect(order).toEqual([
      'register:first',
      'register:second',
      'destroy:second',
      'destroy:first',
    ]);
  });

  it('provides unctx composables inside onTick', async () => {
    let tickFromComposable: number | undefined;
    let engineAvailable = false;

    const engine = makeTestEngine();
    engine.use(
      makeSystem({
        id: 'composable-test',
        phase: TickPhase.Bootstrap,
        onTick: async () => {
          const ctx = useTick();
          tickFromComposable = ctx.tickNumber;
          const eng = useEngine();
          engineAvailable = !!eng.config;
          return {};
        },
      })
    );

    await engine.boot();
    await engine.tick();

    expect(tickFromComposable).toBe(1);
    expect(engineAvailable).toBe(true);
    await engine.shutdown();
  });

  it('provides useEngine as singleton between ticks after boot', async () => {
    const engine = makeTestEngine();
    engine.use(makeSystem({ id: 'a', phase: TickPhase.Bootstrap }));

    // Before boot, no tick context available
    expect(tryUseTick()).toBeFalsy();

    await engine.boot();

    // After boot, useEngine works as singleton
    const eng = useEngine();
    expect(eng.config.budgetMs).toBe(60000);

    // tryUseTick returns falsy outside a tick
    expect(tryUseTick()).toBeFalsy();

    await engine.shutdown();
  });
});
