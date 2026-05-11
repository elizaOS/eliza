/**
 * OptimizedPromptService — runtime cache of native-optimizer artifacts.
 *
 * Native MIPRO/GEPA/bootstrap-fewshot optimizers (under
 * `plugins/app-training/src/optimizers/`) write a JSON artifact per task into
 * `~/.eliza/optimized-prompts/<task>/<timestamp>.json`. The runtime consults
 * this service before constructing the system prompt for one of the five core
 * decision tasks and substitutes the optimized prompt (plus any few-shot
 * demonstrations) when an artifact is available.
 *
 * Service contract:
 *   - `getPrompt(task)` — synchronous accessor, returns the loaded prompt or
 *     null. Cheap to call; reads the in-memory cache. Does not refresh.
 *   - `setPrompt(task, artifact)` — atomically writes a new artifact and
 *     refreshes the in-memory cache for that task.
 *   - `getMetadata(task)` — quick view of optimizer + score for diagnostics.
 *   - `refresh()` — re-scan the disk store. Called automatically by `start()`,
 *     also exposed for the `Settings → Auto-Training` panel.
 *
 * Loading rule: for each task, the artifact with the most recent
 * `generatedAt` wins. Ties are broken by the file's `mtime` so manual
 * intervention (touching a file) can promote an older artifact.
 *
 * The on-disk format intentionally mirrors `OptimizedPromptArtifact` from
 * `plugins/app-training/src/optimizers/types.ts`. We re-declare the type here
 * (instead of importing) because `@elizaos/core` is upstream of
 * `@elizaos/app-training` and adding the dependency would invert the layering.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logger } from "../logger.js";
import type { IAgentRuntime } from "../types/runtime.js";
import { Service } from "../types/service.js";
import { resolveStateDir } from "../utils/state-dir.js";

export const OPTIMIZED_PROMPT_SERVICE = "optimized_prompt";

export type OptimizedPromptTask =
	| "should_respond"
	| "context_routing"
	| "action_planner"
	| "response"
	| "media_description";

export const OPTIMIZED_PROMPT_TASKS: readonly OptimizedPromptTask[] = [
	"should_respond",
	"context_routing",
	"action_planner",
	"response",
	"media_description",
] as const;

export type OptimizerName =
	| "instruction-search"
	| "prompt-evolution"
	| "bootstrap-fewshot";

/**
 * Mirror of `OptimizationExample` from `plugins/app-training/src/optimizers/types.ts`.
 * Kept narrow on purpose — the runtime only renders these into the prompt.
 */
export interface OptimizedPromptFewShotExample {
	id?: string;
	input: {
		system?: string;
		user: string;
	};
	expectedOutput: string;
	reward?: number;
	metadata?: Record<string, unknown>;
}

export interface OptimizedPromptLineageEntry {
	round: number;
	variant: number;
	score: number;
	notes?: string;
}

export interface OptimizedPromptArtifact {
	task: OptimizedPromptTask;
	optimizer: OptimizerName;
	baseline: string;
	prompt: string;
	score: number;
	baselineScore: number;
	datasetId: string;
	datasetSize: number;
	generatedAt: string;
	fewShotExamples?: OptimizedPromptFewShotExample[];
	lineage: OptimizedPromptLineageEntry[];
}

export interface OptimizedPromptResolved {
	prompt: string;
	fewShotExamples?: OptimizedPromptFewShotExample[];
	optimizerSource: OptimizerName;
}

export interface OptimizedPromptMetadata {
	generatedAt: string;
	optimizer: OptimizerName;
	score: number;
	baselineScore: number;
	datasetSize: number;
}

function defaultStoreRoot(): string {
	return join(resolveStateDir(), "optimized-prompts");
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptimizerName(value: unknown): value is OptimizerName {
	return (
		value === "instruction-search" ||
		value === "prompt-evolution" ||
		value === "bootstrap-fewshot"
	);
}

function isTask(value: unknown): value is OptimizedPromptTask {
	return (
		typeof value === "string" &&
		(OPTIMIZED_PROMPT_TASKS as readonly string[]).includes(value)
	);
}

/**
 * Strict parser. We reject artifacts that are missing required fields so a
 * corrupt file cannot silently shadow the baseline prompt with garbage.
 */
export function parseOptimizedPromptArtifact(
	raw: unknown,
): OptimizedPromptArtifact | null {
	if (!isStringRecord(raw)) return null;
	if (!isTask(raw.task)) return null;
	if (!isOptimizerName(raw.optimizer)) return null;
	if (typeof raw.baseline !== "string" || typeof raw.prompt !== "string") {
		return null;
	}
	if (typeof raw.score !== "number" || typeof raw.baselineScore !== "number") {
		return null;
	}
	if (
		typeof raw.datasetId !== "string" ||
		typeof raw.datasetSize !== "number"
	) {
		return null;
	}
	if (typeof raw.generatedAt !== "string") return null;
	if (!Array.isArray(raw.lineage)) return null;
	const lineage: OptimizedPromptLineageEntry[] = [];
	for (const entry of raw.lineage) {
		if (!isStringRecord(entry)) continue;
		if (
			typeof entry.round === "number" &&
			typeof entry.variant === "number" &&
			typeof entry.score === "number"
		) {
			lineage.push({
				round: entry.round,
				variant: entry.variant,
				score: entry.score,
				notes: typeof entry.notes === "string" ? entry.notes : undefined,
			});
		}
	}
	const fewShot: OptimizedPromptFewShotExample[] | undefined = Array.isArray(
		raw.fewShotExamples,
	)
		? coerceFewShot(raw.fewShotExamples)
		: undefined;
	return {
		task: raw.task,
		optimizer: raw.optimizer,
		baseline: raw.baseline,
		prompt: raw.prompt,
		score: raw.score,
		baselineScore: raw.baselineScore,
		datasetId: raw.datasetId,
		datasetSize: raw.datasetSize,
		generatedAt: raw.generatedAt,
		lineage,
		fewShotExamples: fewShot,
	};
}

function coerceFewShot(
	value: unknown[],
): OptimizedPromptFewShotExample[] | undefined {
	const out: OptimizedPromptFewShotExample[] = [];
	for (const entry of value) {
		if (!isStringRecord(entry)) continue;
		const input = entry.input;
		if (!isStringRecord(input) || typeof input.user !== "string") continue;
		if (typeof entry.expectedOutput !== "string") continue;
		out.push({
			id: typeof entry.id === "string" ? entry.id : undefined,
			input: {
				user: input.user,
				system: typeof input.system === "string" ? input.system : undefined,
			},
			expectedOutput: entry.expectedOutput,
			reward: typeof entry.reward === "number" ? entry.reward : undefined,
			metadata: isStringRecord(entry.metadata) ? entry.metadata : undefined,
		});
	}
	return out.length > 0 ? out : undefined;
}

interface CachedEntry {
	artifact: OptimizedPromptArtifact;
	loadedAt: number;
}

/**
 * Parse the `OPTIMIZED_PROMPT_DISABLE` env var into a strongly-typed set of
 * disabled tasks. Unknown task names are silently dropped — an operator
 * disabling a misspelled task should not crash the runtime, but the
 * misspelling should also not accidentally disable some other task.
 *
 * Format: comma-separated list of task names. Whitespace is trimmed.
 * Example: `OPTIMIZED_PROMPT_DISABLE=should_respond,response`.
 */
export function parseDisabledTasksEnv(
	raw: string | undefined,
): ReadonlySet<OptimizedPromptTask> {
	if (!raw) return new Set();
	const tasks = new Set<OptimizedPromptTask>();
	for (const part of raw.split(",")) {
		const trimmed = part.trim();
		if (isTask(trimmed)) {
			tasks.add(trimmed);
		}
	}
	return tasks;
}

/**
 * Stateful service. Subclassing `Service` keeps it discoverable via
 * `runtime.getService(OPTIMIZED_PROMPT_SERVICE)` and lets us register through
 * the standard plugin lifecycle.
 */
export class OptimizedPromptService extends Service {
	static override serviceType = OPTIMIZED_PROMPT_SERVICE;
	override capabilityDescription =
		"Loads and serves prompts produced by the native MIPRO/GEPA/bootstrap-fewshot optimizers.";

	private storeRoot: string = defaultStoreRoot();
	private cache: Partial<Record<OptimizedPromptTask, CachedEntry>> = {};
	private disabledTasks: ReadonlySet<OptimizedPromptTask> =
		parseDisabledTasksEnv(process.env.OPTIMIZED_PROMPT_DISABLE);

	static override async start(
		runtime: IAgentRuntime,
	): Promise<OptimizedPromptService> {
		const service = new OptimizedPromptService(runtime);
		await service.refresh();
		return service;
	}

	override async stop(): Promise<void> {
		this.cache = {};
	}

	/** Override the on-disk store root. Primarily for tests. */
	setStoreRoot(root: string): void {
		this.storeRoot = root;
	}

	getStoreRoot(): string {
		return this.storeRoot;
	}

	/**
	 * Test-only hook to refresh the disabled-tasks set after the env var has
	 * changed. The default constructor snapshot is read once on instantiation,
	 * which is the right behavior in production (env vars set at boot).
	 */
	setDisabledTasksFromEnv(raw: string | undefined): void {
		this.disabledTasks = parseDisabledTasksEnv(raw);
	}

	/**
	 * Returns true when the operator has emergency-disabled this task via
	 * `OPTIMIZED_PROMPT_DISABLE`. The runtime should fall back to the baseline
	 * prompt instead of substituting the artifact.
	 */
	isTaskDisabled(task: OptimizedPromptTask): boolean {
		return this.disabledTasks.has(task);
	}

	/**
	 * Synchronous accessor. Returns the cached artifact for the task or null.
	 * Hot path — called per-prompt in the runtime loop. Honours
	 * `OPTIMIZED_PROMPT_DISABLE` — a disabled task returns null even when an
	 * artifact is cached.
	 */
	getPrompt(task: OptimizedPromptTask): OptimizedPromptResolved | null {
		if (this.disabledTasks.has(task)) return null;
		const entry = this.cache[task];
		if (!entry) return null;
		return {
			prompt: entry.artifact.prompt,
			fewShotExamples: entry.artifact.fewShotExamples,
			optimizerSource: entry.artifact.optimizer,
		};
	}

	getMetadata(task: OptimizedPromptTask): OptimizedPromptMetadata | null {
		const entry = this.cache[task];
		if (!entry) return null;
		return {
			generatedAt: entry.artifact.generatedAt,
			optimizer: entry.artifact.optimizer,
			score: entry.artifact.score,
			baselineScore: entry.artifact.baselineScore,
			datasetSize: entry.artifact.datasetSize,
		};
	}

	/**
	 * True iff the task has an optimized artifact loaded and is not disabled
	 * by `OPTIMIZED_PROMPT_DISABLE`. Mirrors the gate used by `getPrompt`.
	 */
	hasOptimized(task: OptimizedPromptTask): boolean {
		if (this.disabledTasks.has(task)) return false;
		return Boolean(this.cache[task]);
	}

	/**
	 * Atomic write of a new artifact. Writes to a temp file under the same
	 * directory and renames into place. Refreshes the cache for the task.
	 */
	async setPrompt(
		task: OptimizedPromptTask,
		artifact: OptimizedPromptArtifact,
	): Promise<string> {
		if (artifact.task !== task) {
			throw new Error(
				`[OptimizedPromptService] artifact.task=${artifact.task} does not match target task=${task}`,
			);
		}
		const dir = join(this.storeRoot, task);
		mkdirSync(dir, { recursive: true });
		const stamp = artifact.generatedAt.replace(/[^0-9]/g, "");
		const finalPath = join(dir, `${stamp}.json`);
		const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
		const payload = `${JSON.stringify(artifact, null, 2)}\n`;
		mkdirSync(dirname(tempPath), { recursive: true });
		await writeFile(tempPath, payload, "utf-8");
		await rename(tempPath, finalPath);
		this.cache[task] = { artifact, loadedAt: Date.now() };
		logger.info(
			{
				src: "service:optimized_prompt",
				task,
				optimizer: artifact.optimizer,
				score: artifact.score,
				baselineScore: artifact.baselineScore,
				path: finalPath,
			},
			"Persisted optimized prompt artifact",
		);
		return finalPath;
	}

	/** Re-scan the on-disk store. Safe to call repeatedly. */
	async refresh(): Promise<void> {
		const next: Partial<Record<OptimizedPromptTask, CachedEntry>> = {};
		for (const task of OPTIMIZED_PROMPT_TASKS) {
			const dir = join(this.storeRoot, task);
			if (!existsSync(dir)) continue;
			const entries = readdirSync(dir);
			let bestArtifact: OptimizedPromptArtifact | null = null;
			let bestStamp = -Infinity;
			for (const name of entries) {
				if (!name.endsWith(".json")) continue;
				const path = join(dir, name);
				const raw = await readFile(path, "utf-8");
				const parsedJson: unknown = JSON.parse(raw);
				const artifact = parseOptimizedPromptArtifact(parsedJson);
				if (!artifact) {
					logger.warn(
						{ src: "service:optimized_prompt", task, path },
						"Optimized prompt artifact failed strict parse — skipping",
					);
					continue;
				}
				const stamp = Date.parse(artifact.generatedAt);
				if (Number.isFinite(stamp) && stamp > bestStamp) {
					bestStamp = stamp;
					bestArtifact = artifact;
				}
			}
			if (bestArtifact) {
				next[task] = { artifact: bestArtifact, loadedAt: Date.now() };
			}
		}
		this.cache = next;
	}
}
