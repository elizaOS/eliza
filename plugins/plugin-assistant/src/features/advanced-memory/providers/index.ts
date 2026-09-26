/**
 * Barrel for the advanced-memory `longTermMemoryProvider`, consumed by
 * `createAdvancedMemoryPlugin`.
 *
 * Uses direct import + re-export rather than `export { … } from` so Bun.build's
 * tree-shaker cannot elide the value bindings (same workaround as
 * `../evaluators/index.ts`): the pure re-export form emitted an empty
 * `init_providers` in the mobile agent bundle, crashing the runtime with
 * `ReferenceError: longTermMemoryProvider is not defined`.
 */
import { longTermMemoryProvider as _longTermMemoryProvider } from "./long-term-memory.ts";

export const longTermMemoryProvider = _longTermMemoryProvider;
