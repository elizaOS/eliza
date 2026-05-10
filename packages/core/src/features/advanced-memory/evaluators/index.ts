// Direct import + re-export (instead of `export { … } from`) so Bun.build's
// tree-shaker can't elide the value bindings. The pure re-export form here
// produced an empty module init in the mobile agent bundle and the runtime
// crashed with `ReferenceError: memoryItems is not defined` when
// `createAdvancedMemoryPlugin` referenced the binding.
import {
	longTermMemoryEvaluator as _longTermMemoryEvaluator,
	memoryItems as _memoryItems,
	summaryEvaluator as _summaryEvaluator,
} from "./memory-items.ts";

export const memoryItems = _memoryItems;
export const longTermMemoryEvaluator = _longTermMemoryEvaluator;
export const summaryEvaluator = _summaryEvaluator;
