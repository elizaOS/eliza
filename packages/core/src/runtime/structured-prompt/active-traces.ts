/** Owns in-flight prompt optimization traces and their run-indexed enrichment lifecycle.
 * Each runtime has its own store; persistence remains with registered optimization hooks. */
import { ScoreCard } from "../../types/prompt-optimization-score-card";
import type {
	ExecutionTrace,
	ScoreSignal,
} from "../../types/prompt-optimization-trace";
export class ActivePromptTraces {
	private activeTraces = new Map<string, ExecutionTrace>();
	private runToTraces = new Map<string, Set<string>>();
	enrichTrace(runId: string, signal: ScoreSignal): void {
		const traceIds = this.runToTraces.get(runId);
		if (!traceIds) return;

		const targetTraceId = (signal as { traceId?: string }).traceId;

		for (const tid of traceIds) {
			if (targetTraceId && tid !== targetTraceId) continue;

			const trace = this.activeTraces.get(tid);
			if (!trace) continue;
			trace.scoreCard.signals.push(signal);
			const card = ScoreCard.fromJSON(trace.scoreCard);
			trace.scoreCard.compositeScore = card.composite();
			trace.enrichedAt = Date.now();
		}
	}
	getActiveTrace(runId: string): ExecutionTrace | undefined {
		const traceIds = this.runToTraces.get(runId);
		if (!traceIds) return undefined;
		let latest: ExecutionTrace | undefined;
		for (const tid of traceIds) {
			const t = this.activeTraces.get(tid);
			if (t) latest = t;
		}
		return latest;
	}
	getActiveTracesForRun(runId: string): ExecutionTrace[] {
		const traceIds = this.runToTraces.get(runId);
		if (!traceIds) return [];
		const traces: ExecutionTrace[] = [];
		for (const tid of traceIds) {
			const t = this.activeTraces.get(tid);
			if (t) traces.push(t);
		}
		return traces;
	}
	deleteActiveTrace(runId: string): void {
		const traceIds = this.runToTraces.get(runId);
		if (traceIds) {
			for (const tid of traceIds) {
				this.activeTraces.delete(tid);
			}
			this.runToTraces.delete(runId);
		}
	}
	deleteActiveTraceById(traceId: string): void {
		this.activeTraces.delete(traceId);
		for (const [rid, tids] of this.runToTraces) {
			if (tids.delete(traceId) && tids.size === 0) {
				this.runToTraces.delete(rid);
			}
		}
	}
	private static readonly ACTIVE_TRACE_TTL_MS = 5 * 60 * 1000;
	private activeTraceTtlPurgeCounter = 0;
	purgeStaleActiveTraces(): void {
		const now = Date.now();
		const ttl = ActivePromptTraces.ACTIVE_TRACE_TTL_MS;
		for (const [id, t] of this.activeTraces) {
			if (now - t.createdAt <= ttl) continue;
			this.activeTraces.delete(id);
			for (const [rid, tids] of this.runToTraces) {
				tids.delete(id);
				if (tids.size === 0) this.runToTraces.delete(rid);
			}
		}
	}
	private maybeRunActiveTraceTTLPurge(): void {
		if (++this.activeTraceTtlPurgeCounter % 100 !== 0) return;
		this.purgeStaleActiveTraces();
	}
	record(trace: ExecutionTrace): void {
		this.maybeRunActiveTraceTTLPurge();
		const runId = trace.runId;
		if (runId) {
			this.activeTraces.set(trace.id, trace);
			if (!this.runToTraces.has(runId)) {
				this.runToTraces.set(runId, new Set());
			}
			this.runToTraces.get(runId)?.add(trace.id);
		}
	}
}
