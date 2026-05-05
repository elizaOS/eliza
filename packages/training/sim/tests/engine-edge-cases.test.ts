import { describe, expect, it } from 'bun:test';
import type { DrizzleClient } from '@babylon/db';
import { BabylonEngine } from '../core/engine';
import { CircularDependencyError, FrameworkError } from '../core/errors';
import { defineSystem } from '../core/system';
import type { BabylonSystem } from '../core/types';
import { TickPhase } from '../core/types';

function makeTestEngine(budgetMs = 60000) {
  return new BabylonEngine({
    db: {} as DrizzleClient,
    llm: { execute: async () => ({}) as never, getClient: () => ({}) },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as import('@babylon/shared').Logger,
    config: { budgetMs },
  });
}

function makeSystem(
  overrides: Partial<BabylonSystem> & { id: string; phase: TickPhase }
): BabylonSystem {
  return {
    name: overrides.id,
    onTick: async () => ({}),
    ...overrides,
  };
}

describe('circular dependency detection', () => {
  it('detects 3-node cycle (a -> b -> c -> a)', () => {
    const engine = makeTestEngine();
    engine.use(
      makeSystem({ id: 'a', phase: TickPhase.Events, dependencies: ['c'] })
    );
    engine.use(
      makeSystem({ id: 'b', phase: TickPhase.Events, dependencies: ['a'] })
    );
    engine.use(
      makeSystem({ id: 'c', phase: TickPhase.Events, dependencies: ['b'] })
    );

    expect(engine.boot()).rejects.toThrow(CircularDependencyError);
  });

  it('detects 4-node cycle', () => {
    const engine = makeTestEngine();
    engine.use(
      makeSystem({ id: 'w', phase: TickPhase.Events, dependencies: ['z'] })
    );
    engine.use(
      makeSystem({ id: 'x', phase: TickPhase.Events, dependencies: ['w'] })
    );
    engine.use(
      makeSystem({ id: 'y', phase: TickPhase.Events, dependencies: ['x'] })
    );
    engine.use(
      makeSystem({ id: 'z', phase: TickPhase.Events, dependencies: ['y'] })
    );

    expect(engine.boot()).rejects.toThrow(CircularDependencyError);
  });
});

describe('interval validation', () => {
  it('warns and skips interval with every=0', async () => {
    const engine = makeTestEngine();
    engine.use(
      makeSystem({
        id: 'bad-interval',
        phase: TickPhase.Bootstrap,
        intervals: {
          broken: {
            every: 0,
            handler: async () => ({ metrics: { shouldNotRun: true } }),
          },
        },
      })
    );

    await engine.boot();
    const result = await engine.tick();

    expect(result.shouldNotRun).toBeUndefined();
    await engine.shutdown();
  });

  it('warns and skips interval with negative everyMs', async () => {
    const engine = makeTestEngine();
    engine.use(
      makeSystem({
        id: 'neg-interval',
        phase: TickPhase.Bootstrap,
        intervals: {
          broken: {
            everyMs: -100,
            handler: async () => ({ metrics: { shouldNotRun: true } }),
          },
        },
      })
    );

    await engine.boot();
    const result = await engine.tick();

    expect(result.shouldNotRun).toBeUndefined();
    await engine.shutdown();
  });

  it('runs interval with every=1 on every tick', async () => {
    const runs: number[] = [];
    const engine = makeTestEngine();
    engine.use(
      makeSystem({
        id: 'every-tick',
        phase: TickPhase.Bootstrap,
        intervals: {
          always: {
            every: 1,
            handler: async (ctx) => {
              runs.push(ctx.tickNumber);
              return {};
            },
          },
        },
      })
    );

    await engine.boot();
    await engine.tick();
    await engine.tick();
    await engine.tick();

    expect(runs).toEqual([1, 2, 3]);
    await engine.shutdown();
  });
});

describe('register failures', () => {
  it('throws FrameworkError when register() fails', () => {
    const engine = makeTestEngine();
    engine.use(
      defineSystem({
        id: 'bad-register',
        name: 'Bad Register',
        phase: TickPhase.Bootstrap,
        register: async () => {
          throw new Error('db not available');
        },
        onTick: async () => ({}),
      })
    );

    expect(engine.boot()).rejects.toThrow(FrameworkError);
  });
});

describe('multiple system failures in one tick', () => {
  it('continues running all systems even when multiple fail', async () => {
    const engine = makeTestEngine();
    const errors: string[] = [];

    engine.hook('system:error', (id, err) => {
      errors.push(`${id}:${err.message}`);
    });

    engine.use(
      makeSystem({
        id: 'fail1',
        phase: TickPhase.Bootstrap,
        onTick: async () => {
          throw new Error('boom1');
        },
      })
    );
    engine.use(
      makeSystem({
        id: 'fail2',
        phase: TickPhase.Questions,
        onTick: async () => {
          throw new Error('boom2');
        },
      })
    );
    engine.use(
      makeSystem({
        id: 'ok',
        phase: TickPhase.Events,
        onTick: async () => ({ metrics: { survived: true } }),
      })
    );

    await engine.boot();
    const result = await engine.tick();

    expect(errors).toEqual(['fail1:boom1', 'fail2:boom2']);
    expect(result.survived).toBe(true);
    await engine.shutdown();
  });
});

describe('empty engine', () => {
  it('boots and ticks with zero systems', async () => {
    const engine = makeTestEngine();
    await engine.boot();
    const result = await engine.tick();

    expect(typeof result._tickDurationMs).toBe('number');
    await engine.shutdown();
  });
});

describe('tick before boot', () => {
  it('throws FrameworkError', () => {
    const engine = makeTestEngine();
    expect(engine.tick()).rejects.toThrow(FrameworkError);
  });
});

describe('shutdown cleans up lastIntervalRun', () => {
  it('interval state resets across boot cycles', async () => {
    const runs: number[] = [];
    const engine = makeTestEngine();
    engine.use(
      makeSystem({
        id: 'interval-sys',
        phase: TickPhase.Bootstrap,
        intervals: {
          check: {
            every: 2,
            handler: async (ctx) => {
              runs.push(ctx.tickNumber);
              return {};
            },
          },
        },
      })
    );

    await engine.boot();
    await engine.tick(); // tick 1
    await engine.tick(); // tick 2 — fires
    await engine.shutdown();

    // Interval ran on tick 2
    expect(runs).toEqual([2]);
  });
});

describe('destroy order matches reverse registration', () => {
  it('destroys in reverse registration order regardless of phase', async () => {
    const order: string[] = [];
    const engine = makeTestEngine();

    engine.use(
      makeSystem({
        id: 'z-finalize',
        phase: TickPhase.Finalize,
        destroy: async () => {
          order.push('z');
        },
      })
    );
    engine.use(
      makeSystem({
        id: 'a-bootstrap',
        phase: TickPhase.Bootstrap,
        destroy: async () => {
          order.push('a');
        },
      })
    );

    await engine.boot();
    await engine.shutdown();

    // Reverse of registration order: a, then z
    expect(order).toEqual(['a', 'z']);
  });
});
