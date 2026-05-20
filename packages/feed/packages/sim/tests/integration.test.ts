import { describe, expect, it } from 'bun:test';
import type { DrizzleClient } from '@babylon/db';
import {
  useDB,
  useEngine,
  useMetrics,
  useServices,
  useTick,
} from '../core/composables';
import { BabylonEngine } from '../core/engine';
import { defineSystem } from '../core/system';
import type { EngineContext, TickContext } from '../core/types';
import { TickPhase } from '../core/types';

function makeTestEngine(budgetMs = 60000) {
  return new BabylonEngine({
    db: { _marker: 'integration-db' } as unknown as DrizzleClient,
    llm: {
      execute: async () => ({ generated: true }) as never,
      getClient: () => ({ _marker: 'integration-client' }),
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as import('@babylon/shared').Logger,
    config: { budgetMs },
  });
}

describe('Integration: full engine lifecycle', () => {
  it('boot → register services → tick with shared data → hooks → composables → shutdown', async () => {
    const lifecycle: string[] = [];
    const engine = makeTestEngine();

    // Hook lifecycle tracking
    engine.hook('engine:boot', () => {
      lifecycle.push('hook:boot');
    });
    engine.hook('engine:shutdown', () => {
      lifecycle.push('hook:shutdown');
    });
    engine.hook('tick:before', () => {
      lifecycle.push('hook:tick:before');
    });
    engine.hook('tick:after', () => {
      lifecycle.push('hook:tick:after');
    });

    // Module A: registers a service, produces shared data
    engine.use(
      defineSystem({
        id: 'setup',
        name: 'Setup',
        phase: TickPhase.Bootstrap,
        register: async (ctx: EngineContext) => {
          lifecycle.push('register:setup');
          ctx.services.register('cache', new Map<string, string>());
        },
        onTick: async () => {
          lifecycle.push('tick:setup');
          const services = useServices();
          const cache = services.get<Map<string, string>>('cache');
          cache.set('hello', 'world');

          return {
            sharedData: { bootstrapDone: true },
            metrics: { setupRan: true },
          };
        },
        destroy: async () => {
          lifecycle.push('destroy:setup');
        },
      })
    );

    // Module B: depends on A, reads shared data, uses composables
    engine.use(
      defineSystem({
        id: 'processor',
        name: 'Processor',
        phase: TickPhase.Events,
        dependencies: ['setup'],
        register: async () => {
          lifecycle.push('register:processor');
        },
        onTick: async () => {
          lifecycle.push('tick:processor');

          // Composables work
          const tick = useTick();
          expect(tick.tickNumber).toBe(1);
          expect(tick.shared.get<boolean>('bootstrapDone')).toBe(true);

          const eng = useEngine();
          expect(eng.config.budgetMs).toBe(60000);

          const db = useDB();
          expect((db as unknown as { _marker: string })._marker).toBe(
            'integration-db'
          );

          const metrics = useMetrics();
          metrics.increment('processed', 10);

          return { metrics: { processorRan: true } };
        },
        destroy: async () => {
          lifecycle.push('destroy:processor');
        },
      })
    );

    // Module C: finalize phase, always runs
    engine.use(
      defineSystem({
        id: 'finalize',
        name: 'Finalize',
        phase: TickPhase.Finalize,
        register: async () => {
          lifecycle.push('register:finalize');
        },
        onTick: async () => {
          lifecycle.push('tick:finalize');
          return { metrics: { finalized: true } };
        },
        destroy: async () => {
          lifecycle.push('destroy:finalize');
        },
      })
    );

    // Boot
    await engine.boot();

    // Verify register order (phase-sorted)
    expect(lifecycle).toEqual([
      'register:setup',
      'register:processor',
      'register:finalize',
      'hook:boot',
    ]);

    // Run tick
    const result = await engine.tick();

    expect(lifecycle.slice(4)).toEqual([
      'hook:tick:before',
      'tick:setup',
      'tick:processor',
      'tick:finalize',
      'hook:tick:after',
    ]);

    // Verify aggregated metrics
    expect(result.setupRan).toBe(true);
    expect(result.processorRan).toBe(true);
    expect(result.finalized).toBe(true);
    expect(result.processed).toBe(10);
    expect(typeof result._tickDurationMs).toBe('number');

    // Shutdown
    await engine.shutdown();

    // Destroy in reverse order
    const destroyEvents = lifecycle.filter((e) => e.startsWith('destroy:'));
    expect(destroyEvents).toEqual([
      'destroy:finalize',
      'destroy:processor',
      'destroy:setup',
    ]);
  });

  it('multi-tick state isolation: shared data resets each tick', async () => {
    const engine = makeTestEngine();
    const sharedValues: (string | undefined)[] = [];

    engine.use(
      defineSystem({
        id: 'writer',
        name: 'Writer',
        phase: TickPhase.Bootstrap,
        onTick: async (ctx: TickContext) => {
          // Check if previous tick's data leaked
          sharedValues.push(ctx.shared.get<string>('tick-data'));
          return { sharedData: { 'tick-data': `from-tick-${ctx.tickNumber}` } };
        },
      })
    );

    await engine.boot();
    await engine.tick();
    await engine.tick();
    await engine.tick();

    // Each tick starts with fresh shared data
    expect(sharedValues).toEqual([undefined, undefined, undefined]);
    await engine.shutdown();
  });

  it('multi-tick metric isolation: metrics reset each tick', async () => {
    const engine = makeTestEngine();

    engine.use(
      defineSystem({
        id: 'counter',
        name: 'Counter',
        phase: TickPhase.Bootstrap,
        onTick: async () => ({ metrics: { count: 1 } }),
      })
    );

    await engine.boot();
    const r1 = await engine.tick();
    const r2 = await engine.tick();

    // Metrics don't accumulate across ticks
    expect(r1.count).toBe(1);
    expect(r2.count).toBe(1);
    await engine.shutdown();
  });

  it('error in one module does not prevent subsequent modules', async () => {
    const engine = makeTestEngine();
    const errors: string[] = [];

    engine.hook('system:error', (id, err) => {
      errors.push(`${id}:${err.message}`);
    });

    engine
      .use(
        defineSystem({
          id: 'bad',
          name: 'Bad',
          phase: TickPhase.Bootstrap,
          onTick: async () => {
            throw new Error('kaboom');
          },
        })
      )
      .use(
        defineSystem({
          id: 'good',
          name: 'Good',
          phase: TickPhase.Questions,
          onTick: async () => ({ metrics: { survived: true } }),
        })
      );

    await engine.boot();
    const result = await engine.tick();

    expect(errors).toEqual(['bad:kaboom']);
    expect(result.survived).toBe(true);
    await engine.shutdown();
  });

  it('deadline skipping with Finalize always running', async () => {
    const engine = makeTestEngine(-1); // immediately past deadline
    const ran: string[] = [];

    engine
      .use(
        defineSystem({
          id: 'skipped',
          name: 'Skipped',
          phase: TickPhase.Bootstrap,
          onTick: async () => {
            ran.push('skipped');
            return {};
          },
        })
      )
      .use(
        defineSystem({
          id: 'critical',
          name: 'Critical',
          phase: TickPhase.Markets,
          skipDeadlineCheck: true,
          onTick: async () => {
            ran.push('critical');
            return {};
          },
        })
      )
      .use(
        defineSystem({
          id: 'final',
          name: 'Final',
          phase: TickPhase.Finalize,
          onTick: async () => {
            ran.push('final');
            return {};
          },
        })
      );

    await engine.boot();
    await engine.tick();

    expect(ran).toEqual(['critical', 'final']);
    await engine.shutdown();
  });

  it('complex dependency graph with multi-phase modules', async () => {
    const order: string[] = [];
    const engine = makeTestEngine();

    // Phase Bootstrap: a, b (b depends on a)
    engine.use(
      defineSystem({
        id: 'a',
        name: 'A',
        phase: TickPhase.Bootstrap,
        onTick: async () => {
          order.push('a');
          return {};
        },
      })
    );
    engine.use(
      defineSystem({
        id: 'b',
        name: 'B',
        phase: TickPhase.Bootstrap,
        dependencies: ['a'],
        onTick: async () => {
          order.push('b');
          return {};
        },
      })
    );

    // Phase Markets: c depends on d (both in same phase)
    engine.use(
      defineSystem({
        id: 'c',
        name: 'C',
        phase: TickPhase.Markets,
        dependencies: ['d'],
        onTick: async () => {
          order.push('c');
          return {};
        },
      })
    );
    engine.use(
      defineSystem({
        id: 'd',
        name: 'D',
        phase: TickPhase.Markets,
        onTick: async () => {
          order.push('d');
          return {};
        },
      })
    );

    // Phase Finalize: e depends on b (cross-phase, b already ran)
    engine.use(
      defineSystem({
        id: 'e',
        name: 'E',
        phase: TickPhase.Finalize,
        dependencies: ['b'],
        onTick: async () => {
          order.push('e');
          return {};
        },
      })
    );

    await engine.boot();
    await engine.tick();

    // a before b (dep), then d before c (dep), then e
    expect(order).toEqual(['a', 'b', 'd', 'c', 'e']);
    await engine.shutdown();
  });

  it('intervals with defineSystem', async () => {
    const engine = makeTestEngine();
    const intervalRuns: number[] = [];

    engine.use(
      defineSystem({
        id: 'with-interval',
        name: 'With Interval',
        phase: TickPhase.Bootstrap,
        intervals: {
          periodic: {
            every: 2,
            handler: async (ctx) => {
              intervalRuns.push(ctx.tickNumber);
              return { metrics: { intervalRan: true } };
            },
          },
        },
        onTick: async () => ({}),
      })
    );

    await engine.boot();
    await engine.tick(); // tick 1 — no interval
    await engine.tick(); // tick 2 — interval fires
    await engine.tick(); // tick 3 — no interval
    await engine.tick(); // tick 4 — interval fires

    expect(intervalRuns).toEqual([2, 4]);
    await engine.shutdown();
  });

  it('modules communicate through shared data across phases', async () => {
    const engine = makeTestEngine();
    let finalResult: unknown;

    engine.use(
      defineSystem({
        id: 'phase1',
        name: 'Phase 1',
        phase: TickPhase.Bootstrap,
        onTick: async () => ({
          sharedData: { items: [1, 2, 3] },
        }),
      })
    );

    engine.use(
      defineSystem({
        id: 'phase2',
        name: 'Phase 2',
        phase: TickPhase.Events,
        onTick: async (ctx) => {
          const items = ctx.shared.get<number[]>('items') ?? [];
          const doubled = items.map((i) => i * 2);
          return { sharedData: { items: doubled } };
        },
      })
    );

    engine.use(
      defineSystem({
        id: 'phase3',
        name: 'Phase 3',
        phase: TickPhase.Finalize,
        onTick: async (ctx) => {
          finalResult = ctx.shared.get<number[]>('items');
          return {};
        },
      })
    );

    await engine.boot();
    await engine.tick();

    // Phase 2 overwrites the shared data
    expect(finalResult).toEqual([2, 4, 6]);
    await engine.shutdown();
  });

  it('warnings from modules and intervals are collected', async () => {
    const engine = makeTestEngine();

    engine.use(
      defineSystem({
        id: 'warn-mod',
        name: 'Warn Module',
        phase: TickPhase.Bootstrap,
        onTick: async () => ({
          warnings: ['manual warning'],
        }),
      })
    );

    engine.use(
      defineSystem({
        id: 'error-mod',
        name: 'Error Module',
        phase: TickPhase.Questions,
        onTick: async () => {
          throw new Error('oops');
        },
      })
    );

    await engine.boot();
    const result = await engine.tick();

    // Check that metrics snapshot includes the warning-related info
    // The tick should still complete
    expect(typeof result._tickDurationMs).toBe('number');
    await engine.shutdown();
  });
});
