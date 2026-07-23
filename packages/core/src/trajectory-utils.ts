/**
 * Runtime-side utilities for recording model trajectories: the glue between raw
 * LLM/provider call sites and whichever trajectory-logger service is registered
 * (`services/trajectories`). Owns the LLM-call detail/purpose taxonomy, the
 * strict-mode guards that fail fast when a generative call happens outside a
 * trajectory step, and the wrappers that open child steps around actions,
 * providers, evaluators, and spawned sub-agents.
 *
 * `recordLlmCall` is the canonical entry point for raw SDK/fetch generation: it
 * times `fn`, derives the response text, and emits an llm-call entry against the
 * active step. Opt-in request scopes can also attest a pinned instruction on
 * those final provider inputs before quota is spent, returning only hashes and
 * counts. `withStandaloneTrajectory` / `withActionStep` / `withProviderStep` /
 * `withEvaluatorStep` establish the trajectory context those calls attach to;
 * `resolveTrajectoryLogger` picks the best-scoring logger service by capability.
 *
 * Also builds the context-object trajectory export (JSON-sanitized, cycle-safe)
 * and holds the process-global registry of trajectory `source` tags excluded
 * from training/optimization datasets. Strict enforcement is gated on
 * `ELIZA_TRAJECTORY_STRICT`; embeddings, tokenizers, and speech/media models are
 * exempt from the generative-call guards.
 */
import { getAmbientSingleton } from "./ambient-context.js";
import { isTruthyEnvValue } from "./env-utils.js";
import { ElizaError } from "./errors";
import {
	CONTEXT_OBJECT_TRAJECTORY_VERSION,
	type ContextObjectTrajectoryExport,
	type JsonValue,
	type Trajectory,
} from "./features/trajectories/types";
import type { TrajectoryProviderAttribution } from "./runtime/trajectory-provider-attribution";
import type { TrajectorySkillInvocationRecord } from "./services/trajectory-types";
import {
	getTrajectoryContext,
	runWithTrajectoryContext,
} from "./trajectory-context";
import type { ContextEvent, ContextObject } from "./types/context-object";
import { isTextGenerationModelType } from "./types/model";
import type { IAgentRuntime } from "./types/runtime";
import { createHash } from "./utils/crypto-compat";

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
	modelType?: string;
	provider?: string;
	systemPrompt: string;
	userPrompt: string;
	prompt?: string;
	messages?: unknown[];
	tools?: unknown;
	toolChoice?: unknown;
	output?: unknown;
	responseSchema?: unknown;
	providerOptions?: unknown;
	response: string;
	toolCalls?: unknown[];
	finishReason?: string;
	providerMetadata?: unknown;
	reasoning?: string;
	temperature: number;
	maxTokens: number;
	maxTokensOmitted?: boolean;
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
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	providerOrder?: string[];
	providerAttributions?: TrajectoryProviderAttribution[];
};

export type TrajectoryProviderAccessParams = {
	stepId: string;
	providerName: string;
	data: Record<string, string | number | boolean | null>;
	sha256?: string;
	tokenCount?: number;
	position?: number;
	spanStart?: number;
	spanEnd?: number;
	purpose: string;
	query?: Record<string, string | number | boolean | null>;
	runId?: string;
	roomId?: string;
	messageId?: string;
	executionTraceId?: string;
};

export type TrajectoryProviderAccessLogger = {
	logProviderAccess: (params: TrajectoryProviderAccessParams) => void;
};

export type TrajectoryRuntimeLlmCallParams = {
	stepId: string;
	modelSlot?: string;
	runId?: string;
	roomId?: string;
	messageId?: string;
	executionTraceId?: string;
	providerOrder?: string[];
	providerAttributions?: TrajectoryProviderAttribution[];
} & TrajectoryLlmCallDetails;

export type TrajectoryRuntimeLlmCallLogger = {
	logLlmCall: (params: TrajectoryRuntimeLlmCallParams) => void;
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

/**
 * Content-free proof that every final provider input in one request contained
 * an expected instruction exactly once. The raw instruction exists only in
 * the request-scoped collector and is never returned in this summary.
 */
export interface LlmInputSubstringAttestation {
	schemaVersion: 1;
	expectedSha256: string;
	modelCallCount: number;
	matchingCallCount: number;
	totalOccurrences: number;
	exactOncePerModelCall: boolean;
	modelTypeCallCounts: Record<string, number>;
}

interface LlmInputSubstringAttestationStore {
	expectedText: string;
	expectedSha256: string;
	modelCallCount: number;
	matchingCallCount: number;
	totalOccurrences: number;
	modelTypeCallCounts: Map<string, number>;
	seenLogicalCalls: WeakSet<RecordLlmCallDetails>;
}

interface LlmInputSubstringAttestationContextManager {
	run<T>(
		store: LlmInputSubstringAttestationStore | undefined,
		fn: () => T | Promise<T>,
	): T | Promise<T>;
	active(): LlmInputSubstringAttestationStore | undefined;
}

/**
 * Trajectory-shaped input for context-object export: either a slice of the
 * canonical {@link Trajectory} type or a loosely-typed detail/DB row
 * (`Record` metadata/metrics) used by trajectory services.
 */
export type ContextObjectTrajectoryExportTrajectoryInput =
	| Partial<
			Pick<Trajectory, "trajectoryId" | "agentId" | "metadata" | "metrics">
	  >
	| {
			trajectoryId?: string;
			agentId?: string;
			source?: string;
			status?: string;
			startTime?: number;
			endTime?: number;
			durationMs?: number;
			metadata?: Record<string, unknown>;
			metrics?: Record<string, unknown>;
	  };

export type ContextObjectTrajectoryExportInput = {
	trajectory?: ContextObjectTrajectoryExportTrajectoryInput | null;
	contextObject?: ContextObject | null;
	events?: readonly ContextEvent[];
	trajectoryId?: string;
	agentId?: string;
	contextObjectId?: string;
	createdAt?: number;
	source?: string;
	metadata?: Record<string, unknown>;
	metrics?: Record<string, unknown>;
};

type JsonSanitizeResult = JsonValue | undefined;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeJsonValue(
	value: unknown,
	seen: WeakSet<object> = new WeakSet<object>(),
): JsonSanitizeResult {
	if (value === null) return null;
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return Number.isNaN(value) ? null : value;
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) return undefined;
		seen.add(value);
		const out: JsonValue[] = [];
		for (const item of value) {
			const sanitized = sanitizeJsonValue(item, seen);
			out.push(sanitized === undefined ? null : sanitized);
		}
		seen.delete(value);
		return out;
	}
	if (isPlainRecord(value)) {
		if (seen.has(value)) return undefined;
		seen.add(value);
		const out: Record<string, JsonValue> = {};
		for (const [key, entry] of Object.entries(value)) {
			const sanitized = sanitizeJsonValue(entry, seen);
			if (sanitized !== undefined) {
				out[key] = sanitized;
			}
		}
		seen.delete(value);
		return out;
	}
	return undefined;
}

function sanitizeJsonObject(
	value: unknown,
): Record<string, JsonValue> | undefined {
	const sanitized = sanitizeJsonValue(value);
	return isPlainRecord(sanitized)
		? (sanitized as Record<string, JsonValue>)
		: undefined;
}

function hasContextEvents(
	value: unknown,
): value is { events: readonly unknown[] } {
	return isPlainRecord(value) && Array.isArray(value.events);
}

function readContextObjectFromUnknown(value: unknown): ContextObject | null {
	if (!hasContextEvents(value)) {
		return null;
	}
	const record = value as Record<string, unknown> & {
		events: readonly unknown[];
	};
	const version = record.version;
	const id = record.id;
	return {
		...(record as Partial<ContextObject>),
		id: typeof id === "string" && id.trim() ? id : "context-object",
		version: typeof version === "string" ? version : "v5",
		events: [...(record.events as ContextEvent[])],
	};
}

export function extractContextObjectFromTrajectory(
	trajectory: unknown,
): ContextObject | null {
	if (!isPlainRecord(trajectory)) {
		return null;
	}

	const direct = readContextObjectFromUnknown(trajectory.contextObject);
	if (direct) return direct;

	const metadata = isPlainRecord(trajectory.metadata)
		? trajectory.metadata
		: undefined;
	if (metadata) {
		const fromMetadata = readContextObjectFromUnknown(metadata.contextObject);
		if (fromMetadata) return fromMetadata;
	}

	return null;
}

export function extractContextEventsFromTrajectory(
	trajectory: unknown,
): ContextEvent[] | null {
	const contextObject = extractContextObjectFromTrajectory(trajectory);
	if (contextObject) {
		return [...contextObject.events];
	}

	if (!isPlainRecord(trajectory)) {
		return null;
	}

	if (Array.isArray(trajectory.events)) {
		return [...(trajectory.events as ContextEvent[])];
	}

	const metadata = isPlainRecord(trajectory.metadata)
		? trajectory.metadata
		: undefined;
	if (metadata && Array.isArray(metadata.contextEvents)) {
		return [...(metadata.contextEvents as ContextEvent[])];
	}

	if (
		trajectory.contextObjectVersion === CONTEXT_OBJECT_TRAJECTORY_VERSION &&
		Array.isArray(trajectory.events)
	) {
		return [...(trajectory.events as ContextEvent[])];
	}

	return null;
}

export function buildContextObjectTrajectoryExport(
	input: ContextObjectTrajectoryExportInput,
): ContextObjectTrajectoryExport {
	const trajectory = input.trajectory;
	const contextObject =
		input.contextObject ?? extractContextObjectFromTrajectory(trajectory);
	const events =
		input.events ??
		contextObject?.events ??
		extractContextEventsFromTrajectory(trajectory) ??
		[];
	const metadata = sanitizeJsonObject({
		...(isPlainRecord(trajectory?.metadata) ? trajectory.metadata : {}),
		...(input.metadata ?? {}),
	});
	const metrics = sanitizeJsonObject(input.metrics ?? trajectory?.metrics);
	const source =
		input.source ??
		(typeof metadata?.source === "string" ? metadata.source : undefined);
	const contextObjectId =
		input.contextObjectId ??
		contextObject?.id ??
		(typeof metadata?.contextObjectId === "string"
			? metadata.contextObjectId
			: undefined);
	const createdAt =
		input.createdAt ??
		contextObject?.createdAt ??
		(typeof metadata?.createdAt === "number" ? metadata.createdAt : undefined);
	const sanitizedContextObject = contextObject
		? sanitizeJsonObject({
				...contextObject,
				events: [...events],
			})
		: undefined;

	const exportRecord: ContextObjectTrajectoryExport = {
		contextObjectVersion: CONTEXT_OBJECT_TRAJECTORY_VERSION,
		events: sanitizeJsonValue([...events]) as ContextEvent[],
	};

	const trajectoryId = input.trajectoryId ?? trajectory?.trajectoryId;
	const agentId = input.agentId ?? trajectory?.agentId;
	if (trajectoryId) exportRecord.trajectoryId = String(trajectoryId);
	if (agentId) exportRecord.agentId = String(agentId);
	if (contextObjectId) exportRecord.contextObjectId = contextObjectId;
	if (typeof createdAt === "number") exportRecord.createdAt = createdAt;
	if (source) exportRecord.source = source;
	if (metadata) exportRecord.metadata = metadata;
	if (metrics) exportRecord.metrics = metrics;
	if (sanitizedContextObject) {
		const existingId = sanitizedContextObject.id;
		const resolvedId =
			typeof existingId === "string" && existingId.trim()
				? existingId.trim()
				: (contextObject?.id ?? "context-object");
		exportRecord.contextObject = {
			...sanitizedContextObject,
			id: resolvedId,
		};
	}

	return exportRecord;
}

export function serializeContextObjectTrajectoryExport(
	input: ContextObjectTrajectoryExportInput,
	space?: number,
): string {
	return JSON.stringify(buildContextObjectTrajectoryExport(input), null, space);
}

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

type TrajectoryStepKindLike = "llm" | "action";

export type TrajectoryAnnotateParams = {
	stepId: string;
	kind?: TrajectoryStepKindLike;
	script?: string;
	childSteps?: string[];
	appendChildSteps?: string[];
	usedSkills?: string[];
	/**
	 * Per-skill invocation records to append to the step. Closes M13
	 * (W1-T5). Each record carries the (skillSlug, args, result,
	 * durationMs, parentStepId) shape produced by `captureSkillInvocationIO`.
	 * Implementations must append (not replace) so multiple skill invocations
	 * inside the same step accumulate.
	 */
	appendSkillInvocations?: TrajectorySkillInvocationRecord[];
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
	 * childSteps, usedSkills) without depending directly on @elizaos/agent.
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
const LLM_INPUT_SUBSTRING_ATTESTATION_CONTEXT_MANAGER_KEY = Symbol.for(
	"elizaos.llmInputSubstringAttestationContextManager",
);

type TrajectoryContextWithLlmGuard = {
	[RECORD_LLM_CALL_DEPTH_KEY]?: number;
};

function isNodeEnvironment(): boolean {
	return (
		typeof process !== "undefined" &&
		typeof process.versions !== "undefined" &&
		typeof process.versions.node !== "undefined"
	);
}

function supportsAsyncLocalStorage(): boolean {
	return isNodeEnvironment() && typeof process.getBuiltinModule === "function";
}

function createLlmInputSubstringAttestationContextManager(): LlmInputSubstringAttestationContextManager {
	if (!supportsAsyncLocalStorage()) {
		throw new ElizaError(
			"LLM input attestation requires AsyncLocalStorage isolation",
			{
				code: "LLM_INPUT_SUBSTRING_ATTESTATION_UNSUPPORTED_RUNTIME",
				severity: "fatal",
			},
		);
	}
	const { AsyncLocalStorage } = process.getBuiltinModule(
		"node:async_hooks",
	) as typeof import("node:async_hooks");
	const storage = new AsyncLocalStorage<
		LlmInputSubstringAttestationStore | undefined
	>();
	return {
		run<T>(
			store: LlmInputSubstringAttestationStore | undefined,
			fn: () => T | Promise<T>,
		): T | Promise<T> {
			return storage.run(store, fn);
		},
		active(): LlmInputSubstringAttestationStore | undefined {
			return storage.getStore();
		},
	};
}

function getLlmInputSubstringAttestationContextManager(): LlmInputSubstringAttestationContextManager {
	return getAmbientSingleton(
		LLM_INPUT_SUBSTRING_ATTESTATION_CONTEXT_MANAGER_KEY,
		createLlmInputSubstringAttestationContextManager,
	);
}

function sha256Text(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function countExactSubstring(haystack: string, needle: string): number {
	let count = 0;
	let cursor = 0;
	while (cursor <= haystack.length - needle.length) {
		const index = haystack.indexOf(needle, cursor);
		if (index < 0) break;
		count += 1;
		cursor = index + 1;
	}
	return count;
}

function collectMessageContentStrings(
	value: unknown,
	output: string[],
	seen = new WeakSet<object>(),
): void {
	if (typeof value === "string") {
		output.push(value);
		return;
	}
	if (!value || typeof value !== "object") return;
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
	if (seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			collectMessageContentStrings(item, output, seen);
		}
		seen.delete(value);
		return;
	}
	for (const nested of Object.values(value as Record<string, unknown>)) {
		collectMessageContentStrings(nested, output, seen);
	}
	seen.delete(value);
}

function modelInputSurfaces(details: RecordLlmCallDetails): string[] {
	const surfaces: string[] = [];
	if (typeof details.systemPrompt === "string") {
		surfaces.push(details.systemPrompt);
	}
	if (Array.isArray(details.messages) && details.messages.length > 0) {
		for (const message of details.messages) {
			if (typeof message === "string") {
				surfaces.push(message);
				continue;
			}
			if (!message || typeof message !== "object" || Array.isArray(message)) {
				continue;
			}
			collectMessageContentStrings(
				(message as Record<string, unknown>).content,
				surfaces,
			);
		}
		return surfaces;
	}
	// `userPrompt` is a trajectory compatibility alias for the provider's
	// `prompt`. Prefer the final native prompt so one wire input is counted once.
	if (typeof details.prompt === "string") {
		surfaces.push(details.prompt);
	} else if (typeof details.userPrompt === "string") {
		surfaces.push(details.userPrompt);
	}
	return surfaces;
}

/**
 * Verify one final provider attempt against the active request scope.
 *
 * Provider retry loops call this before every transport attempt with the same
 * details object. Every attempt is rechecked, while the returned summary counts
 * that stable object once so its model-call totals retain logical-call parity
 * with usage telemetry.
 */
export function attestLlmInputSubstring(details: RecordLlmCallDetails): void {
	// Attestation is an opt-in Node/Bun server capability. Ordinary browser/edge
	// model calls do not initialize a request-scope manager.
	if (!supportsAsyncLocalStorage()) return;
	const store = getLlmInputSubstringAttestationContextManager().active();
	if (!store) return;

	const occurrences = modelInputSurfaces(details).reduce(
		(total, surface) =>
			total + countExactSubstring(surface, store.expectedText),
		0,
	);
	const modelType =
		typeof details.modelType === "string" && details.modelType.trim()
			? details.modelType.trim()
			: "unknown";
	const isFirstAttempt = !store.seenLogicalCalls.has(details);
	if (isFirstAttempt) {
		store.seenLogicalCalls.add(details);
		store.modelCallCount += 1;
		store.totalOccurrences += occurrences;
		store.modelTypeCallCounts.set(
			modelType,
			(store.modelTypeCallCounts.get(modelType) ?? 0) + 1,
		);
		if (occurrences === 1) {
			store.matchingCallCount += 1;
		}
	}
	if (occurrences === 1) return;

	throw new ElizaError(
		"Final LLM input failed request-scoped instruction attestation",
		{
			code: "LLM_INPUT_SUBSTRING_ATTESTATION_MISMATCH",
			context: {
				expectedSha256: store.expectedSha256,
				modelCallNumber: store.modelCallCount,
				modelType,
				occurrences,
				retryAttempt: !isFirstAttempt,
			},
			severity: "fatal",
		},
	);
}

/**
 * Run one request under exact final-model-input attestation.
 *
 * Each nested {@link recordLlmCall} must carry the expected text exactly once
 * across its actual wire-bearing system/messages or system/prompt surfaces.
 * A mismatch throws before the provider callback runs, and a request that
 * reaches no model boundary fails when the scope closes.
 */
export async function runWithLlmInputSubstringAttestation<T>(
	expectedText: string,
	fn: () => Promise<T> | T,
): Promise<{ result: T; attestation: LlmInputSubstringAttestation }> {
	if (!supportsAsyncLocalStorage()) {
		throw new ElizaError(
			"LLM input attestation requires AsyncLocalStorage isolation",
			{
				code: "LLM_INPUT_SUBSTRING_ATTESTATION_UNSUPPORTED_RUNTIME",
				severity: "fatal",
			},
		);
	}
	if (!expectedText) {
		throw new ElizaError(
			"LLM input attestation requires a non-empty expected instruction",
			{
				code: "LLM_INPUT_SUBSTRING_ATTESTATION_INVALID",
				severity: "fatal",
			},
		);
	}
	const store: LlmInputSubstringAttestationStore = {
		expectedText,
		expectedSha256: sha256Text(expectedText),
		modelCallCount: 0,
		matchingCallCount: 0,
		totalOccurrences: 0,
		modelTypeCallCounts: new Map<string, number>(),
		seenLogicalCalls: new WeakSet<RecordLlmCallDetails>(),
	};
	const result = await getLlmInputSubstringAttestationContextManager().run(
		store,
		fn,
	);
	if (store.modelCallCount === 0) {
		throw new ElizaError(
			"Request completed without reaching an attested LLM input boundary",
			{
				code: "LLM_INPUT_SUBSTRING_ATTESTATION_MISSING",
				context: { expectedSha256: store.expectedSha256 },
				severity: "fatal",
			},
		);
	}
	return {
		result,
		attestation: {
			schemaVersion: 1,
			expectedSha256: store.expectedSha256,
			modelCallCount: store.modelCallCount,
			matchingCallCount: store.matchingCallCount,
			totalOccurrences: store.totalOccurrences,
			exactOncePerModelCall:
				store.matchingCallCount === store.modelCallCount &&
				store.totalOccurrences === store.modelCallCount,
			modelTypeCallCounts: Object.fromEntries(
				[...store.modelTypeCallCounts.entries()].sort(([left], [right]) =>
					left.localeCompare(right),
				),
			),
		},
	};
}

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

export function isTrajectoryStrictModeEnabled(): boolean {
	return isTruthyEnvValue(readProcessEnv("ELIZA_TRAJECTORY_STRICT"));
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
		isTextGenerationModelType(normalized) ||
		normalized.startsWith("OBJECT_") ||
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
 * Strict-mode assertion for any generative LLM call. In normal mode this
 * returns immediately. With `ELIZA_TRAJECTORY_STRICT=1`, it throws unless a
 * trajectory step is active.
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
		return fn();
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
		return callback();
	}

	const trajectoryLogger = resolveTrajectoryLogger(runtime);
	if (
		!trajectoryLogger ||
		typeof trajectoryLogger.startTrajectory !== "function" ||
		typeof trajectoryLogger.endTrajectory !== "function" ||
		(typeof trajectoryLogger.isEnabled === "function" &&
			!trajectoryLogger.isEnabled())
	) {
		return callback();
	}

	const trajectoryId = String(
		await trajectoryLogger.startTrajectory(runtime.agentId, {
			source: options.source,
			metadata: options.metadata,
		}),
	).trim();
	if (!trajectoryId) {
		return callback();
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
 * `ELIZA_TRAJECTORY_STRICT=1`, this throws before calling `fn` unless a
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
	// The attestation scope is opt-in and request-local. When active, this is
	// the last generic boundary before the raw provider callback can spend quota.
	attestLlmInputSubstring(details);

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
		return JSON.stringify({ response: value });
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
		return fn();
	}

	const parentCtx = getTrajectoryContext();
	const parentStepId = parentCtx?.trajectoryStepId;
	if (!(typeof parentStepId === "string" && parentStepId.trim() !== "")) {
		return fn();
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
		return fn();
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
		...parentCtx,
		trajectoryId,
		trajectoryStepId: childStepId,
		parentStepId,
		purpose: options.purpose,
	};

	try {
		return await runWithTrajectoryContext(childContext, () => fn());
	} finally {
		if (
			trajectoryId &&
			typeof trajectoryLogger.flushWriteQueue === "function"
		) {
			try {
				await trajectoryLogger.flushWriteQueue(trajectoryId);
			} catch {
				// Trajectory flushing must never break the host flow.
			}
		}
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
 * Same as {@link withActionStep} but for evaluator turns. Closes M14:
 * every evaluator invocation emits a child trajectory step whose model
 * call(s) attach to it. The child step's `kind` is set to `"evaluator"`
 * downstream by the agent persistence layer when the LLM call carries
 * `purpose === "evaluation"` (see `appendLlmCall`).
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
			purpose: "evaluation",
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
	return fn(handle);
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

function getRegistry(): Map<string, TrajectorySourceMeta> {
	return getAmbientSingleton(
		TRAJECTORY_SOURCE_REGISTRY_KEY,
		() => new Map<string, TrajectorySourceMeta>(),
	);
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
