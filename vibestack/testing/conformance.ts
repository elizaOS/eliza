// A conformance driver for an application written with Effect (SPEC.md, "Conformance"): test/drivers/<name>.ts
// exports one, and the traces stage of `pnpm check` runs it.
import { ManagedRuntime, type Effect, type Layer } from "effect";
import type { Driver, Outcome } from "../conformance.ts";

/** How an application written with Effect is reached; `R` is what `layer` provides. */
export interface EffectDriver<E, V, R> {
  dispatch(key: string, event: E, by?: unknown): Effect.Effect<Outcome, unknown, R>;
  observe(key: string): Effect.Effect<V, unknown, R>;
  observeOutput?(key: string): Effect.Effect<unknown, unknown, R>;
  receive?(key: string, raw: unknown, by?: unknown): Effect.Effect<Outcome, unknown, R>;
}

/**
 * A driver from Effect code. Each `reset` releases the runtime and builds `layer` again, so every trace starts from
 * a fresh application and its finalizers run; a layer with `TestClock.layer()` lets the driver move time.
 */
export function effectDriver<E, V, R, LE>(layer: Layer.Layer<R, LE>, app: EffectDriver<E, V, R>): Driver<E, V> & AsyncDisposable {
  let runtime = ManagedRuntime.make(layer);
  const observeOutput = app.observeOutput?.bind(app), receive = app.receive?.bind(app);
  return {
    reset: async () => { await runtime.dispose(); runtime = ManagedRuntime.make(layer); },
    dispatch: (key, event, by) => runtime.runPromise(app.dispatch(key, event, by)),
    observe: (key) => runtime.runPromise(app.observe(key)),
    ...observeOutput && { observeOutput: (key: string) => runtime.runPromise(observeOutput(key)) },
    ...receive && { receive: (key: string, raw: unknown, by?: unknown) => runtime.runPromise(receive(key, raw, by)) },
    [Symbol.asyncDispose]: () => runtime.dispose(),
  };
}
