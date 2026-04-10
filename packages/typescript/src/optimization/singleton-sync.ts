/**
 * Bridges `OptimizationRunner` (fresh `SlotProfileManager` per run) and the
 * process-wide singleton from `getSlotProfileManager`.
 *
 * **Why:** `markOptimized` in the runner updates disk via a local manager
 * instance; the singleton still holds a stale in-memory profile with
 * `needsReoptimization: true`. The next `maybeRunAutoPromptOptimization`
 * (e.g. another trace in the same RUN_ENDED batch) would run the full pipeline
 * again. Invalidating the singleton cache forces the next `get()` to reload
 * from disk.
 */

export type SlotProfileCacheInvalidator = (
	rootDir: string,
	modelId: string,
	slotKey: string,
	promptKey: string,
) => void;

let invalidator: SlotProfileCacheInvalidator | null = null;

export function registerSlotProfileCacheInvalidator(
	fn: SlotProfileCacheInvalidator,
): void {
	invalidator = fn;
}

export function invalidateSlotProfileProcessCache(
	rootDir: string,
	modelId: string,
	slotKey: string,
	promptKey: string,
): void {
	invalidator?.(rootDir, modelId, slotKey, promptKey);
}
