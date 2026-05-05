# @babylon/sim

A standalone tick engine for the Babylon simulation. Systems are self-contained units of work that run in a defined order each tick. The engine handles scheduling, dependency resolution, deadline gating, metrics, and lifecycle hooks so that each system only has to worry about its own logic.

Built on the [UnJS](https://unjs.io) stack: [c12](https://github.com/unjs/c12) for config, [citty](https://github.com/unjs/citty) for CLI, [unimport](https://github.com/unjs/unimport) for auto-discovery, [hookable](https://github.com/unjs/hookable) for lifecycle events, and [unctx](https://github.com/unjs/unctx) for async-safe composables.

## Quick start

```ts
// systems/my-system.ts
import { defineSystem, TickPhase } from '@babylon/sim';

export default defineSystem({
  id: 'my-system',
  name: 'My System',
  phase: TickPhase.Events,

  async onTick(ctx) {
    // do work
    return {
      metrics: { itemsProcessed: 12 },
    };
  },
});
```

```bash
bun dev         # start with hot-reload
bun run tick    # run a single tick
bun run build   # bundle for production
```

That is the entire surface area for writing a new system. Drop a file in `systems/`, export a `defineSystem()` call, and the engine picks it up.

## Project structure

```
packages/sim/
  babylon.config.ts     Config file (loaded by c12)
  systems/              Drop systems here; auto-scanned at boot
  core/
    engine.ts           BabylonEngine runtime
    system.ts           defineSystem() helper
    types.ts            All interfaces and TickPhase enum
    composables.ts      useEngine(), useTick(), useDB(), etc.
    config.ts           Config loading and watching (c12)
    scanner.ts          System auto-discovery (unimport)
    context.ts          EngineContext and TickContext factories
    metrics.ts          Per-tick metric accumulator
    service-container.ts  Simple DI container
    llm-orchestrator.ts LLM wrapper around BabylonLLMClient
    errors.ts           Error types
    bridge/
      legacy-game-tick.ts  Bridge that wraps executeGameTick()
  cli/
    index.ts            CLI entry (citty)
    shared.ts           Shared CLI utilities (buildEngine, parseInterval, etc.)
    commands/
      dev.ts            Dev mode with file watching
      build.ts          Production bundle
      tick.ts           Single tick or loop
      info.ts           Print config and discovered systems
      document.ts       Generate markdown reference from system metadata
  tests/                Unit and integration tests
```

## Systems

A system is a plain object with an `id`, a `name`, a `phase`, and an `onTick` function. Use `defineSystem()` to get type checking.

```ts
import { defineSystem, TickPhase } from '@babylon/sim';

export default defineSystem({
  id: 'feed-generation',
  name: 'Feed Generation',
  phase: TickPhase.ContentMaintenance,
  dependencies: ['bootstrap'],       // optional: run after these systems
  skipDeadlineCheck: true,            // optional: always run, even past deadline

  async register(ctx) {
    // called once at boot, good for registering services
    ctx.services.register('feedCache', new Map());
  },

  async onTick(ctx) {
    // called every tick
    const cache = ctx.services.get<Map<string, any>>('feedCache');
    // ...
    return {
      metrics: { postsGenerated: 5 },
      sharedData: { feedReady: true },
      warnings: ['cache was cold'],
    };
  },

  async destroy() {
    // called once at shutdown, in reverse registration order
  },
});
```

### Tick phases

Systems run in phase order. Within a phase, dependencies are resolved with a topological sort.

| Phase               | Value | Purpose                              |
|---------------------|-------|--------------------------------------|
| `Bootstrap`         | 100   | Init, day number, LLM warmup        |
| `Questions`         | 200   | Question generation and persistence  |
| `Events`            | 300   | World events, narrative arcs         |
| `Markets`           | 400   | NPC trading, price updates           |
| `Rebalancing`       | 500   | Portfolio rebalancing                |
| `ContentMaintenance`| 600   | Question top-up, arcs, timeframes    |
| `Social`            | 700   | Invites, relationships, groups       |
| `Finalize`          | 800   | Caches, trending, reputation, stats  |

The `Finalize` phase always runs, even if the tick is past its deadline. Individual systems can also opt out of deadline skipping with `skipDeadlineCheck: true`.

### Return value

`onTick` returns a `SystemTickResult`:

- **metrics** - Flat key/value pairs. Numbers are summed across systems (so two systems both returning `{ postsCreated: 3 }` yields 6). Strings and booleans overwrite. Trying to increment a non-numeric metric adds a warning instead of silently failing.
- **sharedData** - Arbitrary data visible to later systems via `ctx.shared.get('key')`. Resets each tick.
- **warnings** - Collected into the tick's warning list.

### Intervals

Systems can define handlers that only run on certain ticks:

```ts
defineSystem({
  id: 'cleanup',
  name: 'Cleanup',
  phase: TickPhase.Finalize,
  intervals: {
    everyTenTicks: {
      every: 10,                     // run on tick 10, 20, 30, ...
      handler: async (ctx) => {
        // periodic cleanup
        return { metrics: { cleaned: true } };
      },
    },
    everyFiveMinutes: {
      everyMs: 300_000,              // run when 5 min have passed since last run
      handler: async (ctx) => ({ metrics: {} }),
    },
  },
  onTick: async () => ({}),
});
```

## Composables

Instead of threading the context through every function, call these anywhere inside a tick. They use `AsyncLocalStorage` under the hood, so they work across awaits without any build-time transforms.

```ts
import { useTick, useEngine, useDB, useLLM, useServices, useMetrics, useShared, useHooks } from '@babylon/sim';

// Inside onTick or any function called during a tick:
const tick = useTick();         // TickContext (tick number, timestamp, deadline, etc.)
const engine = useEngine();     // EngineContext (available after boot, even between ticks)
const db = useDB();             // Drizzle client
const llm = useLLM();           // LLM orchestrator
const services = useServices(); // Service container
const metrics = useMetrics();   // Current tick's metrics
const shared = useShared();     // Current tick's shared data
const hooks = useHooks();       // Hook registration
```

`tryUseTick()` returns `null` instead of throwing when called outside a tick.

## Hooks

The engine emits lifecycle events you can listen to. This works from outside the engine or from inside a system's `register()` function.

```ts
const engine = new BabylonEngine({ /* ... */ });

engine.hook('engine:boot', (ctx) => { /* engine just booted */ });
engine.hook('engine:shutdown', () => { /* about to shut down */ });
engine.hook('tick:before', (ctx) => { /* tick starting */ });
engine.hook('tick:after', (ctx, metrics) => { /* tick finished */ });
engine.hook('system:before', (systemId, ctx) => { /* system about to run */ });
engine.hook('system:after', (systemId, ctx, result) => { /* system finished */ });
engine.hook('system:error', (systemId, error, ctx) => { /* system threw */ });
```

`hook()` returns an unregister function. `hookOnce()` fires once then removes itself. Systems can register hooks during `register()` via `ctx.hooks.hook(...)`.

## Config

Create a `babylon.config.ts` in the package root:

```ts
import { defineBabylonConfig } from '@babylon/sim';

export default defineBabylonConfig({
  systemsDir: './systems',    // where to scan for systems
  budgetMs: 60_000,           // tick deadline in ms
  disabledSystems: [],        // system ids to skip
  dev: {
    watch: true,              // hot-reload systems in dev mode
    watchConfig: true,         // restart on config change
  },
});
```

The config loader uses c12 with `dotenv: true` and automatically finds the git repo root, so your `.env` file at the repository root is loaded before the config is evaluated. You do not need to call `dotenv.config()` yourself.

The config interface has `[key: string]: unknown` so you can add your own keys and read them from `ctx.config` inside systems.

## CLI

```
babylon dev [--interval 60] [--legacy]
  Start in dev mode. Watches the systems directory for changes and
  hot-reloads the engine. Pass --legacy to include the bridge system
  that wraps the old executeGameTick() function.

babylon tick [--loop] [--interval 60] [--legacy]
  Run a single tick and exit. With --loop, keep running on an interval.

babylon build [--outDir .output] [--minify] [--target bun]
  Discover systems, generate an entry point, and bundle everything
  into a single JS file with bun build. Writes a manifest.json with
  system metadata.

babylon info
  Print the current config and list all discovered systems grouped
  by phase.

babylon document [--outDir .docs]
  Generate markdown reference pages from system metadata. One page
  per system plus an index. Separate from the hand-written docs.
```

## Programmatic usage

You do not have to use the CLI. The engine works fine as a library:

```ts
import { BabylonEngine, defineSystem, TickPhase } from '@babylon/sim';

const engine = new BabylonEngine({
  config: { budgetMs: 30_000 },
});

engine.use(defineSystem({
  id: 'hello',
  name: 'Hello',
  phase: TickPhase.Bootstrap,
  onTick: async () => ({ metrics: { greeting: true } }),
}));

await engine.boot();
const metrics = await engine.tick();
console.log(metrics);
await engine.shutdown();
```

## Legacy bridge

The existing `executeGameTick()` function from `@babylon/engine` can run as a system:

```ts
import { BabylonEngine, createLegacyGameTickSystem } from '@babylon/sim';

const engine = new BabylonEngine();
engine.use(createLegacyGameTickSystem());
await engine.boot();
await engine.tick();
```

This lets you run the old tick alongside new systems during migration. The bridge system runs at `TickPhase.Bootstrap` with `skipDeadlineCheck: true` and flattens the entire `GameTickResult` into metrics.

## Testing

```bash
bun test tests/*.test.ts
```

Tests cover the engine, composables, hooks, context, metrics, service container, error types, config, scanner, edge cases, and full integration scenarios. Tests use mock dependencies and do not require a database or API keys.

## Architecture notes

**Phase ordering, then dependency ordering.** Systems are grouped by phase, phases are sorted numerically, and within each phase systems are topologically sorted by their `dependencies` array. A system can depend on a system in an earlier phase (it will have already run) or in the same phase (it will be sorted before you).

**Deadline gating.** Each tick gets a deadline computed from `config.budgetMs`. When the deadline passes, remaining systems are skipped with a warning, except for `Finalize`-phase systems and any system with `skipDeadlineCheck: true`.

**Error isolation.** If a system throws during `onTick`, the error is logged, a warning is added to metrics, the `system:error` hook fires, and the tick continues with the next system.

**Fresh state per tick.** Metrics and shared data are created fresh for each tick. Nothing leaks between ticks.

**Auto-discovery.** The scanner uses unimport's `scanDirExports` to find all `.ts`/`.js` files in the systems directory. It tries the default export first, then named exports. It handles both plain objects and class constructors. Duplicates within a file are deduplicated by system id.
