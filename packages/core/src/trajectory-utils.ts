import {
	getTrajectoryContext,
	runWithTrajectoryContext,
} from "./trajectory-context";
import type { IAgentRuntime } from "./types/runtime";
import { encodeToonValue } from "./utils/toon";

export type TrajectoryFinalStatus =
	| "completed"
	| "error"
	| "timeout"
	| "terminated";

export const TRAJECTORY_LLM_PURPOSES = [
	"planner",
	"action",
	"provider",
	"evaluator",
	"background",
	"external_llm",
	"optimizer",
] as const;

export type TrajectoryLlmPurpose = (typeof TRAJECTORY_LLM_PURPOSES)[number];

export type TrajectoryLlmCallDetails = {
	model: string;
	modelVersion?: string;
	systemPrompt: string;
	userPrompt: string;
	response: string;
	reasoning?: string;
	temperature: number;
	maxTokens: number;
	/**
	 * High-level model-call category. Prefer the canonical taxonomy in
	 * {@link TRAJECTORY_LLM_PURPOSES}; custom strings remain accepted for
	 * compatibility with older trajectory rows.
	 */
	purpose: string;
	/**
	 * Precise call-site label, e.g. `runtime.useModel`, `ai.generateText`,
	 * or `openai.chat.completions.create`.
	 */
	actionType: string;
	latencyMs: number;
	promptTokens?: number;
	completionTokens?: number;
};

/**
 * Caller-supplied portion of {@link TrajectoryLlmCallDetails} for
 * {@link recordLlmCall}. The helper measures `latencyMs` itself and
 * derives `response` from the function's return value.
 */
export type RecordLlmCallDetails = Omit<
	TrajectoryLlmCallDetails,
	"latencyMs" | "response"
> & {
	/** Optional override for the recorded response string. */
	response?: string;
};

type TrajectoryStartOptions = {
	source?: string;
	metadata?: Record<string, unknown>;
};

type TrajectoryStepState = {
	timestamp: number;
	agentBalance: number;
	agentPoints: number;
	agentPnL: number;
	openPositions: number;
};

type TrajectoryStepKindLike = "llm" | "action" | "executeCode";

export type TrajectoryAnnotateParams = {
	stepId: string;
	kind?: TrajectoryStepKindLike;
	script?: string;
	childSteps?: string[];
	appendChildSteps?: string[];
	usedSkills?: string[];
};

type TrajectoryLoggerLike = {
	isEnabled?: () => boolean;
	startTrajectory?: (
		agentId: string,
		options?: TrajectoryStartOptions,
	) => Promise<string> | string;
	startStep?: (trajectoryId: string, state: TrajectoryStepState) => string;
	endTrajectory?: (
		stepIdOrTrajectoryId: string,
		status?: TrajectoryFinalStatus,
		finalMetrics?: Record<string, unknown>,
	) => Promise<void> | void;
	flushWriteQueue?: (trajectoryId: string) => Promise<void> | void;
	logLlmCall?: (params: { stepId: string } & TrajectoryLlmCallDetails) => void;
	/**
	 * Optional. When implemented (DatabaseTrajectoryLogger does), lets a caller
	 * extend an existing step row with the new schema fields (kind, script,
	 * childSteps, usedSkills). The plugin-executecode action uses this to
	 * record its parent step + collected child step IDs without depending
	 * directly on @elizaos/agent.
	 */
	annotateStep?: (params: TrajectoryAnnotateParams) => Promise<void> | void;
};

type StandaloneTrajectoryOptions = {
	source: string;
	metadata?: Record<string, unknown>;
	successStatus?: TrajectoryFinalStatus;
	errorStatus?: Exclude<TrajectoryFinalStatus, "completed">;
};

type TrajectoryLlmGuardContext = {
	model?: string;
	modelType?: string;
	purpose?: string;
	actionType?: string;
};

const RECORD_LLM_CALL_DEPTH_KEY = Symbol.for("elizaos.recordLlmCallDepth");

type TrajectoryContextWithLlmGuard = {
	[RECORD_LLM_CALL_DEPTH_KEY]?: number;
};

function isTrajectoryLoggerCandidate(
	value: unknown,
): value is TrajectoryLoggerLike {
	return !!value && typeof value === "object";
}

function readProcessEnv(name: string): string | undefined {
	if (
		typeof process === "undefined" ||
		!process ||
		typeof process.env !== "object"
	) {
		return undefined;
	}
	return process.env[name];
}

function isTruthyEnvValue(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function isTrajectoryStrictModeEnabled(): boolean {
	return isTruthyEnvValue(readProcessEnv("MILADY_TRAJECTORY_STRICT"));
}

export function normalizeTrajectoryLlmPurpose(
	value: string | null | undefined,
	fallback: TrajectoryLlmPurpose = "external_llm",
): TrajectoryLlmPurpose {
	const normalized = value?.trim().toLowerCase();
	if (
		normalized &&
		TRAJECTORY_LLM_PURPOSES.includes(normalized as TrajectoryLlmPurpose)
	) {
		return normalized as TrajectoryLlmPurpose;
	}
	return fallback;
}

/**
 * Return true for model slots that are expected to produce generative LLM
 * output. Embeddings, tokenizers, and speech/transcription/media models are
 * intentionally excluded from strict trajectory enforcement.
 */
export function isLlmGenerationModelType(modelType: unknown): boolean {
	const normalized = String(modelType ?? "")
		.trim()
		.toUpperCase();
	if (!normalized) return false;

	if (
		normalized === "TEXT_EMBEDDING" ||
		normalized === "TEXT_TO_SPEECH" ||
		normalized.startsWith("TEXT_TOKENIZER")
	) {
		return false;
	}

	return (
		normalized.startsWith("TEXT_") ||
		normalized.startsWith("REASONING_") ||
		normalized.startsWith("OBJECT_") ||
		normalized === "RESPONSE_HANDLER" ||
		normalized === "ACTION_PLANNER" ||
		normalized === "RESEARCH"
	);
}

function getActiveTrajectoryStepId(): string | null {
	const stepId = getTrajectoryContext()?.trajectoryStepId;
	return typeof stepId === "string" && stepId.trim() !== ""
		? stepId.trim()
		: null;
}

function formatLlmGuardContext(context?: TrajectoryLlmGuardContext): string {
	const parts = [
		context?.actionType ? `actionType=${context.actionType}` : "",
		context?.model ? `model=${context.model}` : "",
		context?.modelType ? `modelType=${context.modelType}` : "",
		context?.purpose ? `purpose=${context.purpose}` : "",
	].filter(Boolean);
	return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/**
 * Strict-mode assertion for any generative LLM call. In normal mode this is a
 * no-op. With `MILADY_TRAJECTORY_STRICT=1`, it throws unless a trajectory step
 * is active.
 */
export function assertActiveTrajectoryForLlmCall(
	context?: TrajectoryLlmGuardContext,
): string | null {
	const stepId = getActiveTrajectoryStepId();
	if (stepId || !isTrajectoryStrictModeEnabled()) {
		return stepId;
	}

	throw new Error(
		`[trajectory-strict] LLM-like call outside trajectory${formatLlmGuardContext(
			context,
		)}. Wrap raw SDK/fetch generation in recordLlmCall(runtime, details, fn), or start a trajectory with withStandaloneTrajectory(...). Embeddings and tokenizers are exempt.`,
	);
}

function getRecordedLlmCallDepth(): number {
	const ctx = getTrajectoryContext() as
		| (TrajectoryContextWithLlmGuard & object)
		| undefined;
	const depth = ctx?.[RECORD_LLM_CALL_DEPTH_KEY];
	return typeof depth === "number" && Number.isFinite(depth)
		? Math.max(0, depth)
		: 0;
}

async function runInsideRecordedLlmCall<T>(
	fn: () => Promise<T> | T,
): Promise<T> {
	const ctx = getTrajectoryContext() as
		| (TrajectoryContextWithLlmGuard & object)
		| undefined;
	if (!ctx) {
		return await fn();
	}

	ctx[RECORD_LLM_CALL_DEPTH_KEY] = getRecordedLlmCallDepth() + 1;
	try {
		return await fn();
	} finally {
		const nextDepth = getRecordedLlmCallDepth() - 1;
		if (nextDepth > 0) {
			ctx[RECORD_LLM_CALL_DEPTH_KEY] = nextDepth;
		} else {
			delete ctx[RECORD_LLM_CALL_DEPTH_KEY];
		}
	}
}

/**
 * Strict-mode assertion for low-level raw SDK/fetch shims. Use this in tests
 * or thin adapters that cannot directly call {@link recordLlmCall}; canonical
 * raw generation call sites should still wrap the SDK call in
 * {@link recordLlmCall}.
 */
export function assertRecordedLlmCall(
	context?: TrajectoryLlmGuardContext,
): void {
	assertActiveTrajectoryForLlmCall(context);
	if (!isTrajectoryStrictModeEnabled() || getRecordedLlmCallDepth() > 0) {
		return;
	}

	throw new Error(
		`[trajectory-strict] Raw LLM call is not wrapped by recordLlmCall${formatLlmGuardContext(
			context,
		)}.`,
	);
}

export function resolveTrajectoryLogger(
	runtime: IAgentRuntime,
): TrajectoryLoggerLike | null {
	const candidates: TrajectoryLoggerLike[] = [];
	const seen = new Set<unknown>();
	const push = (candidate: unknown): void => {
		if (!isTrajectoryLoggerCandidate(candidate) || seen.has(candidate)) {
			return;
		}
		seen.add(candidate);
		candidates.push(candidate);
	};

	push(runtime.getService("trajectories"));
	for (const candidate of runtime.getServicesByType("trajectories")) {
		push(candidate);
	}

	let best: TrajectoryLoggerLike | null = null;
	let bestScore = -1;
	for (const candidate of candidates) {
		let score = 0;
		if (typeof candidate.startTrajectory === "function") score += 100;
		if (typeof candidate.startStep === "function") score += 10;
		if (typeof candidate.endTrajectory === "function") score += 10;
		if (typeof candidate.logLlmCall === "function") score += 10;
		if (typeof candidate.flushWriteQueue === "function") score += 2;
		if (score > bestScore) {
			best = candidate;
			bestScore = score;
		}
	}

	return bestScore > 0 ? best : null;
}

export async function withStandaloneTrajectory<T>(
	runtime: IAgentRuntime | null | undefined,
	options: StandaloneTrajectoryOptions,
	callback: () => Promise<T> | T,
): Promise<T> {
	const activeStepId = getTrajectoryContext()?.trajectoryStepId;
	if (
		!runtime ||
		(typeof activeStepId === "string" && activeStepId.trim() !== "")
	) {
		return await callback();
	}

	const trajectoryLogger = resolveTrajectoryLogger(runtime);
	if (
		!trajectoryLogger ||
		typeof trajectoryLogger.startTrajectory !== "function" ||
		typeof trajectoryLogger.endTrajectory !== "function" ||
		(typeof trajectoryLogger.isEnabled === "function" &&
			!trajectoryLogger.isEnabled())
	) {
		return await callback();
	}

	const trajectoryId = String(
		await trajectoryLogger.startTrajectory(runtime.agentId, {
			source: options.source,
			metadata: options.metadata,
		}),
	).trim();
	if (!trajectoryId) {
		return await callback();
	}

	const stepId =
		typeof trajectoryLogger.startStep === "function"
			? String(
					trajectoryLogger.startStep(trajectoryId, {
						timestamp: Date.now(),
						agentBalance: 0,
						agentPoints: 0,
						agentPnL: 0,
						openPositions: 0,
					}),
				).trim() || trajectoryId
			: trajectoryId;

	let completed = false;
	try {
		const result = await runWithTrajectoryContext(
			{ trajectoryId, trajectoryStepId: stepId },
			() => callback(),
		);
		completed = true;
		return result;
	} finally {
		if (typeof trajectoryLogger.flushWriteQueue === "function") {
			await trajectoryLogger.flushWriteQueue(trajectoryId);
		}
		await trajectoryLogger.endTrajectory(
			trajectoryId,
			completed
				? (options.successStatus ?? "completed")
				: (options.errorStatus ?? "error"),
		);
	}
}

/**
 * Annotate a trajectory step via whichever trajectory logger service is
 * registered on the runtime. Returns true when an annotate-capable service
 * was found and called; false when no compatible service exists or it is
 * disabled. Errors from the underlying service are propagated.
 */
export async function annotateActiveTrajectoryStep(
	runtime: IAgentRuntime | null | undefined,
	params: TrajectoryAnnotateParams,
): Promise<boolean> {
	if (!runtime) return false;
	const trajectoryLogger = resolveTrajectoryLogger(runtime);
	if (
		!trajectoryLogger ||
		typeof trajectoryLogger.annotateStep !== "function" ||
		(typeof trajectoryLogger.isEnabled === "function" &&
			!trajectoryLogger.isEnabled())
	) {
		return false;
	}
	await trajectoryLogger.annotateStep(params);
	return true;
}

export function logActiveTrajectoryLlmCall(
	runtime: IAgentRuntime | null | undefined,
	details: TrajectoryLlmCallDetails,
): boolean {
	if (!runtime) {
		return false;
	}

	const stepId = assertActiveTrajectoryForLlmCall({
		actionType: details.actionType,
		model: details.model,
		purpose: details.purpose,
	});
	if (!stepId) {
		return false;
	}

	const trajectoryLogger = resolveTrajectoryLogger(runtime);
	if (
		!trajectoryLogger ||
		typeof trajectoryLogger.logLlmCall !== "function" ||
		(typeof trajectoryLogger.isEnabled === "function" &&
			!trajectoryLogger.isEnabled())
	) {
		return false;
	}

	trajectoryLogger.logLlmCall({
		stepId,
		...details,
	});
	return true;
}

/**
 * Canonical wrapper for raw SDK/fetch generative LLM calls.
 *
 * Time `fn`, capture its result, and emit a trajectory llm-call entry against
 * the currently active trajectory step. The caller supplies the static portion
 * of {@link TrajectoryLlmCallDetails} (model, prompts, purpose, actionType,
 * token limits, etc.); `latencyMs` is measured here and `response` is derived
 * from `fn`'s return value (stringified when not already a string) unless
 * `details.response` is provided explicitly.
 *
 * Use the canonical purpose taxonomy where possible: `planner`, `action`,
 * `provider`, `evaluator`, `background`, `external_llm`, or `optimizer`.
 * `actionType` should identify the concrete call site, such as
 * `ai.generateText` or `openai.chat.completions.create`.
 *
 * If no trajectory step is active or no trajectory logger is registered,
 * `fn` still runs and its result is returned in normal mode. With
 * `MILADY_TRAJECTORY_STRICT=1`, this throws before calling `fn` unless a
 * trajectory step is active.
 */
export async function recordLlmCall<T>(
	runtime: IAgentRuntime | null | undefined,
	details: RecordLlmCallDetails,
	fn: () => Promise<T> | T,
): Promise<T> {
	assertActiveTrajectoryForLlmCall({
		actionType: details.actionType,
		model: details.model,
		purpose: details.purpose,
	});

	const startedAt =
		typeof performance !== "undefined" && typeof performance.now === "function"
			? performance.now()
			: Date.now();
	const result = await runInsideRecordedLlmCall(fn);
	const elapsed =
		(typeof performance !== "undefined" && typeof performance.now === "function"
			? performance.now()
			: Date.now()) - startedAt;

	const responseText =
		typeof details.response === "string"
			? details.response
			: typeof result === "string"
				? result
				: result === undefined || result === null
					? ""
					: tryStringify(result);

	logActiveTrajectoryLlmCall(runtime, {
		...details,
		response: responseText,
		latencyMs: Math.max(0, Math.round(elapsed)),
	});

	return result;
}

function tryStringify(value: unknown): string {
	try {
		return encodeToonValue({ response: value });
	} catch {
		return String(value);
	}
}

function generateChildStepId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function withChildTrajectoryStep<T>(
	runtime: IAgentRuntime | null | undefined,
	options: { stepIdPrefix: string; purpose: string; actionName?: string },
	fn: () => Promise<T> | T,
): Promise<T> {
	if (!runtime) {
		return await fn();
	}

	const parentCtx = getTrajectoryContext();
	const parentStepId = parentCtx?.trajectoryStepId;
	if (!(typeof parentStepId === "string" && parentStepId.trim() !== "")) {
		return await fn();
	}
	const trajectoryId =
		typeof parentCtx?.trajectoryId === "string" &&
		parentCtx.trajectoryId.trim() !== ""
			? parentCtx.trajectoryId.trim()
			: undefined;

	const trajectoryLogger = resolveTrajectoryLogger(runtime);
	if (
		!trajectoryLogger ||
		(typeof trajectoryLogger.isEnabled === "function" &&
			!trajectoryLogger.isEnabled())
	) {
		return await fn();
	}

	let childStepId = generateChildStepId(options.stepIdPrefix);

	if (trajectoryId && typeof trajectoryLogger.startStep === "function") {
		try {
			const startedStepId = trajectoryLogger.startStep(trajectoryId, {
				timestamp: Date.now(),
				agentBalance: 0,
				agentPoints: 0,
				agentPnL: 0,
				openPositions: 0,
			});
			const normalizedStartedStepId =
				typeof startedStepId === "string" ? startedStepId.trim() : "";
			if (
				normalizedStartedStepId !== "" &&
				normalizedStartedStepId !== trajectoryId
			) {
				childStepId = normalizedStartedStepId;
			}
		} catch {
			// startStep is best-effort; continue with the generated id
		}
	}

	const childContext = {
		...(parentCtx ?? {}),
		trajectoryId,
		trajectoryStepId: childStepId,
		parentStepId,
		purpose: options.purpose,
	};

	try {
		return await runWithTrajectoryContext(childContext, () => fn());
	} finally {
		try {
			await annotateActiveTrajectoryStep(runtime, {
				stepId: parentStepId,
				appendChildSteps: [childStepId],
			});
		} catch {
			// Trajectory annotation must never break the host flow.
		}
	}
}

/**
 * Wrap an action handler invocation in a child trajectory step linked to the
 * currently-active parent step. All `useModel` / `useModel` -ish calls inside
 * `fn` will be recorded against the new child step rather than the parent.
 *
 * Transparent: when no trajectory is active, `fn` runs unchanged and no
 * step is created.
 */
export async function withActionStep<T>(
	runtime: IAgentRuntime | null | undefined,
	actionName: string,
	fn: () => Promise<T> | T,
): Promise<T> {
	return withChildTrajectoryStep(
		runtime,
		{ stepIdPrefix: "action", purpose: "action", actionName },
		fn,
	);
}

/**
 * Same as {@link withActionStep} but for provider rendering.
 */
export async function withProviderStep<T>(
	runtime: IAgentRuntime | null | undefined,
	providerName: string,
	fn: () => Promise<T> | T,
): Promise<T> {
	return withChildTrajectoryStep(
		runtime,
		{ stepIdPrefix: "provider", purpose: "provider", actionName: providerName },
		fn,
	);
}

/**
 * Same as {@link withActionStep} but for evaluator dispatch.
 */
export async function withEvaluatorStep<T>(
	runtime: IAgentRuntime | null | undefined,
	evaluatorName: string,
	fn: () => Promise<T> | T,
): Promise<T> {
	return withChildTrajectoryStep(
		runtime,
		{
			stepIdPrefix: "evaluator",
			purpose: "evaluator",
			actionName: evaluatorName,
		},
		fn,
	);
}

export type SpawnTrajectoryHandle = {
	/** The currently-active step id at spawn time, if any. */
	parentStepId: string | undefined;
	/**
	 * Annotate the parent step with a freshly-known child step id (e.g. one
	 * the spawned coding agent reports back over the bridge). No-op when no
	 * parent step was active at spawn time.
	 */
	linkChild: (childStepId: string) => Promise<boolean>;
};

/**
 * Helper for spawn paths (orchestrator / app-control / workbench coding agents)
 * that produces a parent-stepId-aware handle. The fn is run inside the current
 * trajectory context so any inline LLM calls during the spawn dispatch are
 * still parent-attributed; the returned handle lets the caller link
 * later-discovered child step ids back onto the parent.
 */
export async function spawnWithTrajectoryLink<T>(
	runtime: IAgentRuntime | null | undefined,
	_options: { source?: string; metadata?: Record<string, unknown> } | undefined,
	fn: (handle: SpawnTrajectoryHandle) => Promise<T> | T,
): Promise<T> {
	const parentStepId = getTrajectoryContext()?.trajectoryStepId;
	const handle: SpawnTrajectoryHandle = {
		parentStepId:
			typeof parentStepId === "string" && parentStepId.trim() !== ""
				? parentStepId
				: undefined,
		linkChild: async (childStepId: string) => {
			if (!handle.parentStepId) return false;
			if (!runtime) return false;
			if (typeof childStepId !== "string" || childStepId.trim() === "") {
				return false;
			}
			try {
				return await annotateActiveTrajectoryStep(runtime, {
					stepId: handle.parentStepId,
					appendChildSteps: [childStepId.trim()],
				});
			} catch {
				return false;
			}
		},
	};
	return await fn(handle);
}

/**
 * Single source-of-truth registry for trajectory "source" tags whose
 * trajectories must be excluded from training / optimization datasets.
 *
 * Bench-eval harnesses, optimizer self-judge calls, etc. register themselves
 * once at module load:
 *
 *   registerTrajectorySource("plugin-action-bench", {excludeFromTraining: true});
 *
 * Then any pipeline that reads trajectories before training (the privacy
 * filter / nightly export / on-demand orchestrator) checks
 * `isExcludedFromTraining(row.source)` and drops the row.
 */
type TrajectorySourceMeta = {
	excludeFromTraining: boolean;
};

const TRAJECTORY_SOURCE_REGISTRY_KEY = Symbol.for(
	"elizaos.trajectorySourceRegistry",
);

type GlobalWithTrajectorySourceRegistry = typeof globalThis & {
	[TRAJECTORY_SOURCE_REGISTRY_KEY]?: Map<string, TrajectorySourceMeta>;
};

function getRegistry(): Map<string, TrajectorySourceMeta> {
	const g = globalThis as GlobalWithTrajectorySourceRegistry;
	let registry = g[TRAJECTORY_SOURCE_REGISTRY_KEY];
	if (!registry) {
		registry = new Map<string, TrajectorySourceMeta>();
		g[TRAJECTORY_SOURCE_REGISTRY_KEY] = registry;
	}
	return registry;
}

export function registerTrajectorySource(
	name: string,
	opts: TrajectorySourceMeta,
): void {
	if (typeof name !== "string" || name.trim() === "") return;
	getRegistry().set(name.trim(), { ...opts });
}

export function isExcludedFromTraining(
	sourceName: string | null | undefined,
): boolean {
	if (typeof sourceName !== "string" || sourceName.trim() === "") return false;
	const meta = getRegistry().get(sourceName.trim());
	return Boolean(meta?.excludeFromTraining);
}

/**
 * Test-only: wipe the source registry. Not exported via the package barrel.
 * @internal
 */
export function __resetTrajectorySourceRegistryForTests(): void {
	getRegistry().clear();
}
