/**
 * Evaluator stage of the planner loop: renders the evaluator model input, runs
 * the evaluator model call, and parses/repairs/sanitizes its structured
 * decision (FINISH / CONTINUE / NEXT_RECOMMENDED) before the loop acts on it.
 * Also records each evaluation as a trajectory stage for offline review.
 */
import { ElizaError } from "../errors";
import { computeCallCostUsd } from "../features/trajectories/pricing";
import { evaluatorSchema, evaluatorTemplate } from "../prompts/evaluator";
import {
	composeToolDiagnosticRedactor,
	projectToolDiagnosticValue,
	type ToolDiagnosticTextRedactor,
} from "../security/tool-diagnostics";
import {
	emitStreamingHook,
	getStreamingContext,
	runWithStreamingContext,
} from "../streaming-context";
import type { EvaluationResult } from "../types/components";
import {
	type ChatMessage,
	getModelFallbackChain,
	type ModelAttemptContext,
	type ModelRegistrationMetadata,
	ModelType,
	type PromptSegment,
} from "../types/model";
import {
	isModelProviderError,
	modelProviderErrorDetail,
} from "../utils/model-errors";
import { stripReasoningPrefixes } from "../utils/reasoning-tags";
import { resolveSetting } from "../utils/resolve-setting";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../utils/well-formed.js";
import { computePrefixHashes } from "./context-hash";
import {
	buildStageChatMessages,
	normalizePromptSegments,
	renderContextObject,
} from "./context-renderer";
import {
	containsToolCallShapedMarkup,
	extractJsonObjects,
	parseJsonObject,
} from "./json-output";
import { DEFAULT_MAX_KEPT_STEP_CHARS } from "./limits";
import {
	buildModelInputBudget,
	DEFAULT_COMPACTION_RESERVE_TOKENS,
	MODEL_WINDOW_RESERVE_FRACTION,
	withModelInputBudgetProviderOptions,
} from "./model-input-budget";
import {
	cacheProviderOptions,
	trajectoryStepsToMessages,
} from "./planner-rendering";
import type {
	ContextObject,
	EvaluatorEffects,
	EvaluatorModelResult,
	EvaluatorOutput,
	EvaluatorRoute,
	EvaluatorRuntime,
	PlannerToolCall,
	PlannerTrajectory,
	RunEvaluatorParams,
} from "./planner-types";
import type {
	RecordedStage,
	RecordedUsage,
	TrajectoryRecorder,
} from "./trajectory-recorder";

export type {
	EvaluatorEffects,
	EvaluatorOutput,
	EvaluatorRoute,
	EvaluatorRuntime,
	RunEvaluatorParams,
} from "./planner-types";

interface RawEvaluatorOutput {
	success?: unknown;
	decision?: unknown;
	route?: unknown;
	thought?: unknown;
	nextTool?: unknown;
	nextRecommendedTool?: unknown;
	messageToUser?: unknown;
	copyToClipboard?: unknown;
	recommendedToolCallId?: unknown;
}

interface ParsedEvaluatorObject {
	object: RawEvaluatorOutput | null;
	parseError?: string;
}

const EVALUATOR_ENVELOPE_KEYS = new Set([
	"success",
	"decision",
	"route",
	"thought",
	"nextTool",
	"nextRecommendedTool",
	"messageToUser",
	"copyToClipboard",
	"recommendedToolCallId",
]);

/**
 * Base completion budget for the evaluator envelope. Raised from 1024 after a
 * live incident (sol-dev 2026-08-17): fable completions hitting exactly 1024
 * truncated the JSON envelope mid-string, the parse failed with "unparseable
 * output", and the planner burned 1-2 extra full-prompt rounds per affected
 * turn recovering. Observed envelopes are 100-450 tokens; 2048 gives 4x
 * headroom while the single doubled retry below covers pathological ramblers.
 */
const DEFAULT_EVALUATOR_MAX_TOKENS = 2048;

/**
 * Whether an evaluator model result was cut off by the completion-token cap:
 * the provider's finish reason names a length/token limit, or the reported
 * completion usage reached the requested cap. String results carry no
 * finish/usage metadata and are never treated as truncated. Exported for
 * regression coverage of the single-retry truncation guard.
 */
export function evaluatorHitCompletionLimit(
	raw: EvaluatorModelResult,
	maxTokens: number,
): boolean {
	if (typeof raw === "string") return false;
	const finishReason = raw.finishReason?.toLowerCase() ?? "";
	if (
		/(?:^|[^a-z0-9])(?:length|max(?:imum)?(?:[-_\s]completion)?[-_\s]?tokens?|token[-_\s]?limit|output[-_\s]?limit)(?:$|[^a-z0-9])/u.test(
			finishReason,
		)
	) {
		return true;
	}
	return (
		typeof raw.usage?.completionTokens === "number" &&
		Number.isFinite(raw.usage.completionTokens) &&
		raw.usage.completionTokens >= maxTokens
	);
}

type EvaluatorBudgetResolution = {
	contextWindowTokens?: number;
	modelNames: string[];
	unknownReachableModel: boolean;
};

type PreparedEvaluatorAttempt = {
	input: ReturnType<typeof renderEvaluatorModelInput>;
	providerOptions: Record<string, unknown>;
	prefixHashes: ReturnType<typeof computePrefixHashes>;
	prefixHash: string;
	provider: string | undefined;
};

type EvaluatorModelCall = {
	raw: Awaited<ReturnType<EvaluatorRuntime["useModel"]>>;
	preparedAttempt?: PreparedEvaluatorAttempt;
	startedAt: number;
	endedAt: number;
};

function modelNameFromMetadata(
	runtime: EvaluatorRuntime,
	metadata: ModelRegistrationMetadata | undefined,
): string | undefined {
	if (!metadata) return undefined;
	if (
		typeof metadata.displayModel === "string" &&
		metadata.displayModel.trim()
	) {
		return metadata.displayModel.trim();
	}
	for (const setting of [
		...(metadata.displayModelSettings ?? []),
		metadata.displayModelSetting,
	]) {
		if (!setting) continue;
		const value = resolveSetting(
			runtime.getSetting
				? {
						getSetting: (key: string) => runtime.getSetting?.(key) ?? null,
					}
				: undefined,
			setting,
		);
		if (value?.trim()) return value.trim();
	}
	if (
		typeof metadata.displayModelDefault === "string" &&
		metadata.displayModelDefault.trim()
	) {
		return metadata.displayModelDefault.trim();
	}
	return undefined;
}

function resolveEvaluatorBudget(
	runtime: EvaluatorRuntime,
	modelType: string,
	provider: string | undefined,
): EvaluatorBudgetResolution {
	const registrations = runtime.getModelRegistrations?.() ?? [];
	if (registrations.length === 0) {
		return { modelNames: [], unknownReachableModel: false };
	}
	const fallbackChain = getModelFallbackChain(modelType as never);
	const reachableTypes = new Set(fallbackChain);
	const candidates = registrations
		.filter(
			(registration) =>
				reachableTypes.has(registration.modelType) &&
				(provider === undefined || registration.provider === provider),
		)
		.sort(
			(a, b) =>
				fallbackChain.indexOf(a.modelType) - fallbackChain.indexOf(b.modelType),
		);
	if (candidates.length === 0) {
		return { modelNames: [], unknownReachableModel: false };
	}
	const modelNames: string[] = [];
	const windows: number[] = [];
	let unknownReachableModel = false;
	for (const registration of candidates) {
		const modelName = modelNameFromMetadata(runtime, registration.metadata);
		if (!modelName) {
			unknownReachableModel = true;
			windows.push(128_000);
			continue;
		}
		modelNames.push(modelName);
		const budget = buildModelInputBudget({ modelName });
		if (budget.resolvedModelKey === null) {
			unknownReachableModel = true;
		}
		windows.push(budget.contextWindowTokens);
	}
	return {
		contextWindowTokens: windows.length > 0 ? windows[0] : undefined,
		modelNames,
		unknownReachableModel,
	};
}

function evaluatorBudgetOptions(
	contextWindowTokens: number,
	minOutputReserveTokens = DEFAULT_EVALUATOR_MAX_TOKENS,
): {
	contextWindowTokens: number;
	reserveTokens: number;
} {
	const desiredReserve = Math.max(
		DEFAULT_COMPACTION_RESERVE_TOKENS,
		Math.floor(contextWindowTokens * MODEL_WINDOW_RESERVE_FRACTION),
		minOutputReserveTokens,
	);
	// Custom/local model windows can be smaller than the global 10k reserve.
	// Keep enough room for input and the requested evaluator output instead of
	// turning such models into an unconditional one-token bottom-out.
	const smallWindowCap = Math.max(
		minOutputReserveTokens,
		Math.floor(contextWindowTokens * 0.4),
	);
	return {
		contextWindowTokens,
		reserveTokens: Math.min(
			Math.max(0, contextWindowTokens - 1),
			desiredReserve,
			smallWindowCap,
		),
	};
}

function structuredParameterChars(messages: readonly ChatMessage[]): number {
	return messages.reduce((total, message) => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			return total;
		}
		return (
			total +
			message.content.reduce((messageTotal, part) => {
				if (part.type !== "tool-call") return messageTotal;
				return messageTotal + JSON.stringify(part.input ?? {}).length;
			}, 0)
		);
	}, 0);
}

function finalizeEvaluatorOutput(
	raw: EvaluatorModelResult,
	context: ContextObject,
	trajectory: PlannerTrajectory,
): EvaluatorOutput {
	return sanitizeOutputMessage(
		repairFinishWithUnservedDeclaredIntents(
			repairFinishWithProgressPromise(
				repairFinishedToolTurnWithoutUserMessage(
					repairMissingEvaluatorMessage(
						repairMissingEvaluatorSuccess(
							rejectEvaluatorInvocationMessage(
								recoverEvaluatorTextOutput(
									parseEvaluatorOutput(raw),
									raw,
									trajectory,
								),
							),
							trajectory,
						),
						context,
						trajectory,
					),
					trajectory,
				),
				trajectory,
			),
			context,
			trajectory,
		),
	);
}

export async function runEvaluator(
	params: RunEvaluatorParams,
): Promise<EvaluatorOutput> {
	const streamingContext = getStreamingContext();
	const modelType = params.modelType ?? ModelType.RESPONSE_HANDLER;
	const startedAt = Date.now();
	const budgetResolution = resolveEvaluatorBudget(
		params.runtime,
		String(modelType),
		params.provider,
	);
	const redactDiagnosticText = composeToolDiagnosticRedactor(params.runtime);
	const EVALUATOR_MIN_TOOL_RESULT_CHARS = 2_000;
	let toolResultCap = DEFAULT_MAX_KEPT_STEP_CHARS;
	let renderedInput = renderEvaluatorModelInput({
		context: params.context,
		trajectory: params.trajectory,
		maxToolResultChars: undefined,
		redactText: redactDiagnosticText,
	});
	let modelInputBudget = buildModelInputBudget({
		messages: renderedInput.messages,
		promptSegments: renderedInput.promptSegments,
		...(budgetResolution.contextWindowTokens
			? evaluatorBudgetOptions(budgetResolution.contextWindowTokens)
			: {}),
	});
	// Degrade, don't fail: when the assembled input would exceed the window
	// (threshold = window - output reserve), shrink only the rendered tool
	// results and re-estimate. Stable/context segments (system instructions,
	// current user message) are never modified or dropped. Bounded: 30k -> 7.5k
	// -> 2k. Live incident 2026-08: one oversized tool result rendered verbatim
	// pushed the evaluator call to 2.28M tokens and the provider hard-400'd the
	// whole turn with context_length_exceeded instead of answering.
	while (
		modelInputBudget.shouldCompact &&
		toolResultCap > EVALUATOR_MIN_TOOL_RESULT_CHARS
	) {
		toolResultCap = Math.max(
			EVALUATOR_MIN_TOOL_RESULT_CHARS,
			Math.floor(toolResultCap / 4),
		);
		renderedInput = renderEvaluatorModelInput({
			context: params.context,
			trajectory: params.trajectory,
			maxToolResultChars: toolResultCap,
			redactText: redactDiagnosticText,
		});
		modelInputBudget = buildModelInputBudget({
			messages: renderedInput.messages,
			promptSegments: renderedInput.promptSegments,
			...(budgetResolution.contextWindowTokens
				? evaluatorBudgetOptions(budgetResolution.contextWindowTokens)
				: {}),
		});
	}
	const buildAttemptProviderOptions = (
		input: ReturnType<typeof renderEvaluatorModelInput>,
		budget: ReturnType<typeof buildModelInputBudget>,
		provider: string | undefined,
	): {
		providerOptions: Record<string, unknown>;
		prefixHashes: ReturnType<typeof computePrefixHashes>;
		prefixHash: string;
	} => {
		const prefixHashes = computePrefixHashes(input.promptSegments);
		const prefixHash =
			computePrefixHashes(input.cacheKeySegments).at(-1)?.hash ??
			"no-context-segments";
		const providerOptions = withModelInputBudgetProviderOptions(
			cacheProviderOptions({
				prefixHash,
				segmentHashes: prefixHashes.map((entry) => entry.segmentHash),
				promptSegments: input.promptSegments,
				provider,
				conversationId: params.trajectoryId,
			}),
			budget,
		) as Record<string, unknown> & { eliza?: Record<string, unknown> };
		providerOptions.eliza = {
			...(providerOptions.eliza ?? {}),
			thinking: "off",
		};
		return { providerOptions, prefixHashes, prefixHash };
	};
	const initialAttempt = buildAttemptProviderOptions(
		renderedInput,
		modelInputBudget,
		params.provider,
	);
	const providerOptions = initialAttempt.providerOptions;
	const prefixHashes = initialAttempt.prefixHashes;
	const prefixHash = initialAttempt.prefixHash;

	// Authoritative request snapshot for the most recently prepared failover
	// attempt. `prepareModelAttempt` rerenders per registration, so the outer
	// preflight snapshot can differ from what the selected handler actually
	// received; stage recording below must persist this snapshot when present
	// so the trajectory reports the real model input (and, on a terminal
	// budget rejection, the last input that failed to fit).
	let preparedAttempt: PreparedEvaluatorAttempt | undefined;

	const buildInputBudgetError = (args: {
		input: ReturnType<typeof renderEvaluatorModelInput>;
		budget: ReturnType<typeof buildModelInputBudget>;
		toolResultCap: number;
		resolvedModelNames: string[];
		unknownReachableModel: boolean;
	}): ElizaError =>
		new ElizaError(
			"Evaluator model input exceeds the context budget even after tool results were compacted to the floor",
			{
				code: "EVALUATOR_INPUT_OVER_BUDGET",
				context: {
					estimatedInputTokens: args.budget.estimatedInputTokens,
					compactionThresholdTokens: args.budget.compactionThresholdTokens,
					contextWindowTokens: args.budget.contextWindowTokens,
					toolResultCap: args.toolResultCap,
					structuredParameterChars: structuredParameterChars(
						args.input.messages,
					),
					resolvedModelNames: args.resolvedModelNames,
					unknownReachableModel: args.unknownReachableModel,
				},
			},
		);

	const recordInputBudgetFailure = async (args: {
		error: ElizaError;
		input: ReturnType<typeof renderEvaluatorModelInput>;
		provider: string | undefined;
		providerOptions: Record<string, unknown>;
		attempt?: number;
		failureStartedAt?: number;
	}): Promise<void> => {
		const failurePrefixHashes = computePrefixHashes(args.input.promptSegments);
		await recordEvaluationStage({
			runtime: params.runtime,
			recorder: params.recorder,
			trajectoryId: params.trajectoryId,
			parentStageId: params.parentStageId,
			iteration: params.iteration ?? 1,
			attempt: args.attempt,
			modelType: String(modelType),
			provider: args.provider,
			messages: args.input.messages,
			providerOptions: args.providerOptions,
			raw: `[evaluator input budget failure] ${args.error.message} | code: EVALUATOR_INPUT_OVER_BUDGET`,
			output: {
				success: false,
				decision: "CONTINUE",
				thought:
					"Evaluator input exceeded the resolved model budget before provider call.",
				protocolFailure: true,
				raw: { code: "EVALUATOR_INPUT_OVER_BUDGET" },
			},
			startedAt: args.failureStartedAt ?? startedAt,
			endedAt: Date.now(),
			segmentHashes: failurePrefixHashes.map((entry) => entry.segmentHash),
			prefixHash:
				computePrefixHashes(args.input.cacheKeySegments).at(-1)?.hash ??
				"no-context-segments",
			logger: params.runtime.logger,
		});
	};

	const prepareModelAttempt = async (
		attempt: ModelAttemptContext,
		request: {
			messages: ChatMessage[];
			promptSegments?: PromptSegment[];
			providerOptions?: Record<string, unknown>;
		},
		maxOutputTokens = DEFAULT_EVALUATOR_MAX_TOKENS,
	): Promise<void> => {
		const modelName = modelNameFromMetadata(params.runtime, attempt.metadata);
		const resolvedBudget = buildModelInputBudget({ modelName });
		const attemptWindow = resolvedBudget.contextWindowTokens;
		let attemptCap = DEFAULT_MAX_KEPT_STEP_CHARS;
		let attemptInput = renderEvaluatorModelInput({
			context: params.context,
			trajectory: params.trajectory,
			maxToolResultChars: undefined,
			redactText: redactDiagnosticText,
		});
		let attemptBudget = buildModelInputBudget({
			messages: attemptInput.messages,
			promptSegments: attemptInput.promptSegments,
			...evaluatorBudgetOptions(attemptWindow, maxOutputTokens),
		});
		while (
			attemptBudget.shouldCompact &&
			attemptCap > EVALUATOR_MIN_TOOL_RESULT_CHARS
		) {
			attemptCap = Math.max(
				EVALUATOR_MIN_TOOL_RESULT_CHARS,
				Math.floor(attemptCap / 4),
			);
			attemptInput = renderEvaluatorModelInput({
				context: params.context,
				trajectory: params.trajectory,
				maxToolResultChars: attemptCap,
				redactText: redactDiagnosticText,
			});
			attemptBudget = buildModelInputBudget({
				messages: attemptInput.messages,
				promptSegments: attemptInput.promptSegments,
				...evaluatorBudgetOptions(attemptWindow, maxOutputTokens),
			});
		}
		const attemptOptions = buildAttemptProviderOptions(
			attemptInput,
			attemptBudget,
			attempt.provider,
		);
		preparedAttempt = {
			input: attemptInput,
			providerOptions: attemptOptions.providerOptions,
			prefixHashes: attemptOptions.prefixHashes,
			prefixHash: attemptOptions.prefixHash,
			provider: attempt.provider,
		};
		if (attemptBudget.shouldCompact) {
			// Attempt-local rejection: this registration's window cannot fit the
			// stable input even at the tool-result floor. The runtime treats a
			// preparation throw as a skip and advances to the next registration;
			// the stage is recorded only if the rejection turns out terminal
			// (see the EVALUATOR_INPUT_OVER_BUDGET branch in the catch below).
			throw buildInputBudgetError({
				input: attemptInput,
				budget: attemptBudget,
				toolResultCap: attemptCap,
				resolvedModelNames: modelName ? [modelName] : [],
				unknownReachableModel: resolvedBudget.resolvedModelKey === null,
			});
		}
		request.messages = attemptInput.messages;
		request.promptSegments = attemptInput.promptSegments;
		request.providerOptions = attemptOptions.providerOptions;
	};
	// Bottom-out guard: if the input is still over the compaction threshold at
	// the 2k floor, the overflow lives in the stable/context segments this loop
	// deliberately never touches. Calling the provider anyway is a guaranteed
	// context_length_exceeded 400 that burns a round trip and surfaces as an
	// opaque provider error — fail fast with a typed error instead so the
	// planner-loop's degrade/propagate policy sees the real cause.
	if (
		modelInputBudget.shouldCompact &&
		params.runtime.supportsModelAttemptPreparation !== true
	) {
		const preflightError = buildInputBudgetError({
			input: renderedInput,
			budget: modelInputBudget,
			toolResultCap,
			resolvedModelNames: budgetResolution.modelNames,
			unknownReachableModel: budgetResolution.unknownReachableModel,
		});
		await recordInputBudgetFailure({
			error: preflightError,
			input: renderedInput,
			provider: params.provider,
			providerOptions,
		});
		throw preflightError;
	}
	let raw: Awaited<ReturnType<EvaluatorRuntime["useModel"]>>;
	let selectedCall: EvaluatorModelCall | undefined;
	let activeCallStartedAt = startedAt;
	let activeAttempt: number | undefined;
	let initialCallRecorded = false;
	let fellBackToInitialCall = false;
	try {
		const callEvaluatorModel = async (
			maxTokens: number,
		): Promise<EvaluatorModelCall> => {
			preparedAttempt = undefined;
			const callStartedAt = Date.now();
			activeCallStartedAt = callStartedAt;
			let callInput = renderedInput;
			let callProviderOptions = providerOptions;
			if (
				maxTokens > DEFAULT_EVALUATOR_MAX_TOKENS &&
				params.runtime.supportsModelAttemptPreparation !== true &&
				budgetResolution.contextWindowTokens
			) {
				let retryToolResultCap = toolResultCap;
				let retryBudget = buildModelInputBudget({
					messages: callInput.messages,
					promptSegments: callInput.promptSegments,
					...evaluatorBudgetOptions(
						budgetResolution.contextWindowTokens,
						maxTokens,
					),
				});
				while (
					retryBudget.shouldCompact &&
					retryToolResultCap > EVALUATOR_MIN_TOOL_RESULT_CHARS
				) {
					retryToolResultCap = Math.max(
						EVALUATOR_MIN_TOOL_RESULT_CHARS,
						Math.floor(retryToolResultCap / 4),
					);
					callInput = renderEvaluatorModelInput({
						context: params.context,
						trajectory: params.trajectory,
						maxToolResultChars: retryToolResultCap,
						redactText: redactDiagnosticText,
					});
					retryBudget = buildModelInputBudget({
						messages: callInput.messages,
						promptSegments: callInput.promptSegments,
						...evaluatorBudgetOptions(
							budgetResolution.contextWindowTokens,
							maxTokens,
						),
					});
				}
				const retryOptions = buildAttemptProviderOptions(
					callInput,
					retryBudget,
					params.provider,
				);
				callProviderOptions = retryOptions.providerOptions;
				preparedAttempt = {
					input: callInput,
					providerOptions: callProviderOptions,
					prefixHashes: retryOptions.prefixHashes,
					prefixHash: retryOptions.prefixHash,
					provider: params.provider,
				};
				if (retryBudget.shouldCompact) {
					throw buildInputBudgetError({
						input: callInput,
						budget: retryBudget,
						toolResultCap: retryToolResultCap,
						resolvedModelNames: budgetResolution.modelNames,
						unknownReachableModel: budgetResolution.unknownReachableModel,
					});
				}
			}
			const callRaw = await runWithStreamingContext(
				streamingContext
					? {
							...streamingContext,
							onStreamChunk: async () => undefined,
						}
					: undefined,
				() => {
					const modelRequest = {
						messages: callInput.messages,
						maxTokens,
						responseSchema: evaluatorSchema,
						promptSegments: callInput.promptSegments,
						providerOptions: callProviderOptions,
						prepareModelAttempt: (
							attempt: ModelAttemptContext,
							attemptParams: {
								messages: ChatMessage[];
								promptSegments?: PromptSegment[];
								providerOptions?: Record<string, unknown>;
							},
						) => prepareModelAttempt(attempt, attemptParams, maxTokens),
					};
					return params.runtime.useModel(
						modelType,
						modelRequest,
						params.provider,
					);
				},
			);
			return {
				raw: callRaw,
				preparedAttempt,
				startedAt: callStartedAt,
				endedAt: Date.now(),
			};
		};
		const recordCompletedCall = async (
			call: EvaluatorModelCall,
			output: EvaluatorOutput,
			attempt?: number,
		): Promise<void> => {
			const snapshot = call.preparedAttempt;
			await recordEvaluationStage({
				runtime: params.runtime,
				recorder: params.recorder,
				trajectoryId: params.trajectoryId,
				parentStageId: params.parentStageId,
				iteration: params.iteration ?? 1,
				attempt,
				modelType: String(modelType),
				provider: snapshot?.provider ?? params.provider,
				messages: (snapshot?.input ?? renderedInput).messages,
				providerOptions: snapshot?.providerOptions ?? providerOptions,
				raw: call.raw,
				output,
				startedAt: attempt === undefined ? startedAt : call.startedAt,
				endedAt: call.endedAt,
				segmentHashes: (snapshot?.prefixHashes ?? prefixHashes).map(
					(entry) => entry.segmentHash,
				),
				prefixHash: snapshot?.prefixHash ?? prefixHash,
				logger: params.runtime.logger,
			});
		};
		activeAttempt = undefined;
		const initialCall = await callEvaluatorModel(DEFAULT_EVALUATOR_MAX_TOKENS);
		selectedCall = initialCall;
		raw = initialCall.raw;
		reportEvaluatorUsage(raw, params.onUsage);
		// Truncation guard: a completion cut off at the cap yields an unparseable
		// envelope, and each unparseable evaluation costs the planner a full extra
		// replan round (live sol-dev 2026-08-17: 1024-cap truncations chained into
		// 30-117s turns). Retry exactly ONCE with a doubled budget — never loop —
		// and only when the truncated output actually failed to parse; a result
		// that happens to be both complete-and-parseable at the cap stands.
		if (
			evaluatorHitCompletionLimit(raw, DEFAULT_EVALUATOR_MAX_TOKENS) &&
			parseEvaluatorOutput(raw).protocolFailure === true
		) {
			const retryMaxTokens = DEFAULT_EVALUATOR_MAX_TOKENS * 2;
			// A retry is a second billable model call. Persist the truncated first
			// attempt before starting it so trajectories retain every request,
			// response, usage record, and provider selection even if the retry fails.
			await recordCompletedCall(
				initialCall,
				finalizeEvaluatorOutput(raw, params.context, params.trajectory),
				1,
			);
			initialCallRecorded = true;
			params.runtime.logger?.warn?.(
				{
					modelType: String(modelType),
					maxTokens: DEFAULT_EVALUATOR_MAX_TOKENS,
					retryMaxTokens,
				},
				"[evaluator] completion truncated at token cap and unparseable; retrying once with a doubled cap",
			);
			try {
				activeAttempt = 2;
				const retryCall = await callEvaluatorModel(retryMaxTokens);
				reportEvaluatorUsage(retryCall.raw, params.onUsage);
				selectedCall = retryCall;
				raw = retryCall.raw;
				if (evaluatorHitCompletionLimit(raw, retryMaxTokens)) {
					params.runtime.logger?.warn?.(
						{ modelType: String(modelType), retryMaxTokens },
						"[evaluator] retry completion still truncated; proceeding with parse-recovery (no further retries)",
					);
				}
			} catch (retryError) {
				// error-policy:J4 The retry is an optional recovery attempt. Preserve
				// the original truncated response so the established protocol-failure
				// path can request another planner round for expected provider or
				// retry-budget failures; programmer failures still propagate.
				const retryBudgetError =
					retryError instanceof ElizaError &&
					retryError.code === "EVALUATOR_INPUT_OVER_BUDGET";
				if (!retryBudgetError && !isModelProviderError(retryError)) {
					throw retryError;
				}
				const retrySnapshot = preparedAttempt;
				const retryDetail = retryBudgetError
					? undefined
					: modelProviderErrorDetail(retryError);
				if (retryBudgetError) {
					await recordInputBudgetFailure({
						error: retryError,
						input: retrySnapshot?.input ?? renderedInput,
						provider: retrySnapshot?.provider ?? params.provider,
						providerOptions: retrySnapshot?.providerOptions ?? providerOptions,
						attempt: 2,
						failureStartedAt: activeCallStartedAt,
					});
				} else {
					await recordEvaluationStage({
						runtime: params.runtime,
						recorder: params.recorder,
						trajectoryId: params.trajectoryId,
						parentStageId: params.parentStageId,
						iteration: params.iteration ?? 1,
						attempt: 2,
						modelType: String(modelType),
						provider: retrySnapshot?.provider ?? params.provider,
						messages: (retrySnapshot?.input ?? renderedInput).messages,
						providerOptions: retrySnapshot?.providerOptions ?? providerOptions,
						raw: `[evaluator truncation retry failed] ${
							retryError instanceof Error
								? retryError.message
								: String(retryError)
						}${retryDetail?.providerMessage ? ` | provider: ${retryDetail.providerMessage}` : ""}${
							retryDetail?.status !== undefined
								? ` | status: ${retryDetail.status}`
								: ""
						}`,
						output: {
							success: false,
							decision: "CONTINUE",
							thought:
								"Evaluator truncation retry failed before producing output.",
							protocolFailure: true,
							raw: {},
						},
						startedAt: activeCallStartedAt,
						endedAt: Date.now(),
						segmentHashes: (retrySnapshot?.prefixHashes ?? prefixHashes).map(
							(entry) => entry.segmentHash,
						),
						prefixHash: retrySnapshot?.prefixHash ?? prefixHash,
						logger: params.runtime.logger,
					});
				}
				// The selected response remains the initial attempt. Restore its
				// provider/input snapshot rather than attributing it to the failed retry.
				selectedCall = initialCall;
				raw = initialCall.raw;
				fellBackToInitialCall = true;
				params.runtime.logger?.warn?.(
					{
						err:
							retryError instanceof Error
								? retryError.message
								: String(retryError),
						modelType: String(modelType),
						retryMaxTokens,
					},
					"[evaluator] truncation retry failed; using the original response for parse-recovery",
				);
				params.runtime.reportError?.("Evaluator.truncationRetry", retryError, {
					modelType: String(modelType),
					retryMaxTokens,
				});
			}
		}
	} catch (error) {
		if (
			error instanceof ElizaError &&
			error.code === "EVALUATOR_INPUT_OVER_BUDGET"
		) {
			// Terminal budget rejection: every reachable registration was either
			// exhausted or refused the input pre-handler. Record the last
			// prepared (and rejected) request so the trajectory shows what
			// failed to fit, then rethrow for the planner-loop policy.
			await recordInputBudgetFailure({
				error,
				input: preparedAttempt?.input ?? renderedInput,
				provider: preparedAttempt?.provider ?? params.provider,
				providerOptions: preparedAttempt?.providerOptions ?? providerOptions,
				attempt: activeAttempt,
				failureStartedAt:
					activeAttempt === undefined ? undefined : activeCallStartedAt,
			});
			throw error;
		}
		// error-policy:J2 context-adding rethrow — the evaluator model call is
		// the one whose REQUEST is otherwise never persisted: on success the
		// stage records below, but a provider failure (e.g. an intermittent
		// Cerebras 400) used to leave the trajectory with no evaluation stage at
		// all, making the failing request undiagnosable. Record the errored
		// stage WITH the request messages and the provider's real error detail,
		// then rethrow for the planner-loop's degrade/propagate policy.
		const detail = modelProviderErrorDetail(error);
		await recordEvaluationStage({
			runtime: params.runtime,
			recorder: params.recorder,
			trajectoryId: params.trajectoryId,
			parentStageId: params.parentStageId,
			iteration: params.iteration ?? 1,
			attempt: activeAttempt,
			modelType: String(modelType),
			provider: preparedAttempt?.provider ?? params.provider,
			messages: (preparedAttempt?.input ?? renderedInput).messages,
			providerOptions: preparedAttempt?.providerOptions ?? providerOptions,
			raw: `[evaluator model call failed] ${
				error instanceof Error ? error.message : String(error)
			}${detail?.providerMessage ? ` | provider: ${detail.providerMessage}` : ""}${
				detail?.status !== undefined ? ` | status: ${detail.status}` : ""
			}`,
			output: {
				success: false,
				decision: "CONTINUE",
				thought: "Evaluator model call failed before producing output.",
				protocolFailure: true,
				raw: {},
			},
			startedAt: activeAttempt === undefined ? startedAt : activeCallStartedAt,
			endedAt: Date.now(),
			segmentHashes: (preparedAttempt?.prefixHashes ?? prefixHashes).map(
				(entry) => entry.segmentHash,
			),
			prefixHash: preparedAttempt?.prefixHash ?? prefixHash,
			logger: params.runtime.logger,
		});
		throw error;
	}
	const output = finalizeEvaluatorOutput(
		raw,
		params.context,
		params.trajectory,
	);
	await emitStreamingHook(streamingContext, "onEvaluation", {
		evaluation: projectToolDiagnosticValue(
			output,
			redactDiagnosticText,
		) as EvaluatorOutput,
		messageId: streamingContext?.messageId,
	});
	await applyEvaluatorEffects(output, params.effects);

	// The first call was already persisted before the retry. When a provider
	// failure makes us fall back to that same response, do not append a duplicate
	// stage; the failed retry has its own attempt-2 stage above.
	if (!fellBackToInitialCall) {
		const snapshot = selectedCall?.preparedAttempt;
		await recordEvaluationStage({
			runtime: params.runtime,
			recorder: params.recorder,
			trajectoryId: params.trajectoryId,
			parentStageId: params.parentStageId,
			iteration: params.iteration ?? 1,
			attempt: initialCallRecorded ? 2 : undefined,
			modelType: String(modelType),
			provider: snapshot?.provider ?? params.provider,
			messages: (snapshot?.input ?? renderedInput).messages,
			providerOptions: snapshot?.providerOptions ?? providerOptions,
			raw,
			output,
			startedAt:
				initialCallRecorded && selectedCall
					? selectedCall.startedAt
					: startedAt,
			endedAt: selectedCall?.endedAt ?? Date.now(),
			segmentHashes: (snapshot?.prefixHashes ?? prefixHashes).map(
				(entry) => entry.segmentHash,
			),
			prefixHash: snapshot?.prefixHash ?? prefixHash,
			logger: params.runtime.logger,
		});
	}

	return output;
}

async function recordEvaluationStage(args: {
	runtime?: EvaluatorRuntime;
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
	iteration: number;
	/** Present only when one evaluator run made multiple provider calls. */
	attempt?: number;
	modelType: string;
	provider?: string;
	messages?: ChatMessage[];
	providerOptions?: Record<string, unknown>;
	raw: string | { text?: string; object?: unknown; providerMetadata?: unknown };
	output: EvaluatorOutput;
	startedAt: number;
	endedAt: number;
	segmentHashes: string[];
	prefixHash: string;
	logger?: EvaluatorRuntime["logger"];
}): Promise<void> {
	if (!args.recorder || !args.trajectoryId) return;
	try {
		const responseText =
			typeof args.raw === "string"
				? args.raw
				: typeof args.raw.text === "string"
					? args.raw.text
					: JSON.stringify(args.raw.object ?? {});
		const usage = extractEvaluatorUsage(args.raw);
		const modelName = extractEvaluatorModelName(args.raw);
		const stage: RecordedStage = {
			stageId: `stage-eval-iter-${args.iteration}-${args.startedAt}${
				args.attempt === undefined ? "" : `-attempt-${args.attempt}`
			}`,
			kind: "evaluation",
			iteration: args.iteration,
			parentStageId: args.parentStageId,
			startedAt: args.startedAt,
			endedAt: args.endedAt,
			latencyMs: args.endedAt - args.startedAt,
			model: {
				modelType: args.modelType,
				modelName,
				provider: extractEvaluatorProviderName(args.raw) ?? args.provider,
				messages: args.messages,
				tools: [],
				toolCalls: [],
				providerOptions: args.providerOptions,
				response: responseText,
				usage,
				costUsd: usage ? computeCallCostUsd(modelName, usage) : undefined,
			},
			evaluation: {
				success: args.output.success,
				decision: args.output.decision,
				thought: args.output.thought,
				messageToUser: args.output.messageToUser,
				copyToClipboard: args.output.copyToClipboard,
				recommendedToolCallId: args.output.recommendedToolCallId,
				protocolFailure: args.output.protocolFailure,
				parseError: args.output.parseError,
			},
			cache: {
				segmentHashes: args.segmentHashes,
				prefixHash: args.prefixHash,
			},
		};
		await args.recorder.recordStage(args.trajectoryId, stage);
	} catch (err) {
		// error-policy:J7 Evaluation recording is diagnostic and cannot alter
		// the evaluator decision it observes.
		args.logger?.warn?.(
			{ err: (err as Error).message, trajectoryId: args.trajectoryId },
			"[TrajectoryRecorder] failed to record evaluation stage",
		);
		args.runtime?.reportError?.("Evaluator.recordStage", err, {
			trajectoryId: args.trajectoryId,
		});
	}
}

function extractEvaluatorModelName(
	raw: string | { providerMetadata?: unknown },
): string | undefined {
	if (typeof raw === "string") return undefined;
	const meta = raw.providerMetadata;
	if (meta && typeof meta === "object" && !Array.isArray(meta)) {
		const direct = (meta as Record<string, unknown>).modelName;
		if (typeof direct === "string") return direct;
		const model = (meta as Record<string, unknown>).model;
		if (typeof model === "string") return model;
	}
	return undefined;
}

function extractEvaluatorProviderName(
	raw: string | { providerMetadata?: unknown },
): string | undefined {
	if (typeof raw === "string") return undefined;
	const meta = raw.providerMetadata;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
		return undefined;
	}
	const record = meta as Record<string, unknown>;
	for (const key of ["provider", "providerName"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

function extractEvaluatorUsage(
	raw: string | { text?: string; object?: unknown; usage?: unknown },
): RecordedUsage | undefined {
	if (typeof raw === "string") return undefined;
	const usage = (raw as Record<string, unknown>).usage as
		| Record<string, unknown>
		| undefined;
	if (!usage) return undefined;
	const out: RecordedUsage = {};
	for (const key of [
		"promptTokens",
		"completionTokens",
		"totalTokens",
	] as const) {
		if (typeof usage[key] === "number" && Number.isFinite(usage[key])) {
			out[key] = usage[key];
		}
	}
	if (typeof usage.cacheReadInputTokens === "number") {
		out.cacheReadInputTokens = usage.cacheReadInputTokens;
	} else if (typeof usage.cachedPromptTokens === "number") {
		out.cacheReadInputTokens = usage.cachedPromptTokens;
	}
	if (typeof usage.cacheCreationInputTokens === "number") {
		out.cacheCreationInputTokens = usage.cacheCreationInputTokens;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function reportEvaluatorUsage(
	raw: Awaited<ReturnType<EvaluatorRuntime["useModel"]>>,
	onUsage: RunEvaluatorParams["onUsage"],
): void {
	const usage = extractEvaluatorUsage(raw);
	if (
		usage?.promptTokens !== undefined &&
		usage.completionTokens !== undefined
	) {
		onUsage?.({
			promptTokens: usage.promptTokens,
			completionTokens: usage.completionTokens,
		});
	}
}

function renderEvaluatorModelInput(params: {
	context: ContextObject;
	trajectory: PlannerTrajectory;
	template?: string;
	redactText: ToolDiagnosticTextRedactor;
	/**
	 * Per-tool-result render cap (chars) applied via
	 * `trajectoryStepsToMessages`. Undefined preserves the trajectory result
	 * byte-for-byte; `runEvaluator` applies the cap only after the resolved
	 * model budget requires compaction.
	 */
	maxToolResultChars?: number;
}): {
	messages: ChatMessage[];
	promptSegments: PromptSegment[];
	cacheKeySegments: PromptSegment[];
} {
	const renderedContext = renderContextObject(params.context);
	const template = params.template ?? evaluatorTemplate;
	const instructions = (
		template.split("context_object:")[0] ?? template
	).trim();
	const stepMessages = trajectoryStepsToMessages(params.trajectory.steps, {
		maxToolResultChars: params.maxToolResultChars,
		redactText: params.redactText,
	});
	// Mirrors planner-loop: the evaluator stage instructions are template-derived
	// (`evaluatorTemplate`) and structurally identical across calls. Marking
	// the segment `stable: true` makes them cacheable on Anthropic's wire path.
	const stableContextSegments = renderedContext.promptSegments.filter(
		(segment) => segment.stable,
	);
	const dynamicContextSegments = renderedContext.promptSegments.filter(
		(segment) => !segment.stable,
	);
	const promptSegments = normalizePromptSegments([
		...stableContextSegments,
		{ content: `evaluator_stage:\n${instructions}`, stable: true },
		...dynamicContextSegments,
	]);
	const cacheKeySegments = normalizePromptSegments(stableContextSegments);
	// Use proper assistant/tool message pairs so the evaluator sees the same
	// native tool-calling format as the planner. The trajectory JSON is NOT
	// included in dynamicBlocks — it is conveyed through stepMessages.
	const messages = buildStageChatMessages({
		contextSegments: renderedContext.promptSegments,
		stageLabel: "evaluator_stage",
		instructions,
		dynamicBlocks: [],
		stepMessages,
	});
	return { messages, promptSegments, cacheKeySegments };
}

export function parseEvaluatorOutput(
	raw: string | { text?: string; object?: unknown },
): EvaluatorOutput {
	const parsedResult = getStructuredEvaluatorObject(raw);
	if (parsedResult.parseError) {
		return {
			success: false,
			decision: "CONTINUE",
			thought: `Invalid evaluator output: ${parsedResult.parseError}. Replanning from recorded tool results.`,
			protocolFailure: true,
			parseError: parsedResult.parseError,
			raw: {},
		};
	}

	const parsed = parsedResult.object ?? {};
	const protocolError = evaluatorEnvelopeProtocolError(parsed);
	if (protocolError) {
		return {
			success: false,
			decision: "CONTINUE",
			thought: `Invalid evaluator output: ${protocolError}. Replanning from recorded tool results.`,
			protocolFailure: true,
			raw: { ...(parsed as Record<string, unknown>), protocolError },
		};
	}
	const decision = normalizeEvaluatorRoute(parsed.decision ?? parsed.route);
	return {
		success: parsed.success === true,
		decision,
		thought: typeof parsed.thought === "string" ? parsed.thought : "",
		nextTool: normalizeNextTool(parsed.nextTool ?? parsed.nextRecommendedTool),
		messageToUser:
			typeof parsed.messageToUser === "string" &&
			parsed.messageToUser.trim().length > 0
				? parsed.messageToUser
				: undefined,
		copyToClipboard: normalizeClipboard(parsed.copyToClipboard),
		recommendedToolCallId:
			typeof parsed.recommendedToolCallId === "string"
				? parsed.recommendedToolCallId
				: undefined,
		raw: parsed as Record<string, unknown>,
	};
}

function evaluatorEnvelopeProtocolError(
	output: RawEvaluatorOutput,
): string | undefined {
	const unknownKey = Object.keys(output).find(
		(key) => !EVALUATOR_ENVELOPE_KEYS.has(key),
	);
	if (unknownKey)
		return `field "${unknownKey}" is not allowed in evaluator output`;
	if (typeof output.success !== "boolean")
		return 'required field "success" must be a boolean';
	const decision = output.decision ?? output.route;
	if (!parseEvaluatorRoute(decision)) {
		return 'required field "decision" must be FINISH, NEXT_RECOMMENDED, or CONTINUE';
	}
	if (
		output.decision !== undefined &&
		output.route !== undefined &&
		parseEvaluatorRoute(output.decision) !== parseEvaluatorRoute(output.route)
	)
		return 'fields "decision" and legacy "route" must agree';
	if (typeof output.thought !== "string")
		return 'required field "thought" must be a string';
	if (
		Object.hasOwn(output, "messageToUser") &&
		typeof output.messageToUser !== "string"
	) {
		return 'optional field "messageToUser" must be a string';
	}
	if (
		Object.hasOwn(output, "recommendedToolCallId") &&
		typeof output.recommendedToolCallId !== "string"
	) {
		return 'optional field "recommendedToolCallId" must be a string';
	}
	for (const key of ["nextTool", "nextRecommendedTool"] as const) {
		if (Object.hasOwn(output, key) && !normalizeNextTool(output[key])) {
			return `optional field "${key}" must declare a tool name and object parameters`;
		}
	}
	if (Object.hasOwn(output, "copyToClipboard")) {
		const value = output.copyToClipboard;
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return 'optional field "copyToClipboard" must be an object';
		}
		const record = value as Record<string, unknown>;
		const unknownClipboardKey = Object.keys(record).find(
			(key) => key !== "title" && key !== "content" && key !== "tags",
		);
		if (unknownClipboardKey)
			return `field "copyToClipboard.${unknownClipboardKey}" is not allowed`;
		if (
			typeof record.title !== "string" ||
			typeof record.content !== "string"
		) {
			return 'fields "copyToClipboard.title" and "copyToClipboard.content" must be strings';
		}
		if (
			record.tags !== undefined &&
			(!Array.isArray(record.tags) ||
				record.tags.some((tag) => typeof tag !== "string"))
		) {
			return 'optional field "copyToClipboard.tags" must be an array of strings';
		}
	}
	return undefined;
}

/**
 * Patterns that match internal orchestration mechanics the LLM
 * sometimes echoes into `messageToUser` after a TASKS / sub-agent
 * spawn. They expose implementation details (auto-generated agent
 * labels, raw PTY session IDs, multi-agent enumeration verbiage) and
 * read as robotic to the human on the other end of the chat.
 *
 * Each pattern is conservative: it targets a parenthetical / inline
 * annotation that the LLM appends as metadata, not the surrounding
 * natural language. The replacement either drops the parenthetical
 * entirely or substitutes a neutral phrase, then collapses any
 * doubled whitespace.
 */
// Orchestrator auto-generated task labels always have at least two
// hyphen-separated word segments before the trailing index (e.g.
// "count-py-files-projects-1", "write-arxiv-grab-py-1"). Requiring
// `{2,}` segments here is what keeps the sanitizer from eating
// legitimate parentheticals the LLM might write — "(bug-42)",
// "(phase-1)", "(rfc-2616)", "(attempt-3)" — none of which match.
const AUTO_LABEL = /(?:[a-z][a-z0-9]*-){2,}\d+/.source;

const INTERNAL_MECHANIC_PATTERNS: ReadonlyArray<{
	pattern: RegExp;
	replacement: string;
}> = [
	// "(session: pty-1778500471501-4cf0e3a6)", "(session pty-...)"
	{
		pattern: /\s*\((?:session(?:[- _]?id)?\s*[:=]?\s*)?pty-\d+-[A-Za-z0-9]+\)/g,
		replacement: "",
	},
	// Bare session IDs "pty-1778500471501-4cf0e3a6" anywhere in the
	// message — `\s*` so the strip still fires at position 0.
	{ pattern: /\s*pty-\d+-[A-Za-z0-9]+/g, replacement: "" },
	// "(session write-arxiv-grab-py-1)" / "(write-arxiv-grab-py-1)" /
	// "(count-py-files-projects-1 and count-ts-files-iqlabs-1)" —
	// auto-generated labels in parens.
	{
		pattern: new RegExp(
			`\\s*\\((?:session\\s*[:=]?\\s*|sessions?\\s+)?${AUTO_LABEL}(?:\\s+and\\s+${AUTO_LABEL})*\\)`,
			"g",
		),
		replacement: "",
	},
	// "session write-arxiv-grab-py-1" inline (no parens).
	{
		pattern: new RegExp(`\\s+session\\s+${AUTO_LABEL}`, "g"),
		replacement: "",
	},
	// "task-agent / task_agent / subagent" mechanic phrases that
	// surface as "task-agent count-py-files-projects-1" right before
	// a label. Drop the prefix; keep "agent" in the natural-language
	// sense by mapping to "agent" only when the label follows.
	{
		pattern: new RegExp(`\\b(?:task[-_]agent|subagent)\\s+${AUTO_LABEL}`, "g"),
		replacement: "agent",
	},
];

function sanitizeMessageToUser(text: string): string {
	let cleaned = text;
	for (const { pattern, replacement } of INTERNAL_MECHANIC_PATTERNS) {
		cleaned = cleaned.replace(pattern, replacement);
	}
	// Collapse multiple spaces introduced by the substitutions and
	// trim trailing space before punctuation (", ." -> ".").
	cleaned = cleaned.replace(/[ \t]{2,}/g, " ");
	cleaned = cleaned.replace(/\s+([.,!?:;])/g, "$1");
	return cleaned.trim();
}

function sanitizeOutputMessage(output: EvaluatorOutput): EvaluatorOutput {
	if (typeof output.messageToUser !== "string") return output;
	const sanitized = sanitizeMessageToUser(output.messageToUser);
	if (sanitized === output.messageToUser) return output;
	if (sanitized.length === 0) {
		// If sanitization removed everything, drop messageToUser so the
		// runtime doesn't post an empty Discord message.
		return { ...output, messageToUser: undefined };
	}
	return { ...output, messageToUser: sanitized };
}

function repairMissingEvaluatorSuccess(
	output: EvaluatorOutput,
	trajectory: PlannerTrajectory,
): EvaluatorOutput {
	if (output.raw && Object.hasOwn(output.raw, "success")) {
		return output;
	}
	if (output.decision !== "FINISH") {
		return output;
	}
	const latestStep = [...trajectory.steps]
		.reverse()
		.find((step) => step.toolCall && step.result);
	if (latestStep?.result?.success !== true) {
		return output;
	}
	return {
		...output,
		success: true,
	};
}

function repairMissingEvaluatorMessage(
	output: EvaluatorOutput,
	context: ContextObject,
	trajectory: PlannerTrajectory,
): EvaluatorOutput {
	if (typeof output.messageToUser === "string") return output;
	if (output.success !== true || output.decision !== "FINISH") return output;
	const command = latestSafeCommandForUser(context, trajectory);
	if (hasSuccessfulToolResult(trajectory) && !command) return output;
	const thought = output.thought.trim();
	if (!looksLikeUserFacingAnswer(thought)) return output;

	const messageToUser =
		command && !thought.includes(command)
			? `Command run: \`${command}\`\n\n${thought}`
			: thought;
	return {
		...output,
		messageToUser,
	};
}

function repairFinishedToolTurnWithoutUserMessage(
	output: EvaluatorOutput,
	trajectory: PlannerTrajectory,
): EvaluatorOutput {
	if (typeof output.messageToUser === "string") return output;
	if (output.success !== true || output.decision !== "FINISH") return output;
	// Terminal-only iteration: the planner just emitted a user-facing message
	// (pushed as the latest step) and the loop finishes with
	// `evaluator.messageToUser ?? plannerOutput.messageToUser`. A FINISH without
	// an evaluator message is complete there; coercing it to CONTINUE burns
	// `terminal_only_continuations` and, after three identical planner answers,
	// throws TrajectoryLimitExceeded and relays a generic apology instead of the
	// planner's real answer (observed live: MMLU via the benchmark server — the
	// planner answered "B" three times and the turn still errored).
	const lastStep = trajectory.steps.at(-1);
	if (lastStep?.terminalOnly && lastStep.terminalMessage?.trim()) {
		return output;
	}
	const latestStep = [...trajectory.steps]
		.reverse()
		.find((step) => step.toolCall && step.result);
	const latestResult = latestStep?.result;
	if (latestResult?.success !== true) return output;
	if (latestResult.userFacingText?.trim()) return output;
	return {
		...output,
		success: false,
		decision: "CONTINUE",
		thought:
			"Evaluator finished without a user-facing message; replanning from recorded tool results.",
	};
}

/**
 * A FINISH whose user message promises ongoing work is self-contradictory:
 * the evaluator ends the turn while telling the user the work continues, so
 * the promised delivery never happens (observed live twice on web-search
 * turns: a bare final "checking.", and "<link> … checking this list for the
 * top pick under $150." posted as the turn's last message with no pick ever
 * delivered). Coerce to CONTINUE and drop the promise text — the planner gets
 * the iteration the message promised, bounded by the loop's existing caps.
 *
 * Matching is deliberately narrow to keep substantive answers final: either
 * the whole message is a short bare ack ("checking.", "on it", "one moment"),
 * or the LAST sentence opens with a progress verb aimed at a referent
 * ("checking this list …", "looking into that now"). Informative statements
 * that merely open with a gerund ("Checking accounts are bank accounts …")
 * fail the determiner test and stay final.
 */
const FINISH_BARE_PROGRESS_ACK_RE =
	/^(?:checking|fetching|gathering|reading|scanning|looking (?:up|into)|working on it|on it|one (?:moment|sec(?:ond)?)|give me a (?:sec(?:ond)?|moment)|let me (?!know\b)[a-z]+)[.…!\s]*$/i;
const FINISH_PROGRESS_PROMISE_TAIL_RE =
	/(?:^|[.!?…]\s+|\n\s*)(?:checking|reading|opening|fetching|scanning|pulling(?: up)?|going through|digging into|looking (?:up|into)|working on)\s+(?:this|that|these|those|it\b|the\b)[^.!?\n]{0,80}[.!?…]?\s*$/i;

/**
 * A FINISH that leaves declared multi-step work unserved is a broken promise:
 * Stage 1 explicitly listed the turn's intents ("delete reminder", "create
 * reminder", "list reminders"), the planner served the first and quit, and
 * the reminder stayed deleted (live 2026-08-18, three times — the context
 * instruction alone did not move a small planner model). When the context
 * carries the declared-intents instruction and fewer successful non-terminal
 * operations exist than declared intents, coerce ONE CONTINUE so the loop
 * gets the iterations the declaration promised; the marker thought makes the
 * coercion once-per-turn so an intent genuinely unservable cannot loop.
 */
const UNSERVED_INTENTS_THOUGHT_MARKER = "unserved declared intents";

function declaredIntentsFromContext(context: ContextObject): string[] {
	const events = Array.isArray(context.events) ? context.events : [];
	for (const event of events) {
		if (
			event &&
			typeof event === "object" &&
			(event as { id?: unknown }).id === "stage1-declared-intents"
		) {
			const content = (event as { content?: unknown }).content;
			if (typeof content !== "string") return [];
			return content
				.split("\n")
				.filter((line) => line.startsWith("- "))
				.map((line) => line.slice(2).trim())
				.filter(Boolean);
		}
	}
	return [];
}

function repairFinishWithUnservedDeclaredIntents(
	output: EvaluatorOutput,
	context: ContextObject,
	trajectory: PlannerTrajectory,
): EvaluatorOutput {
	if (output.decision !== "FINISH") return output;
	const intents = declaredIntentsFromContext(context);
	if (intents.length < 2) return output;
	const priorCoercion = (trajectory.evaluatorOutputs ?? []).some((prior) =>
		(prior?.thought ?? "").includes(UNSERVED_INTENTS_THOUGHT_MARKER),
	);
	if (priorCoercion) return output;
	const served = [
		...(trajectory.archivedSteps ?? []),
		...trajectory.steps,
	].filter((step) => step.toolCall && step.result?.success === true).length;
	if (served >= intents.length) return output;
	return {
		...output,
		success: false,
		decision: "CONTINUE",
		messageToUser: undefined,
		thought: `Stage 1 declared ${intents.length} intents (${intents.join("; ")}) but only ${served} tool operation(s) succeeded — continuing with the ${UNSERVED_INTENTS_THOUGHT_MARKER}.`,
	};
}

function repairFinishWithProgressPromise(
	output: EvaluatorOutput,
	trajectory: PlannerTrajectory,
): EvaluatorOutput {
	if (output.decision !== "FINISH") return output;
	const message = (output.messageToUser ?? "").trim();
	if (!message) return output;
	if (!hasSuccessfulToolResult(trajectory)) return output;
	const bareAck =
		message.length <= 64 && FINISH_BARE_PROGRESS_ACK_RE.test(message);
	if (!bareAck && !FINISH_PROGRESS_PROMISE_TAIL_RE.test(message)) {
		return output;
	}
	return {
		...output,
		success: false,
		decision: "CONTINUE",
		messageToUser: undefined,
		thought:
			"Evaluator finished while promising ongoing work; continuing so the promised result is actually delivered.",
	};
}

function recoverEvaluatorTextOutput(
	output: EvaluatorOutput,
	raw: string | { text?: string; object?: unknown },
	trajectory: PlannerTrajectory,
): EvaluatorOutput {
	if (!output.parseError) return output;
	const text = rawText(raw).trim();
	if (!text) return output;

	if (
		containsToolAttemptObject(text) ||
		containsInvocationDsl(text) ||
		invokesTrajectoryTool(text, trajectory)
	) {
		return {
			...output,
			success: false,
			decision: "CONTINUE",
			thought:
				"Evaluator emitted tool/action syntax instead of evaluator JSON; replanning from recorded tool results.",
			parseError: undefined,
			raw: { recoverySource: "tool_attempt_text" },
		};
	}

	// A response that IS an envelope — fenced or bare — but failed strict
	// parsing is machinery, never prose. Salvage the known over-escaping
	// quirk first (small models emit \\" and \\n inside string values, which
	// terminates the JSON string early); if the repaired envelope parses, the
	// user gets the answer trapped in `messageToUser`. If it still cannot be
	// parsed, replan — the raw envelope must never ship as a reply (live
	// leak 2026-08-10: a whole fenced FINISH envelope posted to the channel
	// because only the trailing-envelope strip below guarded this path).
	const envelopeShaped = looksLikeEvaluatorEnvelopeText(text);
	if (envelopeShaped) {
		const salvaged = salvageOverEscapedEnvelope(text);
		if (salvaged) {
			return {
				success: salvaged.success,
				decision: salvaged.decision,
				thought: salvaged.thought,
				messageToUser: salvaged.messageToUser,
				raw: { recoverySource: "salvaged_over_escaped_envelope" },
			};
		}
		return {
			...output,
			success: false,
			decision: "CONTINUE",
			thought:
				"Evaluator emitted a malformed envelope instead of evaluator JSON; replanning from recorded tool results.",
			parseError: undefined,
			raw: { recoverySource: "malformed_envelope_text" },
		};
	}

	if (!hasSuccessfulToolResult(trajectory)) return output;

	const envelopeMessage = trailingFinishEnvelopeMessage(text);
	if (envelopeMessage) {
		return {
			success: true,
			decision: "FINISH",
			thought:
				"Recovered the terminal evaluator envelope's answer from surrounding debris.",
			messageToUser: envelopeMessage,
			raw: { recoverySource: "trailing_finish_envelope_message" },
		};
	}
	if (!looksLikeUserFacingAnswer(text)) return output;

	const userFacing = stripTrailingEvaluatorEnvelope(text);
	if (!looksLikeUserFacingAnswer(userFacing)) {
		return {
			...output,
			success: false,
			decision: "CONTINUE",
			thought:
				"Evaluator prose was only debris around a structured envelope; replanning from recorded tool results.",
			parseError: undefined,
			raw: { recoverySource: "debris_only_text" },
		};
	}

	// Committed state is authoritative over recovered prose: when the turn's
	// successful tool result carries VERIFIED canonical user-facing text
	// (do-not-paraphrase contract, #14873), the unparseable evaluator prose is
	// the least trustworthy artifact in the turn — live matrix F30
	// (tj-e9bdfb8015bc11): OWNER_REMINDERS_REVIEW returned "water the ficus at
	// 10am…" verified, and this recovery shipped hallucinated
	// conversation-history items ("your 20 pushups and the sandpaper run")
	// instead. Finish with the verified tool text; prose recovery remains for
	// turns whose tools make no verified-text claim (web search, shell, …).
	const verifiedToolText = latestVerifiedToolUserFacingText(trajectory);
	if (verifiedToolText) {
		return {
			success: true,
			decision: "FINISH",
			thought:
				"Recovered the turn's answer from the verified tool result; unparseable evaluator prose must not override committed state.",
			messageToUser: verifiedToolText,
			raw: { recoverySource: "verified_tool_text_over_prose" },
		};
	}

	return {
		success: true,
		decision: "FINISH",
		thought:
			"Recovered user-facing evaluator prose after a successful tool result.",
		messageToUser: userFacing,
		raw: { recoverySource: "prose_after_successful_tool" },
	};
}

/**
 * The most recent successful step whose result carries the verified
 * do-not-paraphrase user-facing text. Archived steps are deliberately
 * excluded: only the live turn's surface output is authoritative for the
 * live turn's reply.
 */
function latestVerifiedToolUserFacingText(
	trajectory: PlannerTrajectory,
): string | null {
	for (let index = trajectory.steps.length - 1; index >= 0; index -= 1) {
		const result = trajectory.steps[index]?.result;
		if (result?.success !== true || result.verifiedUserFacing !== true) {
			continue;
		}
		const text =
			typeof result.userFacingText === "string"
				? result.userFacingText.trim()
				: "";
		if (text) return text;
	}
	return null;
}

/**
 * Recover the user-facing answer from a valid trailing terminal envelope.
 * Nonterminal envelopes remain planner control flow and must never be promoted
 * into a finished user reply merely because noisy text preceded them.
 */
function trailingFinishEnvelopeMessage(text: string): string | null {
	const trimmed = text.trimEnd();
	if (!trimmed.endsWith("}")) return null;
	const candidate = extractJsonObjects(trimmed).at(-1);
	if (!candidate || !trimmed.endsWith(candidate)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		// error-policy:J3 malformed model output is not a recoverable envelope.
		return null;
	}
	if (!isEvaluatorEnvelopeObject(parsed)) return null;
	const record = parsed as Record<string, unknown>;
	const decision = String(record.decision ?? record.route)
		.trim()
		.toUpperCase();
	if (decision !== "FINISH") return null;
	const message = record.messageToUser;
	return typeof message === "string" && message.trim().length > 0
		? message.trim()
		: null;
}

/**
 * Real emittable widget markers — a paired `[NAME]…[/NAME]` (or single-line
 * `[NAME…]`) block with one of these names renders to a native component and
 * must NOT be treated as a fabricated tool invocation. Everything else that
 * looks like `[SOME_ACTION] {json} [/SOME_ACTION]` is the model inventing a
 * marker to "call" an action in prose (observed live: a documents ask replied
 * `checking documents context. [DOCUMENT_SEARCH] {"limit":20} [/DOCUMENT_SEARCH]`
 * — the raw marker shipped to the user AND no search actually ran). Kept in
 * lockstep with the widget markers `stripDashboardOnlyMarkers` /
 * `parseInteractionBlocks` recognize. */
const KNOWN_WIDGET_MARKER_NAMES = new Set([
	"CHECKLIST",
	"WORKFLOW",
	"FORM",
	"CONFIG",
	"BACKGROUND",
	"FOLLOWUPS",
	"CHOICE",
	"TASK",
]);

/** A fabricated marker invocation: a paired uppercase bracket tag whose name is
 * not a known widget marker and whose body is a JSON-shaped action payload.
 * Literal bracket-tag examples and fenced code are user-visible content, not
 * planner control flow. */
function containsFabricatedMarkerInvocation(text: string): boolean {
	const prose = text
		.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "")
		.replace(/`[^`\r\n]*`/g, "");
	for (const match of prose.matchAll(
		/\[[ \t]*([A-Z][A-Z0-9_]{2,})[ \t]*\]([\s\S]*?)\[[ \t]*\/[ \t]*\1[ \t]*\]/g,
	)) {
		const name = match[1];
		if (!name || KNOWN_WIDGET_MARKER_NAMES.has(name)) continue;
		const body = match[2]?.trim();
		if (!body) continue;
		if (
			(body.startsWith("{") && body.endsWith("}")) ||
			(body.startsWith("[") && body.endsWith("]"))
		) {
			return true;
		}
	}
	return false;
}

function containsInvocationDsl(text: string): boolean {
	return (
		/(?:^|[^A-Za-z0-9_])(?:call|invoke|use|run)\s*:\s*[A-Za-z][A-Za-z0-9_.-]*(?::[A-Za-z][A-Za-z0-9_.-]*)*\s*[({]/im.test(
			text,
		) || containsFabricatedMarkerInvocation(text)
	);
}

function rejectEvaluatorInvocationMessage(
	output: EvaluatorOutput,
): EvaluatorOutput {
	if (
		typeof output.messageToUser !== "string" ||
		!containsInvocationDsl(output.messageToUser)
	) {
		return output;
	}
	return {
		...output,
		success: false,
		decision: "CONTINUE",
		protocolFailure: true,
		thought:
			"Evaluator emitted tool/action syntax instead of a user-facing answer; replanning from recorded tool results.",
		messageToUser: undefined,
	};
}

// When the evaluator model emits user-facing prose followed by the
// structured envelope (e.g. shell output ... then `{"success":true,
// "decision":"FINISH","thought":"..."}`) the strict JSON parser
// rejects the whole response. The recovery path above then uses the
// raw text as the user reply — and without this strip, the JSON
// envelope leaks into Discord.
//
// Live regression on 2026-05-25 (trajectory tj-b224d87039960b.json):
// user asked "use shell to show disk space" — the evaluator model
// emitted the actual `df -h` table prose immediately followed by a
// JSON object `{"success":true,"decision":"FINISH","thought":...}`
// and that object was published verbatim to the user's Discord
// channel underneath the table.
//
// The strip is conservative: it only removes a trailing balanced JSON object
// that parses as a real evaluator envelope (`success` boolean plus a valid
// `decision`/`route`). A legitimate user-asked-for trailing JSON object such
// as `{"success":true}` or `{"decision":"approve"}` is left untouched.
function stripTrailingEvaluatorEnvelope(text: string): string {
	const trimmed = text.trimEnd();
	if (!trimmed.endsWith("}")) return text;
	const candidate = extractJsonObjects(trimmed).at(-1);
	if (!candidate || !trimmed.endsWith(candidate)) return text;
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		// error-policy:J3 A trailing candidate is untrusted model output; a
		// malformed candidate is not an evaluator envelope.
		return text;
	}
	if (!isEvaluatorEnvelopeObject(parsed)) return text;
	return trimmed.slice(0, trimmed.length - candidate.length).trimEnd();
}

/**
 * True when the (fence-stripped) text is a single evaluator envelope by shape:
 * one leading JSON object carrying the envelope's discriminator keys. Shape
 * detection is deliberately parse-free so it still classifies envelopes whose
 * JSON is broken — that is exactly the case it exists for.
 */
function looksLikeEvaluatorEnvelopeText(text: string): boolean {
	const body = stripJsonFence(text);
	if (!body.startsWith("{")) return false;
	return (
		/"success"\s*:/.test(body) &&
		(/"decision"\s*:/.test(body) || /"route"\s*:/.test(body))
	);
}

function stripJsonFence(text: string): string {
	return text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "")
		.trim();
}

/**
 * Deterministic repair for the known small-model envelope quirk: string
 * values emitted with doubled escapes (`\\"`, `\\n`), where the literal
 * backslash terminates the JSON string early and the whole envelope fails to
 * parse. Collapses double-backslash-before-escape-char into a single escape
 * and re-parses. Returns the normalized envelope only when the repaired body
 * parses AND looks like a real envelope with a usable string
 * `messageToUser`; anything else returns undefined so the caller replans.
 */
function salvageOverEscapedEnvelope(text: string):
	| {
			success: boolean;
			decision: "FINISH" | "CONTINUE";
			thought: string;
			messageToUser: string;
	  }
	| undefined {
	const body = stripJsonFence(text);
	const repaired = body.replace(/\\\\(["nrt])/g, "\\$1");
	if (repaired === body) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(repaired);
	} catch {
		// error-policy:J3 untrusted model output; unrepairable stays unparsed
		// and the caller replans instead of shipping it.
		return undefined;
	}
	if (!isEvaluatorEnvelopeObject(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	const messageToUser =
		typeof record.messageToUser === "string" ? record.messageToUser.trim() : "";
	if (!messageToUser) return undefined;
	const rawDecision = (
		(typeof record.decision === "string" && record.decision) ||
		(typeof record.route === "string" && record.route) ||
		"FINISH"
	).toUpperCase();
	return {
		success: record.success === true,
		decision: rawDecision === "CONTINUE" ? "CONTINUE" : "FINISH",
		thought:
			typeof record.thought === "string"
				? record.thought
				: "Recovered from an over-escaped evaluator envelope.",
		messageToUser,
	};
}

function isEvaluatorEnvelopeObject(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (typeof record.success !== "boolean") return false;
	const decision = typeof record.decision === "string" ? record.decision : "";
	const route = typeof record.route === "string" ? record.route : "";
	const normalizedDecision = (decision || route).toUpperCase();
	return (
		normalizedDecision === "FINISH" ||
		normalizedDecision === "CONTINUE" ||
		normalizedDecision === "NEXT_RECOMMENDED"
	);
}

function rawText(raw: string | { text?: string; object?: unknown }): string {
	if (typeof raw === "string") return raw;
	if (typeof raw.text === "string") return raw.text;
	return "";
}

function hasSuccessfulToolResult(trajectory: PlannerTrajectory): boolean {
	return trajectory.steps.some((step) => step.result?.success === true);
}

/**
 * True when the recovered text invokes a tool this trajectory actually
 * carries — the model wanted ANOTHER tool call, not a user reply. Grounded in
 * the turn's real tool surface (step tool names) rather than a syntax
 * dictionary, because models drift into invocation dialects the JSON screen
 * above cannot parse (observed live: gemma emitting
 * `call:WEB_SEARCH{numResults:6,query:…}` with unquoted keys — JSON.parse
 * throws, the guard passed it, and the invocation shipped to Discord as the
 * final answer, repeatedly).
 */
function invokesTrajectoryTool(
	text: string,
	trajectory: PlannerTrajectory,
): boolean {
	for (const step of trajectory.steps) {
		const name = step.toolCall?.name?.trim();
		if (!name) continue;
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}\\s*[({]`, "i").test(text)) {
			return true;
		}
	}
	return false;
}

function containsToolAttemptObject(text: string): boolean {
	for (const objectText of extractJsonObjects(text)) {
		try {
			const parsed = JSON.parse(objectText);
			if (isToolAttemptObject(parsed)) return true;
		} catch {
			// error-policy:J3 unparseable/mismatched text is simply not a tool-attempt object
		}
	}
	return false;
}

function isToolAttemptObject(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	const name = record.name ?? record.tool ?? record.action;
	if (typeof name !== "string" || name.trim().length === 0) {
		return false;
	}
	if (isEvaluatorShapedObject(record)) {
		return false;
	}
	return (
		"parameters" in record ||
		"params" in record ||
		"args" in record ||
		"command" in record ||
		"arguments" in record
	);
}

function looksLikeUserFacingAnswer(text: string): boolean {
	if (text.length < 8 || text.length > 4000) return false;
	if (looksLikeRawToolTranscript(text)) return false;
	if (containsInternalWorkPlanning(text)) return false;
	if (/\{\s*"(?:action|tool|name|parameters|command)"\s*:/i.test(text)) {
		return false;
	}
	// Native model tool syntax is machine output, never a user-facing answer.
	// Three dialects need their own screens because none carries the JSON keys
	// the guard above matches: XML-style tool markup (<tool_call>/<arg_key>),
	// invented `<UPPER_SNAKE>` pseudo-tags, and a bare ALL_CAPS action name
	// followed by a JSON args object ("GET_WEATHER\n{\"location\":\"Tokyo\"}").
	// The pseudo-tag screen must run HERE, on the raw text: downstream reply
	// sanitizers strip the markup, so accepting markup-bearing prose ships the
	// surviving text as a fabricated effect claim — live matrix F38
	// (tj-9129a432454364): "temp is 35°C. saving note." delivered while the
	// `<NOTES_CREATE>{…}</NOTES_CREATE>` beside it was never executed, and the
	// next turn grounded on the false claim. Declining recovery keeps the turn
	// on the protocol-failure CONTINUE path, which replans through the real
	// tool dispatch instead.
	if (containsToolCallShapedMarkup(text)) {
		return false;
	}
	if (/^\s*[A-Z][A-Z0-9_]{2,}\s*\n\s*\{/.test(text)) {
		return false;
	}
	// A reply that OPENS with an invocation DSL ("call:WEB_SEARCH{…}",
	// "call:automation:GET_WORKFLOW{…}", "invoke: shell(…)") is machine
	// syntax regardless of dialect. Providers may namespace the action with
	// additional colon-delimited segments, and the argument block is rarely
	// valid JSON, so the key-based guard above cannot see it.
	if (containsInvocationDsl(text)) {
		return false;
	}
	if (
		/\b(?:need|needs|should|must|will)\s+(?:to\s+)?(?:run|call|use|invoke|execute)\b/i.test(
			text,
		)
	) {
		return false;
	}
	if (/\b(?:cannot|can't)\s+(?:answer|finish|complete)\b/i.test(text)) {
		return false;
	}
	return true;
}

function containsInternalWorkPlanning(text: string): boolean {
	return evaluatorProseFragments(text).some((fragment) => {
		const normalized = fragment.trim().replace(/\s+/g, " ");
		if (!normalized) return false;
		return (
			/^(?:i|we)\s+(?:need|needs|should|must|will|can|have)\s+(?:to\s+)?(?:locate|find|search|grep|inspect|check|read|open|run|use|try|verify|figure out|determine|look\s+(?:for|up))\b/i.test(
				normalized,
			) ||
			/^(?:let'?s\s+)?(?:grep|search|find|inspect|check|read|open|run|try|look)\s+(?:for|through|in|at|up|again|path)\b/i.test(
				normalized,
			) ||
			/^use\s+(?:grep|rg|search|find|shell|bash|curl)\b/i.test(normalized)
		);
	});
}

function evaluatorProseFragments(text: string): string[] {
	return text
		.replace(/([.!?])(?=[A-Z])/g, "$1\n")
		.replace(/([.!?])\s+/g, "$1\n")
		.split(/\r?\n/)
		.flatMap((line) => line.split(/\s+(?=-\s+\*\*)/));
}

function looksLikeRawToolTranscript(text: string): boolean {
	return /\[(?:exit\s+\d+|timeout\s+\d+ms)\]|\(cwd=|---\s+(?:stdout|stderr)\s+---/i.test(
		text,
	);
}

function latestSafeCommandForUser(
	context: ContextObject,
	trajectory: PlannerTrajectory,
): string | undefined {
	if (!latestUserAskedForCommandEcho(context)) return undefined;
	for (const step of [...trajectory.steps].reverse()) {
		const command = step.toolCall?.params?.command;
		if (typeof command !== "string") continue;
		const trimmed = command.trim();
		if (isSafeCommandEcho(trimmed)) return trimmed;
	}
	return undefined;
}

function latestUserAskedForCommandEcho(context: ContextObject): boolean {
	const latestUserText = [...context.events]
		.reverse()
		.map((event) => messageEventContent(event))
		.find((content) => typeof content !== "undefined");
	const text = messageContentText(latestUserText).toLowerCase();
	if (!text.includes("command")) return false;
	return (
		text.includes("exact command") ||
		text.includes("command you ran") ||
		text.includes("command ran") ||
		text.includes("what command") ||
		text.includes("which command") ||
		text.includes("show the command") ||
		text.includes("include the command")
	);
}

function messageEventContent(event: unknown): unknown {
	if (!event || typeof event !== "object") return undefined;
	const record = event as Record<string, unknown>;
	if (record.type !== "message") return undefined;
	const message = record.message;
	if (!message || typeof message !== "object") return undefined;
	const messageRecord = message as Record<string, unknown>;
	if (messageRecord.role !== "user") return undefined;
	return messageRecord.content;
}

function messageContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!content || typeof content !== "object") return "";
	const text = (content as Record<string, unknown>).text;
	return typeof text === "string" ? text : "";
}

function isSafeCommandEcho(command: string): boolean {
	if (command.length === 0 || command.length > 240) return false;
	if (command.includes("\n") || command.includes("\r")) return false;
	const lower = command.toLowerCase();
	return ![
		"authorization",
		"bearer",
		"password",
		"passwd",
		"secret",
		"token",
		"api_key",
		"apikey",
		"vault://",
	].some((needle) => lower.includes(needle));
}

export async function applyEvaluatorEffects(
	output: EvaluatorOutput,
	effects?: EvaluatorEffects,
): Promise<void> {
	if (output.protocolFailure) return;
	if (output.copyToClipboard && effects?.copyToClipboard) {
		await effects.copyToClipboard(output.copyToClipboard);
	}
	if (output.messageToUser && effects?.messageToUser) {
		await effects.messageToUser(output.messageToUser);
	}
}

export function normalizeEvaluatorRoute(route: unknown): EvaluatorRoute {
	return parseEvaluatorRoute(route) ?? "CONTINUE";
}

function parseEvaluatorRoute(route: unknown): EvaluatorRoute | undefined {
	const normalized = String(route ?? "")
		.trim()
		.toUpperCase();
	if (
		normalized === "FINISH" ||
		normalized === "NEXT_RECOMMENDED" ||
		normalized === "CONTINUE"
	) {
		return normalized;
	}
	return undefined;
}

function isEvaluatorShapedObject(value: unknown): value is RawEvaluatorOutput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return "success" in record || "decision" in record || "route" in record;
}

function getStructuredEvaluatorObject(
	raw: string | { text?: string; object?: unknown },
): ParsedEvaluatorObject {
	if (typeof raw === "string") {
		return parseEvaluatorText(raw);
	}
	if (
		raw.object &&
		typeof raw.object === "object" &&
		!Array.isArray(raw.object)
	) {
		// Same shape gate the text path applies: a structured object carrying
		// none of success/decision/route (e.g. a bare {"command": ...} tool-call
		// shape) is model drift, not an evaluator verdict. It routes through the
		// parse-error path so the loop sees a malformed evaluation and retries,
		// instead of a silent default verdict.
		if (!isEvaluatorShapedObject(raw.object)) {
			return {
				object: null,
				parseError: `structured evaluator output is not evaluator-shaped: ${truncateWellFormed(toWellFormedUnicode(JSON.stringify(raw.object)), 200)}`,
			};
		}
		return { object: raw.object as RawEvaluatorOutput };
	}
	if (typeof raw.text === "string") {
		return parseEvaluatorText(raw.text);
	}
	return { object: null, parseError: "missing evaluator text/object" };
}

/**
 * Split a response that BEGINS with a fenced JSON block into the block and the
 * prose after it. Some evaluator models emit a fenced verdict envelope followed
 * by the user-facing answer as trailing prose; a whole-string JSON parse
 * rejects that shape, so the envelope and the prose must be separated before
 * either can be used.
 */
function extractLeadingJsonFence(
	text: string,
): { block: string; rest: string } | null {
	if (!text.startsWith("```")) return null;
	const firstLineEnd = text.indexOf("\n");
	if (firstLineEnd < 0) return null;
	const closeIdx = text.indexOf("\n```", firstLineEnd);
	if (closeIdx < 0) return null;
	const afterClose = text.indexOf("\n", closeIdx + 1);
	const block = text.slice(firstLineEnd + 1, closeIdx).trim();
	const rest = afterClose < 0 ? "" : text.slice(afterClose + 1);
	if (!block) return null;
	return { block, rest };
}

/** JSON.parse that reports failure as null instead of throwing. */
function tryParseJson(candidate: string): unknown {
	try {
		return JSON.parse(candidate);
	} catch {
		// error-policy:J3 the fenced block is untrusted model output; a parse
		// failure means "not a verdict", reported as null so the caller falls
		// through to the tolerant parse instead of treating it as valid.
		return null;
	}
}

function parseEvaluatorText(text: string): ParsedEvaluatorObject {
	// Reasoning-token residue defeats every stage below: a reply like
	// `None</think>\`\`\`json {…}` fails the fence unwrap, the strict parse,
	// AND the leading-fence repair (which requires the text to START with a
	// fence) — the raw envelope then leaked verbatim to Discord (live
	// tj-b8809c9841cdfd, matrix F18). The reasoning-tag contract is
	// unambiguous for every canonical spelling (think/thinking/reasoning/…):
	// everything before the LAST close is reasoning, never output — strip it
	// before any envelope handling (#20080 generalizes the F18 </think> fix).
	return parseEvaluatorVisibleText(stripReasoningPrefixes(text));
}

function parseEvaluatorVisibleText(text: string): ParsedEvaluatorObject {
	const candidate = unwrapJsonFence(text.trim());
	if (!candidate) {
		return { object: null, parseError: "empty response" };
	}
	try {
		const parsed = JSON.parse(candidate);
		if (!isEvaluatorShapedObject(parsed)) {
			return {
				object: null,
				parseError: "JSON object is not evaluator-shaped",
			};
		}
		return { object: parsed };
	} catch {
		// error-policy:J3 Evaluator output is untrusted model data; repair only
		// the explicitly supported envelope-then-prose shape below.
		// Envelope-then-prose repair: a leading fenced evaluator verdict with the
		// answer following it is a valid response — the envelope is the verdict
		// and the prose is the user-facing message. The prose must pass the same
		// machine-output screen every other recovery path uses: an envelope
		// followed by native tool syntax means the model was trying to ACT, so
		// the whole response is reported invalid (the loop retries/continues)
		// rather than finishing the turn with tool syntax as the answer or a
		// silent no-message FINISH.
		const leading = extractLeadingJsonFence(text.trim());
		if (leading) {
			const parsedBlock = tryParseJson(leading.block);
			if (parsedBlock && isEvaluatorShapedObject(parsedBlock)) {
				const prose = leading.rest.trim();
				const record = parsedBlock as RawEvaluatorOutput & {
					messageToUser?: unknown;
				};
				if (prose && typeof record.messageToUser !== "string") {
					if (!looksLikeUserFacingAnswer(prose)) {
						return {
							object: null,
							parseError:
								"leading evaluator envelope followed by machine output (tool syntax), not a user-facing answer",
						};
					}
					record.messageToUser = prose;
				}
				return { object: record };
			}
		}
		const tolerant = parseJsonObject<RawEvaluatorOutput>(candidate);
		if (isEvaluatorShapedObject(tolerant)) {
			return {
				object: null,
				parseError:
					"response contains extra text or multiple JSON objects around evaluator JSON",
			};
		}
		const labeled = parseLabeledEvaluatorText(candidate);
		if (labeled) {
			return { object: labeled };
		}
		return { object: null, parseError: "response is not a single JSON object" };
	}
}

function unwrapJsonFence(text: string): string {
	if (!text.startsWith("```")) return text;
	const firstLineEnd = text.indexOf("\n");
	if (firstLineEnd < 0 || !text.endsWith("```")) return text;
	return text.slice(firstLineEnd + 1, -3).trim();
}

function parseLabeledEvaluatorText(text: string): RawEvaluatorOutput | null {
	const sections: Array<{ label: string; value: string }> = [];
	let current: { label: string; lines: string[] } | null = null;
	for (const line of text.split(/\r?\n/)) {
		const labeledLine = parseEvaluatorLabelLine(line);
		if (labeledLine) {
			if (current) {
				sections.push({
					label: current.label,
					value: current.lines.join("\n").trim(),
				});
			}
			current = { label: labeledLine.label, lines: [labeledLine.value] };
			continue;
		}
		if (current) current.lines.push(line);
	}
	if (current) {
		sections.push({
			label: current.label,
			value: current.lines.join("\n").trim(),
		});
	}
	if (sections.length === 0) return null;

	const output: RawEvaluatorOutput = {};
	for (const section of sections) {
		if (section.label === "success") {
			const success = parseBooleanLabelValue(section.value);
			if (typeof success === "boolean") output.success = success;
			continue;
		}
		if (section.label === "decision" || section.label === "route") {
			output.decision = firstLabelToken(section.value);
			continue;
		}
		if (section.label === "thought") {
			output.thought = section.value;
			continue;
		}
		if (section.label === "messagetouser" || section.label === "message") {
			output.messageToUser = section.value;
		}
	}

	if (!isEvaluatorShapedObject(output)) return null;
	deriveMessageFromLabeledFinalThought(output);
	return output;
}

function parseEvaluatorLabelLine(
	line: string,
): { label: string; value: string } | null {
	const colon = line.indexOf(":");
	if (colon <= 0) return null;
	const label = normalizeEvaluatorLabel(line.slice(0, colon));
	if (!isKnownEvaluatorTextLabel(label)) return null;
	return {
		label,
		value: line.slice(colon + 1).trimStart(),
	};
}

function normalizeEvaluatorLabel(label: string): string {
	return label
		.trim()
		.toLowerCase()
		.replaceAll(" ", "")
		.replaceAll("_", "")
		.replaceAll("-", "");
}

function isKnownEvaluatorTextLabel(label: string): boolean {
	return (
		label === "success" ||
		label === "decision" ||
		label === "route" ||
		label === "thought" ||
		label === "messagetouser" ||
		label === "message"
	);
}

function parseBooleanLabelValue(value: string): boolean | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized.startsWith("true") || normalized.startsWith("yes"))
		return true;
	if (normalized.startsWith("false") || normalized.startsWith("no"))
		return false;
	return undefined;
}

function firstLabelToken(value: string): string {
	return (
		value
			.trim()
			.split(/\s+/)[0]
			?.replace(/[.,;:]+$/g, "") ?? ""
	);
}

function deriveMessageFromLabeledFinalThought(
	output: RawEvaluatorOutput,
): void {
	if (typeof output.messageToUser === "string") return;
	if (output.success !== true) return;
	if (normalizeEvaluatorRoute(output.decision) !== "FINISH") return;
	if (typeof output.thought !== "string") return;
	const thought = output.thought.trim();
	if (!looksLikeMultilineFinalAnswer(thought)) return;
	output.messageToUser = thought;
	output.thought = "Recovered evaluator-labeled final answer.";
}

function looksLikeMultilineFinalAnswer(text: string): boolean {
	if (!text.includes("\n")) return false;
	if (!looksLikeUserFacingAnswer(text)) return false;
	return (
		text.includes("```") ||
		text.includes("\n- ") ||
		text.includes("\n* ") ||
		text.includes("\n1. ") ||
		text.includes("**")
	);
}

function normalizeNextTool(value: unknown): PlannerToolCall | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}

	const record = value as Record<string, unknown>;
	const name = String(record.name ?? record.tool ?? record.action ?? "").trim();
	if (!name) {
		return undefined;
	}

	const params =
		record.args && typeof record.args === "object"
			? (record.args as Record<string, unknown>)
			: record.params && typeof record.params === "object"
				? (record.params as Record<string, unknown>)
				: undefined;
	return { name, params };
}

function normalizeClipboard(
	value: unknown,
): EvaluationResult["copyToClipboard"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const title = typeof record.title === "string" ? record.title.trim() : "";
	const content =
		typeof record.content === "string" ? record.content.trim() : "";
	if (!title || !content) {
		return undefined;
	}
	const tags = Array.isArray(record.tags)
		? record.tags.map((tag) => String(tag).trim()).filter(Boolean)
		: undefined;
	return {
		title,
		content,
		...(tags && tags.length > 0 ? { tags } : {}),
	};
}
