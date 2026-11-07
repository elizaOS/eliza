/**
 * Per-turn LLM-usage capture for the bench server, keyed by async context.
 *
 * Model plugins (@elizaos/plugin-openai, -anthropic, -openrouter, …) emit a
 * `MODEL_USED` event for each LLM call but carry no session/turn handle in the
 * payload — the only way to attribute an event to the turn that triggered it is
 * the async call chain it fires within: the plugin's model handler runs inside
 * `runtime.useModel(...)`, which the turn `await`s, and `emitEvent` invokes the
 * registered handler synchronously within that same chain. `AsyncLocalStorage`
 * carries the turn's buffer down that chain, so overlapping turns on different
 * sessions each collect exactly their own calls with no shared mutable state.
 *
 * This replaces a former process-global `activeUsageBuffer` that was only
 * correct for one-turn-at-a-time-per-session; the multitask concurrency
 * benchmark (issue #13777) runs a single agent handling N overlapping turns,
 * which corrupted token/cost attribution under the global. Every turn body runs
 * inside {@link UsageCapture.run}; the `MODEL_USED` listener pushes into
 * {@link UsageCapture.current}.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { BenchmarkLlmCallUsage } from "./server-utils.js";

export class UsageCapture {
  private readonly store = new AsyncLocalStorage<BenchmarkLlmCallUsage[]>();

  /**
   * Run `fn` with `buffer` bound as the active turn's usage buffer for the
   * duration of its async execution. `MODEL_USED` events emitted anywhere in
   * `fn`'s call chain land in `buffer`. Nested/overlapping calls each see their
   * own buffer; the binding is torn down automatically when `fn` settles.
   */
  run<T>(buffer: BenchmarkLlmCallUsage[], fn: () => Promise<T>): Promise<T> {
    return this.store.run(buffer, fn);
  }

  /** The buffer bound by the enclosing {@link run}, or `null` outside a turn. */
  current(): BenchmarkLlmCallUsage[] | null {
    return this.store.getStore() ?? null;
  }
}
