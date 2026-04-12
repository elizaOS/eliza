/**
 * OptimizationRunner — end-to-end optimization entry point.
 *
 * WHY a separate runner class: it creates its own fresh TraceWriter,
 * PromptArtifactResolver, and SlotProfileManager instances (not the
 * process-wide singletons). This is intentional — optimization runs are
 * infrequent, expensive operations that should not share write locks or
 * LRU caches with the hot DPE path.
 *
 * WHY baseline-only training: training on optimized-variant traces would
 * create a feedback loop where the optimizer reinforces its own output.
 * By training only on baseline traces, each optimization round starts from
 * the unoptimized ground truth.
 *
 * Can be triggered from:
 * - CLI: `eliza optimize --model <id> --slot <slot> --prompt <name>`
 * - API route: POST /api/optimize
 * - SlotProfileManager auto-trigger (when shouldReoptimize() returns true)
 */

import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { logger } from "@elizaos/core";
import type { IAgentRuntime, SchemaRow } from "@elizaos/core";
import { AxACEAdapter } from "./adapters/ax-ace.ts";
import { AxBootstrapFewShotAdapter } from "./adapters/ax-bootstrap.ts";
import { AxGEPAAdapter } from "./adapters/ax-gepa.ts";
import { parseInstrumentationLevel } from "./adapters/instrumentation.ts";
import { readOptimizationAIConfig } from "./adapters/optimization-ai.ts";
import { DefaultOptimizerPipeline } from "./pipeline.ts";
import { PromptArtifactResolver, sanitizeModelId } from "./resolver.ts";
import { ScoreCard } from "./score-card.ts";
import { invalidateSlotProfileProcessCache } from "./singleton-sync.ts";
import { SlotProfileManager } from "./slot-profile.ts";
import { TraceWriter } from "./trace-writer.ts";
import type {
	ExecutionTrace,
	OptimizationRun,
	OptimizerStage,
	PromptKey,
	SlotKey,
} from "./types.ts";
import { DEFAULT_SIGNAL_WEIGHTS } from "./types.ts";

export interface OptimizationRunnerOptions {
	rootDir: string;
	modelId: string;
	slotKey: SlotKey;
	promptKey: PromptKey;
	promptTemplate: string;
	schema: SchemaRow[];
	/** Override signal weights for metric computation */
	signalWeights?: Record<string, number>;
	/** Skip stages by name */
	disabledStages?: string[];
	/** Per-stage config overrides */
	stageConfigs?: Record<string, Record<string, unknown>>;
	/** Progress callback */
	onProgress?: (stage: string, progress: number, message?: string) => void;
	/** Dry run: compute but don't write artifact */
	dryRun?: boolean;
	/** When set, enables OPTIMIZATION_AI_* and instrumentation settings for GEPA/ACE */
	runtime?: IAgentRuntime;
}

export interface OptimizationRunResult {
	success: boolean;
	artifact?: import("./types.ts").OptimizedPromptArtifact;
	run?: OptimizationRun;
	error?: string;
	tracesUsed: number;
	baselineScore: number;
	finalScore: number;
}

export class OptimizationRunner {
	async run(opts: OptimizationRunnerOptions): Promise<OptimizationRunResult> {
		const signalWeights = { ...DEFAULT_SIGNAL_WEIGHTS, ...opts.signalWeights };
		const resolver = new PromptArtifactResolver(opts.rootDir);
		const traceWriter = new TraceWriter(opts.rootDir);
		const slotProfileManager = new SlotProfileManager(
			opts.rootDir,
			signalWeights,
		);

		// Load traces for this prompt key
		const allTraces = await traceWriter.loadTracesForPrompt(
			opts.modelId,
			opts.slotKey,
			opts.promptKey,
		);

		if (allTraces.length === 0) {
			return {
				success: false,
				error:
					"No traces available for optimization. Run the agent to collect traces first.",
				tracesUsed: 0,
				baselineScore: 0,
				finalScore: 0,
			};
		}

		// Use baseline traces for training. If no pure baseline traces exist,
		// fall back to all traces *excluding* optimized variant to avoid
		// training on outputs that were already influenced by prior optimization.
		const baselineTraces: ExecutionTrace[] = allTraces.filter(
			(t) => t.variant === "baseline",
		);
		const trainingTraces =
			baselineTraces.length > 0
				? baselineTraces
				: allTraces.filter((t) => t.variant !== "optimized");

		if (trainingTraces.length === 0) {
			return {
				success: false,
				error:
					"No non-optimized traces available for training. Need baseline traces to optimize against.",
				tracesUsed: 0,
				baselineScore: 0,
				finalScore: 0,
			};
		}

		opts.onProgress?.(
			"setup",
			0,
			`Using ${trainingTraces.length} traces for optimization`,
		);

		// Phase 4: AI stages read settings from the same runtime as the agent.
		// WHY optional `runtime`: CLI/scripts may run the runner without an
		// IAgentRuntime; GEPA/ACE then receive no aiConfig and stay stubs.
		const aiConfig = opts.runtime
			? readOptimizationAIConfig(opts.runtime)
			: null;
		// WHY parse even when `runtime` is absent: stage config still carries
		// defaults; harmless for bootstrap, and keeps types consistent for tests.
		const instrumentationLevel = parseInstrumentationLevel(
			opts.runtime?.getSetting?.("OPTIMIZATION_INSTRUMENTATION_LEVEL"),
		);
		// WHY same path as TraceWriter: operators find traces, runs, and Ax logs
		// in one directory per (modelId, slotKey).
		const instrumentationDir = join(
			opts.rootDir,
			sanitizeModelId(opts.modelId),
			opts.slotKey,
		);

		// WHY merge only for GEPA/ACE below: AxBootstrapFewShot does not call LLMs;
		// injecting aiConfig there would suggest unused settings.
		const mergeAiStageConfig = (base: Record<string, unknown>) => ({
			...base,
			...(aiConfig ? { aiConfig } : {}),
			instrumentationDir,
			instrumentationLevel,
		});

		logger.debug(
			{
				src: "optimization:runner",
				modelId: opts.modelId,
				slotKey: opts.slotKey,
				promptKey: opts.promptKey,
				phase4AiSettingsPresent: !!aiConfig,
				studentProvider: aiConfig?.provider,
				studentModel: aiConfig?.model,
				instrumentationLevel,
				instrumentationDir,
			},
			"OptimizationRunner pipeline inputs",
		);

		// Build pipeline stages
		const stages: OptimizerStage[] = [
			{
				name: "AxBootstrapFewShot",
				adapter: new AxBootstrapFewShotAdapter(
					opts.stageConfigs?.AxBootstrapFewShot ?? {},
				),
				enabled: !opts.disabledStages?.includes("AxBootstrapFewShot"),
				config: opts.stageConfigs?.AxBootstrapFewShot ?? {},
			},
			{
				name: "AxGEPA",
				adapter: new AxGEPAAdapter(opts.stageConfigs?.AxGEPA ?? {}),
				enabled: !opts.disabledStages?.includes("AxGEPA"),
				config: mergeAiStageConfig(opts.stageConfigs?.AxGEPA ?? {}),
			},
			{
				name: "AxACE",
				adapter: new AxACEAdapter(opts.stageConfigs?.AxACE ?? {}),
				enabled: !opts.disabledStages?.includes("AxACE"),
				config: mergeAiStageConfig(opts.stageConfigs?.AxACE ?? {}),
			},
		];

		const pipeline = new DefaultOptimizerPipeline(stages);

		try {
			const startTime = Date.now();

			const artifact = await pipeline.compile({
				modelId: opts.modelId,
				modelSlot: opts.slotKey,
				promptKey: opts.promptKey,
				promptTemplate: opts.promptTemplate,
				schema: opts.schema,
				traces: trainingTraces,
				metricFn: (trace) => {
					return ScoreCard.fromJSON(trace.scoreCard).composite(signalWeights);
				},
				signalWeights,
				onProgress: opts.onProgress,
			});

			const run: OptimizationRun = {
				type: "optimization_run",
				id: uuidv4(),
				promptKey: opts.promptKey,
				modelSlot: opts.slotKey,
				modelId: opts.modelId,
				stages: artifact.pipeline.stages,
				totalDurationMs: Date.now() - startTime,
				baselineScore: artifact.pipeline.baselineScore,
				finalScore: artifact.pipeline.finalScore,
				createdAt: Date.now(),
			};

			if (!opts.dryRun) {
				// Write artifact to disk
				await resolver.writeArtifact(
					opts.modelId,
					opts.slotKey,
					opts.promptKey,
					artifact,
				);

				// Log the optimization run to history.jsonl
				await traceWriter.appendOptimizationRun(
					opts.modelId,
					opts.slotKey,
					run,
				);

				// Update slot profile
				await slotProfileManager.markOptimized(
					opts.modelId,
					opts.slotKey,
					opts.promptKey,
					artifact.version,
					artifact.pipeline.finalScore,
				);

				// Sync process singleton (see singleton-sync.ts) — runner uses a
				// local SlotProfileManager; auto-opt reads getSlotProfileManager().
				invalidateSlotProfileProcessCache(
					opts.rootDir,
					opts.modelId,
					opts.slotKey,
					opts.promptKey,
				);
			}

			opts.onProgress?.(
				"complete",
				1.0,
				`Optimization complete: ${artifact.pipeline.baselineScore.toFixed(3)} -> ${artifact.pipeline.finalScore.toFixed(3)}`,
			);

			return {
				success: true,
				artifact,
				run,
				tracesUsed: trainingTraces.length,
				baselineScore: artifact.pipeline.baselineScore,
				finalScore: artifact.pipeline.finalScore,
			};
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			return {
				success: false,
				error,
				tracesUsed: trainingTraces.length,
				baselineScore: 0,
				finalScore: 0,
			};
		}
	}

	/**
	 * Check which slots need re-optimization across all models.
	 * Returns a list of pending optimization tasks.
	 */
	async listPendingOptimizations(
		rootDir: string,
	): Promise<
		Array<{ modelId: string; slotKey: SlotKey; promptKey: PromptKey }>
	> {
		// Read directory structure to discover all model/slot/profile combinations
		const { readdir, readFile } = await import("node:fs/promises");
		const { join } = await import("node:path");

		const pending: Array<{
			modelId: string;
			slotKey: SlotKey;
			promptKey: PromptKey;
		}> = [];

		try {
			const modelDirs = await readdir(rootDir, { withFileTypes: true });
			for (const modelDir of modelDirs) {
				if (!modelDir.isDirectory()) continue;
				const modelPath = join(rootDir, modelDir.name);

				const slotDirs = await readdir(modelPath, { withFileTypes: true });
				for (const slotDir of slotDirs) {
					if (!slotDir.isDirectory()) continue;
					const slotPath = join(modelPath, slotDir.name);

					const files = await readdir(slotPath);
					for (const file of files) {
						if (!file.startsWith("profile_") || !file.endsWith(".json"))
							continue;

						try {
							const content = await readFile(join(slotPath, file), "utf-8");
							const profile = JSON.parse(content);
							if (profile.optimization?.needsReoptimization) {
								pending.push({
									modelId: modelDir.name,
									slotKey: slotDir.name,
									promptKey: profile.promptKey,
								});
							}
						} catch {
							// Skip malformed profiles
						}
					}
				}
			}
		} catch {
			// Root dir doesn't exist yet
		}

		return pending;
	}
}
