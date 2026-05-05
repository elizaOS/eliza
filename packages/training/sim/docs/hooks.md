# Hooks

The engine emits lifecycle events at key points during boot, tick execution, and shutdown. You can listen to these from outside the engine or from inside a system's `register()` function.

Hooks are powered by [hookable](https://github.com/unjs/hookable). `BabylonEngine` extends `Hookable<RuntimeHooks>` directly.

## Hook reference

### engine:boot

Fires after all systems have been registered and the engine is ready.

```ts
engine.hook('engine:boot', (ctx: EngineContext) => {
  console.log('Engine is up');
});
```

### engine:shutdown

Fires at the start of shutdown, before systems are destroyed.

```ts
engine.hook('engine:shutdown', () => {
  console.log('Shutting down');
});
```

### tick:before

Fires at the start of each tick, before any systems run.

```ts
engine.hook('tick:before', (ctx: TickContext) => {
  console.log(`Starting tick ${ctx.tickNumber}`);
});
```

### tick:after

Fires after all systems have run and metrics have been collected.

```ts
engine.hook('tick:after', (ctx: TickContext, metrics: Record<string, number | string | boolean>) => {
  console.log(`Tick ${ctx.tickNumber} done`, metrics);
});
```

### system:before

Fires before a specific system's `onTick` runs.

```ts
engine.hook('system:before', (systemId: string, ctx: TickContext) => {
  console.log(`About to run ${systemId}`);
});
```

### system:after

Fires after a specific system's `onTick` completes successfully.

```ts
engine.hook('system:after', (systemId: string, ctx: TickContext, result: SystemTickResult) => {
  console.log(`${systemId} finished`, result.metrics);
});
```

### system:error

Fires when a system throws during `onTick`. The tick continues with the next system.

```ts
engine.hook('system:error', (systemId: string, error: Error, ctx: TickContext) => {
  reportToSentry(error, { systemId, tick: ctx.tickNumber });
});
```

## Registering hooks

### From outside the engine

```ts
const engine = new BabylonEngine({ /* ... */ });
const unregister = engine.hook('tick:before', (ctx) => { /* ... */ });

// Later, to stop listening:
unregister();
```

### From inside a system

Use `ctx.hooks` during `register()`:

```ts
defineSystem({
  id: 'monitoring',
  name: 'Monitoring',
  phase: TickPhase.Bootstrap,

  async register(ctx) {
    ctx.hooks.hook('system:error', (systemId, error) => {
      alertOps(systemId, error);
    });
  },

  async onTick() {
    return {};
  },
});
```

### hookOnce

If you only want a hook to fire once:

```ts
engine.hookOnce('engine:boot', (ctx) => {
  // runs exactly once, then removes itself
});
```

## Execution order

Hooks run in the order they were registered. All hooks for an event complete before the engine moves on. Async hooks are awaited.

The full sequence for a tick looks like this:

1. `tick:before`
2. For each system (in sorted order):
   1. `system:before`
   2. `onTick()` runs
   3. `system:after` (or `system:error` if it threw)
   4. Interval handlers run (if applicable)
3. `tick:after`
