/**
 * OptimizedPromptService — runtime cache of native-optimizer artifacts.
 *
 * Native MIPRO/GEPA/bootstrap-fewshot optimizers (under
 * `plugins/app-training/src/optimizers/`) write a JSON artifact per task into
 * `~/.eliza/optimized-prompts/<task>/`. The runtime consults this service
 * before constructing the system prompt for one of the five core decision
 * tasks and substitutes the optimized prompt (plus any few-shot
 * demonstrations) when an artifact is available.
 *
 * On-disk layout (per task):
 *   ~/.eliza/optimized-prompts/<task>/
 *     v1.json, v2.json, ..., vN.json   — concrete artifact files (last 5 retained)
 *     current   -> vN.json              — symlink; the live prompt
 *     previous  -> vN-1.json            — symlink; the immediate predecessor
 *     previous2 -> vN-2.json            — symlink; one further back
 *
 * Service contract:
 *   - `getPrompt(task)` — synchronous accessor, returns the loaded prompt or
 *     null. Cheap to call; reads the in-memory cache. Does not refresh.
 *   - `setPrompt(task, artifact)` — atomically writes a new artifact as the
 *     next `vN.json`, repoints the `current` / `previous` / `previous2`
 *     symlinks, prunes to the last 5 versions, and refreshes the cache.
 *   - `rollback(task)` — flip `current` and `previous` symlinks, then
 *     refresh the cache. Used by `eliza training rollback-prompt <task>`.
 *   - `getMetadata(task)` — quick view of optimizer + score for diagnostics.
 *   - `refresh()` — re-scan the disk store. Called automatically by `start()`,
 *     also exposed for the `Settings → Auto-Training` panel.
 *
 * Loading rule: for each task, the `current` symlink wins. When `current`
 * is missing (e.g. a corrupted store) we fall back to scanning the directory
 * and selecting the most recent `generatedAt`.
 *
 * The on-disk format intentionally mirrors `OptimizedPromptArtifact` from
 * `plugins/app-training/src/optimizers/types.ts`. We re-declare the type here
 * (instead of importing) because `@elizaos/core` is upstream of
 * `@elizaos/app-training` and adding the dependency would invert the layering.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import {
	readFile,
	readlink,
	rename,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { logger } from "../logger.js";
import type { IAgentRuntime } from "../types/runtime.js";
import { Service } from "../types/service.js";
import { resolveStateDir } from "../utils/state-dir.js";

export const OPTIMIZED_PROMPT_CURRENT_LINK = "current";
export const OPTIMIZED_PROMPT_PREVIOUS_LINK = "previous";
export const OPTIMIZED_PROMPT_PREVIOUS2_LINK = "previous2";
export const OPTIMIZED_PROMPT_RETAIN_VERSIONS = 5;

const VERSION_FILE_PATTERN = /^v(\d+)\.json$/;

export const OPTIMIZED_PROMPT_SERVICE = "optimized_prompt";

export type OptimizedPromptTask =
	| "should_respond"
	| "context_routing"
	| "action_planner"
	| "response"
	| "media_description"
	| "action_descriptions";

export const OPTIMIZED_PROMPT_TASKS: readonly OptimizedPromptTask[] = [
	"should_respond",
	"context_routing",
	"action_planner",
	"response",
	"media_description",
	"action_descriptions",
] as const;

export type OptimizerName =
	| "instruction-search"
	| "prompt-evolution"
	| "bootstrap-fewshot"
	| "dspy-bootstrap-fewshot"
	| "dspy-copro"
	| "dspy-mipro";

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
		value === "bootstrap-fewshot" ||
		value === "dspy-bootstrap-fewshot" ||
		value === "dspy-copro" ||
		value === "dspy-mipro"
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
	 * Atomic write of a new artifact. Writes the new version as `v(N+1).json`,
	 * repoints `current` / `previous` / `previous2` symlinks, prunes the
	 * directory to the last `OPTIMIZED_PROMPT_RETAIN_VERSIONS` artifacts, and
	 * refreshes the cache for the task.
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

		const existingVersions = listVersionNumbers(dir);
		const nextVersion = (existingVersions.at(-1) ?? 0) + 1;
		const finalName = `v${nextVersion}.json`;
		const finalPath = join(dir, finalName);
		const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
		const payload = `${JSON.stringify(artifact, null, 2)}\n`;
		await writeFile(tempPath, payload, "utf-8");
		await rename(tempPath, finalPath);

		// Repoint symlinks: current → vN, previous → vN-1, previous2 → vN-2.
		const allVersions = [...existingVersions, nextVersion];
		await repointVersionLinks(dir, allVersions);

		// Prune older artifacts beyond the retention window. Done after the
		// symlinks are repointed so we never delete a file the symlinks
		// still reference.
		await pruneOldVersions(dir, allVersions);

		this.cache[task] = { artifact, loadedAt: Date.now() };
		logger.info(
			{
				src: "service:optimized_prompt",
				task,
				optimizer: artifact.optimizer,
				score: artifact.score,
				baselineScore: artifact.baselineScore,
				path: finalPath,
				version: nextVersion,
			},
			"Persisted optimized prompt artifact",
		);
		return finalPath;
	}

	/**
	 * Flip the `current` and `previous` symlinks. After this call,
	 * `getPrompt(task)` returns the artifact that was previously second-most
	 * recent, and the artifact that was current becomes the new previous.
	 * `previous2` is left untouched (next-back history pointer).
	 *
	 * Returns the absolute path of the artifact that is now `current`.
	 * Throws when `previous` is not present (nothing to roll back to).
	 */
	async rollback(task: OptimizedPromptTask): Promise<string> {
		const dir = join(this.storeRoot, task);
		if (!existsSync(dir)) {
			throw new Error(
				`[OptimizedPromptService] no artifact directory for task=${task}`,
			);
		}
		const currentTarget = await readLinkOrNull(
			join(dir, OPTIMIZED_PROMPT_CURRENT_LINK),
		);
		const previousTarget = await readLinkOrNull(
			join(dir, OPTIMIZED_PROMPT_PREVIOUS_LINK),
		);
		if (!previousTarget) {
			throw new Error(
				`[OptimizedPromptService] no previous version to roll back to for task=${task}`,
			);
		}
		if (!currentTarget) {
			throw new Error(
				`[OptimizedPromptService] no current version to flip away from for task=${task}`,
			);
		}

		// Swap targets atomically. `replaceSymlink` writes a temp link and
		// renames it over the old one so no window exists where `current`
		// is missing.
		await replaceSymlink(
			join(dir, OPTIMIZED_PROMPT_CURRENT_LINK),
			previousTarget,
		);
		await replaceSymlink(
			join(dir, OPTIMIZED_PROMPT_PREVIOUS_LINK),
			currentTarget,
		);

		await this.refresh();
		const newCurrentPath = join(dir, previousTarget);
		logger.info(
			{
				src: "service:optimized_prompt",
				task,
				newCurrent: previousTarget,
				newPrevious: currentTarget,
			},
			"Rolled back optimized prompt artifact",
		);
		return newCurrentPath;
	}

	/** Re-scan the on-disk store. Safe to call repeatedly. */
	async refresh(): Promise<void> {
		const next: Partial<Record<OptimizedPromptTask, CachedEntry>> = {};
		for (const task of OPTIMIZED_PROMPT_TASKS) {
			const dir = join(this.storeRoot, task);
			if (!existsSync(dir)) continue;

			// Preferred path: read via the `current` symlink. This is the
			// declared live version after a `setPrompt` or `rollback` call.
			const currentLink = join(dir, OPTIMIZED_PROMPT_CURRENT_LINK);
			const fromCurrent = await loadArtifactFromPath(currentLink, task);
			if (fromCurrent) {
				next[task] = { artifact: fromCurrent, loadedAt: Date.now() };
				continue;
			}

			// Fallback: directory may pre-date the symlink layout (legacy
			// timestamp-named files), or `current` may have been deleted.
			// Walk the directory and pick the artifact with the most recent
			// `generatedAt`.
			const entries = readdirSync(dir);
			let bestArtifact: OptimizedPromptArtifact | null = null;
			let bestStamp = -Infinity;
			for (const name of entries) {
				if (!name.endsWith(".json")) continue;
				const path = join(dir, name);
				const artifact = await loadArtifactFromPath(path, task);
				if (!artifact) continue;
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

/**
 * Return the sorted ascending list of version numbers (`v1`, `v2`, ...)
 * present in `dir`. Files that don't match the `vN.json` pattern are ignored.
 */
function listVersionNumbers(dir: string): number[] {
	if (!existsSync(dir)) return [];
	const versions: number[] = [];
	for (const name of readdirSync(dir)) {
		const match = VERSION_FILE_PATTERN.exec(name);
		if (!match) continue;
		const n = Number.parseInt(match[1] ?? "", 10);
		if (Number.isFinite(n)) versions.push(n);
	}
	versions.sort((a, b) => a - b);
	return versions;
}

/**
 * Repoint `current`, `previous`, and `previous2` symlinks based on the
 * sorted-ascending list of version numbers. `current` always points at the
 * largest. `previous` and `previous2` are unset when the corresponding
 * history slot doesn't exist (e.g. the very first write has no previous).
 */
async function repointVersionLinks(
	dir: string,
	versions: number[],
): Promise<void> {
	const sorted = [...versions].sort((a, b) => a - b);
	const current = sorted.at(-1);
	const previous = sorted.at(-2);
	const previous2 = sorted.at(-3);
	if (current !== undefined) {
		await replaceSymlink(
			join(dir, OPTIMIZED_PROMPT_CURRENT_LINK),
			`v${current}.json`,
		);
	}
	const previousLink = join(dir, OPTIMIZED_PROMPT_PREVIOUS_LINK);
	if (previous !== undefined) {
		await replaceSymlink(previousLink, `v${previous}.json`);
	} else {
		await removeIfExists(previousLink);
	}
	const previous2Link = join(dir, OPTIMIZED_PROMPT_PREVIOUS2_LINK);
	if (previous2 !== undefined) {
		await replaceSymlink(previous2Link, `v${previous2}.json`);
	} else {
		await removeIfExists(previous2Link);
	}
}

/**
 * Delete `v*.json` files beyond the most recent `OPTIMIZED_PROMPT_RETAIN_VERSIONS`.
 * The newest 5 versions plus the live symlinks survive.
 */
async function pruneOldVersions(
	dir: string,
	versions: number[],
): Promise<void> {
	const sorted = [...versions].sort((a, b) => a - b);
	if (sorted.length <= OPTIMIZED_PROMPT_RETAIN_VERSIONS) return;
	const obsolete = sorted.slice(
		0,
		sorted.length - OPTIMIZED_PROMPT_RETAIN_VERSIONS,
	);
	for (const version of obsolete) {
		const path = join(dir, `v${version}.json`);
		await rm(path, { force: true });
	}
}

/**
 * Atomically replace `linkPath` with a symlink whose target is `target`.
 * Writes a temp link beside it and renames into place so the link is never
 * absent during the swap.
 */
async function replaceSymlink(linkPath: string, target: string): Promise<void> {
	const tempPath = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
	mkdirSync(dirname(tempPath), { recursive: true });
	try {
		await unlink(tempPath);
	} catch {
		// nothing to clean up
	}
	await symlink(target, tempPath);
	await rename(tempPath, linkPath);
}

async function removeIfExists(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
}

async function readLinkOrNull(path: string): Promise<string | null> {
	try {
		return await readlink(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

/**
 * Read + strict-parse a single artifact file. Returns null when the file is
 * missing or fails the parser. Logs a warning on parse failure so a corrupt
 * file is visible in logs.
 */
async function loadArtifactFromPath(
	path: string,
	task: OptimizedPromptTask,
): Promise<OptimizedPromptArtifact | null> {
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch {
		logger.warn(
			{ src: "service:optimized_prompt", task, path },
			"Optimized prompt artifact is not valid JSON — skipping",
		);
		return null;
	}
	const artifact = parseOptimizedPromptArtifact(parsedJson);
	if (!artifact) {
		logger.warn(
			{ src: "service:optimized_prompt", task, path },
			"Optimized prompt artifact failed strict parse — skipping",
		);
		return null;
	}
	if (artifact.task !== task) {
		logger.warn(
			{
				src: "service:optimized_prompt",
				task,
				path,
				artifactTask: artifact.task,
			},
			"Optimized prompt artifact task mismatch — skipping",
		);
		return null;
	}
	return artifact;
}
