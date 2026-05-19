// Direct import + re-export so Bun.build's tree-shaker can't elide these
// value bindings the way it did for the pure `export { … } from` form
// (see `../evaluators/index.ts` for the same workaround). The mobile
// agent bundle was emitting an empty `init_providers` and the runtime
// crashed with `ReferenceError: longTermMemoryProvider is not defined`.
import { contextSummaryProvider as _contextSummaryProvider } from "./context-summary.ts";
import { longTermMemoryProvider as _longTermMemoryProvider } from "./long-term-memory.ts";

export const contextSummaryProvider = _contextSummaryProvider;
export const longTermMemoryProvider = _longTermMemoryProvider;
