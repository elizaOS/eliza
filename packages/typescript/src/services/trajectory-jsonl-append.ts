/**
 * Append optional trajectory rows to the same **`history.jsonl`** partitions as
 * **`@elizaos/plugin-promptopt`’s `TraceWriter`**, without importing the plugin.
 *
 * **Why a dedicated module:** `TrajectoryLoggerService` lives in core; pulling
 * plugin code would create a product dependency cycle and complicate browser builds.
 * **Why reuse `historyJsonlFilePath`:** Path drift between “optimizer traces” and
 * “raw observations” was a real failure mode; shared helpers keep one directory story.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { historyJsonlFilePath } from "../history-jsonl-paths.ts";
import { getOptimizationRootDir } from "../optimization-root-dir.ts";
import type { SlotKey } from "../types/prompt-optimization-trace.ts";
import type {
	LlmObservationRecord,
	ProviderObservationRecord,
} from "../types/trajectory-jsonl.ts";

class JsonlAppender {
	private readonly rootDir: string;
	private readonly createdDirs = new Set<string>();
	private readonly writeLocks = new Map<string, Promise<void>>();

	constructor(rootDir: string) {
		this.rootDir = rootDir;
	}

	private getHistoryPath(modelId: string, slotKey: SlotKey): string {
		return historyJsonlFilePath(this.rootDir, modelId, slotKey);
	}

	private async ensureDir(modelId: string, slotKey: SlotKey): Promise<void> {
		const dir = dirname(this.getHistoryPath(modelId, slotKey));
		if (!this.createdDirs.has(dir)) {
			await mkdir(dir, { recursive: true });
			this.createdDirs.add(dir);
		}
	}

	private async withWriteLock(
		path: string,
		fn: () => Promise<void>,
	): Promise<void> {
		const prev = this.writeLocks.get(path) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		this.writeLocks.set(path, next);
		await next;
	}

	async appendRecord(
		modelId: string,
		slotKey: SlotKey,
		row: LlmObservationRecord | ProviderObservationRecord,
	): Promise<void> {
		const line = `${JSON.stringify(row)}\n`;
		await this.ensureDir(modelId, slotKey);
		const path = this.getHistoryPath(modelId, slotKey);
		await this.withWriteLock(path, () => appendFile(path, line, "utf-8"));
	}
}

const appendersByRoot = new Map<string, JsonlAppender>();

function getAppender(rootDir: string): JsonlAppender {
	let a = appendersByRoot.get(rootDir);
	if (!a) {
		a = new JsonlAppender(rootDir);
		appendersByRoot.set(rootDir, a);
	}
	return a;
}

/** Append trajectory union rows to the same `history.jsonl` tree as prompt optimization. */
export async function appendTrajectoryHistoryJsonl(
	optDirSetting: string | null | undefined,
	modelId: string,
	slotKey: SlotKey,
	row: LlmObservationRecord | ProviderObservationRecord,
): Promise<void> {
	const optDir = getOptimizationRootDir(
		typeof optDirSetting === "string" && optDirSetting ? optDirSetting : null,
	);
	await getAppender(optDir).appendRecord(modelId, slotKey, row);
}
