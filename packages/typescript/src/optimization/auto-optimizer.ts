/**
 * Background prompt optimization: run OptimizationRunner when SlotProfileManager
 * marks needsReoptimization (enough traces, cooldowns, etc.).
 *
 * WHY not inline in DPE: optimization is slow (optional Ax/LLM stages) and must
 * not block message handling. RUN_ENDED (plugin-neuro) already batches trace work;
 * we chain after recordTrace so profile stats are up to date.
 *
 * Logs: **info** when a run starts and completes (scores + traces used);
 * **debug** per pipeline stage via `onProgress`; **warn** for missing registry
 * or runner failure. `OPTIMIZATION_DIR` remains the durable source of truth
 * (`artifact.json`, `history.jsonl`, `profile_*.json`).
 */

import { logger } from "../logger.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import { getSlotProfileManager } from "./index.ts";
import { readPromptRegistryEntry } from "./prompt-registry.ts";
import { OptimizationRunner } from "./runner.ts";
import type { ExecutionTrace } from "./types.ts";
import { DEFAULT_SIGNAL_WEIGHTS } from "./types.ts";

const runLocks = new Map<string, Promise<void>>();
const failureCooldownUntil = new Map<string, number>();

/** Skip re-attempts for this long after a failed auto run (ms). */
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

function lockKey(
	modelId: string,
	slotKey: string,
	promptKey: string,
	schemaFingerprint: string,
): string {
	return `${modelId}\0${slotKey}\0${promptKey}\0${schemaFingerprint}`;
}

/** One auto-opt schedule per RUN_ENDED batch for this trace identity. */
export function autoOptimizationDedupeKey(trace: ExecutionTrace): string {
	return lockKey(
		trace.modelId,
		trace.modelSlot,
		trace.promptKey,
		trace.schemaFingerprint,
	);
}

function parseSignalWeights(
	raw: string | boolean | number | null,
): Record<string, number> | undefined {
	if (raw == null || typeof raw !== "string" || !raw.trim()) return undefined;
	try {
		return JSON.parse(raw) as Record<string, number>;
	} catch {
		return undefined;
	}
}

/**
 * Fire-and-forget from finalizer: may run OptimizationRunner and write artifact.json.
 */
export async function maybeRunAutoPromptOptimization(
	runtime: IAgentRuntime,
	optDir: string,
	trace: ExecutionTrace,
): Promise<void> {
	if (!runtime.isPromptOptimizationEnabled()) {
		return;
	}

	const { modelId, modelSlot, promptKey, schemaFingerprint } = trace;
	const key = lockKey(modelId, modelSlot, promptKey, schemaFingerprint);

	const prev = runLocks.get(key) ?? Promise.resolve();
	const next = prev.then(() => doAutoRun(runtime, optDir, trace));
	runLocks.set(key, next);
	await next;
	// Clean up resolved lock to prevent unbounded memory growth
	if (runLocks.get(key) === next) {
		runLocks.delete(key);
	}
}

async function doAutoRun(
	runtime: IAgentRuntime,
	optDir: string,
	trace: ExecutionTrace,
): Promise<void> {
	const { modelId, modelSlot, promptKey, schemaFingerprint } = trace;
	const key = lockKey(modelId, modelSlot, promptKey, schemaFingerprint);

	const until = failureCooldownUntil.get(key);
	if (until !== undefined && Date.now() < until) {
		return;
	}

	const profileManager = getSlotProfileManager(optDir);
	const profile = await profileManager.get(modelId, modelSlot, promptKey);
	const ready =
		profile.optimization.needsReoptimization ||
		profileManager.shouldReoptimize(profile);
	if (!ready) {
		return;
	}

	const registry = await readPromptRegistryEntry(
		optDir,
		promptKey,
		schemaFingerprint,
	);
	if (!registry) {
		failureCooldownUntil.set(key, Date.now() + FAILURE_COOLDOWN_MS);
		logger.warn(
			{
				src: "optimization:auto",
				modelId,
				slotKey: modelSlot,
				promptKey,
				schemaFingerprint,
			},
			"Auto optimization skipped: no prompt registry entry (DPE has not recorded this prompt yet)",
		);
		return;
	}

	const weightsRaw = runtime.getSetting?.("PROMPT_OPT_SIGNAL_WEIGHTS") ?? null;
	const signalWeights = {
		...DEFAULT_SIGNAL_WEIGHTS,
		...parseSignalWeights(weightsRaw),
	};

	logger.info(
		{
			src: "optimization:auto",
			modelId,
			slotKey: modelSlot,
			promptKey,
			totalTraces: profile.stats.totalTraces,
		},
		"Starting automatic prompt optimization run",
	);

	const runner = new OptimizationRunner();
	const result = await runner.run({
		rootDir: optDir,
		modelId,
		slotKey: modelSlot,
		promptKey,
		promptTemplate: registry.promptTemplate,
		schema: registry.schema,
		signalWeights,
		onProgress: (stage, progress, message) => {
			logger.debug(
				{ src: "optimization:auto", stage, progress, message },
				"optimization progress",
			);
		},
	});

	if (!result.success) {
		failureCooldownUntil.set(key, Date.now() + FAILURE_COOLDOWN_MS);
		logger.warn(
			{
				src: "optimization:auto",
				modelId,
				slotKey: modelSlot,
				promptKey,
				error: result.error,
			},
			"Automatic prompt optimization failed",
		);
		return;
	}

	failureCooldownUntil.delete(key);
	logger.info(
		{
			src: "optimization:auto",
			modelId,
			slotKey: modelSlot,
			promptKey,
			baselineScore: result.baselineScore,
			finalScore: result.finalScore,
			tracesUsed: result.tracesUsed,
		},
		"Automatic prompt optimization complete",
	);
}
