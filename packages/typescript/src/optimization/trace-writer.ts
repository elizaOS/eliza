import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeModelId } from "./resolver.ts";
import type {
	ABDecision,
	ExecutionTrace,
	HistoryRecord,
	LlmObservationRecord,
	OptimizationRun,
	ProviderObservationRecord,
	SignalContextRecord,
	SlotKey,
} from "./types.ts";

/**
 * TraceWriter appends records to history.jsonl on disk.
 *
 * WHY JSONL: append-only writes are atomic on POSIX (single write < PIPE_BUF),
 * need no schema migrations, and can be processed with standard Unix tools.
 * Each line is self-contained JSON, so a crash mid-write at most corrupts one
 * line, which loadTraces silently skips.
 *
 * WHY fire-and-forget: DPE must not block on disk I/O. The baseline trace is
 * written asynchronously; if it fails, the finalizer's enriched write still
 * captures the data. Dedup by seq handles any ordering ambiguity.
 */
export class TraceWriter {
	private readonly rootDir: string;
	/** Tracks which directories have been created to avoid repeated mkdir calls */
	private readonly createdDirs = new Set<string>();
	/** WHY per-path locks: multiple fire-and-forget writes to the same file
	 *  can interleave, producing corrupt lines. Promise-chaining serializes
	 *  them without external dependencies or deadlock risk. */
	private readonly writeLocks = new Map<string, Promise<void>>();
	/** WHY monotonic seq: DPE and finalizer both write the same trace.id.
	 *  The higher seq always wins in loadTraces, guaranteeing the enriched
	 *  copy prevails regardless of async I/O ordering. */
	private _seq = 0;

	constructor(rootDir: string) {
		this.rootDir = rootDir;
	}

	/** Returns a monotonically increasing sequence number */
	nextSeq(): number {
		return ++this._seq;
	}

	private getHistoryPath(modelId: string, slotKey: SlotKey): string {
		return join(
			this.rootDir,
			sanitizeModelId(modelId),
			slotKey,
			"history.jsonl",
		);
	}

	private async ensureDir(modelId: string, slotKey: SlotKey): Promise<string> {
		const dir = join(this.rootDir, sanitizeModelId(modelId), slotKey);
		if (!this.createdDirs.has(dir)) {
			await mkdir(dir, { recursive: true });
			this.createdDirs.add(dir);
		}
		return dir;
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

	private async append(
		modelId: string,
		slotKey: SlotKey,
		record: HistoryRecord,
	): Promise<void> {
		// WHY eager stringify: the DPE calls appendTrace fire-and-forget, then
		// evaluators mutate the same trace object (pushing signals). Serializing
		// before the first await captures the trace state at call time.
		const line = `${JSON.stringify(record)}\n`;
		await this.ensureDir(modelId, slotKey);
		const path = this.getHistoryPath(modelId, slotKey);
		await this.withWriteLock(path, () => appendFile(path, line, "utf-8"));
	}

	async appendTrace(
		modelId: string,
		slotKey: SlotKey,
		trace: ExecutionTrace,
	): Promise<void> {
		await this.append(modelId, slotKey, trace);
	}

	async appendOptimizationRun(
		modelId: string,
		slotKey: SlotKey,
		run: OptimizationRun,
	): Promise<void> {
		await this.append(modelId, slotKey, run);
	}

	async appendABDecision(
		modelId: string,
		slotKey: SlotKey,
		decision: ABDecision,
	): Promise<void> {
		await this.append(modelId, slotKey, decision);
	}

	// --- Observability union rows (same file + lock as optimizer traces) ---
	// loadTraces() ignores these types; see docs/PROMPT_OPTIMIZATION.md.

	async appendLlmObservation(
		modelId: string,
		slotKey: SlotKey,
		row: LlmObservationRecord,
	): Promise<void> {
		await this.append(modelId, slotKey, row);
	}

	async appendProviderObservation(
		modelId: string,
		slotKey: SlotKey,
		row: ProviderObservationRecord,
	): Promise<void> {
		await this.append(modelId, slotKey, row);
	}

	async appendSignalContext(
		modelId: string,
		slotKey: SlotKey,
		row: SignalContextRecord,
	): Promise<void> {
		await this.append(modelId, slotKey, row);
	}

	/**
	 * Load all traces from history.jsonl for a given model/slot.
	 * Used by the optimizer pipeline to load training data.
	 */
	async loadTraces(
		modelId: string,
		slotKey: SlotKey,
	): Promise<ExecutionTrace[]> {
		const path = this.getHistoryPath(modelId, slotKey);
		const { readFile } = await import("node:fs/promises");
		let content: string;
		try {
			content = await readFile(path, "utf-8");
		} catch {
			return [];
		}

		// Deduplicate by trace id, keeping the row with the highest `seq`.
		// DPE writes a baseline trace and the finalizer writes the enriched
		// version with the same id but a higher seq number; this guarantees
		// the enriched copy wins regardless of I/O ordering on disk.
		const byId = new Map<string, ExecutionTrace>();
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const record = JSON.parse(trimmed) as HistoryRecord;
				if (record.type === "trace") {
					const trace = record as ExecutionTrace;
					const existing = byId.get(trace.id);
					if (!existing || (trace.seq ?? 0) >= (existing.seq ?? 0)) {
						byId.set(trace.id, trace);
					}
				}
			} catch {
				// Skip malformed lines
			}
		}
		return [...byId.values()];
	}

	/**
	 * Load traces filtered by promptKey.
	 */
	async loadTracesForPrompt(
		modelId: string,
		slotKey: SlotKey,
		promptKey: string,
	): Promise<ExecutionTrace[]> {
		const all = await this.loadTraces(modelId, slotKey);
		return all.filter((t) => t.promptKey === promptKey);
	}
}
