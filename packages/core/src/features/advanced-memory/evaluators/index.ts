/**
 * Barrel for the advanced-memory evaluators — `summaryEvaluator`,
 * `longTermMemoryEvaluator`, and the `memoryItems` bundle — consumed by
 * `createAdvancedMemoryPlugin`.
 *
 * Uses direct import + re-export rather than `export { … } from` so Bun.build's
 * tree-shaker cannot elide the value bindings: the pure re-export form produced
 * an empty module init in the mobile agent bundle, crashing the runtime with
 * `ReferenceError: memoryItems is not defined` when the plugin referenced the
 * binding.
 */
import {
	longTermMemoryEvaluator as _longTermMemoryEvaluator,
	memoryItems as _memoryItems,
	summaryEvaluator as _summaryEvaluator,
} from "./memory-items.ts";

export const memoryItems = _memoryItems;
export const longTermMemoryEvaluator = _longTermMemoryEvaluator;
export const summaryEvaluator = _summaryEvaluator;
