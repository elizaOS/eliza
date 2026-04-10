/**
 * RUN_ENDED handler for plugin-neuro.
 *
 * WHY finalize on RUN_ENDED: signals accumulate throughout the request lifecycle
 * (DPE adds structural signals, evaluator adds quality signals, reactions may
 * arrive). RUN_ENDED is the last guaranteed hook before the run is forgotten.
 * The finalizer writes the enriched trace with a higher seq than the DPE's
 * baseline, so dedup in loadTraces always keeps the enriched version.
 *
 * WHY per-trace error handling: in a multi-DPE run (e.g. should-respond +
 * reply), one trace failing to persist shouldn't prevent the other from being
 * saved. Failed traces remain in activeTraces for TTL cleanup rather than
 * being silently dropped.
 */

import {
	autoOptimizationDedupeKey,
	maybeRunAutoPromptOptimization,
} from "../../optimization/auto-optimizer.ts";
import {
	getABAnalyzer,
	getOptimizationRootDir,
	getSlotProfileManager,
	getTraceWriter,
	ScoreCard,
} from "../../optimization/index.ts";
import type { RunEventPayload } from "../../types/events.ts";
import { EventType } from "../../types/events.ts";
import type { IAgentRuntime } from "../../types/runtime.ts";

export async function handleRunEnded(
	payload: RunEventPayload,
	runtime: IAgentRuntime,
): Promise<void> {
	const { runId } = payload;
	if (!runId) {
		runtime.logger.debug(
			{ src: "plugin-neuro", reason: "missing_runId" },
			"RUN_ENDED finalizer: skip",
		);
		return;
	}

	// A single run can produce multiple DPE traces (e.g. should-respond + reply).
	const traces = runtime.getActiveTracesForRun?.(runId) ?? [];
	if (traces.length === 0) {
		// Backwards compat: fall back to single-trace getter
		const single = runtime.getActiveTrace(runId);
		if (single) traces.push(single);
	}
	if (traces.length === 0) {
		runtime.logger.debug(
			{ src: "plugin-neuro", runId, reason: "no_active_traces" },
			"RUN_ENDED finalizer: skip",
		);
		return;
	}

	const optDir = getOptimizationRootDir(
		runtime.getSetting?.("OPTIMIZATION_DIR") as string | null,
	);
	runtime.logger.debug(
		{
			src: "plugin-neuro",
			runId,
			traceCount: traces.length,
			optDir,
		},
		"RUN_ENDED finalizer: persisting enriched traces",
	);
	const tw = getTraceWriter(optDir);
	const abAnalyzer = getABAnalyzer(optDir);
	const persistedTraces: typeof traces = [];
	const autoOptScheduled = new Set<string>();

	for (const trace of traces) {
		try {
			// Finalize: update enrichedAt and recompute composite score
			trace.enrichedAt = Date.now();
			const card = ScoreCard.fromJSON(trace.scoreCard);
			trace.scoreCard.compositeScore = card.composite();

			// DPE wrote a baseline trace with a lower seq. We write the enriched
			// version with a higher seq so dedup keeps the enriched copy.
			await tw.appendTrace(trace.modelId, trace.modelSlot, {
				...trace,
				type: "trace" as const,
				seq: tw.nextSeq(),
			});
			persistedTraces.push(trace);

			try {
				await getSlotProfileManager(optDir).recordTrace(
					trace.modelId,
					trace.modelSlot,
					trace.promptKey,
					trace,
				);
			} catch (err) {
				runtime.logger.debug(
					{ src: "plugin-neuro", error: err instanceof Error ? err.message : String(err) },
					"SlotProfile recordTrace failed (best-effort)"
				);
			}

			// Run A/B analysis if we have enough samples (fire-and-forget)
			abAnalyzer
				.maybeAnalyze(trace.modelId, trace.modelSlot, trace.promptKey)
				.catch((err) => {
					runtime.logger.warn(
						{
							src: "plugin-neuro",
							runId,
							modelId: trace.modelId,
							modelSlot: trace.modelSlot,
							promptKey: trace.promptKey,
							error: err instanceof Error ? err.message : String(err),
						},
						"A/B maybeAnalyze failed",
					);
				});

			const autoKey = autoOptimizationDedupeKey(trace);
			if (!autoOptScheduled.has(autoKey)) {
				autoOptScheduled.add(autoKey);
				void maybeRunAutoPromptOptimization(runtime, optDir, trace).catch(
					(err) => {
						runtime.logger.warn(
							{
								src: "plugin-neuro",
								runId,
								modelId: trace.modelId,
								modelSlot: trace.modelSlot,
								promptKey: trace.promptKey,
								error: err instanceof Error ? err.message : String(err),
							},
							"Auto prompt optimization failed",
						);
					},
				);
			}
		} catch {
			// This trace failed to persist — it remains in activeTraces
			// (with a baseline copy on disk from the DPE write).
			runtime.logger.warn(
				{
					src: "plugin-neuro",
					runId,
					reason: "trace_persist_failed",
				},
				"RUN_ENDED finalizer: trace append failed",
			);
		}
	}

	if (persistedTraces.length > 0) {
		if (persistedTraces.length === traces.length) {
			// All traces persisted — bulk cleanup
			runtime.deleteActiveTrace(runId);
		} else {
			// Partial success — only remove persisted traces so failed ones
			// remain in activeTraces for TTL cleanup or retry.
			for (const trace of persistedTraces) {
				runtime.deleteActiveTraceById?.(trace.id);
			}
		}

		for (const trace of persistedTraces) {
			runtime.emitEvent?.(EventType.OPTIMIZATION_TRACE, {
				runtime,
				runId,
				promptKey: trace.promptKey,
				modelSlot: trace.modelSlot,
				modelId: trace.modelId,
				variant: trace.variant,
				parseSuccess: trace.parseSuccess,
				compositeScore: trace.scoreCard.compositeScore,
			});
		}

		runtime.logger.debug(
			{
				src: "plugin-neuro",
				runId,
				persisted: persistedTraces.length,
			},
			"RUN_ENDED finalizer: done",
		);
	}
}
