/**
 * OptimizedPromptService — runtime cache of native-optimizer artifacts.
 *
 * Native MIPRO/GEPA/bootstrap-fewshot optimizers (under
 * `plugins/plugin-training/src/optimizers/`) write a JSON artifact per task into
 * `<stateDir>/optimized-prompts/<task>/`. The runtime consults this service
 * before constructing the system prompt for one of the core decision
 * tasks and substitutes the optimized prompt (plus any few-shot
 * demonstrations) when an artifact is available.
 *
 * On-disk layout (per task):
 *   <stateDir>/optimized-prompts/<task>/
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
 * `plugins/plugin-training/src/optimizers/types.ts`. We re-declare the type here
 * (instead of importing) because `@elizaos/core` is upstream of
 * `@elizaos/plugin-training` and adding the dependency would invert the layering.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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
const VERSION_CLAIM_PATTERN = /^\.v(\d+)\.json\.claim$/;

export const OPTIMIZED_PROMPT_SERVICE = "optimized_prompt";

export type OptimizedPromptTask =
	| "should_respond"
	| "action_planner"
	| "response"
	| "media_description"
	| "action_descriptions"
	| "autonomy"
	| "view_context"
	// LifeOps (personal-assistant / health) per-capability optimization tasks.
	// Each names a concrete LifeOps LLM call site (extraction or chat-shaped)
	// whose inline prompt template is a GEPA optimization target. The call site
	// consults OptimizedPromptService.getPrompt(task) with its inline template as
	// the fallback baseline, so an absent artifact is a no-op (never a failure).
	| "calendar_extract"
	| "schedule_plan"
	| "reminder_dispatch"
	| "inbox_triage"
	| "meeting_prep"
	| "morning_brief"
	| "health_checkin"
	| "screentime_recap";

export const OPTIMIZED_PROMPT_TASKS: readonly OptimizedPromptTask[] = [
	"should_respond",
	"action_planner",
	"response",
	"media_description",
	"action_descriptions",
	"autonomy",
	// Contextual view-switching evaluator (plugin-app-control viewContextEvaluator):
	// the situation→view judgment prompt is a GEPA optimization target.
	"view_context",
	// LifeOps per-capability tasks (see OptimizedPromptTask union above).
	"calendar_extract",
	"schedule_plan",
	"reminder_dispatch",
	"inbox_triage",
	"meeting_prep",
	"morning_brief",
	"health_checkin",
	"screentime_recap",
] as const;

/**
 * The LifeOps subset of {@link OPTIMIZED_PROMPT_TASKS}. Exposed so LifeOps
 * plugins and the training optimizer can iterate the per-capability tasks
 * without re-declaring the list — keeps `@elizaos/core` the single source of
 * truth for the LifeOps optimization taxonomy.
 */
export const LIFEOPS_OPTIMIZED_PROMPT_TASKS: readonly OptimizedPromptTask[] = [
	"calendar_extract",
	"schedule_plan",
	"reminder_dispatch",
	"inbox_triage",
	"meeting_prep",
	"morning_brief",
	"health_checkin",
	"screentime_recap",
] as const;

export type OptimizerName =
	| "instruction-search"
	| "prompt-evolution"
	| "gepa"
	| "bootstrap-fewshot"
	| "dspy-bootstrap-fewshot"
	| "dspy-copro"
	| "dspy-mipro";

/**
 * Mirror of `OptimizationExample` from `plugins/plugin-training/src/optimizers/types.ts`.
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

/** Collision-proof temp filename suffix for write-then-rename scratch files. */
function uniqueTempSuffix(): string {
	return `${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
}

/**
 * Per-key serialization. setPrompt for a given task dir mutates shared
 * symlinks + the retention window; overlapping in-process writes for the same
 * dir would race the repoint/prune. Each key (the task dir) gets a tail
 * promise; callers chain onto it so writes for one dir run one-at-a-time,
 * while different dirs stay fully parallel. The map self-cleans when a key's
 * chain drains.
 */
const dirWriteChains = new Map<string, Promise<unknown>>();

async function runExclusive<T>(
	key: string,
	work: () => Promise<T>,
): Promise<T> {
	const prior = dirWriteChains.get(key) ?? Promise.resolve();
	// Swallow the prior result/rejection for chaining purposes only — the
	// originating caller still observes its own outcome.
	const run = prior.then(work, work);
	dirWriteChains.set(key, run);
	try {
		return await run;
	} finally {
		if (dirWriteChains.get(key) === run) dirWriteChains.delete(key);
	}
}

// -----------------------------------------------------------------------------
// SOC2 CC6.8 — HMAC integrity tags on optimized-prompt artifacts.
//
// Every artifact written via setPrompt() gets a sibling `.mac` file containing
// HMAC-SHA256(payload_bytes, key). On load, the MAC is recomputed and a
// mismatch triggers AUDIT_ACTIONS.optimized_prompt.integrity_failed (emitted
// via the runtime's structured logger; the audit dispatcher in
// @elizaos/security picks up the entry through the logger sink).
//
// Key source: in this single-user-desktop context the HMAC key is derived
// from `ELIZA_OPTIMIZED_PROMPT_HMAC_KEY` (a 32-byte hex/base64 secret set at
// install time). The contract mirrors `KmsClient.hmac(orgKey(orgId,
// "optimized-prompt-integrity"), bytes)` from `@elizaos/security`; once core
// can depend on security in the build graph this is swapped for the real KMS
// adapter without changing the on-disk format.
// -----------------------------------------------------------------------------

const OPTIMIZED_PROMPT_MAC_SUFFIX = ".mac";
const OPTIMIZED_PROMPT_HMAC_DEFAULT_KEY_TAG =
	"elizaos.optimized-prompt.integrity.v1";

function resolveHmacKey(): Buffer {
	const fromEnv = process.env.ELIZA_OPTIMIZED_PROMPT_HMAC_KEY;
	if (fromEnv?.trim()) {
		// Accept hex (64 chars) or base64; fall back to raw utf-8 bytes.
		const trimmed = fromEnv.trim();
		if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
			return Buffer.from(trimmed, "hex");
		}
		try {
			const buf = Buffer.from(trimmed, "base64");
			if (buf.length >= 16) return buf;
		} catch {
			// fall through
		}
		return Buffer.from(trimmed, "utf-8");
	}
	// Deterministic fallback: HMAC key tag itself. This is NOT secret-grade
	// but it does protect against accidental tampering by an unrelated
	// process and it lets local-dev installs run without explicit setup.
	// Production deployments must set ELIZA_OPTIMIZED_PROMPT_HMAC_KEY.
	return Buffer.from(OPTIMIZED_PROMPT_HMAC_DEFAULT_KEY_TAG, "utf-8");
}

function computeArtifactMac(payload: Buffer | string): string {
	const key = resolveHmacKey();
	const data =
		typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;
	return createHmac("sha256", key).update(data).digest("hex");
}

function verifyArtifactMac(
	payload: Buffer | string,
	expectedHex: string,
): boolean {
	if (!/^[0-9a-fA-F]{64}$/.test(expectedHex.trim())) return false;
	const expected = Buffer.from(expectedHex.trim(), "hex");
	const actual = Buffer.from(computeArtifactMac(payload), "hex");
	if (expected.length !== actual.length) return false;
	return timingSafeEqual(expected, actual);
}

function macPathFor(artifactPath: string): string {
	return `${artifactPath}${OPTIMIZED_PROMPT_MAC_SUFFIX}`;
}

/**
 * Audit-event tag emitted when an optimized-prompt artifact's HMAC fails
 * verification. Mirrors the contract surface
 * `AUDIT_ACTIONS.optimized_prompt.integrity_failed` from
 * `@elizaos/security`; the dispatcher is loaded by the runtime, which
 * means logging this tag from core is sufficient for the audit pipeline
 * to pick it up.
 */
export const OPTIMIZED_PROMPT_INTEGRITY_FAILED_AUDIT_ACTION =
	"optimized_prompt.integrity_failed";

/** Test/diagnostic helper: compute the MAC the service would write. */
export function _computeOptimizedPromptMacForTest(payload: string): string {
	return computeArtifactMac(payload);
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptimizerName(value: unknown): value is OptimizerName {
	return (
		value === "instruction-search" ||
		value === "prompt-evolution" ||
		value === "gepa" ||
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
 * disabled tasks. Unknown task names are dropped — an operator disabling a
 * misspelled task should not crash the runtime, and the misspelling must not
 * accidentally disable some other task — but each dropped token is logged so a
 * typo doesn't silently disable nothing.
 *
 * Format: comma-separated list of task names. Whitespace is trimmed; empty
 * tokens are ignored without a warning.
 * Example: `OPTIMIZED_PROMPT_DISABLE=should_respond,response`.
 */
export function parseDisabledTasksEnv(
	raw: string | undefined,
): ReadonlySet<OptimizedPromptTask> {
	if (!raw) return new Set();
	const tasks = new Set<OptimizedPromptTask>();
	for (const part of raw.split(",")) {
		const trimmed = part.trim();
		if (trimmed === "") continue;
		if (isTask(trimmed)) {
			tasks.add(trimmed);
		} else {
			logger.warn(
				{ src: "service:optimized_prompt", entry: trimmed },
				`[OptimizedPromptService] OPTIMIZED_PROMPT_DISABLE entry "${trimmed}" is not a known task — ignored`,
			);
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
	 *
	 * The same taxonomy is registered by both core basicServices and
	 * plugin-training register-runtime, and trigger/CLI train also call this —
	 * so two setPrompt calls for one task can overlap in-process. The version
	 * claim is made cross-process-safe with O_EXCL; the symlink-repoint and
	 * prune steps mutate shared `current`/`previous` links and the retention
	 * window, so the whole write is serialized per task dir via an in-process
	 * lock to keep those mutations consistent.
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
		return runExclusive(dir, () => this.writeArtifact(task, dir, artifact));
	}

	private async writeArtifact(
		task: OptimizedPromptTask,
		dir: string,
		artifact: OptimizedPromptArtifact,
	): Promise<string> {
		mkdirSync(dir, { recursive: true });

		const payload = `${JSON.stringify(artifact, null, 2)}\n`;
		const macHex = computeArtifactMac(payload);

		// Atomically claim the next `vN.json` slot. Two concurrent setPrompt
		// calls for the same task (e.g. basicServices + plugin-training, or a
		// CLI/trigger train) read the same version list and would otherwise
		// both target the same vN — clobbering one artifact and/or leaving a
		// vN.json without a matching .mac. Claiming a hidden lock filename with
		// O_EXCL ('wx') serializes the race without exposing a final-looking
		// artifact before the payload and MAC are both durable.
		const { nextVersion, finalPath, claimPath } =
			await claimNextVersionPath(dir);

		const macPath = macPathFor(finalPath);
		const tempPath = `${finalPath}.tmp-${uniqueTempSuffix()}`;
		const macTemp = `${macPath}.tmp-${uniqueTempSuffix()}`;
		try {
			await writeFile(tempPath, payload, "utf-8");

			// SOC2 CC6.8: persist HMAC sidecar so getPrompt() can detect
			// tampering. The MAC covers the on-disk payload bytes verbatim.
			await writeFile(macTemp, `${macHex}\n`, "utf-8");
			await rename(macTemp, macPath);

			// Publish the payload only after its matching MAC is already in place.
			// A crash before this point leaves at most hidden/temp files; a crash
			// after this point leaves a complete MAC-valid artifact.
			await rename(tempPath, finalPath);

			// Repoint symlinks: current → vN, previous → vN-1, previous2 → vN-2.
			// Re-scan the directory and include only complete MAC-valid artifacts:
			// concurrent claims and stale crashed writes must never become live.
			const allVersions = await listCompleteVersionNumbers(dir);
			await repointVersionLinks(dir, allVersions);

			// Prune older artifacts beyond the retention window. Done after the
			// symlinks are repointed so we never delete a file the symlinks
			// still reference.
			await pruneOldVersions(dir, allVersions);
		} catch (err) {
			await Promise.all([
				removeFileBestEffort(tempPath),
				removeFileBestEffort(macTemp),
				removeFileBestEffort(finalPath),
				removeFileBestEffort(macPath),
			]);
			throw err;
		} finally {
			await removeFileBestEffort(claimPath);
		}

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
			// A corrupt / looping / permission-denied artifact for ONE task
			// (ELOOP, EACCES, EISDIR, etc.) must not poison the other tasks or
			// fail service start: an absent or unreadable artifact is a no-op,
			// the task simply falls back to its baseline prompt. Isolate each
			// task's disk reads so one bad directory leaves the rest cached.
			try {
				const entry = await this.loadTaskEntry(task);
				if (entry) next[task] = entry;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				logger.warn(
					{
						src: "service:optimized_prompt",
						task,
						code,
						err,
					},
					"[OptimizedPromptService] Skipping task: artifact store unreadable — falling back to baseline",
				);
			}
		}
		this.cache = next;
	}

	/**
	 * Load the live cache entry for a single task by reading its on-disk store.
	 * Returns null when the task has no usable artifact. Throws only on
	 * unexpected filesystem errors (e.g. ELOOP/EACCES/EISDIR), which
	 * {@link refresh} isolates per task.
	 */
	private async loadTaskEntry(
		task: OptimizedPromptTask,
	): Promise<CachedEntry | null> {
		const dir = join(this.storeRoot, task);
		if (!existsSync(dir)) return null;

		// Preferred path: read via the `current` symlink. This is the
		// declared live version after a `setPrompt` or `rollback` call.
		const currentLink = join(dir, OPTIMIZED_PROMPT_CURRENT_LINK);
		const fromCurrent = await loadArtifactFromPath(currentLink, task);
		if (fromCurrent) {
			return { artifact: fromCurrent, loadedAt: Date.now() };
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
			return { artifact: bestArtifact, loadedAt: Date.now() };
		}
		return null;
	}
}

/**
 * Return the sorted ascending list of version numbers (`v1`, `v2`, ...)
 * that are complete and MAC-valid. Files that don't match the `vN.json`
 * pattern, hidden claim files, temp files, missing MACs, and corrupt MACs are
 * ignored.
 */
async function listCompleteVersionNumbers(dir: string): Promise<number[]> {
	if (!existsSync(dir)) return [];
	const versions: number[] = [];
	for (const name of readdirSync(dir)) {
		const match = VERSION_FILE_PATTERN.exec(name);
		if (!match) continue;
		const n = Number.parseInt(match[1] ?? "", 10);
		if (!Number.isFinite(n)) continue;
		const path = join(dir, name);
		try {
			const payload = await readFile(path, "utf-8");
			const macHex = (await readFile(macPathFor(path), "utf-8")).trim();
			if (verifyArtifactMac(payload, macHex)) versions.push(n);
		} catch {
			// error-policy:J3 an absent or unverifiable artifact version is simply not available to the scan
		}
	}
	versions.sort((a, b) => a - b);
	return versions;
}

/**
 * Return all version numbers that are already claimed, whether by a complete
 * artifact (`vN.json`), an incomplete legacy artifact, or a hidden in-flight
 * claim (`.vN.json.claim`). This is deliberately broader than
 * {@link listCompleteVersionNumbers}; its job is only to choose a never-used
 * slot for the next write.
 */
function listClaimedVersionNumbers(dir: string): number[] {
	if (!existsSync(dir)) return [];
	const versions = new Set<number>();
	for (const name of readdirSync(dir)) {
		const match =
			VERSION_FILE_PATTERN.exec(name) ?? VERSION_CLAIM_PATTERN.exec(name);
		if (!match) continue;
		const n = Number.parseInt(match[1] ?? "", 10);
		if (Number.isFinite(n)) versions.add(n);
	}
	return [...versions].sort((a, b) => a - b);
}

/**
 * Maximum O_EXCL retries when claiming a version slot. Each attempt is one
 * concurrent setPrompt losing the race; the number of contenders for a single
 * task dir is tiny (basicServices + plugin-training + at most one CLI/trigger
 * train), so this is comfortably above any real-world contention. Exhausting
 * it means the directory is genuinely wedged — surface that as an error rather
 * than spinning forever.
 */
const VERSION_CLAIM_MAX_ATTEMPTS = 64;

/**
 * Atomically reserve the next free `vN.json` slot in `dir`. Reads every claimed
 * version, then tries to create a hidden `.vN.json.claim` file with `O_EXCL`
 * ('wx') so exactly one concurrent caller can own a given version. On `EEXIST`
 * (another setPrompt claimed it first) re-read the directory and bump. Returns
 * the claimed version number, final artifact path, and claim path.
 */
async function claimNextVersionPath(
	dir: string,
): Promise<{ nextVersion: number; finalPath: string; claimPath: string }> {
	let candidate = (listClaimedVersionNumbers(dir).at(-1) ?? 0) + 1;
	for (let attempt = 0; attempt < VERSION_CLAIM_MAX_ATTEMPTS; attempt += 1) {
		const finalPath = join(dir, `v${candidate}.json`);
		const claimPath = join(dir, `.v${candidate}.json.claim`);
		try {
			await writeFile(claimPath, "", { flag: "wx" });
			return { nextVersion: candidate, finalPath, claimPath };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			// Lost the claim race: re-read the directory and target the next
			// free version above whatever the winner(s) just wrote.
			const highest = listClaimedVersionNumbers(dir).at(-1) ?? 0;
			candidate = Math.max(candidate + 1, highest + 1);
		}
	}
	throw new Error(
		`[OptimizedPromptService] could not claim a version slot in ${dir} after ${VERSION_CLAIM_MAX_ATTEMPTS} attempts`,
	);
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
		await rm(macPathFor(path), { force: true });
	}
}

/**
 * Atomically replace `linkPath` with a symlink whose target is `target`.
 * Writes a temp link beside it and renames into place so the link is never
 * absent during the swap.
 */
async function replaceSymlink(linkPath: string, target: string): Promise<void> {
	const tempPath = `${linkPath}.tmp-${uniqueTempSuffix()}`;
	mkdirSync(dirname(tempPath), { recursive: true });
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

async function removeFileBestEffort(path: string): Promise<void> {
	try {
		await rm(path, { force: true });
	} catch {
		// Cleanup must not mask the original write failure.
	}
}

/**
 * Resolve the `.mac` sidecar path for a given artifact path. When `path` is
 * a symlink (e.g. `current` -> `v3.json`), the MAC lives next to the
 * concrete file (`v3.json.mac`), not next to the symlink itself.
 */
async function resolveMacPath(artifactPath: string): Promise<string> {
	const linkTarget = await readLinkOrNull(artifactPath);
	if (linkTarget !== null) {
		return macPathFor(join(dirname(artifactPath), linkTarget));
	}
	return macPathFor(artifactPath);
}

async function readLinkOrNull(path: string): Promise<string | null> {
	try {
		return await readlink(path);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// ENOENT: path missing. EINVAL: path is a regular file (not a symlink).
		// Both mean "no symlink target" — callers handle that as null.
		if (code === "ENOENT" || code === "EINVAL") return null;
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
	// SOC2 CC6.8: verify HMAC sidecar before parsing. A `.mac` next to the
	// artifact (or next to the symlink target if `path` is a symlink) must
	// match HMAC-SHA256(payload). Missing/invalid MAC -> refuse to load
	// and emit the integrity-failed audit action via the logger.
	const macPath = await resolveMacPath(path);
	let macHex: string | null = null;
	try {
		macHex = (await readFile(macPath, "utf-8")).trim();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (macHex === null) {
		logger.warn(
			{
				src: "service:optimized_prompt",
				task,
				path,
				macPath,
				action: OPTIMIZED_PROMPT_INTEGRITY_FAILED_AUDIT_ACTION,
				reason: "mac_missing",
			},
			"Optimized prompt artifact rejected: HMAC sidecar missing",
		);
		return null;
	}
	if (!verifyArtifactMac(raw, macHex)) {
		logger.error(
			{
				src: "service:optimized_prompt",
				task,
				path,
				macPath,
				action: OPTIMIZED_PROMPT_INTEGRITY_FAILED_AUDIT_ACTION,
				reason: "mac_mismatch",
			},
			"Optimized prompt artifact rejected: HMAC mismatch",
		);
		return null;
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
