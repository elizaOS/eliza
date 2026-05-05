# Writing systems

This guide covers everything you need to know to write a new system for `@babylon/sim`.

## The basics

A system is a plain object. You define it with `defineSystem()`, which gives you type safety but does not add any runtime behavior. It just returns what you pass in.

```ts
import { defineSystem, TickPhase } from '@babylon/sim';

export default defineSystem({
  id: 'my-system',
  name: 'My System',
  phase: TickPhase.Events,

  async onTick(ctx) {
    return {};
  },
});
```

Put this in the `systems/` directory (or wherever `systemsDir` points in your config). The engine scans that directory at boot and picks up any file that exports something matching the `BabylonSystem` shape.

The file must have a default export or a named export. Both work. If you have multiple exports in one file, the scanner tries all of them.

## Required fields

- **id** - Unique string. Used for dependency resolution, metrics keys, and logs.
- **name** - Human-readable label. Shows up in `babylon info` output.
- **phase** - A `TickPhase` value that determines when your system runs relative to others.
- **onTick(ctx)** - The function that runs every tick. Must return a `SystemTickResult` (or just `{}`).

## Optional fields

- **dependencies** - Array of system ids. Your system will run after all of them. They can be in the same phase or an earlier one.
- **skipDeadlineCheck** - If `true`, your system runs even when the tick is past its time budget.
- **register(ctx)** - Called once at boot, before any ticks. Good for setting up services.
- **destroy()** - Called once at shutdown, in reverse registration order. Good for cleanup.
- **intervals** - Named handlers that run conditionally (see below).

## The tick context

The `ctx` argument passed to `onTick` has everything you need:

```ts
ctx.db              // Drizzle database client
ctx.llm             // LLM orchestrator (execute prompts, get the raw client)
ctx.logger          // Logger instance
ctx.services        // Service container (get/register/has)
ctx.config          // Engine config (budgetMs, plus any custom keys)
ctx.hooks           // Register lifecycle hooks
ctx.timestamp       // Date object for this tick
ctx.deadline        // Unix ms timestamp when the budget runs out
ctx.tickNumber      // Increments each tick (1, 2, 3, ...)
ctx.dayNumber       // Optional, passed from engine.tick(dayNumber)
ctx.shared          // Shared data store (get/set/has), fresh each tick
ctx.metrics         // Tick metrics (set/get/increment)
ctx.isPastDeadline()  // Check if we have exceeded the budget
```

You can also use composables instead of passing `ctx` around. See the composables doc for details.

## Returning results

`onTick` returns a `SystemTickResult`:

```ts
return {
  metrics: {
    itemsProcessed: 42,      // numbers are summed across systems
    cacheHit: true,           // booleans and strings overwrite
  },
  sharedData: {
    feedItems: [...],          // visible to systems that run later via ctx.shared
  },
  warnings: [
    'Feed cache was stale',   // collected and reported at end of tick
  ],
};
```

All three fields are optional. Returning `{}` is fine.

**Metric accumulation**: if two systems both return `{ postsCreated: 3 }`, the final value is 6. This only applies to numbers. Strings and booleans just overwrite whatever was there before. If a system returns a string or boolean for a key that was previously a number, the engine adds a warning rather than silently dropping the increment.

**Shared data**: written to `ctx.shared` after your system runs. Later systems can read it with `ctx.shared.get<T>('key')`. Shared data resets between ticks. It does not accumulate.

## Dependencies

```ts
defineSystem({
  id: 'trade-execution',
  name: 'Trade Execution',
  phase: TickPhase.Markets,
  dependencies: ['market-context'],
  // ...
});
```

This guarantees `market-context` runs before `trade-execution`. Both systems must be registered. If a dependency is missing, boot fails with a `SystemNotFoundError`. If there is a cycle, boot fails with a `CircularDependencyError`.

Dependencies only affect ordering within a phase. If your dependency is in an earlier phase, it runs first anyway because of phase ordering. You can still list it as a dependency for clarity (and the engine will not complain), but it has no practical effect.

## Intervals

Sometimes you want a handler that runs every N ticks or every N milliseconds, not every tick.

```ts
defineSystem({
  id: 'cache-refresh',
  name: 'Cache Refresh',
  phase: TickPhase.Finalize,
  intervals: {
    hourly: {
      everyMs: 3_600_000,
      handler: async (ctx) => {
        await refreshCaches();
        return { metrics: { cachesRefreshed: true } };
      },
    },
    periodic: {
      every: 5,          // runs on tick 5, 10, 15, ...
      handler: async (ctx) => {
        return {};
      },
    },
  },
  onTick: async () => ({}),
});
```

Interval handlers run after `onTick` completes. Their results are merged into the same tick's metrics and shared data.

`every` is tick-count-based (must be >= 1). `everyMs` is wall-clock-based in milliseconds (must be >= 1, checked against the time since the last run). Values less than 1 are skipped with a warning. You can use one or both on a single interval.

## Registering services

If your system needs to share a long-lived object (a cache, a connection pool, a stateful service), register it in `register()`:

```ts
defineSystem({
  id: 'feed-cache',
  name: 'Feed Cache',
  phase: TickPhase.Bootstrap,

  async register(ctx) {
    const cache = new FeedCache();
    await cache.init();
    ctx.services.register('feedCache', cache);
  },

  async onTick(ctx) {
    const cache = ctx.services.get<FeedCache>('feedCache');
    // ...
  },

  async destroy() {
    // clean up if needed
  },
});
```

Other systems can then call `ctx.services.get<FeedCache>('feedCache')`. If you ask for a service that does not exist, it throws a `ServiceNotFoundError` with a list of what is available.

## Hooks from inside a system

Systems can listen to engine lifecycle events during `register()`:

```ts
defineSystem({
  id: 'analytics',
  name: 'Analytics',
  phase: TickPhase.Finalize,

  async register(ctx) {
    ctx.hooks.hook('tick:after', (tickCtx, metrics) => {
      console.log('Tick finished:', metrics);
    });
  },

  async onTick() {
    return {};
  },
});
```

The available hooks are `engine:boot`, `engine:shutdown`, `tick:before`, `tick:after`, `system:before`, `system:after`, and `system:error`.

## Error handling

If your `onTick` throws, the engine catches it, logs it, adds a warning to the tick metrics, fires the `system:error` hook, and moves on to the next system. The tick does not abort. Multiple systems can fail in the same tick and the engine keeps going.

If your `register()` throws, boot fails immediately with a `FrameworkError` that includes your system id and the original error message.

You do not need to wrap your logic in try/catch unless you want to handle specific errors yourself and return partial results.

## Deadline behavior

Each tick has a deadline computed from `config.budgetMs`. When a system is about to run and the deadline has passed, the engine skips it with a warning.

Two exceptions:
1. Systems in the `Finalize` phase (800) always run.
2. Systems with `skipDeadlineCheck: true` always run.

Use `skipDeadlineCheck` for systems where skipping would cause data integrity problems (like trade execution).

You can check the deadline yourself inside `onTick` with `ctx.isPastDeadline()` if you want to bail out of expensive work early.
