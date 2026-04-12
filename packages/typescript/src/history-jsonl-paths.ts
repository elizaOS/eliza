import { join } from "node:path";

/**
 * Filesystem-safe paths under `OPTIMIZATION_DIR` shared by:
 *
 * - `@elizaos/plugin-promptopt` **`TraceWriter`** (optimizer + finalizer traces)
 * - **`TrajectoryLoggerService`** optional JSONL rows (`llm_observation`, …)
 *
 * **Why live in core?** Trajectory logging is a core service but must not import the
 * plugin (cyclic product dependency + harder browser story). Duplicating only **path
 * rules** keeps append serialization next to `TraceWriter` without pulling `node:fs`
 * into every consumer of types.
 *
 * **Why colon → `__`?** Model ids often include `provider:tag`; `:` is invalid on
 * some filesystems and annoying in shell tab-completion.
 */
export function sanitizeModelId(modelId: string): string {
	return modelId
		.replace(/:/g, "__")
		.replace(/\//g, "_")
		.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Absolute path to `history.jsonl` for a `(modelId, slotKey)` partition. */
export function historyJsonlFilePath(
	rootDir: string,
	modelId: string,
	slotKey: string,
): string {
	return join(rootDir, sanitizeModelId(modelId), slotKey, "history.jsonl");
}
