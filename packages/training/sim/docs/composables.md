# Composables

Composables let you access the engine and tick context from anywhere in your call stack without passing `ctx` through every function. They use `unctx` with `AsyncLocalStorage`, so they work across awaits without any compile-time transforms or Babel plugins.

## Available composables

| Function | Returns | Available |
|---|---|---|
| `useEngine()` | `EngineContext` | After `boot()`, including between ticks |
| `useTick()` | `TickContext` | Inside a tick only |
| `tryUseTick()` | `TickContext \| null` | Anywhere (returns null outside a tick) |
| `useDB()` | `DrizzleClient` | After `boot()` |
| `useLLM()` | `LLMOrchestrator` | After `boot()` |
| `useServices()` | `ServiceContainer` | After `boot()` |
| `useHooks()` | `RuntimeHookable` | After `boot()` |
| `useMetrics()` | `TickMetrics` | Inside a tick only |
| `useShared()` | `TickSharedData` | Inside a tick only |

"Inside a tick" means during execution of `onTick`, interval handlers, or any function called from them. "After boot" means after `engine.boot()` has been called and before `engine.shutdown()` completes.

## Usage

```ts
import { defineSystem, TickPhase, useDB, useMetrics } from '@babylon/sim';

export default defineSystem({
  id: 'example',
  name: 'Example',
  phase: TickPhase.Events,

  async onTick() {
    const result = await doExpensiveWork();
    return { metrics: { processed: result.count } };
  },
});

// This function does not take ctx as an argument.
// It uses composables instead.
async function doExpensiveWork() {
  const db = useDB();
  const metrics = useMetrics();

  const rows = await db.select().from(someTable);
  metrics.increment('rowsScanned', rows.length);

  return { count: rows.length };
}
```

This is useful when you have helper functions or service classes that need database access or metrics but sit several layers deep in the call stack.

## When composables throw

`useEngine()`, `useTick()`, `useDB()`, `useLLM()`, `useServices()`, `useHooks()`, `useMetrics()`, and `useShared()` all throw if called outside their valid scope. If you are not sure whether you are inside a tick, use `tryUseTick()` which returns `null` instead.

## How it works

The engine wraps `boot()` and each `tick()` call in unctx's `callAsync()`, which sets up an `AsyncLocalStorage` context. Any code running inside that async tree can call `use()` on the context to get the current value. This is the same pattern Nuxt uses for `useNuxtApp()` and `useRuntimeConfig()`.

The engine context is also set as a singleton after boot, which is why `useEngine()` works between ticks (for example, in hook handlers or scheduled jobs).
