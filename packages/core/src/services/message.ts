/**
 * Built-in `DefaultMessageService` (the runtime's `IMessageService` singleton) and
 * the helpers it composes, implementing the full inbound-message pipeline: memory
 * creation, should-respond gating, the pre-LLM shortcut gate, Stage-1 response
 * generation with its retry/truncation policy, the planner loop over tiered
 * actions, attachment enrichment, voice-turn arbitration, and post-turn evaluation
 * — turning a received `Memory` into a response plus any executed actions. The
 * runtime message loop drives it; a host may swap in an alternate `IMessageService`
 * to replace it wholesale.
 */
import { v4 } from "uuid";
import { formatActionNames, formatActions } from "../actions";
import {
	actionToTool,
	buildPlannerToolsFromTieredActions,
	CORE_PLANNER_TERMINALS,
	createHandleResponseTool,
	HANDLE_RESPONSE_TOOL_NAME,
} from "../actions/to-tool";
import { evaluateConnectorAccountPolicies } from "../connectors/account-manager";
import { createUniqueUuid } from "../entities";
import {
	formatTaskCompletionStatus,
	type TaskCompletionAssessment,
} from "../features/advanced-capabilities/evaluators/task-completion";
import {
	decideReplyGate,
	enforceVerbosity,
} from "../features/advanced-capabilities/personality";
import { getPersonalityStore } from "../features/advanced-capabilities/personality/services/personality-store.ts";
import { runShouldRespondInjectionGate } from "../features/trust/should-respond-risk-gate";
import {
	emitInferenceTiming,
	INFERENCE_MARKS,
	InferenceTurnTimer,
	markInference,
	nextInferenceTurnId,
	runWithInferenceTiming,
} from "../inference-timing";
import { logger } from "../logger";
import { describeImageCached } from "../media";
import { fetchRemoteMedia } from "../media/fetch";
import { imageDescriptionTemplate, messageHandlerTemplate } from "../prompts";
import {
	checkSenderRole,
	getUnresolvedSenderRoleFloor,
	hasAtLeastRole,
	isAdminRank,
} from "../roles";
import {
	type ActionCatalog,
	buildActionCatalog,
	type LocalizedActionExampleResolver,
} from "../runtime/action-catalog";
import { actionGateFailure, canActionRun } from "../runtime/action-gate";
import {
	parentAliasesForCandidateAction,
	retrieveActions,
} from "../runtime/action-retrieval";
import { tierActionResults } from "../runtime/action-tiering";
import {
	applyAddressedTo,
	messageAddressedToOtherParticipant,
} from "../runtime/addressed-to";
import { normalizeTopics } from "../runtime/builtin-field-evaluators";
import {
	type CandidateActionBackstopRule,
	getCandidateActionBackstopRules,
} from "../runtime/candidate-action-backstop";
import { filterProvidersByContextGate } from "../runtime/context-gates.ts";
import { computePrefixHashes, hashString } from "../runtime/context-hash";
import {
	appendContextEvent,
	createContextObject,
} from "../runtime/context-object";
import type { ContextRegistry } from "../runtime/context-registry";
import {
	normalizePromptSegments,
	renderContextObject,
	segmentBlock,
} from "../runtime/context-renderer";
import {
	getMessageHistoryCompactionHook,
	type MessageHistoryCompactionTelemetry,
} from "../runtime/conversation-compaction-hook";
import {
	type EvaluatorEffects,
	type EvaluatorOutput,
	runEvaluator,
} from "../runtime/evaluator";
import {
	type ExecutePlannedToolCallContext,
	type ExecutePlannedToolCallOptions,
	executePlannedToolCall,
} from "../runtime/execute-planned-tool-call";
import {
	type FactsAndRelationshipsRunResult,
	runFactsAndRelationshipsStage,
} from "../runtime/facts-and-relationships";
import {
	extractJsonObjects,
	parseJsonObject,
	stripJsonStructuralJunkReply,
} from "../runtime/json-output";
import { getLocalizedExamplesProvider } from "../runtime/localized-examples-provider";
import {
	getMessageHandlerReply,
	parseMessageHandlerOutput,
	routeMessageHandlerOutput,
	SIMPLE_CONTEXT_ID,
} from "../runtime/message-handler";
import {
	buildModelInputBudget,
	withModelInputBudgetProviderOptions,
} from "../runtime/model-input-budget";
import {
	actionResultToPlannerToolResult,
	cacheProviderOptions,
	type PlannerLoopParams,
	type PlannerLoopResult,
	type PlannerRuntime,
	type PlannerToolCall,
	type PlannerToolResult,
	type PlannerTrajectory,
	runPlannerLoop,
	summarizeActionResultForPlanner,
} from "../runtime/planner-loop";
import {
	extractReplyTextFromTranscript,
	looksLikeRawFieldTranscript,
} from "../runtime/response-field-transcript";
import {
	buildResponseGrammar,
	buildSpanSamplerPlan,
	withGuidedDecodeProviderOptions,
} from "../runtime/response-grammar";
import {
	type ResponseHandlerEvaluator,
	runResponseHandlerEvaluators,
} from "../runtime/response-handler-evaluators";
import type {
	ResponseHandlerFieldContext,
	ResponseHandlerFieldEvaluator,
	ResponseHandlerFieldRunResult,
	ResponseHandlerResult,
	ResponseHandlerSenderRole,
} from "../runtime/response-handler-field-evaluator";
import type { ResponseHandlerFieldSelectionOptions } from "../runtime/response-handler-field-registry";
import type { ShortcutRegistry } from "../runtime/shortcut-registry";
import { actionHasSubActions, runSubPlanner } from "../runtime/sub-planner";
import { buildCanonicalSystemPrompt } from "../runtime/system-prompt";
import { resolveTraceCorrelationFromEnv } from "../runtime/trace-correlation";
import {
	createJsonFileTrajectoryRecorder,
	finalizeTrajectoryRecording,
	isTrajectoryRecordingEnabled,
	type TrajectoryRecorder,
} from "../runtime/trajectory-recorder";
import { TurnAbortedError } from "../runtime/turn-controller";
import {
	getModelStreamChunkDeliveryDepth,
	getStreamingContext,
	runWithStreamingContext,
	type StreamingContext,
} from "../streaming-context";
import {
	getTrajectoryContext,
	runWithTrajectoryContext,
} from "../trajectory-context";
import type {
	Action,
	ActionResult,
	AgentContext,
	HandlerCallback,
	MessageHandlerResult,
	Provider,
	StreamChunkCallback,
} from "../types/components";
import type { ContextEvent, ContextObject } from "../types/context-object";
import type { ContextDefinition, RoleGateRole } from "../types/contexts";
import type { Room } from "../types/environment";
import type { RunEventPayload } from "../types/events";
import { EventType } from "../types/events";
import type { Memory } from "../types/memory";
import type {
	ContextRoutedResponseDecision,
	IMessageService,
	MessageProcessingOptions,
	MessageProcessingResult,
	ShouldRespondModelType,
} from "../types/message-service";
import { MESSAGE_SOURCE_CLIENT_CHAT } from "../types/message-source";
import type {
	ChatMessage,
	GenerateTextAttachment,
	GenerateTextParams,
	GenerateTextResult,
	PromptSegment,
	TextToSpeechParams,
	ToolDefinition,
} from "../types/model";
import { ModelType } from "../types/model";
import {
	incomingPipelineHookContext,
	modelStreamChunkPipelineHookContext,
	outgoingPipelineHookContext,
	parallelWithShouldRespondPipelineHookContext,
	preShouldRespondPipelineHookContext,
} from "../types/pipeline-hooks";
import type {
	Content,
	JsonValue,
	Media,
	MentionContext,
	UUID,
} from "../types/primitives";
import { asUUID, ChannelType, ContentType } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { ShortcutMatch } from "../types/shortcut";
import type { State } from "../types/state";
import type {
	StreamingContextEventPayload,
	StreamingEvaluationPayload,
	StreamingToolCallPayload,
	StreamingToolResultPayload,
} from "../types/streaming";
import {
	composePrompt,
	getLocalServerUrl,
	parseBooleanFromText,
	parseJSONObjectFromText,
	truncateToCompleteSentence,
} from "../utils";
import {
	collectActionResultSizeWarnings,
	formatActionResultsForPrompt,
	trimActionResultForPromptState,
} from "../utils/action-results";
import {
	AVAILABLE_CONTEXTS_STATE_KEY,
	attachAvailableContexts,
	CONTEXT_ROUTING_METADATA_KEY,
	CONTEXT_ROUTING_STATE_KEY,
	type ContextRoutingDecision,
	getActiveRoutingContexts,
	inferContextRoutingFromMessage,
	isPageScopedRoutingContext,
	parseContextRoutingMetadata,
	setContextRoutingMetadata,
} from "../utils/context-routing";
import { getUserMessageText } from "../utils/message-text";
import { readEnv } from "../utils/read-env";
import {
	extractFirstSentence,
	hasFirstSentence,
} from "../utils/text-splitting";
import { isObjectRecord as isRecord } from "../utils/type-guards";
import { maybeHandleAnalysisActivation } from "./analysis-mode-handler";
import { ChannelTopicsService } from "./channel-topics";
import { runPostTurnEvaluators } from "./evaluator";
import { runBotNoiseTriage } from "./message/bot-noise-triage";
import {
	findCodingDelegationActionName,
	findShellDirectActionName,
	findWebLookupActionName,
	findWebLookupActionNames,
	inferDirectCurrentRequestCandidateActions as inferDirectCurrentRequestCandidateActionsFromHeuristics,
	inferLocalShellCommandFromMessageText,
	inferWebSearchQueryFromMessageText,
	isShellDirectActionName,
	LEGACY_CODING_DELEGATION_ACTION_NAMES,
	looksLikeLocalShellRequest,
	looksLikeWebSearchRequest,
	normalizeActionIdentifier,
} from "./message/direct-action-heuristics";
import {
	buildFailureReplyPrompt,
	INSUFFICIENT_CREDITS_REPLY,
	isAuthError,
	isInsufficientCreditsError,
	isRateLimitError,
	stripReasoningBlocks,
} from "./message/fallback-reply";
import {
	extractGenerateTextContentText,
	getV5ModelText,
} from "./message/generate-text-result";
import { resolveEffectiveMuteState } from "./message/mute-state";
import {
	GROUP_TRIAGE_MESSAGE_HANDLER_TEMPLATE,
	isStage1GroupTriageTierEnabled,
	isUnaddressedTextGroupTurn,
} from "./message/stage1-prompt-tier";
import type { OptimizedPromptTask } from "./optimized-prompt";
import {
	type OptimizedPromptRuntimeLike,
	resolveOptimizedPromptForRuntime,
} from "./optimized-prompt-resolver";

export {
	findWebLookupActionName,
	findWebLookupActionNames,
	inferLocalShellCommandFromMessageText,
	inferWebSearchQueryFromMessageText,
};

const DEFAULT_STAGE1_MAX_TOKENS = 2048;
const STAGE1_TRUNCATION_REPLY =
	"That answer got cut off before I could finish it. Please try again with a shorter request or ask for a narrower format.";
const CODE_SNIPPET_VALIDITY_INSTRUCTION =
	"For code snippets, prioritize syntactically valid runnable code over impossible formatting constraints. If a tight line count would require invalid syntax, provide a valid version and briefly note the constraint tradeoff.";
const COMPACT_CODE_SNIPPET_VALIDITY_INSTRUCTION =
	"For code snippets, prefer valid runnable syntax over impossible formatting constraints.";
const DIRECT_CHANNEL_OMITTED_RESPONSE_FIELDS = new Set([
	"shouldRespond",
	"facts",
	"relationships",
	"topics",
	"addressedTo",
	"emotion",
]);

function buildDirectChannelResponseFieldSelection(
	fields: ReadonlyArray<Pick<ResponseHandlerFieldEvaluator, "name">>,
): ResponseHandlerFieldSelectionOptions {
	const includeFieldNames = new Set<string>();
	for (const field of fields) {
		if (!DIRECT_CHANNEL_OMITTED_RESPONSE_FIELDS.has(field.name)) {
			includeFieldNames.add(field.name);
		}
	}
	return { includeFieldNames };
}

function mergeAbortSignals(
	signals: Array<AbortSignal | undefined>,
): AbortSignal | undefined {
	const active = signals.filter(
		(signal): signal is AbortSignal => signal !== undefined,
	);
	if (active.length === 0) return undefined;
	if (active.length === 1) return active[0];
	const controller = new AbortController();
	const abort = (signal: AbortSignal) => {
		if (!controller.signal.aborted) {
			controller.abort(signal.reason);
		}
	};
	for (const signal of active) {
		if (signal.aborted) {
			abort(signal);
			break;
		}
		signal.addEventListener("abort", () => abort(signal), { once: true });
	}
	return controller.signal;
}

function canonicalPlannerControlActionName(actionName: string): string | null {
	const normalized = normalizeActionIdentifier(actionName);
	switch (normalized) {
		case "REPLY":
		case "RESPOND":
			return "REPLY";
		case "IGNORE":
			return "IGNORE";
		case "STOP":
			return "STOP";
		default:
			return null;
	}
}

function isReplyActionIdentifier(actionName: string): boolean {
	return canonicalPlannerControlActionName(actionName) === "REPLY";
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textContainsAgentName(
	text: string | undefined,
	names: Array<string | null | undefined>,
): boolean {
	if (!text) {
		return false;
	}

	return names.some((name) => {
		const candidate = name?.trim();
		if (!candidate) {
			return false;
		}

		const pattern = new RegExp(
			`(^|[^\\p{L}\\p{N}])${escapeRegex(candidate)}(?=$|[^\\p{L}\\p{N}])`,
			"iu",
		);
		return pattern.test(text);
	});
}

function textContainsUserTag(text: string | undefined): boolean {
	if (!text) {
		return false;
	}

	const safeText = text.length > 10_000 ? text.slice(0, 10_000) : text;
	return /<@!?[^>]+>|@\w+/u.test(safeText);
}

/**
 * Structural "this message addresses the agent" signal: platform mention,
 * platform reply-to-agent, or the agent's name/username appearing in the
 * text. Shared by the reply gate, the bot-noise TEXT_SMALL triage, and the
 * Stage-1 prompt tier so all three branch on the same ground truth.
 */
function messageExplicitlyAddressesAgent(
	runtime: IAgentRuntime,
	message: Memory,
): boolean {
	const mentionContext = message.content?.mentionContext;
	return (
		mentionContext?.isMention === true ||
		mentionContext?.isReply === true ||
		textContainsAgentName(message.content?.text, [
			runtime.character?.name,
			runtime.character?.username,
		])
	);
}

function getPlannerActionObjectName(action: Record<string, unknown>): string {
	const rawName = action.name ?? action.action ?? action.actionName;
	return typeof rawName === "string" ? unwrapPlannerIdentifier(rawName) : "";
}

function attachInlinePlannerActionParams(
	parsedPlanner: Record<string, unknown>,
	actionName: string,
	params: unknown,
): void {
	if (!actionName || !isRecord(params) || Object.keys(params).length === 0) {
		return;
	}

	const existingParams = parsedPlanner.params;
	const nextParams =
		isRecord(existingParams) && !Array.isArray(existingParams)
			? { ...existingParams }
			: {};
	nextParams[actionName.trim().toUpperCase()] = params;
	parsedPlanner.params = nextParams;
}

function splitPlannerActionList(actionsText: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let inParams = false;
	let inJsonString = false;
	let jsonEscape = false;
	let jsonDepth = 0;
	const lower = actionsText.toLowerCase();

	for (let index = 0; index < actionsText.length; index += 1) {
		if (!inJsonString && lower.startsWith("<params", index)) {
			inParams = true;
			const close = actionsText.indexOf(">", index);
			if (close >= 0) {
				index = close;
			}
			continue;
		}
		if (!inJsonString && lower.startsWith("</params>", index)) {
			inParams = false;
			index += "</params>".length - 1;
			continue;
		}

		const char = actionsText[index];
		if (!inParams) {
			if (inJsonString) {
				if (jsonEscape) {
					jsonEscape = false;
				} else if (char === "\\") {
					jsonEscape = true;
				} else if (char === '"') {
					inJsonString = false;
				}
			} else if (jsonDepth > 0 && char === '"') {
				inJsonString = true;
			} else if (char === "{") {
				jsonDepth += 1;
			} else if (char === "}" && jsonDepth > 0) {
				jsonDepth -= 1;
			}
		}

		if (char === "," && !inParams && jsonDepth === 0 && !inJsonString) {
			parts.push(actionsText.slice(start, index));
			start = index + 1;
		}
	}

	parts.push(actionsText.slice(start));
	return parts;
}

function parseInlinePlannerParams(
	value: string,
): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(value);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function extractInlinePlannerActionParams(value: string): {
	name: string;
	params?: Record<string, unknown>;
} {
	const inlineJsonMatch = value.match(
		/^\s*([A-Z][A-Z0-9_:-]*)\s+(\{[\s\S]*\})\s*$/i,
	);
	if (inlineJsonMatch) {
		const params = parseInlinePlannerParams(inlineJsonMatch[2]);
		if (params) {
			return {
				name: unwrapPlannerIdentifier(inlineJsonMatch[1]),
				params,
			};
		}
	}

	const inlineParamsMatch = value.match(
		/^([\s\S]*?)\s*<params\b[^>]*>([\s\S]*?)<\/params>\s*$/i,
	);
	if (inlineParamsMatch) {
		return {
			name: unwrapPlannerIdentifier(inlineParamsMatch[1]),
			params: parseInlinePlannerParams(inlineParamsMatch[2]) ?? undefined,
		};
	}

	return { name: unwrapPlannerIdentifier(value) };
}

export function extractPlannerActionNames(
	parsedPlanner: Record<string, unknown>,
): string[] {
	return (() => {
		if (typeof parsedPlanner.actions === "string") {
			return splitPlannerActionList(parsedPlanner.actions)
				.map((action) => {
					const { name, params } = extractInlinePlannerActionParams(
						String(action),
					);
					attachInlinePlannerActionParams(parsedPlanner, name, params);
					return name;
				})
				.filter((action) => action.length > 0);
		}
		if (Array.isArray(parsedPlanner.actions)) {
			return parsedPlanner.actions
				.map((action) => {
					if (isRecord(action)) {
						const actionName = getPlannerActionObjectName(action);
						attachInlinePlannerActionParams(
							parsedPlanner,
							actionName,
							action.params,
						);
						return actionName;
					}
					const { name, params } = extractInlinePlannerActionParams(
						String(action),
					);
					attachInlinePlannerActionParams(parsedPlanner, name, params);
					return name;
				})
				.filter((action) => action.length > 0);
		}
		return [];
	})();
}

function _normalizePlannerActions(
	parsedPlanner: Record<string, unknown>,
	runtime: IAgentRuntime,
): string[] {
	const normalizedActions = extractPlannerActionNames(parsedPlanner);

	const finalActions =
		!runtime.isActionPlanningEnabled() && normalizedActions.length > 1
			? [normalizedActions[0]]
			: normalizedActions;

	const actionLookup = buildRuntimeActionLookup(runtime);
	const validActions = finalActions.flatMap((actionName) => {
		const normalized = normalizeActionIdentifier(actionName);
		if (!normalized) {
			return [];
		}

		const controlActionName = canonicalPlannerControlActionName(actionName);
		if (controlActionName) {
			return [controlActionName];
		}

		const resolvedAction = resolveRuntimeAction(actionLookup, actionName);
		if (resolvedAction) {
			return [resolvedAction.name];
		}

		runtime.logger.warn(
			{
				src: "service:message",
				actionName,
			},
			"Dropping unknown planner action",
		);
		return [];
	});

	if (validActions.length > 0) {
		return validActions;
	}

	const replyText =
		typeof parsedPlanner.text === "string" ? parsedPlanner.text.trim() : "";
	if (replyText.length > 0) return ["REPLY"];

	// Fallthrough: no valid action, no text. By the time the planner ran,
	// the shouldRespond gate already decided the bot needed to respond, so
	// landing on IGNORE here means the user sees silence even though the
	// framework chose to engage. That reads as "the bot is broken" to the
	// operator. Coerce to REPLY so the agent's reply handler emits at
	// least a short clarifying message (e.g. "not sure what you want — can
	// you be more specific?"). The only downside is an extra reply turn
	// on rare cases where the LLM emitted a totally empty response; that's
	// a better failure mode than dead silence.
	return ["REPLY"];
}

export function resolvePlannerActionName(
	runtime: Pick<IAgentRuntime, "actions" | "logger">,
	actionLookup: Map<string, Action> | undefined,
	actionName: string,
	options?: { strict?: boolean },
): string[] {
	const lookup =
		actionLookup ?? buildRuntimeActionLookup(runtime as IAgentRuntime);
	const resolved = resolvePlannerActionNameFromLookup(lookup, actionName);
	if (resolved.length > 0) {
		return resolved;
	}

	// In strict mode don't fall back to the full registry — LLM aliases
	// like WRITE -> FILE would defeat a candidateActions narrow.
	if (actionLookup && !options?.strict) {
		const runtimeResolved = resolvePlannerActionNameFromLookup(
			buildRuntimeActionLookup(runtime as IAgentRuntime),
			actionName,
		);
		if (runtimeResolved.length > 0) {
			return runtimeResolved;
		}
	}

	runtime.logger.warn(
		{
			src: "service:message",
			actionName,
		},
		"Dropping unknown planner action",
	);
	return [];
}

function resolvePlannerActionNameFromLookup(
	lookup: Map<string, Action>,
	actionName: string,
): string[] {
	const normalized = normalizeActionIdentifier(actionName);
	if (!normalized) {
		return [];
	}

	const controlActionName = canonicalPlannerControlActionName(actionName);
	if (controlActionName) {
		return [controlActionName];
	}

	const resolvedAction = resolveRuntimeAction(lookup, actionName);
	if (resolvedAction) {
		return [resolvedAction.name];
	}

	return [];
}

const CORE_RESPONSE_STATE_PROVIDERS = [
	"RUNTIME_MODEL_CONTEXT",
	"UI_CONTEXT",
	"ENTITIES",
	"RECENT_MESSAGES",
	"ATTACHMENTS",
	"PLATFORM_CHAT_CONTEXT",
	"PLATFORM_USER_CONTEXT",
	"RUNTIME_MODEL_CONTEXT",
	// FACTS is dynamic and would otherwise never run during response
	// composition. Stage 1 keeps it rendered when present (see
	// STAGE1_EXTRA_PROVIDER_EXCLUSIONS) precisely so durable user facts
	// ("my dog's name is Jeff", "my car is named Bertha") persisted by the
	// facts-and-relationships stage can be recalled on a later turn — even a
	// simple-path turn after the source message has scrolled out of the
	// RECENT_MESSAGES window. Without this, stored facts are written but
	// never retrieved into the answer. FACTS is cacheStable:false /
	// cacheScope:"turn" and BM25-ranked against the current message, so its
	// rendered text varies per turn (like CURRENT_TIME); we accept that
	// prefix-cache churn and token cost as the price of cross-turn recall.
	"FACTS",
	// CURRENT_TIME is dynamic and would otherwise be filtered out before
	// reaching the response handler. The wall-clock time is a baseline
	// signal for nearly every routing decision (scheduling, freshness of
	// recent messages, "today/tomorrow" parsing), so it's always-on here.
	"CURRENT_TIME",
];

/**
 * Names of registered providers that opted into always-on Stage-1 response
 * state via `alwaysInResponseState`. Composed regardless of selected contexts,
 * so a plugin's dynamic provider reaches Stage 1 without core naming it.
 */
function alwaysOnResponseStateProviderNames(runtime: IAgentRuntime): string[] {
	const providers = Array.isArray(runtime.providers)
		? (runtime.providers as Provider[])
		: [];
	const names: string[] = [];
	for (const provider of providers) {
		const name = provider.name?.trim();
		if (provider.alwaysInResponseState && name && !provider.private) {
			names.push(name);
		}
	}
	return names;
}

/**
 * Provider names that must NEVER be rendered as text blocks in the v5
 * ContextObject because they're already conveyed through another channel:
 *   - ACTIONS / PROVIDERS / ACTION_STATE: meta-listings — the planner sees
 *     actions as native function tools, so a parallel text block is
 *     duplicative and confusing.
 *   - CHARACTER: already rendered via `staticPrefix.systemPrompt` (which
 *     includes system + bio + role) so the text-block CHARACTER provider
 *     would duplicate the same content.
 * RECENT_MESSAGES stays included because Stage 1 needs full prior dialogue
 * text when no structured `recentMessages` array is available from the
 * provider. Structured prior turns are additionally rendered by
 * `appendPriorDialogueEvents`.
 */
const MODEL_CONTEXT_PROVIDER_EXCLUSIONS = [
	"ACTIONS",
	"ACTION_STATE",
	"CHARACTER",
	"PROVIDERS",
] as const;

const MODEL_CONTEXT_PROVIDER_EXCLUSION_SET = new Set<string>(
	MODEL_CONTEXT_PROVIDER_EXCLUSIONS,
);

/**
 * Stage 1 (messageHandler / shouldRespond) does NOT need wall-clock,
 * room entities, or document store context. It just decides
 * processMessage + which contexts apply. Excluding these from the
 * Stage 1 prompt keeps the user message byte-stable across responses
 * (no per-call CURRENT_TIME drift) so the provider's prefix cache
 * grows with the conversation rather than resetting every turn.
 *
 * These exclusions apply to COMPOSITION as well as rendering:
 * `composeResponseState` subtracts them from the include list it hands
 * `composeState`, so the providers never execute for a Stage-1-only turn
 * (ENTITIES is a room-participant DB fetch per inbound message — pure
 * waste on group noise that ends in IGNORE, since nothing on the Stage-1
 * or simple-reply path reads its output). Planner turns still get them:
 * `selectV5PlannerStateProviderNames` re-adds the core set and the
 * planner recompose runs any provider missing from the turn's cached
 * state (see composeState's refreshProviders contract in runtime.ts).
 *
 * Note: we still keep FACTS composed and rendered — Stage 1 may need a
 * grounded fact to discriminate ambiguous routing, and stored facts must
 * be recallable on the simple path (see CORE_RESPONSE_STATE_PROVIDERS).
 */
const STAGE1_EXTRA_PROVIDER_EXCLUSIONS = [
	"CURRENT_TIME",
	"ENTITIES",
	"DOCUMENTS",
] as const;

function isCurrentTimeQuestion(message: Memory): boolean {
	const text = message.content.text?.toLowerCase() ?? "";
	if (!text) return false;
	return /\b(?:what(?:'s| is)?|tell me|give me|do you know|current)\b[\s\S]{0,80}\b(?:date|time|year|day|today)\b/.test(
		text,
	);
}

function stage1ProviderExclusionsForMessage(message: Memory): string[] {
	const exclusions = [...STAGE1_EXTRA_PROVIDER_EXCLUSIONS];
	if (isCurrentTimeQuestion(message)) {
		const index = exclusions.indexOf("CURRENT_TIME");
		if (index >= 0) exclusions.splice(index, 1);
	}
	return exclusions;
}
function hasInboundBenchmarkContext(message: Memory): boolean {
	const metadata = message.metadata as Record<string, unknown> | undefined;
	const benchmarkContext = metadata?.benchmarkContext;
	return (
		typeof benchmarkContext === "string" && benchmarkContext.trim().length > 0
	);
}

/**
 * Returns true when the current turn was issued by a benchmark harness AND the
 * `ELIZA_BENCH_FORCE_TOOL_CALL` env opt-in is set. Used to bias the planner
 * toward emitting structured tool calls instead of routing every turn through
 * `REPLY`, which is what tool-calling benchmark harnesses score against.
 *
 * Detection is intentionally narrow: we require BOTH
 *   1. an env-var opt-in (so default behavior is unchanged for normal chat), AND
 *   2. an inbound benchmark signal on the message itself
 *      (`content.metadata.benchmark` is set, or `content.source === "benchmark"`).
 *
 * This means flipping the env var on a process that also serves real chat
 * traffic still leaves normal turns alone — only requests that arrive with the
 * bench-server metadata get the tool-call boost.
 */
/**
 * True when the turn came from a benchmark suite that grades the reply TEXT
 * (the standard public suite: MMLU / GSM8K / HumanEval / MT-Bench). Those
 * turns must never hard-force a non-terminal tool call — neither via
 * `ELIZA_BENCH_FORCE_TOOL_CALL` nor via a Stage-1 `requiresTool` vote. The
 * Stage-1 classifier reliably over-flags hard exam questions as
 * tool-requiring (observed live: `candidateActions: ["VIEWS"]` on
 * abstract-algebra MCQs); forcing then makes the planner either loop into a
 * `required_tool_misses` TrajectoryLimitExceeded apology or run a junk tool
 * whose capture text becomes the graded reply. Planning stays on "auto" —
 * the planner can still call a tool when one genuinely helps.
 */
function isTextScoredBenchmarkTurn(message: Memory): boolean {
	const benchmark = (
		message.content?.metadata as Record<string, unknown> | undefined
	)?.benchmark;
	return (
		typeof benchmark === "string" &&
		benchmark.trim().toLowerCase() === "standard"
	);
}

function isBenchmarkForcingToolCall(message: Memory): boolean {
	if (process.env.ELIZA_BENCH_FORCE_TOOL_CALL !== "1") return false;
	const content = message.content;
	if (!content) return false;
	const benchmark = (content.metadata as Record<string, unknown> | undefined)
		?.benchmark;
	if (
		typeof benchmark === "string" &&
		benchmark.trim().toLowerCase() === "vending-bench"
	) {
		return false;
	}
	if (content.source === "benchmark") return true;
	const contentMetadata = content.metadata as
		| Record<string, unknown>
		| undefined;
	if (
		contentMetadata &&
		typeof contentMetadata.benchmark === "string" &&
		contentMetadata.benchmark.trim().length > 0
	) {
		return true;
	}
	return false;
}

function hasPageScopedRoutingMetadata(message: Memory): boolean {
	const metadataCandidates = [message.content?.metadata, message.metadata];
	for (const rawMetadata of metadataCandidates) {
		if (!rawMetadata || typeof rawMetadata !== "object") continue;
		const routing = parseContextRoutingMetadata(
			(rawMetadata as Record<string, unknown>)[CONTEXT_ROUTING_METADATA_KEY],
		);
		if (
			isPageScopedRoutingContext(routing.primaryContext) ||
			routing.secondaryContexts?.some(isPageScopedRoutingContext)
		) {
			return true;
		}
	}
	return false;
}

function latestMessageHistoryCompactionTelemetry(
	state: State,
): MessageHistoryCompactionTelemetry | undefined {
	const value = state.data?.messageHistoryCompaction;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	// The guards above narrow `value` to a non-null, non-array object, so a plain
	// downcast suffices here — no `as unknown` laundering needed.
	return value as MessageHistoryCompactionTelemetry;
}

function appendMessageHistoryCompactionTelemetry(
	state: State,
	telemetry: MessageHistoryCompactionTelemetry,
): State {
	const history = Array.isArray(state.data?.messageHistoryCompactionHistory)
		? state.data.messageHistoryCompactionHistory
		: [];
	return {
		...state,
		data: {
			...state.data,
			messageHistoryCompaction: telemetry,
			messageHistoryCompactionHistory: [...history, telemetry].slice(-10),
		},
	};
}

async function applyMessageHistoryCompactionHook(
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
	source:
		| "compose-response-state"
		| "provider-grounded-state"
		| "continuation-state",
): Promise<State> {
	const hook = getMessageHistoryCompactionHook(runtime);
	if (!hook) return state;
	try {
		const result = await hook({ runtime, message, state, source });
		if (!result?.state) return state;
		return result.telemetry
			? appendMessageHistoryCompactionTelemetry(result.state, result.telemetry)
			: result.state;
	} catch (error) {
		runtime.logger.warn(
			{
				src: "service:message",
				error: error instanceof Error ? error.message : String(error),
			},
			"Message-history compaction hook failed",
		);
		return state;
	}
}

function withMessageHistoryCompactionProviderOptions<
	T extends Record<string, unknown>,
>(providerOptions: T, state: State): T {
	const telemetry = latestMessageHistoryCompactionTelemetry(state);
	if (!telemetry) return providerOptions;
	const eliza =
		typeof providerOptions.eliza === "object" && providerOptions.eliza !== null
			? (providerOptions.eliza as Record<string, unknown>)
			: {};
	return {
		...providerOptions,
		eliza: {
			...eliza,
			messageHistoryCompaction: telemetry,
		},
	} as T;
}

/**
 * The provider include list for Stage-1 response-state composition: the core
 * response providers plus always-on plugin providers, minus the Stage-1
 * exclusions (which are execution exclusions, not just render exclusions —
 * see STAGE1_EXTRA_PROVIDER_EXCLUSIONS). Exported for tests.
 */
export function stage1ResponseStateProviderNames(
	runtime: IAgentRuntime,
	message: Memory,
): string[] {
	const exclusions = new Set(stage1ProviderExclusionsForMessage(message));
	return [
		...CORE_RESPONSE_STATE_PROVIDERS,
		...alwaysOnResponseStateProviderNames(runtime),
		...(hasInboundBenchmarkContext(message) ? ["CONTEXT_BENCH"] : []),
	].filter((name) => !exclusions.has(name));
}

async function composeResponseState(
	runtime: IAgentRuntime,
	message: Memory,
	skipCache = false,
): Promise<State> {
	const providers = stage1ResponseStateProviderNames(runtime, message);
	if (hasPageScopedRoutingMetadata(message)) {
		const state = await runtime.composeState(
			message,
			[...providers, "page-scoped-context"],
			true,
			skipCache,
		);
		return applyMessageHistoryCompactionHook(
			runtime,
			message,
			state,
			"compose-response-state",
		);
	}
	const state = await runtime.composeState(message, providers, true, skipCache);
	return applyMessageHistoryCompactionHook(
		runtime,
		message,
		state,
		"compose-response-state",
	);
}

export function selectV5PlannerStateProviderNames(args: {
	runtime: IAgentRuntime;
	message: Memory;
	selectedContexts: readonly AgentContext[];
	userRoles: readonly RoleGateRole[];
}): string[] {
	const providerNames = new Set<string>(CORE_RESPONSE_STATE_PROVIDERS);
	if (hasInboundBenchmarkContext(args.message)) {
		providerNames.add("CONTEXT_BENCH");
	}

	const providers = Array.isArray(args.runtime.providers)
		? (args.runtime.providers as Provider[])
		: [];
	// Always-on response-state providers opt in via `alwaysInResponseState` and
	// are composed regardless of the turn's selected contexts (like the core
	// FACTS / CURRENT_TIME signals) — so a plugin's dynamic provider can reach
	// Stage 1 without core naming it.
	for (const name of alwaysOnResponseStateProviderNames(args.runtime)) {
		providerNames.add(name);
	}
	// filterProvidersByContextGate honors the FULL declared contextGate
	// (anyOf/allOf/noneOf) plus the catalog fallback for undeclared providers —
	// the plain {contexts, roleGate} reduction dropped world-style gates (#13203).
	for (const provider of filterProvidersByContextGate(
		providers,
		args.selectedContexts,
		args.userRoles,
	)) {
		const name = provider.name?.trim();
		if (!name || provider.private) {
			continue;
		}
		if (MODEL_CONTEXT_PROVIDER_EXCLUSION_SET.has(name.toUpperCase())) {
			continue;
		}
		providerNames.add(name);
	}

	return [...providerNames];
}

function _ensureActionStateValues(
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
): State {
	const currentActionNames =
		typeof state.values?.actionNames === "string" &&
		state.values.actionNames.trim().length > 0
			? state.values.actionNames
			: null;
	const currentDescriptions =
		typeof state.values?.actionsWithDescriptions === "string" &&
		state.values.actionsWithDescriptions.trim().length > 0
			? state.values.actionsWithDescriptions
			: null;

	if (currentActionNames && currentDescriptions) {
		return state;
	}

	const actionProviderEntry =
		state.data?.providers &&
		typeof state.data.providers === "object" &&
		state.data.providers !== null &&
		"ACTIONS" in state.data.providers
			? (state.data.providers.ACTIONS as {
					values?: Record<string, unknown>;
					data?: Record<string, unknown>;
				})
			: null;
	const providerValues =
		actionProviderEntry?.values &&
		typeof actionProviderEntry.values === "object" &&
		actionProviderEntry.values !== null
			? actionProviderEntry.values
			: null;

	let actionNames = currentActionNames;
	if (
		!actionNames &&
		typeof providerValues?.actionNames === "string" &&
		providerValues.actionNames.trim().length > 0
	) {
		actionNames = providerValues.actionNames;
	}

	let actionsWithDescriptions = currentDescriptions;
	if (
		!actionsWithDescriptions &&
		typeof providerValues?.actionsWithDescriptions === "string" &&
		providerValues.actionsWithDescriptions.trim().length > 0
	) {
		actionsWithDescriptions = providerValues.actionsWithDescriptions;
	}

	const actionsData =
		actionProviderEntry?.data &&
		typeof actionProviderEntry.data === "object" &&
		actionProviderEntry.data !== null &&
		"actionsData" in actionProviderEntry.data &&
		Array.isArray(actionProviderEntry.data.actionsData)
			? (actionProviderEntry.data.actionsData as Action[])
			: runtime.actions;

	if ((!actionNames || !actionsWithDescriptions) && actionsData.length > 0) {
		const actionSeed = `${runtime.agentId}:${message.roomId}:ACTIONS`;
		if (!actionNames) {
			actionNames = `Possible response actions: ${formatActionNames(actionsData, actionSeed)}`;
		}
		if (!actionsWithDescriptions) {
			actionsWithDescriptions = `# Available Actions\n${formatActions(actionsData, actionSeed)}`;
		}
	}

	if (!actionNames && !actionsWithDescriptions) {
		return state;
	}

	return {
		...state,
		values: {
			...(state.values ?? {}),
			...(actionNames ? { actionNames } : {}),
			...(actionsWithDescriptions ? { actionsWithDescriptions } : {}),
		},
	};
}

/**
 * Escape Handlebars syntax in a string to prevent template injection.
 *
 * WHY: When embedding LLM-generated text into continuation prompts, the text
 * goes through Handlebars.compile(). If the LLM output contains {{variable}},
 * Handlebars will try to substitute it with state values, corrupting the prompt.
 *
 * This function escapes {{ to \\{{ so Handlebars outputs literal {{.
 *
 * @param text - Text that may contain Handlebars-like syntax
 * @returns Text with {{ escaped to prevent interpretation
 */
function _escapeHandlebars(text: string): string {
	// Single-pass replacement to avoid double-escaping triple braces.
	return text.replace(/\{\{\{|\{\{/g, (match) => `\\${match}`);
}

type MediaWithInlineData = Media & {
	_data?: unknown;
	_mimeType?: unknown;
};

/**
 * Hard cap on bytes fetched while enriching a single attachment (description /
 * transcription / text extraction). Bounds memory and is enforced by the
 * SSRF-guarded fetcher for remote URLs and explicitly for local ones.
 */
const ATTACHMENT_FETCH_MAX_BYTES = 50 * 1024 * 1024;

function sanitizeAttachmentsForStorage(
	attachments: Media[] | undefined,
): Media[] | undefined {
	if (!attachments?.length) {
		return attachments;
	}

	return attachments.map((attachment) => {
		const {
			_data: _discardData,
			_mimeType: _discardMimeType,
			...rest
		} = attachment as MediaWithInlineData;
		return rest;
	});
}

function _resolvePromptAttachments(
	attachments: Media[] | undefined,
): GenerateTextAttachment[] | undefined {
	if (!attachments?.length) {
		return undefined;
	}

	const resolved = attachments.flatMap((attachment) => {
		const withInlineData = attachment as MediaWithInlineData;
		if (
			typeof withInlineData._data === "string" &&
			withInlineData._data.trim() &&
			typeof withInlineData._mimeType === "string" &&
			withInlineData._mimeType.trim()
		) {
			return [
				{
					data: withInlineData._data,
					mediaType: withInlineData._mimeType,
					filename: attachment.title,
				},
			];
		}

		const dataUrlMatch = attachment.url.match(/^data:([^;,]+);base64,(.+)$/i);
		if (dataUrlMatch) {
			return [
				{
					data: dataUrlMatch[2],
					mediaType: dataUrlMatch[1],
					filename: attachment.title,
				},
			];
		}

		return [];
	});

	return resolved.length > 0 ? resolved : undefined;
}

/**
 * Resolved message options with defaults applied.
 * Required numeric options + optional streaming callback.
 */
type ResolvedMessageOptions = {
	maxRetries: number;
	timeoutDuration: number;
	continueAfterActions: boolean;
	keepExistingResponses: boolean;
	onStreamChunk?: StreamChunkCallback;
	shouldRespondModel: ShouldRespondModelType;
	/**
	 * Per-turn abort signal threaded into the streaming context so
	 * `runtime.useModel` and model handlers downstream can cancel
	 * in-flight inference. Sourced from `MessageProcessingOptions.abortSignal`.
	 */
	abortSignal?: AbortSignal;
};

function normalizeShouldRespondModelType(
	value: unknown,
): ShouldRespondModelType {
	if (typeof value !== "string") {
		return "response-handler";
	}

	const normalized = value.trim().toLowerCase();
	switch (normalized) {
		case "nano":
		case "text_nano":
			return "nano";
		case "small":
		case "text_small":
			return "small";
		case "large":
		case "text_large":
			return "large";
		case "mega":
		case "text_mega":
			return "mega";
		case "response-handler":
		case "response_handler":
		case "responsehandler":
			return "response-handler";
		case "response_handler_model":
			return "response-handler";
		default:
			return "response-handler";
	}
}

/**
 * Strategy mode for response generation
 */
type StrategyMode = "simple" | "actions" | "none";

/**
 * Strategy result from core processing
 */
interface StrategyResult {
	responseContent: Content | null;
	responseMessages: Memory[];
	state: State;
	mode: StrategyMode;
}

/**
 * Outcome of attempting the fallback model loop in
 * `buildStructuredFailureReply`. `noProvider` means a model call surfaced
 * `NoModelProviderConfiguredError`; the caller must short-circuit to
 * `buildNoModelProviderReply` instead of continuing the loop.
 */
type FailureReplyAttempt =
	| { kind: "text"; value: string }
	| { kind: "noProvider" }
	| { kind: "creditsExhausted" }
	| { kind: "rateLimited" }
	| { kind: "authFailed" };

export function shouldSkipResponseMemoryPersistence(memory: Memory): boolean {
	const content = memory.content as Record<string, unknown> | undefined;
	const metadata = memory.metadata as Record<string, unknown> | undefined;
	return (
		content?.doNotPersist === true ||
		content?.skipMemory === true ||
		content?.transient === true ||
		metadata?.doNotPersist === true ||
		metadata?.skipMemory === true ||
		metadata?.transient === true
	);
}

export {
	buildFailureReplyPrompt,
	INSUFFICIENT_CREDITS_REPLY,
	isAuthError,
	isInsufficientCreditsError,
	isInsufficientCreditsMessage,
	isModelProviderFallbackError,
	isRateLimitError,
	stripReasoningBlocks,
} from "./message/fallback-reply";

export {
	type EffectiveMuteState,
	muteExpiryDue,
	resolveEffectiveMuteState,
	resolveMutedTargetFlags,
	roomMuteActive,
	setRoomMuteUntil,
	setWorldMuteState,
	worldMuteActive,
} from "./message/mute-state";

export type V5MessageRuntimeStage1Result =
	| {
			kind: "terminal";
			action: "IGNORE" | "STOP";
			messageHandler: MessageHandlerResult;
			state: State;
	  }
	| {
			kind: "direct_reply" | "planned_reply";
			messageHandler: MessageHandlerResult;
			result: StrategyResult;
	  };

type ResponseHandlerEarlyReplyEvent = {
	text: string;
	messageHandler: MessageHandlerResult;
};

function isVoiceChannelMessage(message: Pick<Memory, "content">): boolean {
	return (
		message.content?.channelType === ChannelType.VOICE_DM ||
		message.content?.channelType === ChannelType.VOICE_GROUP
	);
}

/** A multi-party voice room (≥1 agent, ≥1 human / other agents). */
function isVoiceGroupChannelMessage(message: Pick<Memory, "content">): boolean {
	return message.content?.channelType === ChannelType.VOICE_GROUP;
}

/**
 * Multi-agent / multi-speaker voice-room turn-taking (#8786). An agent DEFERS
 * (suppresses its reply) when the turn is explicitly addressed to OTHER
 * participants and not to this agent — the "only the addressed agent replies"
 * contract that keeps ≥3-participant rooms from devolving into a cross-talk
 * storm where every agent answers every utterance.
 *
 * Pure + deterministic. An empty `addressedTo` (no explicit target) never
 * suppresses — normal `shouldRespond` decides — so a single-agent group room
 * and undirected questions are unaffected; only an utterance directed AT a
 * named participant who is not this agent is gated. Fails OPEN (no suppression)
 * when this agent cannot be identified.
 */
function voiceGroupAddressSuppressesAgent(
	addressedTo: readonly string[] | undefined,
	selfIdentifiers: readonly string[],
): boolean {
	if (!Array.isArray(addressedTo) || addressedTo.length === 0) return false;
	const self = new Set(
		selfIdentifiers.map((s) => s.trim().toLowerCase()).filter(Boolean),
	);
	if (self.size === 0) return false; // can't identify self → fail open
	const targets = addressedTo
		.map((t) => t.trim().toLowerCase())
		.filter(Boolean);
	if (targets.length === 0) return false;
	// Addressed to me (possibly among others) → not suppressed. Addressed only
	// to others → defer to the agent who was named.
	return !targets.some((t) => self.has(t));
}

type VoiceTurnSignalMetadata = {
	endOfTurnProbability?: number;
	nextSpeaker?: "agent" | "user" | "unknown";
	agentShouldSpeak?: boolean | null;
	source?: string;
	model?: string;
};

export function getVoiceTurnSignalMetadata(
	message: Pick<Memory, "content">,
): VoiceTurnSignalMetadata | null {
	const content = message.content;
	// The in-process voice path writes `content.voiceTurnSignal` at top level,
	// but chat clients nest custom fields under `content.metadata` — that's where
	// the conversation route persists a request's `metadata` object (see
	// buildUserMessages in agent/api/server-helpers). Read both so the gate sees
	// the ambient signal regardless of which entry point produced the turn.
	const nested =
		content?.metadata &&
		typeof content.metadata === "object" &&
		!Array.isArray(content.metadata)
			? (content.metadata as Record<string, unknown>).voiceTurnSignal
			: undefined;
	const value = content?.voiceTurnSignal ?? nested;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const raw = value as Record<string, unknown>;
	const signal: VoiceTurnSignalMetadata = {};
	if (typeof raw.endOfTurnProbability === "number") {
		signal.endOfTurnProbability = raw.endOfTurnProbability;
	}
	if (
		raw.nextSpeaker === "agent" ||
		raw.nextSpeaker === "user" ||
		raw.nextSpeaker === "unknown"
	) {
		signal.nextSpeaker = raw.nextSpeaker;
	}
	const agentShouldSpeak = raw.agentShouldSpeak;
	if (typeof agentShouldSpeak === "boolean") {
		signal.agentShouldSpeak = agentShouldSpeak;
	} else if (agentShouldSpeak === null) {
		signal.agentShouldSpeak = null;
	}
	if (typeof raw.source === "string") signal.source = raw.source;
	if (typeof raw.model === "string") signal.model = raw.model;
	return Object.keys(signal).length > 0 ? signal : null;
}

/**
 * The resolved speaker entity for a voice turn (#8786). Voice attribution
 * (imprint cluster → entityId) writes `speakerEntityId` onto the turn; like
 * {@link getVoiceTurnSignalMetadata} it can arrive top-level (`content.speaker
 * EntityId`, the in-process engine path) or nested under `content.metadata`
 * (chat clients). Returns the trimmed id, or null when the speaker is unbound.
 */
export function getVoiceSpeakerEntityId(
	message: Pick<Memory, "content">,
): string | null {
	const content = message.content;
	const nested =
		content?.metadata &&
		typeof content.metadata === "object" &&
		!Array.isArray(content.metadata)
			? (content.metadata as Record<string, unknown>).speakerEntityId
			: undefined;
	const value =
		(content as { speakerEntityId?: unknown } | undefined)?.speakerEntityId ??
		nested;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function voiceTurnSignalSuppressesAgent(
	signal: VoiceTurnSignalMetadata | null,
): boolean {
	if (!signal) return false;
	return (
		signal.agentShouldSpeak === false ||
		signal.nextSpeaker === "user" ||
		(typeof signal.endOfTurnProbability === "number" &&
			signal.endOfTurnProbability < 0.4)
	);
}

/**
 * The turn signal POSITIVELY confirms the agent should reply — the server-side
 * "decide, don't just veto" path (#8786). Conservative: it only fires on the
 * EXPLICIT `agentShouldSpeak === true` signal (the client sets this on a
 * wake-word / direct-address turn), and only when end-of-turn doesn't read as
 * the user still talking. Used to PROMOTE an IGNORE to RESPOND; it never
 * overrides an explicit STOP or an already-RESPOND decision.
 */
export function voiceTurnSignalConfirmsAgent(
	signal: VoiceTurnSignalMetadata | null,
): boolean {
	if (!signal) return false;
	return (
		signal.agentShouldSpeak === true &&
		signal.nextSpeaker !== "user" &&
		(typeof signal.endOfTurnProbability !== "number" ||
			signal.endOfTurnProbability >= 0.4)
	);
}

/**
 * Read the transcription-mode flag off a turn. Mirrors
 * {@link getVoiceTurnSignalMetadata}: chat clients nest custom fields under
 * `content.metadata` (where the conversation route persists a request's
 * `metadata`), while in-process callers may set `content.transcriptionMode`
 * at top level — read both. Transcription mode records the user turn into the
 * conversation but suppresses the agent's reply (long-form "transcribe, agent
 * stays silent until an exit phrase").
 */
export function transcriptionModeActive(
	message: Pick<Memory, "content">,
): boolean {
	const content = message.content;
	if (content?.transcriptionMode === true) return true;
	const metadata = content?.metadata;
	if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
		return (metadata as Record<string, unknown>).transcriptionMode === true;
	}
	return false;
}

function normalizeVisibleTextForDuplicateCheck(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Zerollama/OpenAI-style async media endpoints should be delivered as attachments, not echoed as chat copy. */
const MEDIA_CONTENT_URL_RE =
	/<?\s*https?:\/\/[^\s<>]+\/v1\/(?:videos|images|audio)\/[^\s<>/]+\/content\s*>?/gi;

function collectMediaDeliveryUrls(actionResults: ActionResult[]): string[] {
	const urls = new Set<string>();
	for (const result of actionResults) {
		if (!result.success) continue;
		const data = result.data;
		if (!data || typeof data !== "object") continue;
		for (const key of [
			"videoUrl",
			"mediaUrl",
			"imageUrl",
			"audioUrl",
			"url",
		] as const) {
			const value = data[key];
			if (typeof value === "string" && value.trim()) {
				urls.add(value.trim());
			}
		}
	}
	return [...urls];
}

export function sanitizeReplyTextAfterMediaDelivery(
	text: string,
	deliveredUrls: readonly string[],
): string {
	let cleaned = text.trim();
	if (!cleaned) return cleaned;

	// This sanitizer exists ONLY to tidy a reply after a media URL was
	// delivered/stripped. A turn with no delivered media and no embedded media
	// content URL is an ordinary reply — return it untouched. Running the
	// whitespace tidy-up below on every planner reply flattened ALL multiline
	// output (code bodies, lists, paragraphs) to one line, because
	// `\s{2,}` matches `\n` + indentation (observed: every HumanEval
	// completion through the eliza harness lost its newlines and failed with
	// SyntaxError).
	const hasEmbeddedMediaUrl = new RegExp(MEDIA_CONTENT_URL_RE.source, "i").test(
		cleaned,
	);
	if (deliveredUrls.length === 0 && !hasEmbeddedMediaUrl) {
		return cleaned;
	}

	for (const url of deliveredUrls) {
		const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		cleaned = cleaned.replace(new RegExp(`<?\\s*${escaped}\\s*>?`, "gi"), "");
	}
	cleaned = cleaned.replace(MEDIA_CONTENT_URL_RE, "");
	cleaned = cleaned
		.replace(
			/^\s*(?:here(?:'s| is| you go)?(?:\s+it\s+is)?|done(?:\.|\s+video'?s?\s+(?:up|live|ready))?|your video(?: is ready)?)\s*:?\s*/i,
			"",
		)
		.replace(/:\s*$/g, "")
		.replace(/<\s*>/g, "")
		.replace(/\(\s*\)/g, "")
		// Collapse only same-line whitespace gaps left by URL removal —
		// newlines are reply formatting and must survive.
		.replace(/[^\S\n]{2,}/g, " ")
		.trim();

	if (
		/^(?:here|done|your video\b|it is|video'?s?\s+(?:up|live|ready))[^.?!]*:?\s*$/i.test(
			cleaned,
		)
	) {
		cleaned = "";
	}

	return cleaned;
}

/**
 * Restore PII surrogates → real values at the final user-facing reply egress
 * (#10827). The NER pseudonymization layer swaps real PII to surrogates on
 * ingress and restores them at the tool-call execution boundary
 * (`execute-planned-tool-call.ts`) — but a direct/terminal reply that does NOT
 * go through a tool call was still shipping the surrogate to the user. Mirror
 * the tool-call egress restore here so the user (and the persisted assistant
 * message they read back) sees the real value, while the model, trajectory,
 * logs, and providers upstream keep the surrogate. Best-effort + a zero-cost
 * no-op when PII swap is disabled (no session on the trajectory context) or the
 * text carries no surrogate. Scoped to the reply TEXT only — the `thought`
 * (reasoning trajectory) is intentionally left pseudonymized.
 */
export function restorePiiInUserReplyText(text: string): string {
	const piiSwapSession = getTrajectoryContext()?.piiSwapSession;
	return piiSwapSession ? piiSwapSession.restoreInValue(text) : text;
}

function createV5ReplyStrategyResult(args: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	responseId: UUID;
	text: string;
	thought: string;
	mode?: StrategyMode;
	attachments?: Media[];
}): StrategyResult {
	const responseContent: Content = {
		thought: args.thought,
		actions: ["REPLY"],
		text: restorePiiInUserReplyText(args.text),
		simple: args.mode !== "actions",
		responseId: args.responseId,
		...(args.attachments?.length ? { attachments: args.attachments } : {}),
	};

	return {
		responseContent,
		responseMessages: [
			{
				id: args.responseId,
				entityId: args.runtime.agentId,
				agentId: args.runtime.agentId,
				content: responseContent,
				roomId: args.message.roomId,
				createdAt: Date.now(),
			},
		],
		state: args.state,
		mode: args.mode ?? "simple",
	};
}

function asProviderRecord(value: unknown):
	| {
			text?: unknown;
			providerName?: unknown;
	  }
	| undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return value as {
		text?: unknown;
		providerName?: unknown;
	};
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function cleanPriorDialogueSpeakerName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().split(/\s+/).join(" ");
	if (!normalized) return undefined;
	return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function senderIdentityName(value: unknown): string | undefined {
	const record = asPlainRecord(value);
	if (!record) return undefined;
	return (
		cleanPriorDialogueSpeakerName(record.name) ??
		cleanPriorDialogueSpeakerName(record.username) ??
		cleanPriorDialogueSpeakerName(record.tag)
	);
}

function priorDialogueSpeakerName(memory: Memory): string | undefined {
	const metadata = asPlainRecord(memory.metadata);
	const content = asPlainRecord(memory.content);
	const contentMetadata = asPlainRecord(content?.metadata);
	const sender =
		senderIdentityName(metadata?.sender) ??
		senderIdentityName(contentMetadata?.sender);
	if (sender) return sender;
	for (const record of [metadata, contentMetadata, content]) {
		const name =
			cleanPriorDialogueSpeakerName(record?.entityName) ??
			cleanPriorDialogueSpeakerName(record?.senderName) ??
			cleanPriorDialogueSpeakerName(record?.authorName) ??
			cleanPriorDialogueSpeakerName(record?.displayName) ??
			cleanPriorDialogueSpeakerName(record?.userName) ??
			cleanPriorDialogueSpeakerName(record?.username) ??
			cleanPriorDialogueSpeakerName(record?.name);
		if (name) return name;
	}
	return undefined;
}

function priorDialogueContent(text: string, speaker?: string): string {
	if (!speaker) return text;
	const trimmedStart = text.trimStart();
	if (trimmedStart.toLowerCase().startsWith(`${speaker.toLowerCase()}:`)) {
		return text;
	}
	return `${speaker}: ${text}`;
}

function appendPriorDialogueEvents(
	events: ContextEvent[],
	runtime: IAgentRuntime,
	state: State,
	currentMessage: Memory,
	options?: { includeOwnReplies?: boolean },
): void {
	const includeOwnReplies = options?.includeOwnReplies ?? false;
	const providers = state.data?.providers;
	if (!providers || typeof providers !== "object") {
		return;
	}
	const recent = (providers as Record<string, unknown>).RECENT_MESSAGES;
	if (!recent || typeof recent !== "object") {
		return;
	}
	const data = (recent as { data?: unknown }).data;
	const recentMessages =
		data && typeof data === "object" && "recentMessages" in data
			? (data as { recentMessages?: unknown }).recentMessages
			: undefined;
	if (!Array.isArray(recentMessages)) {
		return;
	}
	const dialogue = recentMessages
		.filter((memory): memory is Memory => {
			if (!memory || typeof memory !== "object") return false;
			const m = memory as Memory;
			if (m.id && currentMessage.id && m.id === currentMessage.id) return false;
			// The agent's own prior replies stay in the chat-recall window
			// (role-tagged prior_message:agent below): the current_turn_boundary
			// contract tells the model these blocks are its only chat-recall
			// source, so dropping its own turns made it confabulate about what it
			// previously said. The tool planner opts out (includeOwnReplies=false)
			// because a planner that sees its own stale tool-derived answer
			// parrots it instead of running the fresh check. The artifact guards
			// below still strip non-dialogue agent output for every sender.
			if (!includeOwnReplies && m.entityId === runtime.agentId) {
				return false;
			}
			if (
				typeof m.content?.source === "string" &&
				m.content.source.includes("sub-agent")
			) {
				return false;
			}
			if (
				m.content?.metadata &&
				typeof m.content.metadata === "object" &&
				(m.content.metadata as { subAgent?: unknown }).subAgent === true
			) {
				return false;
			}
			const contentType =
				m.content && typeof m.content === "object"
					? (m.content as { type?: string }).type
					: undefined;
			if (contentType === "action_result") return false;
			if (isSubAgentCompletionArtifact(m)) return false;
			const text =
				typeof m.content?.text === "string" ? m.content.text.trim() : "";
			if (looksLikePriorDialogueArtifact(text)) return false;
			return text.length > 0;
		})
		.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
	for (const memory of dialogue) {
		const text = getUserMessageText(memory);
		if (!text) continue;
		const isOwnReply = memory.entityId === runtime.agentId;
		const speakerName = isOwnReply
			? (runtime.character?.name ?? priorDialogueSpeakerName(memory))
			: priorDialogueSpeakerName(memory);
		events.push({
			id: `history:${memory.id}`,
			type: "segment",
			source: "prior-dialogue",
			createdAt: memory.createdAt,
			segment: {
				id: `history:${memory.id}`,
				label: isOwnReply ? "prior_message:agent" : "prior_message:user",
				content: priorDialogueContent(text, speakerName),
				stable: false,
				metadata: {
					roomId: memory.roomId,
					entityId: memory.entityId,
					...(speakerName ? { speakerName } : {}),
				},
			},
		});
	}
}

function currentMessageContentForContext(message: Memory): Memory["content"] {
	const currentText = getUserMessageText(message);
	const content = message.content;
	if (
		!currentText ||
		!content ||
		typeof content !== "object" ||
		typeof content.text !== "string" ||
		content.text === currentText
	) {
		return content;
	}
	return {
		...content,
		text: currentText,
	};
}

function readMessageContentString(
	message: Memory,
	key: string,
): string | undefined {
	const content = message.content;
	if (!content || typeof content !== "object") return undefined;
	const value = (content as Record<string, unknown>)[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

type PlatformReplyReference = {
	text: string;
	sender?: string;
	externalId?: string;
};

const PLATFORM_REPLY_REFERENCE_START = "[platform_reply_reference]";
const PLATFORM_REPLY_REFERENCE_END = "[/platform_reply_reference]";

function valueAfterPrefix(line: string, prefix: string): string | undefined {
	if (!line.startsWith(prefix)) return undefined;
	const value = line.slice(prefix.length).trim();
	return value.length > 0 ? value : undefined;
}

function parsePlatformReplyReferenceBlock(
	text: string | undefined,
): PlatformReplyReference | null {
	if (!text) return null;
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let start = -1;
	for (let index = lines.length - 1; index >= 0; index--) {
		if (lines[index]?.trim() === PLATFORM_REPLY_REFERENCE_START) {
			start = index;
			break;
		}
	}
	if (start === -1) return null;
	const end = lines.findIndex(
		(line, index) =>
			index > start && line.trim() === PLATFORM_REPLY_REFERENCE_END,
	);
	if (end === -1) return null;

	const body = lines.slice(start + 1, end);
	const textIndex = body.findIndex((line) => line.trim() === "text:");
	if (textIndex === -1) return null;

	let sender: string | undefined;
	let externalId: string | undefined;
	for (const line of body.slice(0, textIndex)) {
		const trimmed = line.trim();
		sender ??= valueAfterPrefix(trimmed, "author:");
		externalId ??= valueAfterPrefix(trimmed, "message_id:");
	}

	const referenceText = body
		.slice(textIndex + 1)
		.join("\n")
		.trim();
	return referenceText ? { text: referenceText, sender, externalId } : null;
}

function replyReferenceForContext(
	message: Memory,
): PlatformReplyReference | null {
	const explicitText = readMessageContentString(message, "replyToMessageText");
	if (explicitText) {
		return {
			text: explicitText,
			sender: readMessageContentString(message, "replyToSenderName"),
			externalId: readMessageContentString(message, "replyToExternalMessageId"),
		};
	}

	const content = message.content;
	return parsePlatformReplyReferenceBlock(
		content && typeof content === "object" && typeof content.text === "string"
			? content.text
			: undefined,
	);
}

function replyReferenceEventForContext(message: Memory): ContextEvent | null {
	const reference = replyReferenceForContext(message);
	if (!reference) return null;
	const header = reference.sender
		? `${reference.sender}: ${reference.text}`
		: reference.text;
	const externalId = reference.externalId;
	const id = `reply-reference:${message.id ?? externalId ?? "current"}`;
	return {
		id,
		type: "segment",
		source: message.content.source ?? "platform",
		segment: {
			id,
			label: "reply_reference",
			content: externalId
				? `${header}\n(platform message id: ${externalId})`
				: header,
			stable: false,
		},
	};
}

function isSubAgentCompletionArtifact(memory: Memory): boolean {
	const content = memory.content;
	if (!content || typeof content !== "object") return false;
	const metadata =
		content.metadata && typeof content.metadata === "object"
			? (content.metadata as Record<string, unknown>)
			: {};
	if (metadata.subAgent === true) return true;
	const source = typeof content.source === "string" ? content.source : "";
	if (source.startsWith("acpx:sub-agent-router")) return true;
	const text = typeof content.text === "string" ? content.text.trim() : "";
	return text.startsWith("[sub-agent:");
}

function looksLikePriorDialogueArtifact(text: string): boolean {
	if (!text) return false;
	return /^\s*\[(?:sub-agent|tool output|tool result|command output)\b/im.test(
		text,
	);
}

function hasStructuredRecentMessagesProvider(state: State): boolean {
	const providers = state.data?.providers;
	if (!providers || typeof providers !== "object") {
		return false;
	}
	const recent = (providers as Record<string, unknown>).RECENT_MESSAGES;
	if (!recent || typeof recent !== "object") {
		return false;
	}
	const data = (recent as { data?: unknown }).data;
	return Boolean(
		data &&
			typeof data === "object" &&
			Array.isArray((data as { recentMessages?: unknown }).recentMessages),
	);
}

function getRecentConversationSearchText(
	state: State | undefined,
	currentMessage: Memory,
): string[] {
	const providers = state?.data?.providers;
	if (!providers || typeof providers !== "object") {
		return [];
	}
	const recent = (providers as Record<string, unknown>).RECENT_MESSAGES;
	if (!recent || typeof recent !== "object") {
		return [];
	}
	const data = (recent as { data?: unknown }).data;
	const recentMessages =
		data && typeof data === "object" && "recentMessages" in data
			? (data as { recentMessages?: unknown }).recentMessages
			: undefined;
	if (!Array.isArray(recentMessages)) {
		return [];
	}
	return recentMessages
		.filter((memory): memory is Memory & { content: { text: string } } => {
			if (!memory || typeof memory !== "object") return false;
			if (memory.id && currentMessage.id && memory.id === currentMessage.id) {
				return false;
			}
			if (isSubAgentCompletionArtifact(memory)) return false;
			return typeof memory.content?.text === "string";
		})
		.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
		.slice(0, 8)
		.map((memory) => memory.content.text.trim())
		.filter(Boolean);
}

function appendStateProviderEvents(
	events: ContextEvent[],
	state: State,
	excludedProviderNames?: readonly string[],
): void {
	const providers = state.data?.providers;
	const excluded = excludedProviderNames
		? new Set(excludedProviderNames.map((name) => name.toUpperCase()))
		: null;
	if (!providers || typeof providers !== "object") {
		const fallbackText =
			typeof state.text === "string" ? state.text.trim() : "";
		if (fallbackText) {
			events.push({
				id: "state:fallback",
				type: "provider",
				source: "composeState",
				name: "COMPOSED_STATE",
				text: fallbackText,
			});
		}
		return;
	}

	const providerOrder = Array.isArray(state.data.providerOrder)
		? state.data.providerOrder.map((name) => String(name))
		: Object.keys(providers).sort();
	const seen = new Set<string>();
	for (const providerName of providerOrder) {
		if (seen.has(providerName)) {
			continue;
		}
		seen.add(providerName);
		if (excluded?.has(providerName.toUpperCase())) {
			continue;
		}
		if (
			providerName.toUpperCase() === "RECENT_MESSAGES" &&
			hasStructuredRecentMessagesProvider(state)
		) {
			continue;
		}
		const provider = asProviderRecord(
			(providers as Record<string, unknown>)[providerName],
		);
		if (!provider) {
			continue;
		}
		const text = typeof provider.text === "string" ? provider.text.trim() : "";
		if (!text) {
			continue;
		}
		events.push({
			id: `provider:${providerName}`,
			type: "provider",
			source: "composeState",
			name:
				typeof provider.providerName === "string"
					? provider.providerName
					: providerName,
			text,
		});
	}
}

type V5PlannerActionSurfaceSummary = {
	mode: "full" | "tiered";
	candidateActionCount: number;
	catalogParentCount: number;
	exposedActionCount: number;
	tierAParents: string[];
	/**
	 * Children exposed as first-class planner tools per tier-A parent, after
	 * the per-parent child narrowing (`maxTierAChildrenPerParent`). Read back
	 * by `collectPlannerTools` so the native-tool expansion matches the tiered
	 * surface instead of re-expanding every subaction of a hot parent. Absent
	 * in full-surface mode, where every subaction expands.
	 */
	tierAChildrenByParent?: Record<string, string[]>;
	tierBParents: string[];
	omittedParentCount: number;
	omittedParentNamesPreview: string[];
	actionSurfaceHash?: string;
	warnings: number;
	queryTokens: string[];
	candidateActions: string[];
	parentActionHints: string[];
	fallback?: string;
};

type V5PlannerActionSurface = {
	exposedActionNames: Set<string>;
	summary: V5PlannerActionSurfaceSummary;
};

async function collectV5PlannerCandidateActions(args: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	selectedContexts?: readonly AgentContext[];
	candidateActions?: readonly string[];
	userRoles?: readonly RoleGateRole[];
}): Promise<Action[]> {
	// The candidate surface starts from every runtime action and applies only the
	// same execution gates the planner executor will enforce — it deliberately does
	// NOT pre-filter by `action.contexts` against the messageHandler-picked
	// `selectedContexts`. Context pre-filtering excludes owner actions, CALENDAR,
	// SCHEDULED_TASKS, etc. whenever the messageHandler routes to "general", even
	// when the user clearly asked for a habit/event/etc. Starting from every action
	// keeps role-policy overrides working for deployments that intentionally expose
	// an action outside its declared context, while avoiding dead tools the planner
	// could select but execution would immediately reject.
	const allRuntimeActions = args.runtime.actions;
	const actionLookup = buildRuntimeActionLookup(args.runtime);
	const actionsByName = new Map(
		allRuntimeActions.map((action) => [action.name, action]),
	);
	const actionsByNormalizedName = new Map(
		allRuntimeActions.map((action) => [
			normalizeActionIdentifier(action.name),
			action,
		]),
	);
	const selectedActions: Action[] = [];
	const seen = new Set<string>();

	const appendIfAllowed = async (
		action: Action,
		parentActionName?: string,
		activeContexts: readonly AgentContext[] | undefined = args.selectedContexts,
	): Promise<boolean> => {
		const normalizedName = normalizeActionIdentifier(action.name);
		if (!normalizedName || seen.has(normalizedName)) {
			return false;
		}
		// One gate for exposure and execution (#12087 Item 9): private-action gate
		// (private actions never reach the planner on a user turn) + ACTION_ROLE_POLICY
		// + contextGate + roleGate, all via the shared chokepoint.
		if (
			!canActionRun(action, {
				message: args.message,
				activeContexts,
				userRoles: args.userRoles,
			})
		) {
			return false;
		}
		try {
			const accountPolicy = await evaluateConnectorAccountPolicies(
				args.runtime,
				action,
				{
					message: args.message,
				},
			);
			if (!accountPolicy.allowed) {
				return false;
			}
			if (action.validate) {
				const valid = await action.validate(
					args.runtime,
					args.message,
					args.state,
				);
				if (!valid) {
					return false;
				}
			}
			seen.add(normalizedName);
			selectedActions.push(action);
			return true;
		} catch (error) {
			args.runtime.logger.warn(
				{
					src: "service:message",
					action: action.name,
					parentAction: parentActionName,
					error,
				},
				"Skipping action that cannot be exposed to the v5 planner",
			);
			return false;
		}
	};

	for (const action of allRuntimeActions) {
		await appendIfAllowed(action);
	}

	for (const candidateName of args.candidateActions ?? []) {
		// Resolve the synthetic candidate name Stage-1 invents to real actions:
		// first by exact name/simile, then by the shared parent-alias map that
		// retrieval already uses. The alias fallback lets an explicit permission
		// ask surface its writer (SETTINGS) even when Stage-1 mis-scoped the turn's
		// context (e.g. classified "revoke network access for the weather app" as
		// terminal/general): the candidate is an intent hint, so the resolved
		// parent is admitted under ITS OWN contexts — still gated on
		// role/private/context via appendIfAllowed (#14622).
		const direct = resolveRuntimeAction(actionLookup, candidateName);
		const resolved = direct
			? [direct]
			: parentAliasesForCandidateAction(candidateName)
					.map((alias) => resolveRuntimeAction(actionLookup, alias))
					.filter((action): action is Action => action !== undefined);
		for (const action of resolved) {
			await appendIfAllowed(
				action,
				undefined,
				mergeAgentContexts(args.selectedContexts, action.contexts),
			);
		}
	}

	for (let index = 0; index < selectedActions.length; index += 1) {
		const parentAction = selectedActions[index];
		const childActiveContexts = mergeAgentContexts(
			args.selectedContexts,
			parentAction.contexts,
		);
		for (const subAction of parentAction.subActions ?? []) {
			const childAction =
				typeof subAction === "string"
					? (actionsByName.get(subAction) ??
						actionsByNormalizedName.get(normalizeActionIdentifier(subAction)))
					: subAction;
			if (!childAction) {
				args.runtime.logger.warn(
					{
						src: "service:message",
						parentAction: parentAction.name,
						subAction,
					},
					"Skipping unresolved sub-action while building planner action surface",
				);
				continue;
			}
			await appendIfAllowed(
				childAction,
				parentAction.name,
				mergeAgentContexts(childActiveContexts, childAction.contexts),
			);
		}
	}

	return selectedActions;
}

function stringArrayProperty(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
		.filter((entry) => entry.length > 0);
}

function mergeAgentContexts(
	...lists: Array<readonly AgentContext[] | undefined>
): AgentContext[] {
	const seen = new Set<string>();
	const merged: AgentContext[] = [];
	for (const list of lists) {
		for (const context of list ?? []) {
			const id = String(context);
			if (!id || seen.has(id)) {
				continue;
			}
			seen.add(id);
			merged.push(context);
		}
	}
	return merged;
}

/**
 * The agent contexts a focused coding sub-agent (the eliza-code ACP server,
 * which sets ELIZA_PLANNER_FULL_ACTION_SURFACE) is considered to be operating in.
 * Used to admit the coding tools (FILE/SHELL/WORKTREE gate on these) while the
 * messaging/social chat actions stay gated off.
 */
const CODING_SUB_AGENT_CONTEXTS: readonly AgentContext[] = [
	"code",
	"files",
	"terminal",
	"automation",
];

/**
 * Parent actions a coding sub-agent never needs, excluded from its planner
 * surface even though they'd otherwise pass the coding-context gate. Each extra
 * tool schema enlarges the request, and a large tool set + a large file
 * generation is exactly what makes weaker hosted models (Cerebras glm-4.7)
 * intermittently reject the request (server_error / 400) or narrate instead of
 * emitting FILE. A coding sub-agent does not open/close UI views or spawn its
 * own sub-agents, so dropping these trims the surface toward the tools that
 * actually do the work (FILE/SHELL/WORKTREE/WEB/REPLY/STOP).
 */
const CODING_SUB_AGENT_EXCLUDED_ACTIONS: ReadonlySet<string> = new Set(
	// Stored in normalizeActionIdentifier() form (uppercase, underscores
	// stripped), since that is what the filter compares against.
	["VIEWS", "CLOSEVIEW", "CLOSEALLVIEWS", "TASKS"],
);

function getMessageHandlerCandidateActions(
	messageHandler: MessageHandlerResult,
): string[] {
	return stringArrayProperty(
		(messageHandler.plan as { candidateActions?: unknown }).candidateActions,
	);
}

function getMessageHandlerParentActionHints(
	messageHandler: MessageHandlerResult,
): string[] {
	return stringArrayProperty(
		(messageHandler.plan as { parentActionHints?: unknown }).parentActionHints,
	);
}

function buildFullV5PlannerActionSurface(params: {
	actions: readonly Action[];
	candidateActions?: readonly string[];
	parentActionHints?: readonly string[];
}): V5PlannerActionSurface {
	const exposedActionNames = new Set(
		params.actions.map((action) => normalizeActionIdentifier(action.name)),
	);
	return {
		exposedActionNames,
		summary: {
			mode: "full",
			candidateActionCount: params.actions.length,
			catalogParentCount: params.actions.length,
			exposedActionCount: exposedActionNames.size,
			tierAParents: params.actions.map((action) => action.name).sort(),
			tierBParents: [],
			omittedParentCount: 0,
			omittedParentNamesPreview: [],
			warnings: 0,
			queryTokens: [],
			candidateActions: [...(params.candidateActions ?? [])],
			parentActionHints: [...(params.parentActionHints ?? [])],
		},
	};
}

// buildActionCatalog is a pure function of (actions, localizedExamples) but was
// rebuilt from scratch on every message (~349 us/message). Cache it keyed by the
// action-name list: adding/removing any action — including plugin/view actions —
// changes the key, so the cache self-invalidates on the path that matters (newly
// registered view actions appear in the next message's catalog) without any
// manual register/unregister hook. Only cached when no localized-example
// resolver is active: that resolver depends on the recent message, so the
// localized catalog is message-specific and must be rebuilt each turn.
const actionCatalogCache = new Map<string, ActionCatalog>();
const ACTION_CATALOG_CACHE_LIMIT = 8;

function actionCatalogCacheKey(actions: readonly Action[]): string {
	let key = "";
	for (const action of actions) {
		key += `${action.name}\u0000`;
	}
	return key;
}

export function getCachedActionCatalog(
	actions: readonly Action[],
	localizedExamples?: LocalizedActionExampleResolver,
): ActionCatalog {
	if (localizedExamples) {
		// Message-specific examples — never cache across turns.
		return buildActionCatalog([...actions], { localizedExamples });
	}
	const key = actionCatalogCacheKey(actions);
	const cached = actionCatalogCache.get(key);
	if (cached) {
		return cached;
	}
	const catalog = buildActionCatalog([...actions], { localizedExamples });
	actionCatalogCache.set(key, catalog);
	if (actionCatalogCache.size > ACTION_CATALOG_CACHE_LIMIT) {
		const oldest = actionCatalogCache.keys().next().value;
		if (typeof oldest === "string") {
			actionCatalogCache.delete(oldest);
		}
	}
	return catalog;
}

function buildV5PlannerActionSurface(params: {
	actions: readonly Action[];
	message: Memory;
	state?: State;
	messageHandler: MessageHandlerResult;
	// The messageHandler-selected contexts for this turn. Passed through to
	// `retrieveActions` as a *weight* (boost on-context candidates) — never
	// as a filter. See `services/collectV5PlannerCandidateActions` for why
	// we stopped filtering by context.
	selectedContexts?: readonly AgentContext[];
	// Optional recorder hook. When provided the function emits a `toolSearch`
	// stage to the trajectory before returning. Fire-and-forget — the caller
	// does not need to await.
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	logger?: IAgentRuntime["logger"];
	// Optional locale-aware example swapper. Resolved by the caller (which
	// has async access to `OwnerFactStore.locale`) and passed through to
	// `buildActionCatalog` so the planner sees localized `ActionExample`
	// pairs at catalog-build time.
	localizedExamples?: LocalizedActionExampleResolver;
}): V5PlannerActionSurface {
	const candidateActions = getMessageHandlerCandidateActions(
		params.messageHandler,
	);
	const parentActionHints = getMessageHandlerParentActionHints(
		params.messageHandler,
	);

	// Expose EVERY action as a native tool (no tiering) when the action set is
	// empty, OR when explicitly forced. Tiering is built for large chat catalogs
	// (30+ actions → expose the relevant few); a focused coding sub-agent has a
	// small, all-relevant tool set (FILE/SHELL/READ/EDIT/…) and MUST get them all
	// exposed natively — otherwise the model sees a tool in the prompt but cannot
	// call it (it lands in tier-B, described-only), narrates instead of acting, and
	// trips the terminal-only-continuations guard. `ELIZA_PLANNER_FULL_ACTION_SURFACE=1`
	// opts a runtime into full mode (the eliza-code ACP coding agent sets it).
	const fullSurfaceFlag =
		typeof process !== "undefined"
			? process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE?.trim().toLowerCase()
			: undefined;
	const forceFullSurface =
		fullSurfaceFlag === "1" ||
		fullSurfaceFlag === "true" ||
		fullSurfaceFlag === "yes" ||
		fullSurfaceFlag === "on" ||
		params.actions.length === 0;
	if (forceFullSurface) {
		return buildFullV5PlannerActionSurface({
			actions: params.actions,
			candidateActions,
			parentActionHints,
		});
	}

	const toolSearchStartedAt = Date.now();
	const catalog = getCachedActionCatalog(
		params.actions,
		params.localizedExamples,
	);
	const measurementMode = process.env.ELIZA_RETRIEVAL_MEASUREMENT === "1";
	const messageText = getUserMessageText(params.message);
	if (typeof messageText !== "string") {
		params.logger?.warn(
			{
				src: "service:message",
				messageId: params.message.id,
			},
			"Planner action retrieval received message without text",
		);
	}
	const retrievalMessageText =
		typeof messageText === "string" ? messageText : "";
	const retrieval = retrieveActions({
		catalog,
		messageText: retrievalMessageText,
		recentConversationText: getRecentConversationSearchText(
			params.state,
			params.message,
		),
		selectedContexts: params.selectedContexts,
		candidateActions,
		parentActionHints,
		measurementMode,
	});
	const tieredSurface = tierActionResults({
		catalog,
		results: retrieval.results,
		narrowToCandidateActions: candidateActions,
		// Message-text + candidate tokens rank children WITHIN each tier-A
		// parent so a hot parent exposes its turn-relevant children instead of
		// its whole namespace (maxTierAChildrenPerParent).
		queryTokens: retrieval.query.tokens,
	});
	const toolSearchEndedAt = Date.now();
	const exposedActionNames = new Set(
		tieredSurface.exposedActionNames.map(normalizeActionIdentifier),
	);

	let fallback: string | undefined;
	if (
		params.actions.every(
			(action) =>
				!exposedActionNames.has(normalizeActionIdentifier(action.name)),
		)
	) {
		let addedFallbackAction = false;
		for (const result of retrieval.results.slice(0, 3)) {
			if (result.score <= 0) {
				continue;
			}
			exposedActionNames.add(normalizeActionIdentifier(result.name));
			addedFallbackAction = true;
		}
		if (addedFallbackAction) {
			fallback = "top-ranked-parent-fallback";
		}
	}

	// Every candidate action the message-handler proposed is described to the
	// planner (and reinforced by action examples), so each MUST also be callable.
	// Tiering can otherwise leave a proposed action in the described-only tier:
	// the model then emits a tool_call the surface rejects as "unavailable",
	// burning unavailable-tool retries and — for delegation (TASKS_SPAWN_AGENT) —
	// silently breaking the hand-off (observed live: the planner called
	// TASKS_SPAWN_AGENT, it was unavailable, and the build never delegated). The
	// candidate set is already narrowed to the relevant actions, so exposing the
	// registered ones keeps the callable surface tight.
	for (const name of candidateActions) {
		const normalized = normalizeActionIdentifier(name);
		if (
			params.actions.some(
				(action) => normalizeActionIdentifier(action.name) === normalized,
			)
		) {
			exposedActionNames.add(normalized);
		}
	}

	const exposedActionCount = params.actions.filter((action) =>
		exposedActionNames.has(normalizeActionIdentifier(action.name)),
	).length;

	if (params.recorder && params.trajectoryId) {
		const stageId = `stage-toolsearch-${toolSearchStartedAt}`;
		const trajectoryId = params.trajectoryId;
		void params.recorder
			.recordStage(trajectoryId, {
				stageId,
				kind: "toolSearch",
				startedAt: toolSearchStartedAt,
				endedAt: toolSearchEndedAt,
				latencyMs: toolSearchEndedAt - toolSearchStartedAt,
				toolSearch: {
					query: {
						text: retrievalMessageText,
						tokens: retrieval.query.tokens,
						candidateActions: [...candidateActions],
						parentActionHints: [...parentActionHints],
					},
					results: retrieval.results.slice(0, 25).map((r, idx) => ({
						name: r.name,
						score: r.score,
						rank: idx,
						rrfScore: r.rrfScore,
						matchedBy: r.matchedBy,
						// stageScores is Partial<Record<RetrievalStageName, number>>;
						// the telemetry field is the structurally-identical
						// Record<string, number>, so a plain `as` suffices (no
						// `as unknown as`).
						stageScores: r.stageScores as Record<string, number>,
					})),
					tier: {
						tierA: tieredSurface.sortedTierAParentNames,
						tierB: tieredSurface.sortedTierBParentNames,
						omitted: tieredSurface.omittedParentNames.length,
					},
					durationMs: toolSearchEndedAt - toolSearchStartedAt,
					fallback,
					...(retrieval.measurement
						? {
								perStageScores: retrieval.measurement.perStageScores,
								fusedTopK: retrieval.measurement.fusedTopK,
							}
						: {}),
				},
			})
			.catch((err) => {
				params.logger?.warn?.(
					{ err: (err as Error).message, trajectoryId },
					"[TrajectoryRecorder] failed to record toolSearch stage",
				);
			});
	}

	return {
		exposedActionNames,
		summary: {
			mode: "tiered",
			candidateActionCount: params.actions.length,
			catalogParentCount: catalog.parents.length,
			exposedActionCount,
			tierAParents: tieredSurface.sortedTierAParentNames,
			tierAChildrenByParent: Object.fromEntries(
				tieredSurface.tierAParents.map((parent) => [
					parent.name,
					[...parent.childNames],
				]),
			),
			tierBParents: tieredSurface.sortedTierBParentNames,
			omittedParentCount: tieredSurface.omittedParentNames.length,
			omittedParentNamesPreview: tieredSurface.omittedParentNames.slice(0, 20),
			actionSurfaceHash: tieredSurface.actionSurfaceHash,
			warnings: catalog.warnings.length,
			queryTokens: retrieval.query.tokens.slice(0, 32),
			candidateActions,
			parentActionHints,
			...(fallback ? { fallback } : {}),
		},
	};
}

async function createV5MessageContextObject(args: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	selectedContexts?: readonly AgentContext[];
	includeTools?: boolean;
	userRoles?: readonly RoleGateRole[];
	availableContexts?: readonly ContextDefinition[];
	extraProviderExclusions?: readonly string[];
	preselectedActions?: readonly Action[];
	actionSurface?: V5PlannerActionSurface;
}): Promise<ContextObject> {
	const events: ContextEvent[] = [];

	const renderExclusions = [
		...MODEL_CONTEXT_PROVIDER_EXCLUSIONS,
		...(args.extraProviderExclusions ?? []),
		// The recent-messages provider exposes structured prior turns in
		// data.recentMessages. appendPriorDialogueEvents renders those as proper
		// chat-message events, so also rendering provider.text would duplicate the
		// same conversation and can leak stored assistant thought/action metadata
		// into the prompt. Keep the text fallback only for legacy/unstructured
		// provider states.
		...(hasStructuredRecentMessagesProvider(args.state)
			? ["RECENT_MESSAGES"]
			: []),
	];
	appendStateProviderEvents(events, args.state, renderExclusions);

	if (hasStructuredRecentMessagesProvider(args.state)) {
		events.push({
			id: "prior-dialogue-policy",
			type: "segment",
			source: "message-service",
			segment: {
				id: "prior-dialogue-policy",
				label: "system",
				content:
					"prior_dialogue_policy: Prior chat is context only. For current, latest, live, filesystem, runtime, build, deploy, or verification requests, use the current turn's tools/context instead of answering from prior tool results or stale sub-agent transcripts.",
				stable: true,
			},
		});
	}

	appendPriorDialogueEvents(events, args.runtime, args.state, args.message, {
		// The response handler needs the agent's own prior turns for grounded
		// chat recall ("did you tell me X?"); the tool planner must not see its
		// own stale tool-derived answers or it answers from them instead of
		// executing the fresh check the user asked for.
		includeOwnReplies: !args.includeTools,
	});

	events.push({
		id: "current-turn-boundary",
		type: "instruction",
		source: "message-service",
		stable: false,
		content:
			"current_turn_boundary: The prior_message blocks above are context only. If a reply_reference block follows, it is the platform message that the final message:user is replying to; use it only to resolve references such as this/that/it. Execute and answer only the final message:user below. Do not merge separate prior requests into the current task unless the final message explicitly references them. Exception for visible-context recall: when the final message asks a recall question about what was said in this conversation (who mentioned X, did anyone bring up Y, what did I say about Z, what was the last message, did you yourself say W), you may scan the prior_message blocks above and answer from what is literally visible there." +
			// Only the chat-recall context renders the agent's own prior turns;
			// the tool-planner context deliberately omits them (stale-answer
			// hazard), so this grounding sentence would be false there.
			(args.includeTools
				? ""
				: " Your own prior replies are the prior_message:agent blocks: when asked what YOU said, told, or promised earlier, answer only from those blocks — never assert you said something that does not appear in them, and never deny saying something that does.") +
			' Before saying you cannot find something, read the final message:user itself: if the asker states a fact and asks about it in the same message ("my favorite color is teal, what is my favorite color?"), answer from the current message directly. Only when the asked-about token appears neither in the current message nor in any visible prior_message block, say so plainly ("I don\'t see X in the recent messages I can see") rather than claiming you searched beyond the visible window or fabricating an action — the prior_message blocks are the only window you have, and there is no separate chat-history search tool. This "no chat-history search" limit is about CHAT recall ONLY. It does NOT apply to what a task, build, deploy, or sub-agent YOU ran actually did: that run status IS verifiable with the task/sub-agent tools. So when the final message asks "what happened with [the build/app/task]" or disputes whether something you ran actually worked, treat it as a live verification request (set requiresTool) and CHECK the current task/sub-agent status with a tool before reporting, disclaiming, or conceding — never say you cannot verify a run you can look up.',
	});

	const replyReferenceEvent = replyReferenceEventForContext(args.message);
	if (replyReferenceEvent) {
		events.push(replyReferenceEvent);
	}

	events.push({
		id: String(args.message.id ?? "current-message"),
		type: "message",
		source: args.message.content.source ?? "user",
		createdAt: args.message.createdAt,
		message: {
			id: args.message.id,
			role: "user",
			content: currentMessageContentForContext(args.message),
			metadata: {
				roomId: args.message.roomId,
				entityId: args.message.entityId,
			},
		},
	});

	if (args.includeTools && args.selectedContexts?.length) {
		const actions =
			args.preselectedActions ??
			(await collectV5PlannerCandidateActions({
				runtime: args.runtime,
				message: args.message,
				state: args.state,
				selectedContexts: args.selectedContexts,
				userRoles: args.userRoles,
			}));
		const displayActions = args.actionSurface
			? actions.filter((action) =>
					args.actionSurface?.exposedActionNames.has(
						normalizeActionIdentifier(action.name),
					),
				)
			: actions;
		for (const action of displayActions) {
			try {
				const tool = actionToTool(action);
				events.push({
					id: `tool:${tool.function.name}`,
					type: "tool",
					source: "message-service",
					tool: {
						name: tool.function.name,
						description: tool.function.description,
						parameters: tool.function.parameters,
						action,
					},
				});
			} catch (error) {
				args.runtime.logger.warn(
					{ src: "service:message", action: action.name, error },
					"Skipping action that cannot be exposed as a v5 native tool",
				);
			}
		}
	}

	const systemPrompt = buildCanonicalSystemPrompt({
		character: args.runtime.character,
		userRole: args.userRoles?.[0],
	});
	// Stage 2 exposes each Action as its own native tool. Per-action specs live
	// in `events[type=tool]`; the LLM calls each action directly by name. We
	// also expose the universal terminal-sentinel tools (REPLY / IGNORE / STOP)
	// so the planner has a stable way to end the turn regardless of narrowing.
	// Empty when no actions are gated so the planner can short-circuit.
	const hasAnyAction = events.some(
		(event) =>
			event.type === "tool" &&
			"tool" in event &&
			Boolean(
				(event as { tool?: { name?: string } }).tool?.name?.trim().length,
			),
	);
	const expandedTools: ToolDefinition[] = hasAnyAction
		? [...CORE_PLANNER_TERMINALS]
		: [];
	return createContextObject({
		id: String(args.message.id ?? v4()),
		createdAt: Date.now(),
		metadata: {
			roomId: args.message.roomId,
			messageId: args.message.id,
			selectedContexts: [...(args.selectedContexts ?? [])],
			...(args.actionSurface
				? { actionSurface: args.actionSurface.summary as JsonValue }
				: {}),
		},
		staticPrefix: {
			systemPrompt: systemPrompt
				? {
						id: "system",
						label: "system",
						content: systemPrompt,
						stable: true,
					}
				: undefined,
		},
		trajectoryPrefix: {
			selectedContexts: [...(args.selectedContexts ?? [])],
			contextDefinitions:
				args.selectedContexts && args.availableContexts
					? args.availableContexts.filter((def) =>
							args.selectedContexts?.includes(def.id),
						)
					: [],
			expandedTools,
			createdAtStageId: "message-handler",
		},
		plannedQueue: [],
		metrics: {},
		limits: {},
		events,
	});
}

function filterSelectedContextsForRole(
	contexts: readonly AgentContext[],
	availableContexts: readonly ContextDefinition[],
): AgentContext[] {
	if (contexts.length === 0) {
		return [];
	}
	if (availableContexts.length === 0) {
		return [...new Set(contexts)];
	}
	const allowed = new Set(
		availableContexts.map((definition) => String(definition.id)),
	);
	const selected: AgentContext[] = [];
	const seen = new Set<string>();
	for (const context of contexts) {
		const id = String(context);
		if (!allowed.has(id) || seen.has(id)) {
			continue;
		}
		seen.add(id);
		selected.push(context);
	}
	return selected;
}

export const BUILTIN_RESPONSE_HANDLER_EVALUATORS: readonly ResponseHandlerEvaluator[] =
	[
		{
			name: "core.voice_turn_signal",
			description:
				"Deterministically suppresses voice replies when semantic turn-taking says the next speaker is not the agent.",
			priority: 0,
			shouldRun: ({ message }) =>
				isVoiceChannelMessage(message) &&
				voiceTurnSignalSuppressesAgent(getVoiceTurnSignalMetadata(message)),
			evaluate: ({ message }) => {
				const signal = getVoiceTurnSignalMetadata(message);
				return {
					processMessage: "IGNORE",
					requiresTool: false,
					clearReply: true,
					debug: [
						`voice turn signal suppressed reply (${signal?.source ?? "unknown"}; p=${typeof signal?.endOfTurnProbability === "number" ? signal.endOfTurnProbability.toFixed(3) : "n/a"}; next=${signal?.nextSpeaker ?? "unknown"})`,
					],
				};
			},
		},
		{
			name: "core.voice_turn_signal_confirm",
			description:
				"Server-side positive decision for voice: promotes an IGNORE to RESPOND when the turn signal explicitly confirms the agent should speak (wake-word / direct-address). Never overrides an explicit STOP or an already-RESPOND decision.",
			priority: 0,
			shouldRun: ({ message, messageHandler }) =>
				isVoiceChannelMessage(message) &&
				messageHandler.processMessage === "IGNORE" &&
				voiceTurnSignalConfirmsAgent(getVoiceTurnSignalMetadata(message)),
			evaluate: () => ({
				processMessage: "RESPOND",
				debug: ["voice turn signal confirmed reply (agentShouldSpeak)"],
			}),
		},
		{
			// Runs AFTER the suppress/confirm signal gates: an explicit address to
			// ANOTHER participant is the final word — it overrides even a generic
			// agentShouldSpeak confirm, so a misfiring signal can't make an
			// un-addressed agent talk over the addressed one.
			name: "core.voice_group_address",
			description:
				"Multi-agent/multi-speaker voice-room turn-taking: an agent defers (IGNORE) when a VOICE_GROUP turn is explicitly addressed to another named participant and not to this agent, so only the addressed agent replies. Undirected turns are left to normal shouldRespond.",
			priority: 0,
			shouldRun: ({ message, runtime, messageHandler }) =>
				isVoiceGroupChannelMessage(message) &&
				voiceGroupAddressSuppressesAgent(
					messageHandler.extract?.addressedTo,
					[runtime.character?.name, runtime.agentId].filter(
						(v): v is string => typeof v === "string" && v.length > 0,
					),
				),
			evaluate: ({ runtime, messageHandler }) => ({
				processMessage: "IGNORE",
				requiresTool: false,
				clearReply: true,
				debug: [
					`voice group: turn addressed to [${(messageHandler.extract?.addressedTo ?? []).join(", ")}], not ${runtime.character?.name ?? runtime.agentId} → defer`,
				],
			}),
		},
		{
			name: "core.transcription_mode",
			description:
				"Suppresses the agent's reply while transcription mode is active (the user turn is still persisted), so long-form recording lands in the conversation silently until an exit phrase turns the mode off.",
			priority: 0,
			shouldRun: ({ message }) => transcriptionModeActive(message),
			evaluate: () => ({
				processMessage: "IGNORE",
				requiresTool: false,
				clearReply: true,
				debug: ["transcription mode active — reply suppressed, turn recorded"],
			}),
		},
		{
			name: "core.simple_registered_action_request",
			description:
				"Promotes simple-path replies to planning when the current user request matches a registered action's metadata.",
			priority: 20,
			shouldRun: ({ message, messageHandler, runtime }) => {
				if (messageHandler.processMessage !== "RESPOND") return false;
				if (messageHandler.plan.requiresTool === true) return false;
				// A sub-agent completion relay is owned by the sub-agent-completion
				// evaluator — its only job is to deliver the finished result. Its text
				// echoes the original task ("[sub-agent: Build and deploy a dice
				// roller…]"), which the action-inference below reads as fresh coding
				// work and promotes to requiresTool — forcing a TASKS tool the relay
				// can't satisfy → required_tool_misses exhaustion → a SUCCESSFUL build
				// reports a false "hit a snag". Never promote a relay turn to tooling.
				if (isSubAgentCompletionArtifact(message)) return false;
				const nonSimpleContexts = (messageHandler.plan.contexts ?? []).filter(
					(context) => context !== SIMPLE_CONTEXT_ID,
				);
				if (nonSimpleContexts.length > 0) return false;
				const text = getUserMessageText(message);
				if (!text?.trim()) return false;
				return (
					inferDirectCurrentRequestCandidateActions(runtime.actions ?? [], text)
						.length > 0
				);
			},
			evaluate: ({ message, runtime }) => {
				const text = getUserMessageText(message) ?? "";
				const candidateActions = inferDirectCurrentRequestCandidateActions(
					runtime.actions ?? [],
					text,
				);
				if (candidateActions.length === 0) return undefined;
				return {
					requiresTool: true,
					addContexts: ["general"],
					addCandidateActions: candidateActions,
					reply: "On it.",
					debug: [
						`current request matched registered action metadata: ${candidateActions.join(", ")}`,
					],
				};
			},
		},
	];

const DIRECT_MESSAGE_HANDLER_TEMPLATE = `task: Plan this direct message.

available_contexts:
{{availableContexts}}

direct/private rules:
- Ordinary chat, static knowledge, creative writing, rewriting, translation, brainstorming, and short explanations: use contexts=["simple"] and put the final answer in replyText.
- For simple requests, replyText is the natural user-facing answer; avoid single-token fragments or placeholders unless the user asked for terse.
- Use non-simple context/action names only for tools, live facts, private state, files, web, shell, side effects, scheduling, memory, settings, secrets, wallet/finance, media, or device/app control.
- Only use "simple" when you can answer directly from your static knowledge or the visible prior_message / reply_reference context. If a specific name/thing is unclear, choose general or memory.
- Never claim searched/scanned/recalled unless tool returned it; includes "I scanned the chat" or "Spawning a sub-agent".
- Never deny a capability (memory, tasks, scheduling, reminders) when a matching context is in available_contexts — route to it; deny only when nothing matches.
- A tool that errored on an earlier turn may work now; on a repeated ask, retry it fresh and report this turn's result, not the old failure.
- Crisis/legal/medical/self-harm/police/CPS: contexts=["simple"], replyText deferral only; no actions or conceal/evasion/testimony/contraband advice. Refer to lawyer/emergency services/poison control/doctor/therapist/crisis/DV hotline.
- For tool/planning paths, replyText is only a brief ack ("On it."). Never refuse because tools may run after this stage.
- If schema omits shouldRespond, do not invent it.
- contexts must be ids from available_contexts. If a needed tool context is unclear, use ["general"].

Return exactly one JSON object for {{handleResponseToolName}}. No prose, markdown, or thinking.
`;

/**
 * Answer-free refusal stubs, matched against the WHOLE normalized reply after
 * an optional leading apology ("I'm sorry, but …") is stripped. A refusal that
 * continues into content ("I'm not sure, but my best guess is …") never
 * matches, and a bare social apology ("Sorry.") is a legitimate reply, not a
 * refusal.
 */
const STAGE1_BARE_REFUSAL_STUBS: ReadonlySet<string> = new Set([
	"i am not sure",
	"i'm not sure",
	"i am not sure how to answer that",
	"i'm not sure how to answer that",
	"i don't know",
	"i do not know",
	"i can't help with that",
	"i cannot help with that",
	"i can't answer that",
	"i cannot answer that",
	"i am unable to help with that",
	"i am unable to answer that",
]);

function isBareRefusalStage1Reply(trimmed: string): boolean {
	const normalized = trimmed
		.toLowerCase()
		.replace(/[’‘]/gu, "'")
		.replace(/\s+/gu, " ")
		.replace(/[.!?]+$/u, "")
		.trim();
	const withoutApology = normalized.replace(
		/^(?:i am sorry|i'm sorry|sorry|my apologies|i apologize)[,.!]?\s*(?:but\s+)?/u,
		"",
	);
	return STAGE1_BARE_REFUSAL_STUBS.has(withoutApology);
}

function isUnusableStage1Reply(reply: string | undefined): boolean {
	const trimmed = typeof reply === "string" ? reply.trim() : "";
	if (!trimmed) return true;
	if (/^```[a-z0-9_-]*\s+/iu.test(trimmed)) return false;
	// A bare refusal stub carries no answer — defer instead of shipping it
	// (#11504 asked to tighten the unusable signal to actual refusals/empties).
	// Refusal-plus-content and bare social apologies never match.
	if (isBareRefusalStage1Reply(trimmed)) return true;
	if (/^[\s{}[\]":,]+$/.test(trimmed)) return true;
	if (/^\d+$/.test(trimmed)) return true;
	// Degenerate single-character spam: the WHOLE reply is one code point
	// repeated 5+ times ("aaaaa", "!!!!!", "aaaaa aaaaa" across whitespace).
	// A repeated run INSIDE a longer reply is legitimate — nested code
	// indentation, aligned `df -h` columns, markdown "-----" dividers, an
	// "XXXXXXXX" placeholder, pretty-printed JSON — and matching those blanked
	// valid replies to "I'm not sure how to answer that." (#11504).
	const nonWhitespace = [...trimmed.replace(/\s+/gu, "")];
	if (nonWhitespace.length >= 5 && new Set(nonWhitespace).size === 1) {
		return true;
	}
	// Multi-token degenerate spam: EVERY whitespace-separated token is a single
	// character repeated 5+ times ("aaaaa bbbbb"). Checked per token — an
	// alternation regex over the whole reply backtracks catastrophically.
	if (trimmed.split(/\s+/u).every((token) => /^(\S)\1{4,}$/u.test(token))) {
		return true;
	}
	if (/^[A-Z]{2,8}$/.test(trimmed)) {
		const allowed = new Set(["OK", "YES", "NO", "STOP"]);
		return !allowed.has(trimmed);
	}
	return false;
}

const EXACT_WORD_COUNT_BY_NAME: Record<string, number> = {
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
};

function parseExactWordsInstruction(
	text: string | null | undefined,
): { literal: string; expectedCount?: number } | null {
	const input = text?.trim();
	if (!input) return null;
	const match = input.match(
		/\b(?:reply|respond|say|output|return)\s+with\s+exactly\s+(?:these\s+)?(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?words?\s*:\s*([\s\S]+?)\s*$/i,
	);
	if (!match) return null;
	const literal = (match[2] ?? "")
		.trim()
		.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
		.trim();
	if (!literal) return null;
	const countRaw = match[1]?.toLowerCase();
	const expectedCount =
		countRaw === undefined
			? undefined
			: /^\d+$/.test(countRaw)
				? Number.parseInt(countRaw, 10)
				: EXACT_WORD_COUNT_BY_NAME[countRaw];
	return { literal, expectedCount };
}

function wordCount(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
}

function stripIncidentalTerminalPeriod(text: string): string {
	return text.endsWith(".") ? text.slice(0, -1).trimEnd() : text;
}

function isRequestedTerseLiteralReply(args: {
	reply: string | undefined;
	messageText: string | null | undefined;
}): boolean {
	const reply = typeof args.reply === "string" ? args.reply.trim() : "";
	if (!reply) return false;
	const instruction = parseExactWordsInstruction(args.messageText);
	if (!instruction) return false;
	if (
		instruction.expectedCount !== undefined &&
		(!Number.isFinite(instruction.expectedCount) ||
			instruction.expectedCount <= 0 ||
			wordCount(reply) !== instruction.expectedCount)
	) {
		return false;
	}
	const requested = instruction.literal;
	if (reply === requested) return true;
	return reply === stripIncidentalTerminalPeriod(requested);
}

/**
 * Recognize a simple imperative to emit ONE specific literal token, e.g.
 * "Say PONG", "say pong", "please say PONG", "can you say PONG", "reply with OK",
 * "respond with the word HELLO", "output PONG!". The lightweight sibling of
 * {@link parseExactWordsInstruction} (which requires the explicit
 * "...with exactly N words: ..." form). Anchored to the whole message and a
 * single word, so it only fires on a clear "say <token>" request — not
 * "say something nice about cats". Returns the requested literal or null.
 */
function parseSayLiteralInstruction(
	text: string | null | undefined,
): string | null {
	const input = text?.trim();
	if (!input) return null;
	// Strip a leading connector mention prefix ("Name (@123) ", "<@123> ",
	// "@name ") so "say PONG" still parses when the user @-mentioned the agent
	// first — Discord/Telegram render the mention into the message text, which
	// the anchored matcher below would otherwise reject.
	const body = input
		.replace(/^\s*(?:<@!?\d+>\s*|@\S+\s+|[^()\n]{0,80}\(@\d+\)\s*)/u, "")
		.trim();
	const match = body.match(
		/^(?:(?:can|could|would|will)\s+you\s+|please\s+|just\s+|kindly\s+){0,3}(?:say|reply|respond|answer|output|return|write|type|echo|print)(?:\s+(?:with|back|the\s+word|the\s+phrase)){0,2}\s*:?\s*["'“”‘’]?([\p{L}\p{N}]{1,40})["'“”‘’]?\s*[.!?]*$/iu,
	);
	return match ? match[1] : null;
}

function isTerseReplyWorthKeeping(args: {
	reply: string | undefined;
	messageText?: string | null;
}): boolean {
	const reply = args.reply;
	const trimmed = typeof reply === "string" ? reply.trim() : "";
	if (/^\d+$/.test(trimmed)) return true;
	if (isRequestedTerseLiteralReply({ reply, messageText: args.messageText })) {
		return true;
	}
	// The user explicitly asked the agent to say a specific token and it did
	// (case-insensitive) — that reply is intentional, not the enum/scaffold
	// leakage isUnusableStage1Reply guards against. Keep it instead of deferring,
	// so "Say PONG"/"Say HELLO" don't dead-end into "I'm not sure how to answer
	// that." just because the reply is an all-caps short word.
	const requested = parseSayLiteralInstruction(args.messageText);
	if (requested && trimmed) {
		const norm = (s: string) =>
			s
				.trim()
				.replace(/[.!?]+$/, "")
				.trim()
				.toLowerCase();
		if (norm(trimmed) === norm(requested)) return true;
	}
	return false;
}

/**
 * Format the role-filtered context catalog as a compact bullet list for the
 * Stage 1 prompt. Each line includes the id plus compressed metadata that helps
 * Stage 1 pick generously without inventing contexts.
 */
export function formatAvailableContextsForPrompt(
	contexts: readonly ContextDefinition[],
	options?: { compact?: boolean },
): string {
	if (contexts.length === 0) {
		return "(no contexts registered)";
	}
	return contexts
		.map((definition) => {
			const description = definition.description?.trim();
			const metadata = [
				definition.label && definition.label !== definition.id
					? `label=${definition.label}`
					: undefined,
				definition.aliases?.length
					? `aliases=${definition.aliases.join(",")}`
					: undefined,
				definition.parent
					? `parent=${definition.parent}`
					: definition.parents?.length
						? `parents=${definition.parents.join(",")}`
						: undefined,
				definition.roleGate
					? formatRoleGateForPrompt(definition.roleGate)
					: undefined,
				definition.sensitivity
					? `sensitivity=${definition.sensitivity}`
					: undefined,
				definition.cacheScope ? `cache=${definition.cacheScope}` : undefined,
			].filter(Boolean);
			const suffix = metadata.length > 0 ? ` [${metadata.join("; ")}]` : "";
			if (options?.compact) {
				// Compact catalog lines carry only the short routing hint (when the
				// definition ships one) — never the full description, which is what
				// the compact tiers exist to avoid.
				const compressed = definition.descriptionCompressed?.trim();
				return compressed
					? `- ${definition.id}${suffix}: ${compressed}`
					: `- ${definition.id}${suffix}`;
			}
			return description
				? `- ${definition.id}${suffix}: ${description}`
				: `- ${definition.id}${suffix}`;
		})
		.join("\n");
}

function formatRoleGateForPrompt(
	roleGate: ContextDefinition["roleGate"],
): string | undefined {
	if (!roleGate) {
		return undefined;
	}
	if (roleGate.minRole) {
		return `role>=${roleGate.minRole}`;
	}
	const anyOf = [...(roleGate.roles ?? []), ...(roleGate.anyOf ?? [])];
	if (anyOf.length > 0) {
		return `role=${anyOf.join("|")}`;
	}
	if (roleGate.allOf?.length) {
		return `role_all=${roleGate.allOf.join("+")}`;
	}
	return undefined;
}

/**
 * The Stage-1 `messageHandlerTemplate` covers two optimized-prompt tasks:
 *
 *   - `should_respond` — the prompt asks the model to decide whether to
 *     respond or ignore the message. Optimizing this task tunes the classifier.
 *   - `response` — Stage-1 also emits the assistant's draft reply when it
 *     decides to respond, so a separately-trained `response` artifact
 *     replaces the same baseline when present and the operator wants that
 *     variant active.
 */
function selectMessageHandlerTask(
	_availableContexts: readonly ContextDefinition[],
): OptimizedPromptTask {
	// context_routing was retired (inferContextRoutingFromText is pure regex,
	// no LLM call to optimize); the message-handler template falls back to the
	// should_respond task for both the contexts-available and contexts-empty
	// callers.
	return "should_respond";
}

function renderMessageHandlerInstructions(
	runtime: OptimizedPromptRuntimeLike,
	availableContexts: readonly ContextDefinition[],
	options?: {
		directMessage?: boolean;
		groupTriage?: boolean;
		responseHandlerFields?: string;
	},
): string {
	// Three tiers: DM/private (compact, no shouldRespond), unaddressed
	// group-triage (compact + shouldRespond — most such turns end in IGNORE,
	// so they must not pay the full ~16KB rule block), and the full template
	// for addressed/respond-likely turns.
	const compactTier =
		options?.directMessage === true || options?.groupTriage === true;
	const baselineTemplate = options?.directMessage
		? DIRECT_MESSAGE_HANDLER_TEMPLATE
		: options?.groupTriage
			? GROUP_TRIAGE_MESSAGE_HANDLER_TEMPLATE
			: messageHandlerTemplate;
	const baseline = resolveOptimizedPromptForRuntime(
		runtime,
		selectMessageHandlerTask(availableContexts),
		baselineTemplate,
	);
	const rendered = composePrompt({
		state: {
			directMessage: options?.directMessage ? "true" : "",
			availableContexts: formatAvailableContextsForPrompt(availableContexts, {
				compact: compactTier,
			}),
			handleResponseToolName: HANDLE_RESPONSE_TOOL_NAME,
		},
		template: baseline,
	}).trim();
	const renderedWithSharedRules = compactTier
		? [rendered, "", `- ${COMPACT_CODE_SNIPPET_VALIDITY_INSTRUCTION}`].join(
				"\n",
			)
		: [
				rendered,
				"",
				"## Shared Response Quality Rules",
				`- ${CODE_SNIPPET_VALIDITY_INSTRUCTION}`,
			].join("\n");
	if (!options?.responseHandlerFields?.trim()) {
		return renderedWithSharedRules;
	}
	return [
		renderedWithSharedRules,
		"",
		"## Response Handler Fields",
		"Populate every registered field. Use empty value when not applicable.",
		options.responseHandlerFields.trim(),
	].join("\n");
}

function renderMessageHandlerModelInput(
	runtime: OptimizedPromptRuntimeLike,
	context: ContextObject,
	availableContexts: readonly ContextDefinition[] = [],
	options?: {
		directMessage?: boolean;
		groupTriage?: boolean;
		responseHandlerFields?: string;
	},
): {
	messages: ChatMessage[];
	promptSegments: PromptSegment[];
} {
	const rendered = renderContextObject(context);
	const instructions = renderMessageHandlerInstructions(
		runtime,
		availableContexts,
		options,
	);
	const stableSegments = rendered.promptSegments.filter(
		(segment) => segment.stable,
	);
	const dynamicSegments = rendered.promptSegments.filter(
		(segment) => !segment.stable,
	);
	const promptSegments = normalizePromptSegments([
		...stableSegments,
		{ content: `message_handler_stage:\n${instructions}`, stable: true },
		...dynamicSegments,
	]);
	const systemContent = normalizePromptSegments([
		...stableSegments,
		{ content: `message_handler_stage:\n${instructions}`, stable: true },
	])
		.map(segmentBlock)
		.join("\n\n");
	const userContent = normalizePromptSegments(dynamicSegments)
		.map(segmentBlock)
		.join("\n\n");
	return {
		messages: [
			{ role: "system", content: systemContent },
			{ role: "user", content: userContent },
		],
		promptSegments,
	};
}

/**
 * Render only the *stable* part of the Stage-1 (`HANDLE_RESPONSE`) model
 * input for a given room — the system prompt + tool/action schema block +
 * the stable provider blocks. This is the prefix that does NOT depend on
 * the user's turn, so it is the exact text the local-inference KV cache
 * should be pre-warmed with the instant a voice session opens or VAD
 * detects speech onset (item I1/C1 of the voice swarm).
 *
 * The returned string is byte-identical to the `messages[0].content`
 * (the "system" message) that `renderMessageHandlerModelInput` would
 * produce for the first turn of a fresh conversation in that room — the
 * unstable tail (recent dialogue, the current user message) is dropped.
 * Pre-warming with this string lands the system prefix in the slot's KV
 * so the real request only forward-passes the user tokens.
 *
 * Best-effort by construction: composing state may hit providers that
 * query the DB; a synthetic empty message is used so a brand-new room
 * with no history still renders. Callers that fail to render should just
 * skip the pre-warm (the real request cold-prefills, which is the
 * pre-pre-warm behaviour).
 */
export async function renderMessageHandlerStablePrefix(
	runtime: IAgentRuntime,
	roomId: UUID,
): Promise<string> {
	const syntheticMessage: Memory = {
		id: asUUID(v4()),
		entityId: (runtime.agentId ?? asUUID(v4())) as UUID,
		agentId: runtime.agentId,
		roomId,
		createdAt: Date.now(),
		content: {
			text: "",
			source: "voice-prewarm",
			channelType: ChannelType.VOICE_DM,
		},
	};
	const senderRole = await resolveStage1SenderRole(runtime, syntheticMessage);
	const availableContexts = listAvailableContextsForRole(
		runtime.contexts,
		senderRole,
	);
	const state = await composeResponseState(runtime, syntheticMessage, true);
	const context = await createV5MessageContextObject({
		runtime,
		message: syntheticMessage,
		state,
		userRoles: [senderRole],
		availableContexts,
		extraProviderExclusions:
			stage1ProviderExclusionsForMessage(syntheticMessage),
	});
	const rendered = renderContextObject(context);
	const stableSegments = rendered.promptSegments.filter(
		(segment) => segment.stable,
	);
	const instructions = renderMessageHandlerInstructions(
		runtime,
		availableContexts,
		{ directMessage: true },
	);
	return normalizePromptSegments([
		...stableSegments,
		{ content: `message_handler_stage:\n${instructions}`, stable: true },
	])
		.map(segmentBlock)
		.join("\n\n");
}

function canonicalJsonValue(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJsonValue).join(",")}]`;
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(
			([left], [right]) => left.localeCompare(right),
		);
		return `{${entries
			.map(
				([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonValue(entry)}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function parseToolArgumentsString(
	value: string,
): Record<string, unknown> | null {
	const trimmed = value.trim();
	if (!trimmed) return null;

	try {
		const parsed: unknown = JSON.parse(trimmed);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		// Continue to the duplicated-streaming recovery below.
	}

	const objects = extractJsonObjects(trimmed);
	if (objects.length === 0) return null;

	let remainder = trimmed;
	for (const objectText of objects) {
		remainder = remainder.replace(objectText, "");
	}
	if (remainder.replace(/\0/g, "").trim().length > 0) {
		return null;
	}

	const parsedObjects = objects.map((objectText) => {
		try {
			const parsed: unknown = JSON.parse(objectText);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: null;
		} catch {
			return null;
		}
	});
	if (parsedObjects.some((parsed) => !parsed)) {
		return null;
	}

	const [first, ...rest] = parsedObjects as Record<string, unknown>[];
	const canonical = canonicalJsonValue(first);
	if (rest.some((entry) => canonicalJsonValue(entry) !== canonical)) {
		return null;
	}
	return first;
}

function parseToolArguments(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return typeof value === "string" ? parseToolArgumentsString(value) : null;
	}
	return value as Record<string, unknown>;
}

function parseMessageHandlerNativeToolCall(
	raw: GenerateTextResult,
): MessageHandlerResult | null {
	const args = extractHandleResponseToolArguments(raw);
	return args ? parseMessageHandlerOutput(JSON.stringify(args)) : null;
}

function extractHandleResponseToolArguments(
	raw: GenerateTextResult,
): Record<string, unknown> | null {
	const toolCalls = Array.isArray(raw.toolCalls) ? raw.toolCalls : [];
	for (const entry of toolCalls) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			continue;
		}
		const name = String(
			entry.name ?? entry.toolName ?? entry.tool ?? entry.action ?? "",
		).trim();
		if (name !== HANDLE_RESPONSE_TOOL_NAME) {
			continue;
		}
		const args = parseToolArguments(
			entry.arguments ?? entry.args ?? entry.input ?? entry.params,
		);
		if (!args || !looksLikeMessageHandlerToolArguments(args)) {
			continue;
		}
		return args;
	}
	return null;
}

function hasHandleResponseToolCall(raw: GenerateTextResult): boolean {
	const toolCalls = Array.isArray(raw.toolCalls) ? raw.toolCalls : [];
	return toolCalls.some((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			return false;
		}
		const name = String(
			entry.name ?? entry.toolName ?? entry.tool ?? entry.action ?? "",
		).trim();
		return name === HANDLE_RESPONSE_TOOL_NAME;
	});
}

function looksLikeMessageHandlerToolArguments(
	args: Record<string, unknown>,
): boolean {
	if (Object.keys(args).length === 0) {
		return false;
	}
	return (
		args.shouldRespond !== undefined ||
		args.contexts !== undefined ||
		args.replyText !== undefined ||
		args.intents !== undefined ||
		args.candidateActionNames !== undefined ||
		args.facts !== undefined ||
		args.relationships !== undefined ||
		args.addressedTo !== undefined ||
		args.emotion !== undefined ||
		args.processMessage !== undefined ||
		args.plan !== undefined ||
		args.extract !== undefined
	);
}

function extractMessageHandlerRawParsed(
	raw: string | GenerateTextResult,
): Record<string, unknown> | null {
	const parsed =
		typeof raw === "string"
			? parseJsonObject<Record<string, unknown>>(raw)
			: (extractHandleResponseToolArguments(raw) ??
				parseJsonObject<Record<string, unknown>>(getV5ModelText(raw)));
	return parsed && looksLikeMessageHandlerToolArguments(parsed) ? parsed : null;
}

function normalizeRawParsedForFieldRegistry(
	raw: Record<string, unknown>,
): Record<string, unknown> {
	const normalized = { ...raw };
	const plan =
		raw.plan && typeof raw.plan === "object" && !Array.isArray(raw.plan)
			? (raw.plan as Record<string, unknown>)
			: undefined;
	const extract =
		raw.extract &&
		typeof raw.extract === "object" &&
		!Array.isArray(raw.extract)
			? (raw.extract as Record<string, unknown>)
			: undefined;
	if (normalized.shouldRespond === undefined) {
		normalized.shouldRespond =
			raw.processMessage === "IGNORE" || raw.processMessage === "STOP"
				? raw.processMessage
				: "RESPOND";
	}
	if (normalized.replyText === undefined) {
		normalized.replyText = typeof plan?.reply === "string" ? plan.reply : "";
	}
	if (normalized.contexts === undefined) {
		normalized.contexts = Array.isArray(plan?.contexts) ? plan.contexts : [];
	}
	if (normalized.candidateActionNames === undefined) {
		normalized.candidateActionNames = Array.isArray(plan?.candidateActions)
			? plan.candidateActions
			: [];
	}
	if (normalized.facts === undefined) {
		normalized.facts = Array.isArray(extract?.facts) ? extract.facts : [];
	}
	if (normalized.relationships === undefined) {
		normalized.relationships = Array.isArray(extract?.relationships)
			? extract.relationships
			: [];
	}
	if (normalized.addressedTo === undefined) {
		normalized.addressedTo = Array.isArray(extract?.addressedTo)
			? extract.addressedTo
			: [];
	}
	if (normalized.topics === undefined) {
		normalized.topics = Array.isArray(extract?.topics) ? extract.topics : [];
	}
	return normalized;
}

/**
 * A model-named candidate action is "valid" if it matches an exposed action's
 * name OR one of its similes. Matching similes is essential: the planner often
 * names a sub-action alias (e.g. SPAWN_AGENT) of an exposed action (TASKS), and
 * a name-only check rejects it — dropping the action and shipping a bare "On
 * it." ack with no work done (live regression: "now add a footer to the tea
 * site" -> candidateActionNames:["SPAWN_AGENT"], contexts:[], reply:"On it.",
 * no spawn).
 */
function exposedActionMatches(
	actions: ReadonlyArray<Pick<Action, "name" | "similes">>,
	normalizedCandidate: string,
): boolean {
	return actions.some((action) => {
		if (normalizeActionIdentifier(action.name) === normalizedCandidate) {
			return true;
		}
		const similes = Array.isArray(action.similes) ? action.similes : [];
		return similes.some(
			(simile) =>
				normalizeActionIdentifier(String(simile)) === normalizedCandidate,
		);
	});
}

export function messageHandlerFromFieldResult(
	result: ResponseHandlerResult,
	fieldRun?: ResponseHandlerFieldRunResult,
	runtimeContext?: {
		actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;
		messageText?: string;
		candidateBackstopRules?: readonly CandidateActionBackstopRule[];
		subAgentCompletionRelay?: boolean;
	},
): MessageHandlerResult {
	const rawContexts = Array.isArray(result.contexts)
		? result.contexts.map((context) => String(context).trim()).filter(Boolean)
		: [];
	const rawCandidateActions = Array.isArray(result.candidateActionNames)
		? result.candidateActionNames
				.map((action) => String(action).trim())
				.filter(Boolean)
		: [];
	const currentMessageText = runtimeContext?.messageText ?? "";
	// A sub-agent completion relay's envelope echoes the original task text
	// ("[sub-agent: Build and deploy…]"), so every text-intent inference over
	// the CURRENT message reads a FINISHED task as fresh task intent. Disable
	// the text-derived candidate injections (coding backstop, ack-intent
	// inference, direct-current inference) on relay turns — the relay's only
	// job is to deliver the result, and forcing a tool over it rejects REPLY up
	// to the required-tool miss cap or re-spawns completed work. Structural:
	// the flag comes from the relay's own markers (metadata.subAgent / router
	// source / envelope prefix), not from classifying LLM text. The model's OWN
	// explicit routing (contexts + candidateActionNames it emitted) is
	// untouched, so genuine user task-intent turns keep the full backstop.
	const subAgentCompletionRelay =
		runtimeContext?.subAgentCompletionRelay === true;
	const candidateBackstop = subAgentCompletionRelay
		? { candidateActions: [...rawCandidateActions], forceCodeContext: false }
		: applyCodingCandidateBackstop({
				candidateActions: rawCandidateActions,
				actions: runtimeContext?.actions ?? [],
				messageText: currentMessageText,
				backstopRules: runtimeContext?.candidateBackstopRules ?? [],
			});
	const candidateActions = candidateBackstop.candidateActions;
	const contexts =
		candidateBackstop.forceCodeContext &&
		!rawContexts.some((context) => context.toLowerCase() === "code")
			? ["code", ...rawContexts]
			: rawContexts;
	const replyTextRaw = stripJsonStructuralJunkReply(
		typeof result.replyText === "string" ? result.replyText : "",
	);
	const hasRunnableCandidateAction = candidateActionsContainRunnableAction(
		candidateActions,
		runtimeContext,
	);
	const inferredAckCandidateActions =
		!subAgentCompletionRelay &&
		!hasRunnableCandidateAction &&
		hasAckOnlyActionableIntent(result, replyTextRaw, currentMessageText)
			? inferAckIntentCandidateActions(
					result,
					runtimeContext?.actions ?? [],
					currentMessageText,
				)
			: [];
	const hasValidProvidedCandidate =
		runtimeContext && candidateActions.length > 0
			? candidateActions.some((name) => {
					const normalized = normalizeActionIdentifier(name);
					if (canonicalPlannerControlActionName(normalized) !== null) {
						return true;
					}
					return exposedActionMatches(runtimeContext.actions, normalized);
				})
			: candidateActions.length > 0;
	const directCurrentCandidateActions =
		!subAgentCompletionRelay && currentMessageText.trim().length > 0
			? inferDirectCurrentRequestCandidateActions(
					runtimeContext?.actions ?? [],
					currentMessageText,
				)
			: [];
	const preferDirectCurrentCandidateActions =
		shouldPreferDirectCurrentCandidateActions({
			candidateActions,
			currentMessageText,
			directCandidateActions: directCurrentCandidateActions,
			actions: runtimeContext?.actions,
		});
	const inferredDirectCandidateActions =
		!preferDirectCurrentCandidateActions &&
		!hasValidProvidedCandidate &&
		inferredAckCandidateActions.length === 0 &&
		directCurrentCandidateActions.length > 0
			? directCurrentCandidateActions
			: [];
	const effectiveCandidateActions = preferDirectCurrentCandidateActions
		? directCurrentCandidateActions
		: uniqueActionNames([
				...candidateActions,
				...inferredAckCandidateActions,
				...inferredDirectCandidateActions,
			]);
	const runnableCandidateActions = filterRunnableCandidateActions(
		effectiveCandidateActions,
		runtimeContext,
	);
	const planCandidateActions =
		inferredDirectCandidateActions.length > 0 &&
		candidateActions.length > 0 &&
		!hasValidProvidedCandidate
			? runnableCandidateActions
			: effectiveCandidateActions;
	// When the caller passes the runtime's `actions`, narrow the candidate set
	// to those that are (a) registered actions OR (b) canonical control names
	// (REPLY / IGNORE / STOP). All-bogus candidate lists collapse to length 0,
	// which lets the routing logic below fall back to simple-reply when the
	// only context is "simple". When no `runtimeContext` is provided, behaviour
	// is unchanged (back-compat).
	const validCandidateCount = runnableCandidateActions.length;
	const facts = Array.isArray(result.facts)
		? result.facts.map((fact) => String(fact).trim()).filter(Boolean)
		: [];
	const relationships = Array.isArray(result.relationships)
		? result.relationships
				.map((entry) => {
					if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
						return null;
					}
					const rel = entry as Record<string, unknown>;
					const subject =
						typeof rel.subject === "string" ? rel.subject.trim() : "";
					const predicate =
						typeof rel.predicate === "string" ? rel.predicate.trim() : "";
					const object =
						typeof rel.object === "string" ? rel.object.trim() : "";
					return subject && predicate && object
						? { subject, predicate, object }
						: null;
				})
				.filter(
					(
						entry,
					): entry is { subject: string; predicate: string; object: string } =>
						entry !== null,
				)
		: [];
	const addressedTo = Array.isArray(result.addressedTo)
		? result.addressedTo
				.map((addressed) => String(addressed).trim())
				.filter(Boolean)
		: [];
	const topics = normalizeTopics(result.topics);
	const preempt = fieldRun?.preempt;
	const processMessage =
		preempt?.mode === "ignore"
			? "IGNORE"
			: result.shouldRespond === "STOP"
				? "STOP"
				: result.shouldRespond === "IGNORE"
					? "IGNORE"
					: "RESPOND";
	const preemptDirect =
		preempt?.mode === "ack-and-stop" || preempt?.mode === "direct-reply";
	const routedContexts = preemptDirect
		? Array.from(new Set([...contexts, SIMPLE_CONTEXT_ID]))
		: contexts;
	const initialPlanningContexts = routedContexts.filter(
		(context) => context !== SIMPLE_CONTEXT_ID,
	);
	const requestedPlanning =
		initialPlanningContexts.length > 0 || validCandidateCount > 0;
	// The model can explicitly commit to delegation: for a genuine coding-work
	// request it routes to a non-simple context of its OWN choosing AND names a
	// runnable coding-delegation / spawn-class action in its OWN candidate list
	// (not the runtime backstop's inferred one). When it does, a verbose
	// sentence-shaped ack ("On it — spawning a coding agent to build the page.")
	// is still an ACK, not a finished answer — so the complete-direct-reply
	// override must NOT pull it back to the simple path. Without this guard,
	// planner-models that write fuller acks (e.g. the OAuth Claude bridge) trip
	// looksLikeCompleteDirectReply and the sub-agent never spawns, while terse-ack
	// models ("On it.") plan correctly. Keyed on the parsed plan shape, the action
	// registry, and the same structural coding-work classifier used by the
	// candidate backstop (which excludes creative-writing / explanation asks), so
	// it is model-agnostic and regresses neither the direct-answer nor the
	// poem-about-an-app path.
	// An explicit, runnable spawn/delegation candidate in the model's OWN
	// candidate list — for a message that structurally looks like coding work — is
	// a firm "delegate this" commitment, and must win EVEN when the model ALSO
	// (contradictorily) routed contexts=[simple] with a chatty complete-looking
	// replyText. Previously this also required a non-simple planning context
	// (`initialPlanningContexts.length > 0`); dropping that requirement closes the
	// live bug where "build the app" came back with contexts=[simple] +
	// candidateActionNames=[TASKS_SPAWN_AGENT], so shouldPreferCompleteDirectReply
	// treated the spawn as "weak", suppressed it, and the bot said "I'm building
	// it" while never spawning. Still safe: the text gate below excludes
	// creative-writing / explanation asks, and the candidate must be a REGISTERED
	// delegation action — so this never fires on a poem or a how-do-I question.
	const modelRoutedPlanningContext = rawContexts.some(
		(context) => context.toLowerCase() !== SIMPLE_CONTEXT_ID,
	);
	// Text gate for the delegation commitment. When the model routed a planning
	// context of its OWN (dual model-authored signal: context + candidate), the
	// commitment stands unless the ask is a class delegation can never serve
	// (creative writing, explanation, explicit no-spawn) — requiring positive
	// coding keywords in the CURRENT message was the live ack-then-nothing hole
	// (2026-07-01, trajectory tj-df82b48e763b7b): a follow-up critique of prior
	// build work ("this isn't your best work") carries no coding keywords — the
	// work context lives in conversation history — so the complete-direct-reply
	// override dropped the model's TASKS_SPAWN_AGENT plan and shipped its ack
	// ("Let me take another pass…") as the whole turn. In the contradictory
	// contexts=[simple] shape the candidate is the only signal, so the message
	// itself must still look like coding work.
	const delegationTextGate = modelRoutedPlanningContext
		? !looksLikeDelegationExcludedAsk(currentMessageText)
		: looksLikeCodingWorkRequest(currentMessageText);
	const modelCommittedToDelegation =
		!preemptDirect &&
		delegationTextGate &&
		modelProvidedRunnableDelegationCandidate(
			rawCandidateActions,
			runtimeContext?.actions ?? [],
			// With a planning context the model's own routing already signals
			// work, so any delegation-class candidate (including the ambiguous
			// legacy alias "TASKS") confirms the commitment. In the contradictory
			// contexts=[simple] shape the candidate is the ONLY delegation
			// signal, so it must be unambiguous — bare "TASKS" (task-list
			// management as much as delegation) on a loosely coding-shaped
			// message ("update me on the project") must not override a complete
			// direct answer into forced planning.
			{ requireUnambiguous: initialPlanningContexts.length === 0 },
		);
	// The model can also route a planning context AND name candidates that
	// resolve to NOTHING in the registry (e.g. SEND_ATTACHMENT / UPLOAD_FILE for
	// "attach that here"). That is still a committed plan — the model believes
	// tool work is needed and wrote its replyText as an ACK per the Stage-1
	// field contract — but the candidates expose a capability gap, so the
	// complete-direct-reply override must not reinterpret the full-sentence ack
	// ("On it — attaching now.") as a finished answer and ship the promise as
	// the WHOLE turn (live ack-then-nothing regression, 2026-07-01: trajectory
	// tj-823d6382b54c66). The planner turn is where an unresolvable plan gets an
	// honest "I can't do that here" instead of a silent broken promise. Keyed on
	// the model-authored plan shape (contexts + candidates it emitted vs the
	// action registry), never on the reply text. Registered candidates are not
	// commitment by themselves: weak-class ones stay overridable (a complete
	// answer beats a stray SHELL hint), non-weak ones already block the override
	// via hasOnlyWeakDirectReplyPlanningSignals, and delegation-class ones are
	// the guard above.
	const modelCommittedToPlanning =
		!preemptDirect &&
		modelRoutedPlanningContext &&
		runtimeContext !== undefined &&
		rawCandidateActions.some((name) => {
			const normalized = normalizeActionIdentifier(name);
			return (
				canonicalPlannerControlActionName(normalized) === null &&
				!exposedActionMatches(runtimeContext.actions, normalized)
			);
		});
	const preferCompleteDirectReply =
		!preemptDirect &&
		requestedPlanning &&
		!modelCommittedToDelegation &&
		!modelCommittedToPlanning &&
		shouldPreferCompleteDirectReply({
			replyText: replyTextRaw,
			candidateActions: runnableCandidateActions,
			contexts: routedContexts,
		});
	const preferInlineCodeSnippetDirectReply =
		!preemptDirect &&
		requestedPlanning &&
		shouldPreferInlineCodeSnippetDirectReply({
			currentMessageText,
			candidateActions: runnableCandidateActions,
			contexts: routedContexts,
		});
	const shouldPlan =
		!preemptDirect &&
		requestedPlanning &&
		!preferCompleteDirectReply &&
		!preferInlineCodeSnippetDirectReply;
	const finalContexts =
		preferCompleteDirectReply || preferInlineCodeSnippetDirectReply
			? [SIMPLE_CONTEXT_ID]
			: shouldPlan && initialPlanningContexts.length === 0
				? Array.from(
						new Set([
							...routedContexts.filter(
								(context) => context !== SIMPLE_CONTEXT_ID,
							),
							"general",
						]),
					)
				: routedContexts;
	const replyText = replyTextRaw;
	const plan: MessageHandlerResult["plan"] = {
		contexts: finalContexts,
		reply: replyText,
		simple: preemptDirect ? true : !shouldPlan,
		requiresTool: shouldPlan,
	};
	if (
		!preferCompleteDirectReply &&
		!preferInlineCodeSnippetDirectReply &&
		planCandidateActions.length > 0
	) {
		plan.candidateActions = planCandidateActions;
	}
	const extract =
		facts.length > 0 ||
		relationships.length > 0 ||
		addressedTo.length > 0 ||
		topics.length > 0
			? { facts, relationships, addressedTo, topics }
			: undefined;
	return {
		processMessage,
		thought: fieldRun?.preempt?.reason ?? "",
		plan,
		...(extract ? { extract } : {}),
	};
}

function applyCodingCandidateBackstop(args: {
	candidateActions: readonly string[];
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;
	messageText: string;
	backstopRules: readonly CandidateActionBackstopRule[];
}): { candidateActions: string[]; forceCodeContext: boolean } {
	if (args.candidateActions.length === 0) {
		return {
			candidateActions: [...args.candidateActions],
			forceCodeContext: false,
		};
	}
	if (!looksLikeCodingWorkRequest(args.messageText)) {
		return {
			candidateActions: [...args.candidateActions],
			forceCodeContext: false,
		};
	}
	const normalizedCandidates = args.candidateActions.map(
		normalizeActionIdentifier,
	);
	// A registered backstop rule protects its candidates when it both owns one
	// of the candidate actions AND recognizes this message as addressed to it.
	const protectedByRule = args.backstopRules.some((rule) => {
		const owned = new Set(rule.actionNames.map(normalizeActionIdentifier));
		return (
			normalizedCandidates.some((name) => owned.has(name)) &&
			rule.matches(args.messageText)
		);
	});
	if (protectedByRule) {
		return {
			candidateActions: [...args.candidateActions],
			forceCodeContext: false,
		};
	}
	const codingAction = findCodingDelegationActionName(args.actions);
	if (!codingAction) {
		return {
			candidateActions: [...args.candidateActions],
			forceCodeContext: false,
		};
	}

	const backstopActionNames = new Set(
		args.backstopRules.flatMap((rule) =>
			rule.actionNames.map(normalizeActionIdentifier),
		),
	);
	const filtered = args.candidateActions.filter(
		(name) => !backstopActionNames.has(normalizeActionIdentifier(name)),
	);
	if (filtered.length === args.candidateActions.length) {
		return { candidateActions: filtered, forceCodeContext: false };
	}

	return {
		candidateActions: uniqueActionNames([codingAction, ...filtered]),
		forceCodeContext: true,
	};
}

function candidateActionsContainRunnableAction(
	candidateActions: readonly string[],
	runtimeContext:
		| {
				actions: ReadonlyArray<Pick<Action, "name" | "similes">>;
		  }
		| undefined,
): boolean {
	if (candidateActions.length === 0) return false;
	if (!runtimeContext) return true;
	return candidateActions.some((name) => {
		const normalized = normalizeActionIdentifier(name);
		if (canonicalPlannerControlActionName(normalized) !== null) return true;
		return exposedActionMatches(runtimeContext.actions, normalized);
	});
}

function filterRunnableCandidateActions(
	candidateActions: readonly string[],
	runtimeContext:
		| {
				actions: ReadonlyArray<Pick<Action, "name" | "similes">>;
		  }
		| undefined,
): string[] {
	if (!runtimeContext) return [...candidateActions];
	return candidateActions.filter((name) => {
		const normalized = normalizeActionIdentifier(name);
		if (canonicalPlannerControlActionName(normalized) !== null) return true;
		return exposedActionMatches(runtimeContext.actions, normalized);
	});
}

export function applyDirectCurrentCandidateBackstopToMessageHandler(
	messageHandler: MessageHandlerResult,
	runtimeContext:
		| {
				actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;
				messageText?: string;
				subAgentCompletionRelay?: boolean;
		  }
		| undefined,
): MessageHandlerResult {
	const currentMessageText = runtimeContext?.messageText ?? "";
	// A sub-agent completion relay is not a user request — its envelope ECHOES
	// the original task text ("[sub-agent: Build and deploy…]"), so the intent
	// inference below reads a FINISHED task as fresh task intent, promotes the
	// turn to requiresTool, and the planner rejects REPLY up to the
	// required-tool miss cap (or re-runs the injected delegation candidate,
	// re-spawning completed work). The flag is derived from the relay's
	// structural markers (metadata.subAgent / router source / envelope
	// prefix), never from classifying LLM text, so genuine user task-intent
	// turns keep the backstop.
	if (
		messageHandler.processMessage !== "RESPOND" ||
		!runtimeContext ||
		runtimeContext.subAgentCompletionRelay === true ||
		currentMessageText.trim().length === 0
	) {
		return messageHandler;
	}

	const directCurrentCandidateActions =
		inferDirectCurrentRequestCandidateActions(
			runtimeContext.actions,
			currentMessageText,
		);
	if (directCurrentCandidateActions.length === 0) return messageHandler;

	const runnableCandidateActions = filterRunnableCandidateActions(
		uniqueActionNames([
			...getMessageHandlerCandidateActions(messageHandler),
			...directCurrentCandidateActions,
		]),
		runtimeContext,
	);
	if (runnableCandidateActions.length === 0) return messageHandler;

	// The structured-envelope path (messageHandlerFromFieldResult) already refuses
	// to force-plan over a finished answer whose only planning signals are weak,
	// injectable ones (a simple/general context + search/shell-class candidates)
	// via shouldPreferCompleteDirectReply. The plain-text fallback lands here
	// too and must apply the same valve: without it, a COMPLETE plain-text answer
	// ("Your lucky number is 4291." / a solved logic puzzle) that this backstop
	// happened to tag with an inferred WEB_SEARCH candidate would be promoted to
	// requiresTool=true — forcing a pointless web search + a slow extra planner
	// round, even though the identical answer in JSON form (contexts=[simple])
	// goes direct. Apply the same structural valve here so the two Stage-1 shapes
	// route identically. Live-info stays correct: its Stage-1 reply is an ack
	// ("Checking the price now."), not a complete answer, so it fails
	// looksLikeCompleteDirectReply and still forces the fetch. Coding/spawn stays
	// correct too: a strong (non-weak) candidate fails hasOnlyWeakDirectReplyPlanningSignals.
	// The extra !looksLikeCodingWorkRequest guard mirrors the structured path's
	// !modelCommittedToDelegation gate: spawn-class actions (TASKS_SPAWN_AGENT, …)
	// are ALSO in the weak-override set, so without this a plain-text "build the
	// app" reply that read as a complete sentence could be kept direct and never
	// spawn. Restricting the valve to non-coding-work turns keeps the build-spawn
	// path intact while still short-circuiting finished plain-text answers.
	// The !looksLikeWebSearchRequest guard closes the freshness hole the valve
	// would otherwise open (adversarial review): on an explicitly fresh ask
	// ("what's the current BTC price?") a model that confidently HALLUCINATES a
	// complete-looking plain-text answer must not be kept direct — a stale price
	// delivered confidently is worse than the extra fetch. The valve's wins
	// (lucky-number echoes, solved riddles, static knowledge) carry no
	// current-info signal and keep taking the direct path.
	if (
		!looksLikeCodingWorkRequest(currentMessageText) &&
		!looksLikeWebSearchRequest(currentMessageText) &&
		shouldPreferCompleteDirectReply({
			replyText: String(messageHandler.plan.reply ?? ""),
			candidateActions: runnableCandidateActions,
			contexts: messageHandler.plan.contexts ?? [],
		})
	) {
		return messageHandler;
	}

	const planningContexts = (messageHandler.plan.contexts ?? []).filter(
		(context) => context !== SIMPLE_CONTEXT_ID,
	);
	return {
		...messageHandler,
		plan: {
			...messageHandler.plan,
			contexts:
				planningContexts.length > 0
					? Array.from(new Set(planningContexts))
					: ["general"],
			simple: false,
			requiresTool: true,
			candidateActions: runnableCandidateActions,
		},
	};
}

const PLANNING_ACK_REPLIES = new Set([
	"got it.",
	"looking into it.",
	"on it.",
	"running shell commands to gather disk usage...",
	"spawning the sub-agent now.",
	"working on it.",
]);

function looksLikeProgressOnlyReply(replyText: string): boolean {
	const normalized = replyText.trim().toLowerCase();
	if (!normalized) return false;
	if (PLANNING_ACK_REPLIES.has(normalized)) return true;
	return /^(?:checking|fetching|gathering|looking (?:up|into)|running|using|spawning|starting|working on|one moment|let me|i(?:'|’)ll|i will)\b/.test(
		normalized,
	);
}

function looksLikeCompleteDirectReply(replyText: string): boolean {
	const normalized = replyText.trim();
	if (normalized.length < 24) return false;
	if (looksLikeProgressOnlyReply(normalized)) return false;
	return (
		/[.!?。！？]$/u.test(normalized) || normalized.split(/\s+/u).length >= 8
	);
}

function _isSimpleMessageHandlerShortcut(
	messageHandler: MessageHandlerResult,
): boolean {
	if (messageHandler.processMessage !== "RESPOND") return false;
	if (messageHandler.plan.requiresTool === true) return false;
	const contexts = messageHandler.plan.contexts ?? [];
	const nonSimpleContexts = contexts.filter(
		(context) => context !== SIMPLE_CONTEXT_ID,
	);
	return (
		nonSimpleContexts.length === 0 &&
		(messageHandler.plan.candidateActions?.length ?? 0) === 0
	);
}

// Prefer a complete, substantive direct reply over force-planned action when
// the model already answered the turn. Purely STRUCTURAL — it never scans the
// user's text to classify intent:
//   1. the reply reads as a finished answer, not an ack/progress/refusal/empty
//      fragment (looksLikeCompleteDirectReply), and
//   2. the only signals pushing toward planning are weak/injectable ones — a
//      simple/general context plus search/shell/spawn-class candidate actions,
//      the exact shapes the Stage-1 inference backstop force-injects
//      (hasOnlyWeakDirectReplyPlanningSignals).
// When the model defers to a tool it acks ("On it.") or returns an empty/refusal
// reply, which fails (1) — so genuine web/shell/build turns still plan, while a
// finished answer (e.g. a one-sentence policy explanation) wins directly even if
// a coding-keyword heuristic would have force-injected a spawn over it.
function shouldPreferCompleteDirectReply(args: {
	replyText: string;
	candidateActions: readonly string[];
	contexts: readonly string[];
}): boolean {
	if (!looksLikeCompleteDirectReply(args.replyText)) return false;
	return hasOnlyWeakDirectReplyPlanningSignals(args);
}

// True when the MODEL itself named a runnable coding-delegation / spawn-class
// action in its own candidate list. Resolves by registry tags
// (CODING_DELEGATION_ACTION_TAGS) first, then the legacy name set — the same
// resolution findCodingDelegationActionName uses — so a registered
// TASKS_SPAWN_AGENT (or simile) counts and a bogus/unexposed name does not. Used
// to detect that the model committed to delegation on purpose, so a verbose ack
// is not mistaken for a finished direct reply.
function modelProvidedRunnableDelegationCandidate(
	candidateActions: readonly string[],
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
	opts?: { requireUnambiguous?: boolean },
): boolean {
	if (candidateActions.length === 0) return false;
	const delegationActionName = findCodingDelegationActionName(actions);
	if (!delegationActionName) return false;
	// Bare "TASKS" is the one legacy alias that is ambiguous — it names task-list
	// management as readily as coding delegation. When the caller needs an
	// unambiguous commitment (no planning context backing the candidate), it only
	// counts if the REGISTERED delegation action is itself named TASKS (then the
	// model named the real action, not the ambiguous alias).
	const legacyNames = opts?.requireUnambiguous
		? LEGACY_CODING_DELEGATION_ACTION_NAMES.filter((name) => name !== "TASKS")
		: LEGACY_CODING_DELEGATION_ACTION_NAMES;
	const wanted = new Set<string>([
		normalizeActionIdentifier(delegationActionName),
		...legacyNames.map(normalizeActionIdentifier),
	]);
	return candidateActions.some((name) =>
		wanted.has(normalizeActionIdentifier(name)),
	);
}

function shouldPreferInlineCodeSnippetDirectReply(args: {
	currentMessageText: string;
	candidateActions: readonly string[];
	contexts: readonly string[];
}): boolean {
	if (looksLikeExplicitDelegationRequest(args.currentMessageText)) return false;
	if (!looksLikeInlineCodeSnippetRequest(args.currentMessageText)) return false;
	return hasOnlyWeakDirectReplyPlanningSignals(args);
}

const WEAK_DIRECT_REPLY_OVERRIDE_ACTIONS = new Set(
	[
		"BROWSER",
		"EXEC",
		"EXECUTE_COMMAND",
		"INTERNET_SEARCH",
		"LOOKUP_WEB",
		"REPLY",
		"RUN_COMMAND",
		"RUN_IN_TERMINAL",
		"RUN_SHELL",
		"SEARCH",
		"SEARCH_INTERNET",
		"SEARCH_WEB",
		"SHELL",
		"SPAWN_AGENT",
		"SPAWN_CODING_AGENT",
		"START_CODING_TASK",
		"TASKS",
		"TASKS_SPAWN_AGENT",
		"TERMINAL",
		"TERMINAL_SHELL",
		"WEB_FETCH",
		"WEB_SEARCH",
	].map(normalizeActionIdentifier),
);

export function shouldPreferDirectCurrentCandidateActions(args: {
	candidateActions: readonly string[];
	currentMessageText: string;
	directCandidateActions: readonly string[];
	// Optional live action registry. When supplied, shell-direct membership is
	// resolved through the declared SHELL_DIRECT_ACTION_TAGS contract (with the
	// legacy name set as a covered fallback) instead of a hardcoded literal set;
	// when omitted (e.g. pure unit call sites), the legacy name membership still
	// applies so behavior is unchanged for owner actions that predate the tags.
	actions?: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;
}): boolean {
	if (args.candidateActions.length === 0) return false;
	if (!looksLikeLocalShellRequest(args.currentMessageText)) return false;
	if (looksLikeCodingWorkRequest(args.currentMessageText)) return false;
	if (
		!args.directCandidateActions.some((name) =>
			isShellDirectActionName(name, args.actions),
		)
	) {
		return false;
	}
	return args.candidateActions.every((name) => {
		const normalized = normalizeActionIdentifier(name);
		return (
			WEAK_DIRECT_REPLY_OVERRIDE_ACTIONS.has(normalized) ||
			canonicalPlannerControlActionName(normalized) !== null ||
			// A shell-direct action resolved through the declared tag contract counts
			// as a weak/overridable signal too — same class as the shell names
			// enumerated in WEAK_DIRECT_REPLY_OVERRIDE_ACTIONS — so an owner that
			// renamed its shell action but kept SHELL_DIRECT_ACTION_TAGS still
			// promotes the direct shell turn instead of falling through to planning.
			isShellDirectActionName(normalized, args.actions)
		);
	});
}

function hasOnlyWeakDirectReplyPlanningSignals(args: {
	candidateActions: readonly string[];
	contexts: readonly string[];
}): boolean {
	for (const context of args.contexts) {
		const normalized = context.trim().toLowerCase();
		if (
			normalized &&
			normalized !== SIMPLE_CONTEXT_ID &&
			normalized !== "general"
		) {
			return false;
		}
	}
	for (const actionName of args.candidateActions) {
		const normalized = normalizeActionIdentifier(actionName);
		if (!normalized) continue;
		if (!WEAK_DIRECT_REPLY_OVERRIDE_ACTIONS.has(normalized)) return false;
	}
	return true;
}

function hasAckOnlyActionableIntent(
	result: ResponseHandlerResult,
	replyText: string,
	fallbackText = "",
): boolean {
	if (!looksLikeProgressOnlyReply(replyText)) {
		return false;
	}
	const intentText = Array.isArray(result.intents)
		? result.intents
				.map((intent) => (typeof intent === "string" ? intent : ""))
				.join("\n")
		: "";
	const actionText = [intentText, fallbackText].filter(Boolean).join("\n");
	return (
		looksLikeLocalShellRequest(actionText) ||
		looksLikeWebSearchRequest(actionText) ||
		looksLikeCodingWorkRequest(actionText)
	);
}

function inferAckIntentCandidateActions(
	result: ResponseHandlerResult,
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
	fallbackText = "",
): string[] {
	const intentText = Array.isArray(result.intents)
		? result.intents
				.map((intent) => (typeof intent === "string" ? intent : ""))
				.join("\n")
		: "";
	const actionText = [intentText, fallbackText].filter(Boolean).join("\n");
	if (!actionText.trim()) return [];
	if (looksLikeLocalShellRequest(actionText)) {
		const shellAction = findShellDirectActionName(actions);
		if (shellAction) return [shellAction];
	}
	// Coding-work precedes web-search: "build an app that shows the bitcoin price"
	// trips looksLikeWebSearchRequest (market term) yet is a coding task — route it
	// to coding delegation, not a web lookup. Mirrors the coding-first guard in
	// shouldPreferDirectCurrentCandidateActions.
	if (looksLikeCodingWorkRequest(actionText)) {
		const codingAction = findCodingDelegationActionName(actions);
		if (codingAction) return [codingAction];
	}
	if (looksLikeWebSearchRequest(actionText)) {
		const lookupActions = findWebLookupActionNames(actions);
		if (lookupActions.length > 0) return lookupActions;
	}
	return [];
}

export function inferDirectCurrentRequestCandidateActions(
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
	messageText: string,
): string[] {
	return inferDirectCurrentRequestCandidateActionsFromHeuristics(
		actions,
		messageText,
		{
			// Coding-work precedes web-search: a coding request mentioning a live/market
			// term ("build a crypto price tracker") must route to coding delegation,
			// not a web lookup.
			looksLikeCodingWorkRequest,
			findCodingDelegationActionName,
		},
	);
}

const LIVE_LOOKUP_UNAVAILABLE_REPLY =
	"I don't have a live web search action available here, so I can't look up current information in this chat.";

function shouldReplaceUnavailableLiveLookupAck(args: {
	message: Memory;
	actions: ReadonlyArray<Pick<Action, "name" | "similes">>;
	reply: string;
}): boolean {
	const text = (getUserMessageText(args.message) ?? "").trim();
	return (
		text.length > 0 &&
		looksLikeWebSearchRequest(text) &&
		!findWebLookupActionName(args.actions) &&
		looksLikeProgressOnlyReply(args.reply)
	);
}

function uniqueActionNames(names: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const name of names) {
		const normalized = normalizeActionIdentifier(name);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(name);
	}
	return result;
}

/**
 * Probe for an embedded JSON object inside otherwise plain text. Used by the
 * tolerant simple-reply synthesizer to fall through to the structured-
 * failure path when a weak planner leaked tool-arg-shaped content into prose
 * (e.g. `{"path":"...","contents":"..."}`) instead of into the canonical
 * tool-call envelope. Shipping such a fragment verbatim would surface raw
 * JSON to the user; routing to the failure path produces a clean apology.
 */
function containsEmbeddedJsonObject(text: unknown): boolean {
	if (typeof text !== "string" || text.length === 0) return false;
	const withoutThink = text.replace(/<think>[\s\S]*?<\/think>/g, "");
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < withoutThink.length; i++) {
		const ch = withoutThink[i];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0 && start !== -1) {
				const candidate = withoutThink.slice(start, i + 1);
				try {
					const parsed = JSON.parse(candidate);
					if (parsed && typeof parsed === "object") return true;
				} catch {
					// keep scanning
				}
				start = -1;
			}
			if (depth < 0) {
				depth = 0;
				start = -1;
			}
		}
	}
	return false;
}

/**
 * Tolerant fallback for planners that return plain text instead of the
 * structured Stage 1 envelope. Without this, the runtime throws
 * `v5 messageHandler returned invalid MessageHandlerResult` whenever the
 * model — small instruct-tuned weights routinely served via OpenAI-
 * compatible providers — skips the HANDLE_RESPONSE scaffold and just emits
 * prose. Treating the prose as a simple reply keeps the turn alive.
 *
 * Returns null only when:
 *  - the text is empty (genuine failure, propagate)
 *  - the text looks like incomplete structured output (a stray `{` or `[`
 *    that didn't JSON.parse — model intended tool output and failed
 *    mid-stream; shipping that fragment surfaces broken JSON to the user)
 *  - the text contains an embedded JSON object inside prose (the model
 *    leaked tool-arg shapes into the reply; route to failure path so the
 *    leak doesn't reach the user channel)
 */
function synthesizeSimpleReplyFromPlainText(
	raw: string | undefined | null,
): MessageHandlerResult | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const replyText = stripReasoningBlocks(trimmed);
	if (!replyText) return null;
	const looksLikeIncompleteStructuredOutput =
		(replyText.startsWith("{") || replyText.startsWith("[")) &&
		(() => {
			try {
				JSON.parse(replyText);
				return false;
			} catch {
				// error-policy:J3 untrusted-input parse probe — a parse failure IS the
				// signal (text looks like incomplete structured output, not valid JSON).
				return true;
			}
		})();
	if (looksLikeIncompleteStructuredOutput) return null;
	if (containsEmbeddedJsonObject(replyText)) return null;
	// Never treat a raw HANDLE_RESPONSE field transcript as a plain-text reply
	// (#11712). If the structured-transcript parser upstream didn't claim it,
	// route to the failure path rather than shipping the `shouldRespond:/
	// replyText:/...` skeleton to the user channel.
	if (looksLikeRawFieldTranscript(replyText)) return null;
	return {
		processMessage: "RESPOND",
		thought:
			"Tolerant fallback: model returned plain text instead of the structured plan; treating as simple reply.",
		plan: {
			contexts: [SIMPLE_CONTEXT_ID],
			reply: replyText,
			simple: true,
		},
	};
}

/**
 * Detect a Stage 1 model result with no usable content. Covers an empty
 * string, and the `GenerateTextResult` object shape where `text` is blank
 * AND there are no tool calls / content parts to recover from. Used to gate
 * bounded empty-completion retries.
 */
function isEmptyStage1Result(raw: string | GenerateTextResult): boolean {
	if (typeof raw === "string") return raw.trim().length === 0;
	if (!raw || typeof raw !== "object") return true;
	// `raw` is narrowed to GenerateTextResult here; read its typed fields
	// directly (the defensive `typeof` guards still cover non-conforming
	// provider output) instead of laundering it through `as unknown as`.
	const text = typeof raw.text === "string" ? raw.text.trim() : "";
	if (text.length > 0) return false;
	if (Array.isArray(raw.toolCalls) && raw.toolCalls.length > 0) return false;
	const contentText = extractGenerateTextContentText(raw);
	if (contentText.trim().length > 0) return false;
	return true;
}

export function getStage1RetryReason(
	raw: string | GenerateTextResult,
): "empty completion" | "malformed HANDLE_RESPONSE tool call" | null {
	if (isEmptyStage1Result(raw)) {
		return "empty completion";
	}
	if (typeof raw === "string" || !raw || typeof raw !== "object") {
		return null;
	}
	if (!hasHandleResponseToolCall(raw)) {
		return null;
	}
	if (extractHandleResponseToolArguments(raw)) {
		return null;
	}
	return "malformed HANDLE_RESPONSE tool call";
}

function readStage1EmptyRetryLimit(runtime: IAgentRuntime): number {
	const raw = runtime.getSetting?.("ELIZA_RESPONSE_HANDLER_EMPTY_RETRIES");
	if (raw === undefined || raw === null || raw === "") return 2;
	const parsed =
		typeof raw === "number" ? raw : Number.parseInt(String(raw).trim(), 10);
	if (!Number.isFinite(parsed)) return 2;
	return Math.max(0, Math.min(5, Math.trunc(parsed)));
}

function shouldUseStage1PlannerFallback(
	runtime: IAgentRuntime,
	message: Memory,
): boolean {
	const content = message.content ?? {};
	const channelType = String(content.channelType ?? "").toLowerCase();
	if (
		channelType === ChannelType.DM.toLowerCase() ||
		channelType === ChannelType.VOICE_DM.toLowerCase() ||
		channelType === ChannelType.SELF.toLowerCase() ||
		channelType === ChannelType.API.toLowerCase()
	) {
		return true;
	}
	const mentionContext = content.mentionContext as
		| { isMention?: boolean; isReply?: boolean }
		| undefined;
	if (mentionContext?.isMention === true || mentionContext?.isReply === true) {
		return true;
	}
	const source = String(content.source ?? "").toLowerCase();
	if (source.includes(MESSAGE_SOURCE_CLIENT_CHAT)) {
		return true;
	}
	return textContainsAgentName(content.text, [
		runtime.character.name,
		runtime.character.username,
	]);
}

function synthesizePlannerFallbackFromStage1Failure(args: {
	reason: string;
	actions: ReadonlyArray<Pick<Action, "name" | "similes">>;
	messageText: string;
}): MessageHandlerResult {
	const candidateActions = inferDirectCurrentRequestCandidateActions(
		args.actions,
		args.messageText,
	);
	return {
		processMessage: "RESPOND",
		thought: `Response handler returned ${args.reason}; falling back to planner because the message is explicitly addressed to the agent.`,
		plan: {
			contexts: ["general"],
			reply: "",
			simple: false,
			requiresTool: true,
			candidateActions,
		},
	};
}

/**
 * Stage 1 parse with a tolerant recovery chain. Models reached over OpenAI-
 * compatible providers do not all honour the native function-call path —
 * smaller instruct-tuned weights routinely emit the structured
 * HANDLE_RESPONSE envelope as a plain-text string, or skip structure
 * entirely and return prose. The chain, in priority order:
 *
 *   1. native function-call    — canonical, only valid for the object shape
 *   2. parseMessageHandlerOutput — the structured envelope emitted as text
 *      (`{"shouldRespond":...,"replyText":...,"contexts":[...]}`)
 *   3. synthesizeSimpleReplyFromPlainText — degenerate plain-text reply
 *
 * Returning `null` is the failure signal; callers route those to the
 * structured-failure reply path.
 */
function parseMessageHandlerModelOutput(
	raw: string | GenerateTextResult,
	runtimeContext?: {
		actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;
		messageText?: string;
		subAgentCompletionRelay?: boolean;
	},
): MessageHandlerResult | null {
	const applyBackstops = (result: MessageHandlerResult | null) =>
		result
			? applyDirectCurrentCandidateBackstopToMessageHandler(
					result,
					runtimeContext,
				)
			: null;
	if (typeof raw !== "string") {
		const native = parseMessageHandlerNativeToolCall(raw);
		if (native) return applyBackstops(native);
		const text = getV5ModelText(raw);
		return applyBackstops(
			parseMessageHandlerOutput(text) ??
				synthesizeSimpleReplyFromPlainText(text),
		);
	}
	return applyBackstops(
		parseMessageHandlerOutput(raw) ?? synthesizeSimpleReplyFromPlainText(raw),
	);
}

function getStage1FinishReason(raw: string | GenerateTextResult): string {
	if (typeof raw === "string") return "";
	return typeof raw.finishReason === "string" ? raw.finishReason : "";
}

function stage1HitCompletionLimit(
	raw: string | GenerateTextResult,
	maxTokens: number | undefined,
): boolean {
	if (typeof raw === "string") return false;
	const finishReason = getStage1FinishReason(raw).toLowerCase();
	if (
		/\b(?:length|max[-_\s]?tokens?|token[-_\s]?limit|output[-_\s]?limit)\b/u.test(
			finishReason,
		)
	) {
		return true;
	}
	// With direct-channel provider/model-max output, the runtime has no reliable
	// caller cap to compare against. Truncation is detected via finishReason.
	const completionTokens = raw.usage?.completionTokens;
	return (
		typeof maxTokens === "number" &&
		typeof completionTokens === "number" &&
		Number.isFinite(completionTokens) &&
		completionTokens >= maxTokens
	);
}

/**
 * Whether a Stage-1 result should be regenerated. Empty or garbled output can be
 * fixed by retrying, but a completion-limit truncation cannot: regenerating at
 * the same token cap just truncates again, burning a full Stage-1 turn for the
 * same result. A truncated envelope is routed to the dedicated truncation
 * recovery below instead. Exported for unit coverage of the retry policy.
 */
export function shouldRetryStage1Generation(
	reason: ReturnType<typeof getStage1RetryReason>,
	raw: string | GenerateTextResult,
	maxTokens: number | undefined,
): boolean {
	if (!reason) return false;
	return !stage1HitCompletionLimit(raw, maxTokens);
}

function extractJsonStringField(
	text: string,
	fieldName: string,
): string | null {
	const pattern = new RegExp(
		`"${fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*"`,
		"u",
	);
	const match = pattern.exec(text);
	if (!match) return null;
	const valueStart = match.index + match[0].length;
	let escaped = false;
	for (let i = valueStart; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			try {
				return JSON.parse(`"${text.slice(valueStart, i)}"`) as string;
			} catch {
				return null;
			}
		}
	}
	return null;
}

function extractJsonStringArrayField(
	text: string,
	fieldName: string,
): string[] {
	const pattern = new RegExp(
		`"${fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*\\[([^\\]]*)\\]`,
		"u",
	);
	const match = pattern.exec(text);
	if (!match?.[1]) return [];
	const values: string[] = [];
	const itemPattern = /"((?:\\.|[^"\\])*)"/gu;
	for (const item of match[1].matchAll(itemPattern)) {
		try {
			values.push(JSON.parse(`"${item[1]}"`) as string);
		} catch {
			return [];
		}
	}
	return values;
}

function extractJsonBooleanField(
	text: string,
	fieldName: string,
): boolean | null {
	const pattern = new RegExp(
		`"${fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*(true|false)`,
		"u",
	);
	const match = pattern.exec(text);
	if (!match) return null;
	return match[1] === "true";
}

function recoverStage1TruncatedMessageHandler(
	raw: string | GenerateTextResult,
): MessageHandlerResult | null {
	const text = getV5ModelText(raw);
	const replyText = extractJsonStringField(text, "replyText")?.trim();
	if (!replyText) return null;
	const contexts = extractJsonStringArrayField(text, "contexts");
	const candidateActions = extractJsonStringArrayField(
		text,
		"candidateActionNames",
	);
	const requiresTool = extractJsonBooleanField(text, "requiresTool");
	const hasOnlySimpleContext =
		contexts.length === 0 ||
		contexts.every((context) => context === SIMPLE_CONTEXT_ID);
	if (!hasOnlySimpleContext) return null;
	if (candidateActions.length > 0) return null;
	if (requiresTool === true) return null;
	const strippedReply = stripReasoningBlocks(replyText);
	if (
		!looksLikeCompleteDirectReply(strippedReply) &&
		!looksLikeInlineCodeSnippetRequest(strippedReply)
	) {
		return null;
	}
	return {
		processMessage: "RESPOND",
		thought:
			"Stage 1 hit the completion limit; recovered a completed replyText field from the truncated envelope.",
		plan: {
			contexts: [SIMPLE_CONTEXT_ID],
			reply: strippedReply,
			simple: true,
			requiresTool: false,
		},
	};
}

function synthesizeStage1TruncationReply(): MessageHandlerResult {
	return {
		processMessage: "RESPOND",
		thought:
			"Stage 1 hit the completion limit and no complete replyText field could be recovered.",
		plan: {
			contexts: [SIMPLE_CONTEXT_ID],
			reply: STAGE1_TRUNCATION_REPLY,
			simple: true,
			requiresTool: false,
		},
	};
}

/**
 * Resolve the calling sender's role for context-catalog filtering.
 *
 * This is best-effort: when there is no world context, `checkSenderRole`
 * returns null and we fall through to the same source-aware floor that
 * `hasRoleAccess` uses. Owner-only messages always pass the agent's own
 * messages without a world lookup.
 */
async function resolveStage1SenderRole(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<RoleGateRole> {
	if (
		typeof message.entityId === "string" &&
		message.entityId === runtime.agentId
	) {
		return "OWNER";
	}
	try {
		const result = await checkSenderRole(runtime, message);
		if (result?.role) {
			return result.role as RoleGateRole;
		}
	} catch (error) {
		runtime.logger.debug(
			{ src: "service:message", error },
			"Stage 1 sender role lookup failed; using unresolved role floor",
		);
	}
	return getUnresolvedSenderRoleFloor(message);
}

function listAvailableContextsForRole(
	registry: ContextRegistry | undefined,
	role: RoleGateRole,
): ContextDefinition[] {
	if (!registry) {
		return [];
	}
	return registry.listAvailable(role);
}

interface ExecuteV5PlannedToolCallParams {
	runtime: IAgentRuntime;
	toolCall: PlannerToolCall;
	plannerContext: ContextObject;
	executorCtx: ExecutePlannedToolCallContext;
	executorOptions?: ExecutePlannedToolCallOptions;
	plannerRuntime: PlannerRuntime;
	evaluatorEffects?: EvaluatorEffects;
	evaluate?: (params: {
		runtime: PlannerRuntime;
		context: ContextObject;
		trajectory: PlannerTrajectory;
	}) => Promise<EvaluatorOutput> | EvaluatorOutput;
	provider?: string;
	tools?: ToolDefinition[];
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	plannerLoopConfig?: PlannerLoopParams["config"];
}

interface BuildV5ExecutorContextParams {
	message: Memory;
	state: State;
	selectedContexts: AgentContext[];
	senderRole: RoleGateRole;
	previousResults: readonly ActionResult[];
	callback?: HandlerCallback;
}

function buildV5ExecutorContext(
	args: BuildV5ExecutorContextParams,
): ExecutePlannedToolCallContext {
	return {
		message: args.message,
		state: args.state,
		activeContexts: args.selectedContexts,
		userRoles: [args.senderRole],
		previousResults: args.previousResults,
		...(args.callback ? { callback: args.callback } : {}),
	};
}

export function __buildV5ExecutorContextForTests(
	args: BuildV5ExecutorContextParams,
): ExecutePlannedToolCallContext {
	return buildV5ExecutorContext(args);
}

function plannerErrorLooksTransient(error: unknown): boolean {
	const message =
		error instanceof Error
			? `${error.name} ${error.message} ${String(error.cause ?? "")}`
			: String(error ?? "");
	// The trailing three ("empty completion", "model emitted no decision", "no
	// assistant message") are the CLI/SDK brains' "provider returned nothing
	// usable" errors. They are recoverable per-turn hiccups (a cold-start blip,
	// one bad SDK turn), so treat them as transient → a deterministic fallback
	// tool call, instead of re-throwing and crashing the whole turn with a raw
	// exception the user sees.
	return /\b(?:429|rate[\s_-]*limit|too many requests|temporarily unavailable|overloaded|timeout|timed out|econnreset|etimedout|50[234]|failed after \d+ attempts|empty completion|model emitted no decision|no assistant message)\b/i.test(
		message,
	);
}

function trimExtractedUrl(value: string): string {
	return value.replace(/[),.;:!?]+$/u, "");
}

function extractCalendlyAvailabilityFallbackParams(
	message: Memory,
): Record<string, unknown> | null {
	const text = getUserMessageText(message) ?? "";
	const lower = text.toLowerCase();
	if (
		!/\bcalendly\b|api\.calendly\.com/u.test(lower) ||
		!/\b(?:availability|available|open|slots?|times?)\b/u.test(lower)
	) {
		return null;
	}
	const eventTypeUri =
		/https?:\/\/api\.calendly\.com\/event_types\/[^\s),.;:!?]+/iu.exec(
			text,
		)?.[0];
	const dates = Array.from(text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/gu)).map(
		(match) => match[0],
	);
	return {
		action: "calendly_availability",
		intent: text,
		...(eventTypeUri ? { eventTypeUri: trimExtractedUrl(eventTypeUri) } : {}),
		...(dates[0] ? { startDate: dates[0] } : {}),
		...(dates[1] ? { endDate: dates[1] } : {}),
	};
}

function buildDeterministicPlannerFallbackToolCall(args: {
	message: Memory;
	actions: readonly Action[];
}): PlannerToolCall | null {
	const calendlyParams = extractCalendlyAvailabilityFallbackParams(
		args.message,
	);
	if (!calendlyParams) {
		return null;
	}
	const hasCalendarAction = args.actions.some(
		(action) =>
			normalizeActionIdentifier(action.name) ===
			normalizeActionIdentifier("CALENDAR"),
	);
	if (!hasCalendarAction) {
		return null;
	}
	return {
		id: `deterministic-calendar-${Date.now()}`,
		name: "CALENDAR",
		params: calendlyParams,
	};
}

async function runDeterministicPlannerFallback(args: {
	runtime: IAgentRuntime;
	message: Memory;
	plannerState: State;
	selectedContexts: AgentContext[];
	senderRole: RoleGateRole;
	plannerContext: ContextObject;
	plannerRuntime: PlannerRuntime;
	actions: readonly Action[];
	evaluatorEffects: EvaluatorEffects;
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	plannerLoopConfig?: PlannerLoopParams["config"];
	callback?: HandlerCallback;
	plannerError: unknown;
}): Promise<PlannerLoopResult | null> {
	if (!plannerErrorLooksTransient(args.plannerError)) {
		return null;
	}
	const toolCall = buildDeterministicPlannerFallbackToolCall({
		message: args.message,
		actions: args.actions,
	});
	if (!toolCall) {
		return null;
	}

	const queuedAt = Date.now();
	const serializedParams = JSON.stringify(toolCall.params ?? {});
	const queuedContext = appendContextEvent(
		{
			...args.plannerContext,
			plannedQueue: [
				...(args.plannerContext.plannedQueue ?? []),
				{
					id: toolCall.id,
					name: toolCall.name,
					args: serializedParams,
					status: "queued" as const,
					sourceStageId: "planner:fallback",
				},
			],
		},
		{
			id: `queue:${toolCall.id ?? toolCall.name}:fallback`,
			type: "planned_tool_call",
			source: "message-service",
			createdAt: queuedAt,
			metadata: {
				iteration: 1,
				toolCallId: toolCall.id,
				name: toolCall.name,
				params: serializedParams,
				status: "queued",
				reason: "deterministic_fallback_after_transient_planner_error",
			},
		},
	);
	const trajectory: PlannerTrajectory = {
		context: queuedContext,
		steps: [],
		archivedSteps: [],
		plannedQueue: [],
		evaluatorOutputs: [],
	};

	args.runtime.logger?.warn?.(
		{
			src: "service:message",
			action: toolCall.name,
			error:
				args.plannerError instanceof Error
					? args.plannerError.message
					: String(args.plannerError),
		},
		"Planner hit a transient model error; using deterministic Calendly fallback",
	);

	const result = await executeV5PlannedToolCall({
		runtime: args.runtime,
		toolCall,
		plannerContext: trajectory.context,
		executorCtx: buildV5ExecutorContext({
			message: args.message,
			state: args.plannerState,
			selectedContexts: args.selectedContexts,
			senderRole: args.senderRole,
			previousResults: [],
			...(args.callback ? { callback: args.callback } : {}),
		}),
		plannerRuntime: args.plannerRuntime,
		executorOptions: { actions: args.actions },
		evaluatorEffects: args.evaluatorEffects,
		recorder: args.recorder,
		trajectoryId: args.trajectoryId,
		plannerLoopConfig: args.plannerLoopConfig,
	});
	trajectory.steps.push({
		iteration: 1,
		thought: "Deterministic fallback executed after transient planner error.",
		toolCall,
		result,
	});
	trajectory.context = appendContextEvent(
		{
			...trajectory.context,
			plannedQueue: (trajectory.context.plannedQueue ?? []).map((entry) =>
				entry.id === toolCall.id
					? { ...entry, status: result.success ? "completed" : "failed" }
					: entry,
			),
		},
		{
			id: `tool-result:${toolCall.id ?? toolCall.name}:fallback`,
			type: "tool_result",
			source: "message-service",
			createdAt: Date.now(),
			metadata: {
				iteration: 1,
				toolCallId: toolCall.id,
				name: toolCall.name,
				params: serializedParams,
				result: JSON.stringify({
					success: result.success,
					text: result.text,
					error:
						result.error instanceof Error ? result.error.message : result.error,
				}),
				status: result.success ? "completed" : "failed",
			},
		},
	);
	const fallbackMessage =
		result.text ??
		(result.success
			? "Done."
			: "I tried to check that Calendly availability, but the calendar action failed.");
	const evaluator: EvaluatorOutput = {
		success: result.success,
		decision: "FINISH",
		thought: result.success
			? "Deterministic Calendly fallback completed."
			: "Deterministic Calendly fallback failed.",
		messageToUser: fallbackMessage,
	};
	trajectory.evaluatorOutputs.push(evaluator);
	return {
		status: "finished",
		trajectory,
		evaluator,
		finalMessage: fallbackMessage,
	};
}

async function executeV5PlannedToolCall(
	args: ExecuteV5PlannedToolCallParams,
): Promise<PlannerToolResult> {
	if (!args.toolCall.name) {
		return {
			success: false,
			error: "Planner tool call requires a non-empty action name",
		};
	}

	const actions = args.executorOptions?.actions ?? args.runtime.actions;
	const actionLookup = buildRuntimeActionLookup({ actions });
	// Different reference means the caller narrowed the surface; resolve
	// strictly so LLM aliases can't escape through the global fallback.
	const strictResolve = actions !== args.runtime.actions;
	const resolvedNames = resolvePlannerActionName(
		args.runtime,
		actionLookup,
		args.toolCall.name,
		{ strict: strictResolve },
	);
	const resolvedName = resolvedNames[0] ?? args.toolCall.name;
	const toolCall: PlannerToolCall = { ...args.toolCall, name: resolvedName };

	// Per-turn `actions` is the narrowed action surface — the executable subset
	// the model was given as tools. It does NOT include the CORE_PLANNER_TERMINALS
	// (REPLY / IGNORE / STOP) which are surfaced as tools but live in the global
	// runtime registry. When the model calls a terminal (or, under
	// strictResolve, an action not in the narrow), pull it from the global
	// registry by exact name. With `toolChoice: "required"` + tools-array
	// enforcement the model can only call names that are in our exposed set, so
	// this can't be an off-surface escape — it's the terminal/registry bridge.
	const executionActions = actions.some(
		(candidate) => candidate.name === toolCall.name,
	)
		? actions
		: [
				...actions,
				...args.runtime.actions.filter(
					(candidate) => candidate.name === toolCall.name,
				),
			];
	const action = executionActions.find(
		(candidate) => candidate.name === toolCall.name,
	);
	const executorCtx = action
		? {
				...args.executorCtx,
				activeContexts: mergeAgentContexts(
					args.executorCtx.activeContexts,
					action.contexts,
				),
			}
		: args.executorCtx;

	const hasDispatcherActionParameter =
		plannerToolCallHasActionParameter(toolCall);
	if (action && actionHasSubActions(action) && !hasDispatcherActionParameter) {
		const subResult = await runSubPlanner({
			runtime: args.runtime as IAgentRuntime & PlannerRuntime,
			action,
			context: args.plannerContext,
			ctx: executorCtx,
			options: args.executorOptions,
			evaluate: args.evaluate,
			evaluatorEffects: args.evaluatorEffects,
			provider: args.provider,
			config: args.plannerLoopConfig,
			recorder: args.recorder,
			trajectoryId: args.trajectoryId,
		});
		return subPlannerResultToPlannerToolResult(subResult);
	}

	const actionResult = await executePlannedToolCall(
		args.runtime,
		executorCtx,
		toolCall,
		{ ...(args.executorOptions ?? {}), actions: executionActions },
	);
	return actionResultToPlannerToolResult(actionResult, {
		summary: summarizeActionResultForPlanner(
			action,
			actionResult,
			toolCall.params,
		),
	});
}

function plannerToolCallHasActionParameter(toolCall: PlannerToolCall): boolean {
	const candidates = [
		toolCall.params,
		(toolCall as { args?: unknown }).args,
		(toolCall as { arguments?: unknown }).arguments,
	];
	for (const candidate of candidates) {
		if (
			candidate &&
			typeof candidate === "object" &&
			!Array.isArray(candidate) &&
			"action" in candidate
		) {
			return true;
		}
	}
	return false;
}

/**
 * One entry per executed sub-planner step, projected for the parent loop. This
 * is the structured record the outer planner's next turn reasons over so it can
 * see which multi-step operations already succeeded and advance to the next one
 * instead of re-dispatching the umbrella action from scratch (issue
 * elizaOS/eliza#8007).
 */
interface SubPlannerSubStep {
	action: string;
	success: boolean;
	summary?: string;
	error?: string;
}

const SUB_STEP_SUMMARY_MAX_CHARS = 400;

function truncateSubStepText(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= SUB_STEP_SUMMARY_MAX_CHARS) return trimmed;
	return `${trimmed.slice(0, SUB_STEP_SUMMARY_MAX_CHARS)}...`;
}

function collectSubPlannerSubSteps(
	subResult: Awaited<ReturnType<typeof runSubPlanner>>,
): SubPlannerSubStep[] {
	const subSteps: SubPlannerSubStep[] = [];
	for (const step of subResult.trajectory.steps) {
		if (!step.toolCall?.name || !step.result) continue;
		const result = step.result;
		const errorText =
			typeof result.error === "string"
				? result.error
				: result.error instanceof Error
					? result.error.message
					: undefined;
		const summarySource =
			typeof result.text === "string" && result.text.trim().length > 0
				? result.text
				: typeof result.userFacingText === "string"
					? result.userFacingText
					: undefined;
		subSteps.push({
			action: step.toolCall.name,
			success: result.success,
			...(summarySource ? { summary: truncateSubStepText(summarySource) } : {}),
			...(errorText ? { error: truncateSubStepText(errorText) } : {}),
		});
	}
	return subSteps;
}

/**
 * Diagnostic, log-shaped projection of the full sub-planner trajectory. Renders
 * every executed sub-step as `OK/FAIL <action>: <summary/error>` so the parent
 * planner's tool-result message carries the progression (e.g.
 * `OK provision_workspace, OK spawn_agent, FAIL submit_workspace`) instead of
 * only the terminal step. Without this the outer LLM cannot tell that step 1
 * already succeeded and re-dispatches the umbrella action on every CONTINUE
 * turn.
 */
function renderSubStepDiagnosticText(subSteps: SubPlannerSubStep[]): string {
	return subSteps
		.map((step) => {
			const marker = step.success ? "OK" : "FAIL";
			const detail = step.error ?? step.summary;
			return detail
				? `${marker} ${step.action}: ${detail}`
				: `${marker} ${step.action}`;
		})
		.join("\n");
}

export function subPlannerResultToPlannerToolResult(
	subResult: Awaited<ReturnType<typeof runSubPlanner>>,
): PlannerToolResult {
	const evaluator = subResult.evaluator;
	const lastStep =
		subResult.trajectory.steps[subResult.trajectory.steps.length - 1];
	const success = evaluator?.success ?? lastStep?.result?.success ?? true;
	const userFacingText = subResult.finalMessage ?? evaluator?.messageToUser;

	// Aggregate every executed sub-step, not just the terminal one, so the
	// parent planner's next turn can see which operations already succeeded and
	// advance to the next op instead of re-running the umbrella action from the
	// first step (issue elizaOS/eliza#8007). The per-step progression flows to
	// the outer LLM through `text` (the diagnostic tool-result projection) and
	// to downstream action context through `data.subSteps` /
	// `data.completedSubActions`.
	const subSteps = collectSubPlannerSubSteps(subResult);
	const diagnosticText = renderSubStepDiagnosticText(subSteps);
	const completedSubActions = subSteps
		.filter((step) => step.success)
		.map((step) => step.action);
	const terminalData = lastStep?.result?.data;
	const data =
		terminalData || subSteps.length > 0
			? {
					...(terminalData ?? {}),
					...(subSteps.length > 0
						? {
								subSteps,
								completedSubActions,
							}
						: {}),
				}
			: undefined;

	return {
		success,
		// Diagnostic channel: the whole progression, so CONTINUE re-planning
		// sees the completed steps. Falls back to the user-facing text when the
		// sub-planner executed no discrete steps.
		text: diagnosticText.length > 0 ? diagnosticText : userFacingText,
		userFacingText,
		data,
		error: lastStep?.result?.error,
		// Propagate the terminal sub-action's chain signal to the parent
		// loop. A sub-action that returns `continueChain: false` (e.g.
		// TASKS_SPAWN_AGENT, fire-and-forget) terminates the sub-planner,
		// but without this the parent planner loop never sees the flag,
		// evaluates CONTINUE, and re-runs the umbrella action, producing
		// duplicate spawns on a single user turn.
		continueChain: lastStep?.result?.continueChain,
	};
}

/**
 * Planner-loop tool surface. Each narrowed Action is exposed as its own native
 * tool whose name is the action name and whose `parameters` is the action's
 * JSONSchema. We also always include the universal terminal-sentinel tools
 * (REPLY / IGNORE / STOP) so the planner has a stable way to end the turn.
 *
 * When no actions are gated for the current turn we fall back to an empty
 * tool array so the planner can short-circuit (the pipeline's stage-1
 * shortcut still emits HANDLE_RESPONSE through its own dedicated call).
 */
function collectPlannerTools(
	context: ContextObject,
	narrowedActions?: ReadonlyArray<Action>,
): ToolDefinition[] {
	const hasAnyAction = context.events.some(
		(event) =>
			event.type === "tool" &&
			"tool" in event &&
			Boolean(
				(event as { tool?: { name?: string } }).tool?.name?.trim().length,
			),
	);
	if (!hasAnyAction) return [];
	const actions = narrowedActions ?? collectActionsFromContext(context);
	const tierAParents = readTierAParentsFromContext(context);
	return [
		...buildPlannerToolsFromTieredActions(actions, {
			tierAParents,
			actionLookup: new Map(
				actions.map((action) => [action.name, action] as const),
			),
			tierAChildrenByParent: readTierAChildrenByParentFromContext(context),
		}),
		...CORE_PLANNER_TERMINALS,
	];
}

/**
 * Read the tier-A parent names from the action surface metadata attached to the
 * context object by `buildV5PlannerActionSurface`. Returns an empty set when no
 * surface metadata is present (full-surface mode, or contexts built outside the
 * tiered pipeline), in which case the tiered builder degrades to plain
 * one-tool-per-action behavior.
 */
function readTierAParentsFromContext(context: ContextObject): Set<string> {
	const surface = (context.metadata as { actionSurface?: unknown } | undefined)
		?.actionSurface;
	if (!surface || typeof surface !== "object") {
		return new Set<string>();
	}
	const tierAParents = (surface as { tierAParents?: unknown }).tierAParents;
	if (!Array.isArray(tierAParents)) {
		return new Set<string>();
	}
	const set = new Set<string>();
	for (const value of tierAParents) {
		if (typeof value === "string" && value.trim().length > 0) {
			set.add(value);
		}
	}
	return set;
}

/**
 * Read the per-parent tier-A child allow-list from the action surface
 * metadata. Returns `undefined` when the surface carries no
 * `tierAChildrenByParent` (full-surface mode, or contexts built outside the
 * tiered pipeline), in which case the tiered tool builder expands every
 * subaction of a tier-A parent as before.
 */
function readTierAChildrenByParentFromContext(
	context: ContextObject,
): Record<string, string[]> | undefined {
	const surface = (context.metadata as { actionSurface?: unknown } | undefined)
		?.actionSurface;
	if (!surface || typeof surface !== "object") {
		return undefined;
	}
	const raw = (surface as { tierAChildrenByParent?: unknown })
		.tierAChildrenByParent;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return undefined;
	}
	const record: Record<string, string[]> = {};
	for (const [parentName, childNames] of Object.entries(raw)) {
		if (!Array.isArray(childNames)) {
			continue;
		}
		record[parentName] = childNames.filter(
			(name): name is string => typeof name === "string",
		);
	}
	return record;
}

/**
 * Pull each action surfaced as a `tool` event in the context. Mirrors the
 * filtering used by the planner-loop's tools rendering — sub-planner scoping
 * and dedup by normalised name happen there, while here we just keep the
 * action references in the order they appear so per-turn tool ordering is
 * deterministic.
 */
function collectActionsFromContext(context: ContextObject): Action[] {
	const seen = new Set<string>();
	const actions: Action[] = [];
	for (const event of context.events ?? []) {
		if (event.type !== "tool" || !("tool" in event)) continue;
		const tool = event.tool as { action?: Action; name?: string } | undefined;
		const action = tool?.action;
		if (!action || typeof action.name !== "string") continue;
		const normalized = action.name.trim();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		actions.push(action);
	}
	return actions;
}

function collectPreviousActionResults(
	trajectory: PlannerTrajectory,
): ActionResult[] {
	const results: ActionResult[] = [];
	for (const step of [...trajectory.archivedSteps, ...trajectory.steps]) {
		if (!step.result || !step.toolCall) {
			continue;
		}
		results.push({
			success: step.result.success,
			text: step.result.text,
			data: {
				actionName: step.toolCall.name,
				...(step.result.data ?? {}),
			},
			error:
				typeof step.result.error === "string"
					? step.result.error
					: step.result.error instanceof Error
						? step.result.error.message
						: undefined,
			continueChain: step.result.continueChain,
		});
	}
	return results;
}

/**
 * Pre-LLM action shortcut gate (#8791).
 *
 * Matches the user's text against the runtime's `ShortcutRegistry` BEFORE any
 * model call. Explicit slash/`!` commands are always eligible (this is what
 * makes slash commands deterministic per #8790); natural-language shortcuts use
 * narrow/confidence-floored patterns. On a confident `action`-target match the
 * matched action runs and its reply is returned as a `direct_reply` — emitting
 * ZERO `RESPONSE_HANDLER` tokens. Navigate/client targets are resolved on the
 * client (the slash menu already runs them locally) so the gate ignores them.
 *
 * Returns `null` on no match / mis-fire so the turn proceeds unchanged
 * (byte-identical to today). Set `ELIZA_SHORTCUTS_DISABLED=1` to bypass entirely.
 */
export async function runShortcutGate(args: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	responseId: UUID;
	senderRole: RoleGateRole;
}): Promise<V5MessageRuntimeStage1Result | null> {
	if (process.env.ELIZA_SHORTCUTS_DISABLED === "1") return null;
	const text = getUserMessageText(args.message) ?? "";
	if (!text.trim()) return null;

	const registry = (args.runtime as { shortcutRegistry?: ShortcutRegistry })
		.shortcutRegistry;
	if (!registry || registry.size === 0) return null;

	const authorized = isAdminRank(args.senderRole);
	const match = registry.match(text, {
		actions: args.runtime.actions.map((action) => action.name),
		allowNatural: true,
		isAuthorized: authorized,
		isElevated: hasAtLeastRole(args.senderRole, "OWNER"),
	});
	if (!match) return null;
	const target = match.shortcut.target;
	// Navigate/client targets are resolved on the client (the slash menu runs
	// them locally with no agent round-trip), so the agent gate only fires actions.
	if (target.kind !== "action") return null;

	const action = args.runtime.actions.find((a) => a.name === target.name);
	if (!action) return null;

	// #12087 Item 3: enforce the target action's DECLARED gate (roleGate +
	// contextGate + private-action + ACTION_ROLE_POLICY) via the same chokepoint
	// the planned-tool-call executor uses, BEFORE validate()/handler(). Previously
	// the shortcut path invoked the handler directly, so a shortcut lacking
	// `requiresElevated` that targeted an OWNER-gated action (e.g. SECRETS) let any
	// USER execute it — the registry's coarse auth/elevated flags were the only
	// protection. The shortcut runs pre-planner, so no contexts are active yet:
	// role-gated actions still gate by role; a context-gated action is conservatively
	// withheld from the shortcut fast-path (it can still run through the planner).
	const gateFailure = actionGateFailure(action, {
		message: args.message,
		userRoles: [args.senderRole],
	});
	if (gateFailure) {
		args.runtime.logger?.debug?.(
			{ src: "shortcut-gate", action: action.name, reason: gateFailure },
			"shortcut target action failed the role/context gate; falling through to pipeline",
		);
		return null;
	}

	let valid = false;
	try {
		valid = await action.validate(args.runtime, args.message, args.state);
	} catch (err) {
		args.runtime.logger?.warn?.(
			{
				src: "shortcut-gate",
				shortcut: match.shortcut.id,
				action: action.name,
				err,
			},
			"shortcut action validate() threw; falling through to pipeline",
		);
		return null;
	}
	if (!valid) return null;

	let captured: string | undefined;
	try {
		await action.handler(
			args.runtime,
			args.message,
			args.state,
			{ ...target.parameters, ...match.parameters, mode: "simple" },
			async (content) => {
				if (typeof content?.text === "string" && content.text) {
					captured = content.text;
				}
				return [];
			},
		);
	} catch (err) {
		args.runtime.logger?.warn?.(
			{ src: "shortcut-gate", shortcut: match.shortcut.id, err },
			"shortcut action failed; falling through to pipeline",
		);
		return null;
	}
	if (captured === undefined) return null;

	// #8792: report the interaction so the proactive-comment decider can react.
	void emitInteractionEvent(args.runtime, match, args.message);

	const thought = `Shortcut: ${match.shortcut.id}`;
	return {
		kind: "direct_reply",
		messageHandler: {
			processMessage: "RESPOND",
			thought,
			plan: {
				contexts: [SIMPLE_CONTEXT_ID],
				reply: captured,
				simple: true,
				requiresTool: false,
			},
		},
		result: createV5ReplyStrategyResult({
			runtime: args.runtime,
			message: args.message,
			state: args.state,
			responseId: args.responseId,
			text: captured,
			thought,
		}),
	};
}

/** Emit SLASH_COMMAND_INVOKED / SHORTCUT_FIRED for a gated interaction (#8792). */
async function emitInteractionEvent(
	runtime: IAgentRuntime,
	match: ShortcutMatch,
	message: Memory,
): Promise<void> {
	try {
		const roomId = message.roomId;
		if (match.shortcut.kind === "explicit") {
			const command = (match.shortcut.aliases?.[0] ?? match.shortcut.id)
				.replace(/^[/!]/, "")
				.trim();
			await runtime.emitEvent(EventType.SLASH_COMMAND_INVOKED, {
				runtime,
				source: "shortcut-gate",
				command,
				targetKind: "agent",
				initiatedBy: "user",
				roomId,
			});
		} else {
			await runtime.emitEvent(EventType.SHORTCUT_FIRED, {
				runtime,
				source: "shortcut-gate",
				shortcutId: match.shortcut.id,
				initiatedBy: "user",
				roomId,
			});
		}
	} catch (err) {
		runtime.logger?.debug?.(
			{ src: "shortcut-gate", err },
			"interaction event emit failed",
		);
	}
}

export async function runV5MessageRuntimeStage1(args: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	responseId: UUID;
	callback?: HandlerCallback;
	plannerLoopConfig?: PlannerLoopParams["config"];
	onResponseHandlerEarlyReply?: (
		event: ResponseHandlerEarlyReplyEvent,
	) => Promise<void> | void;
}): Promise<V5MessageRuntimeStage1Result> {
	const senderRole =
		getTrajectoryContext()?.userRole ??
		(await resolveStage1SenderRole(args.runtime, args.message));
	const availableContexts = listAvailableContextsForRole(
		args.runtime.contexts,
		senderRole,
	);
	const context = await createV5MessageContextObject({
		...args,
		userRoles: [senderRole],
		availableContexts,
		extraProviderExclusions: stage1ProviderExclusionsForMessage(args.message),
	});

	// G10/G11: construct the per-trajectory recorder. No-op when disabled via
	// ELIZA_TRAJECTORY_RECORDING=0. Failures inside the recorder must NEVER
	// propagate up — the recorder is observability, not load-bearing.
	const recordingEnabled = isTrajectoryRecordingEnabled();
	const recorder: TrajectoryRecorder | undefined = recordingEnabled
		? createJsonFileTrajectoryRecorder({
				logger: args.runtime.logger as {
					warn?: (context: unknown, message?: string) => void;
				},
			})
		: undefined;
	const trajectoryId = recorder
		? recorder.startTrajectory({
				agentId: String(args.runtime.agentId ?? "unknown-agent"),
				roomId: args.message.roomId ? String(args.message.roomId) : undefined,
				// Run/scenario correlation the aggregator joins on. The scenario CLI
				// sets these env vars before each scenario (packages/scenario-runner/
				// src/cli.ts); passing them here makes this call site the source of
				// truth so file-recorder trajectories carry the join keys without the
				// recorder inferring them from env buried in its persistence layer.
				runId: readEnv("ELIZA_LIFEOPS_RUN_ID"),
				scenarioId: readEnv("ELIZA_LIFEOPS_SCENARIO_ID"),
				// Root-turn correlation minted on the turn's trajectory context
				// (#13775). Threading it here makes the file trajectory join the DB
				// row and any spawned sub-agent trajectory on one traceId.
				traceId: getTrajectoryContext()?.traceId,
				rootMessage: {
					id: String(args.message.id ?? args.responseId),
					text: getUserMessageText(args.message) ?? "",
					sender: args.message.entityId
						? String(args.message.entityId)
						: undefined,
				},
			})
		: undefined;

	let endStatus: "finished" | "errored" = "finished";
	let factsTask: Promise<{
		startedAt: number;
		endedAt: number;
		result: FactsAndRelationshipsRunResult | null;
		error?: unknown;
	} | null> = Promise.resolve(null);
	try {
		const messageHandlerStartedAt = Date.now();
		const directMessageChannel =
			args.message.content?.channelType === ChannelType.DM ||
			args.message.content?.channelType === ChannelType.API ||
			args.message.content?.channelType === ChannelType.SELF;
		// Compact-triage tier: an unaddressed text-group turn usually ends in
		// IGNORE, so it gets the compact template + compact context catalog +
		// compressed field docs instead of the full ~27KB static rule block.
		// Structural signals only; anything uncertain fails open to the full
		// tier (see stage1-prompt-tier.ts).
		const groupTriageTurn =
			!directMessageChannel &&
			isUnaddressedTextGroupTurn(
				args.message,
				messageExplicitlyAddressesAgent(args.runtime, args.message),
			) &&
			isStage1GroupTriageTierEnabled(args.runtime);
		const stage1TurnSignal =
			getStreamingContext()?.abortSignal ?? new AbortController().signal;

		const responseHandlerFieldContext: ResponseHandlerFieldContext = {
			runtime: args.runtime,
			message: args.message,
			state: args.state,
			senderRole: senderRole as ResponseHandlerSenderRole,
			turnSignal: stage1TurnSignal,
		};
		const responseHandlerFields =
			args.runtime.responseHandlerFieldRegistry.list();
		// Group-triage turns keep the full field set (shouldRespond is the whole
		// point) but render the compressed prompt slices; the schema is
		// unaffected by `compact` so the HANDLE_RESPONSE contract is identical.
		const responseHandlerFieldSelection = directMessageChannel
			? buildDirectChannelResponseFieldSelection(responseHandlerFields)
			: groupTriageTurn
				? { compact: true }
				: undefined;
		const selectedResponseHandlerFields =
			args.runtime.responseHandlerFieldRegistry.list(
				responseHandlerFieldSelection,
			);
		const responseHandlerFieldPrompt =
			await args.runtime.responseHandlerFieldRegistry.composePromptSlices(
				responseHandlerFieldContext,
				responseHandlerFieldSelection,
			);
		const responseHandlerSchema =
			args.runtime.responseHandlerFieldRegistry.composeSchema(
				responseHandlerFieldSelection,
			);
		const messageHandlerInput = renderMessageHandlerModelInput(
			args.runtime,
			context,
			availableContexts,
			{
				directMessage: directMessageChannel,
				groupTriage: groupTriageTurn,
				responseHandlerFields: responseHandlerFieldPrompt.rendered,
			},
		);
		const stage1PrefixHashes = computePrefixHashes(
			messageHandlerInput.promptSegments,
		);
		const stableStage1Segments = messageHandlerInput.promptSegments.filter(
			(segment) => segment.stable,
		);
		const stableStage1PrefixHashes = computePrefixHashes(stableStage1Segments);
		const stage1SystemContent =
			typeof messageHandlerInput.messages[0]?.content === "string"
				? messageHandlerInput.messages[0].content
				: "";
		const stage1PrefixHash =
			stableStage1PrefixHashes[stableStage1PrefixHashes.length - 1]?.hash ??
			hashString(`stage1:${stage1SystemContent}`);
		const messageHandlerTools = [
			createHandleResponseTool({
				directMessage: directMessageChannel,
				parameters: responseHandlerSchema,
				description:
					"Stage 1: populate registered response-handler fields once before action tools. Empty values for non-applicable fields.",
			}),
		];
		const messageHandlerProviderOptions =
			withMessageHistoryCompactionProviderOptions(
				withModelInputBudgetProviderOptions(
					cacheProviderOptions({
						prefixHash: stage1PrefixHash,
						segmentHashes: stage1PrefixHashes.map((entry) => entry.segmentHash),
						promptSegments: messageHandlerInput.promptSegments,
						// Use `roomId` as the conversation id for local-inference slot
						// pinning. Cloud providers ignore it; local backends route
						// every turn of the same room to the same KV slot, which is
						// the dominant cache reuse signal for chat.
						conversationId: args.message.roomId
							? String(args.message.roomId)
							: undefined,
					}),
					buildModelInputBudget({
						messages: messageHandlerInput.messages,
						promptSegments: messageHandlerInput.promptSegments,
						tools: messageHandlerTools,
					}),
				),
				args.state,
			);

		// RESPONSE_HANDLER_BEFORE (blocking): hooks fire right before the Stage 1 model
		// call. Used to inject providers / facts / relationships into the
		// stable prefix.
		await args.runtime.runActionsByMode(
			"RESPONSE_HANDLER_BEFORE",
			args.message,
			args.state,
		);

		// RESPONSE_HANDLER_DURING (non-blocking): fire-and-forget alongside the model
		// call. We don't await — the user contract is "during".
		// error-policy:J7 diagnostics-must-not-kill-the-loop — a rejection escaping
		// runActionsByMode must not abort the turn, but it must surface.
		void args.runtime
			.runActionsByMode("RESPONSE_HANDLER_DURING", args.message, args.state)
			.catch((err) =>
				args.runtime.reportError("MessageService.runActionsByMode", err, {
					mode: "RESPONSE_HANDLER_DURING",
				}),
			);

		// Per-turn structure forcing. `buildResponseGrammar` composes the
		// HANDLE_RESPONSE envelope skeleton (fixed key order + the `contexts`
		// element enum from the available context ids + any registered Stage-1
		// field evaluators, single-value enums collapsed to literals) and a
		// precise GBNF grammar. The local llama-server engine (W4) constrains the
		// envelope with it so the model never spends tokens on the scaffold; the
		// prompt text stays byte-stable, only the grammar varies per turn. Cloud
		// adapters ignore `responseSkeleton` / `grammar` — `tools` carries the
		// equivalent (unforced) contract for them.
		const responseGrammar = buildResponseGrammar(
			{
				actions: args.runtime.actions ?? [],
				responseHandlerFields: selectedResponseHandlerFields,
				responseHandlerFieldSignature:
					args.runtime.responseHandlerFieldRegistry?.composeSchemaSignature(
						responseHandlerFieldSelection,
					),
			},
			{
				contexts: availableContexts.map((definition) => String(definition.id)),
				channelType:
					typeof args.message.content?.channelType === "string"
						? args.message.content.channelType
						: undefined,
			},
		);

		// Per-span argmax sampling for the structured envelope: every enum,
		// number, and boolean span gets temperature=0 / topK=1 so the model
		// never randomly tips a decision (shouldRespond, requiresTool, …) that
		// has a clear argmax winner. Free-string spans (replyText, thought)
		// keep the call-level temperature. Engines that don’t honor per-span
		// sampling ignore the field (grammar still constrains the tokens).
		const stage1SpanSamplerPlan = buildSpanSamplerPlan(
			responseGrammar.responseSkeleton,
		);
		const stage1ProviderOptions = withGuidedDecodeProviderOptions(
			messageHandlerProviderOptions,
		);
		stage1ProviderOptions.eliza = {
			...((stage1ProviderOptions as { eliza?: Record<string, unknown> })
				.eliza ?? {}),
			thinking: "off",
		};
		const stage1ModelParams = {
			messages: messageHandlerInput.messages,
			promptSegments: messageHandlerInput.promptSegments,
			tools: messageHandlerTools,
			toolChoice: "required" as const,
			// Direct/DM/API Stage 1 packs the whole answer into `replyText`. We don't
			// cap it: a hardcoded ceiling 400s on any model whose real limit differs
			// and truncates long single-turn replies. `omitMaxTokens` tells adapters
			// to use provider/model-max output instead of the runtime default; group
			// channels keep DEFAULT_STAGE1_MAX_TOKENS so they stay bounded.
			maxTokens: directMessageChannel ? undefined : DEFAULT_STAGE1_MAX_TOKENS,
			omitMaxTokens: directMessageChannel,
			// Streamed structured generation: the local engine (W4) streams the
			// HANDLE_RESPONSE envelope and parses it incrementally so `shouldRespond`
			// / `contexts` route the moment they are known and `replyText` flows to
			// TTS the instant that field opens. Cloud adapters ignore the flag and
			// return the result whole.
			streamStructured: true,
			responseSkeleton: responseGrammar.responseSkeleton,
			grammar: responseGrammar.grammar,
			spanSamplerPlan: stage1SpanSamplerPlan,
			signal: stage1TurnSignal,
			// Guided structured decode on by default for Stage 1 (the call always
			// carries a forced skeleton): the local engine derives the
			// deterministic-token prefill plan and the fork fast-forwards the
			// forced scaffold spans. Opt out with `ELIZA_LOCAL_GUIDED_DECODE=0`.
			// Cloud adapters ignore `providerOptions.eliza.guidedDecode`.
			providerOptions: stage1ProviderOptions,
		};
		// Provider-shape retry: cloud reasoning models reached over
		// OpenAI-compatible providers can intermittently return either no
		// content at all or a required native tool call with no arguments. Both
		// shapes have no recoverable Stage 1 payload, so retry a small bounded
		// number of times before falling back to the planner.
		const stage1RetryLimit = readStage1EmptyRetryLimit(args.runtime);
		let stage1RetryCount = 0;
		let rawMessageHandler = (await args.runtime.useModel(
			ModelType.RESPONSE_HANDLER,
			stage1ModelParams,
		)) as string | GenerateTextResult;
		let stage1RetryReason = getStage1RetryReason(rawMessageHandler);
		while (
			stage1RetryCount < stage1RetryLimit &&
			shouldRetryStage1Generation(
				stage1RetryReason,
				rawMessageHandler,
				stage1ModelParams.maxTokens,
			)
		) {
			stage1RetryCount += 1;
			args.runtime.logger?.warn?.(
				{
					src: "service:message",
					attempt: stage1RetryCount + 1,
					maxAttempts: stage1RetryLimit + 1,
					reason: stage1RetryReason,
				},
				`[message] Stage 1 returned ${stage1RetryReason} — retrying (${stage1RetryCount}/${stage1RetryLimit})`,
			);
			rawMessageHandler = (await args.runtime.useModel(
				ModelType.RESPONSE_HANDLER,
				stage1ModelParams,
			)) as string | GenerateTextResult;
			stage1RetryReason = getStage1RetryReason(rawMessageHandler);
		}
		const messageHandlerEndedAt = Date.now();
		// Capture the provider that served the Stage-1 (RESPONSE_HANDLER) call
		// right after it completes, before any later model call could overwrite the
		// runtime-wide last-resolved-provider, so the recorded stage names the real
		// provider instead of the fabricated "default" literal (#13623).
		const messageHandlerProvider = args.runtime.getLastResolvedModelProvider?.(
			ModelType.RESPONSE_HANDLER,
		);
		const rawFieldParsed = extractMessageHandlerRawParsed(rawMessageHandler);
		let fieldRunResult: ResponseHandlerFieldRunResult | null = null;
		let messageHandler: MessageHandlerResult | null = null;
		if (rawFieldParsed) {
			fieldRunResult = await args.runtime.responseHandlerFieldRegistry.dispatch(
				{
					rawParsed: normalizeRawParsedForFieldRegistry(rawFieldParsed),
					runtime: args.runtime,
					message: args.message,
					state: args.state,
					senderRole: senderRole as ResponseHandlerSenderRole,
					turnSignal: stage1TurnSignal,
				},
			);
			messageHandler = messageHandlerFromFieldResult(
				fieldRunResult.parsed,
				fieldRunResult,
				{
					actions: args.runtime.actions,
					messageText: getUserMessageText(args.message),
					candidateBackstopRules: getCandidateActionBackstopRules(args.runtime),
					subAgentCompletionRelay: isSubAgentCompletionArtifact(args.message),
				},
			);
		}
		if (!messageHandler) {
			messageHandler = parseMessageHandlerModelOutput(rawMessageHandler, {
				actions: args.runtime.actions,
				messageText: getUserMessageText(args.message),
				subAgentCompletionRelay: isSubAgentCompletionArtifact(args.message),
			});
		}
		const stage1CompletionLimitHit = stage1HitCompletionLimit(
			rawMessageHandler,
			stage1ModelParams.maxTokens,
		);
		if (stage1CompletionLimitHit) {
			args.runtime.logger?.warn?.(
				{
					src: "service:message",
					finishReason: getStage1FinishReason(rawMessageHandler),
					usage:
						typeof rawMessageHandler === "string"
							? undefined
							: rawMessageHandler.usage,
					maxTokens: stage1ModelParams.maxTokens,
					recovered: Boolean(messageHandler),
				},
				"[message] Stage 1 hit the completion-token limit",
			);
		}
		if (!messageHandler && stage1CompletionLimitHit) {
			messageHandler =
				recoverStage1TruncatedMessageHandler(rawMessageHandler) ??
				synthesizeStage1TruncationReply();
		}
		if (
			!messageHandler &&
			shouldUseStage1PlannerFallback(args.runtime, args.message)
		) {
			const stage1FailureKind = getStage1RetryReason(rawMessageHandler);
			const stage1FailureReason =
				stage1FailureKind === "empty completion"
					? `empty output after ${stage1RetryLimit + 1} attempts`
					: stage1FailureKind === "malformed HANDLE_RESPONSE tool call"
						? `malformed HANDLE_RESPONSE tool call after ${stage1RetryLimit + 1} attempts`
						: "unparseable output";
			messageHandler = synthesizePlannerFallbackFromStage1Failure({
				reason: stage1FailureReason,
				actions: args.runtime.actions,
				messageText: getUserMessageText(args.message),
			});
			args.runtime.logger?.warn?.(
				{
					src: "service:message",
					reason: stage1FailureReason,
				},
				"[message] Stage 1 did not produce a valid handler result; falling back to planner for explicitly addressed message",
			);
		}

		// RESPONSE_HANDLER_AFTER (blocking): hooks fire after Stage 1 returns and the
		// routing decision is parsed, but before the runtime acts on it.
		// Lets a hook inspect / mutate the parsed plan.
		await args.runtime.runActionsByMode(
			"RESPONSE_HANDLER_AFTER",
			args.message,
			args.state,
		);

		if (!messageHandler) {
			if (isEmptyStage1Result(rawMessageHandler)) {
				throw new Error(
					`v5 messageHandler returned empty Stage 1 result after ${stage1RetryLimit + 1} attempts`,
				);
			}
			throw new Error(
				"v5 messageHandler returned invalid MessageHandlerResult",
			);
		}
		const parsedResponseHandlerReply = getMessageHandlerReply(messageHandler);

		if (recorder && trajectoryId) {
			await recordMessageHandlerStage({
				recorder,
				trajectoryId,
				messages: messageHandlerInput.messages,
				tools: messageHandlerTools,
				toolChoice: "required",
				providerOptions: messageHandlerProviderOptions,
				raw: rawMessageHandler,
				parsed: messageHandler,
				startedAt: messageHandlerStartedAt,
				endedAt: messageHandlerEndedAt,
				segmentHashes: stage1PrefixHashes.map((entry) => entry.segmentHash),
				prefixHash: stage1PrefixHash,
				provider: messageHandlerProvider,
				logger: args.runtime.logger,
			});
		}

		if (messageHandler.processMessage === "RESPOND") {
			const injectionGate = await runShouldRespondInjectionGate({
				runtime: args.runtime,
				message: args.message,
				resolveSenderRole: () => senderRole,
			});
			if (injectionGate.blocked) {
				args.runtime.logger.warn(
					{
						src: "service:message",
						agentId: args.runtime.agentId,
						reason: injectionGate.reason,
						score: injectionGate.score,
					},
					"[ShouldRespondRiskGate] suppressing Stage 1 response before side effects or planner tools",
				);
				return {
					kind: "terminal",
					action: "IGNORE",
					messageHandler,
					state: args.state,
				};
			}
		}

		// Kick off the FACTS_AND_RELATIONSHIPS stage in parallel with whichever
		// Stage 2 path runs (simple reply or planner). This stage is purely a
		// side-effect: it dedups + persists user-stated facts/relationships
		// without blocking the user reply. We DO await it in the `finally`
		// block before `endTrajectory`, so the trajectory record is complete.
		if (
			messageHandler.extract &&
			((messageHandler.extract.facts?.length ?? 0) > 0 ||
				(messageHandler.extract.relationships?.length ?? 0) > 0)
		) {
			const startedAt = Date.now();
			factsTask = runFactsAndRelationshipsStage({
				runtime: args.runtime,
				message: args.message,
				state: args.state,
				extract: messageHandler.extract,
			})
				.then((result) => ({ startedAt, endedAt: Date.now(), result }))
				.catch((error) => ({
					startedAt,
					endedAt: Date.now(),
					result: null,
					error,
				}));
		}

		// Persist `addressedTo` as relationship edges from the speaker to each
		// addressee. No LLM call: UUIDs pass through verbatim, names resolve
		// against the room's participants. Fire-and-forget like the facts task;
		// failures land in the logger but never block the reply.
		const addressedTo = messageHandler.extract?.addressedTo ?? [];
		if (addressedTo.length > 0) {
			void applyAddressedTo({
				runtime: args.runtime,
				message: args.message,
				addressedTo,
			}).catch((error) => {
				args.runtime.logger?.warn?.(
					{
						err: error,
						messageId: args.message.id,
						addressedToCount: addressedTo.length,
					},
					"[message] applyAddressedTo failed",
				);
			});
		}

		// Record Stage-1-extracted topics into the per-channel LRU. Pure
		// fire-and-forget side-effect (like facts/addressedTo): it persists the
		// room's running topic list for the CHANNEL_TOPICS provider and must
		// never block or break the turn.
		const topics = messageHandler.extract?.topics ?? [];
		if (topics.length > 0 && args.message.roomId) {
			const channelTopics = args.runtime.getService<ChannelTopicsService>(
				ChannelTopicsService.serviceType,
			);
			if (channelTopics) {
				void channelTopics
					.recordTopics(args.message.roomId, topics)
					.catch((error) => {
						args.runtime.logger?.warn?.(
							{
								err: error,
								messageId: args.message.id,
								roomId: args.message.roomId,
								topicCount: topics.length,
							},
							"[message] recordTopics failed",
						);
					});
			}
		}

		// Stamp the turn's topics onto the inbound message memory so the dashboard
		// can group the transcript by topic + show a topic chips bar (#8928).
		// Additive, fire-and-forget metadata write — never blocks/breaks the turn.
		if (topics.length > 0 && args.message.id) {
			// args.message is always a message memory, so its metadata is
			// MessageMetadata; force `type: "message"` so the spread result is a
			// valid, discriminated MessageMetadata regardless of the inbound shape
			// (never a sibling union member with an unexpected `topics` field).
			const existingMetadata = args.message.metadata;
			void args.runtime
				.updateMemory({
					id: args.message.id,
					metadata: {
						...(existingMetadata ?? {}),
						type: "message" as const,
						topics,
					},
				})
				.catch((error) => {
					args.runtime.logger?.warn?.(
						{ err: error, messageId: args.message.id },
						"[message] stamp message topics failed",
					);
				});
		}

		const responseHandlerEvaluation = fieldRunResult?.preempt
			? {
					activeEvaluators: [],
					appliedPatches: [],
					errors: [],
				}
			: await runResponseHandlerEvaluators({
					runtime: args.runtime,
					message: args.message,
					state: args.state,
					messageHandler,
					availableContexts,
					evaluators: BUILTIN_RESPONSE_HANDLER_EVALUATORS,
				});
		messageHandler.plan.contexts = filterSelectedContextsForRole(
			messageHandler.plan.contexts,
			availableContexts,
		);
		// #9874 item 1: skip the simple→requiresTool promotion when this turn is
		// explicitly addressed to another participant (not us) — the agent is
		// overhearing, not being asked to act, so forcing a tool fabricates a
		// phantom task. Uniform addressing gate, NOT bot-specific: it fires the
		// same for human and bot addressees (bot-ness is surfaced to the model as
		// transcript context, not handled here). Cheap-gated: only resolve
		// addressees when a promotion could actually fire (requiresTool /
		// candidateActions) and the message carries explicit addressees.
		const mayPromoteToTool =
			messageHandler.plan.requiresTool === true ||
			(messageHandler.plan.candidateActions?.length ?? 0) > 0;
		// Fail SAFE on any resolution error (DB hiccup in getEntitiesForRoom): a
		// transient failure must NOT convert a normal turn into the generic
		// failure reply — it just means "don't suppress", matching the
		// conservative contract and the fire-and-forget addressee handling above.
		const suppressToolPromotion =
			mayPromoteToTool && addressedTo.length > 0
				? await messageAddressedToOtherParticipant({
						runtime: args.runtime,
						message: args.message,
						addressedTo,
					}).catch(() => false)
				: false;
		const route = routeMessageHandlerOutput(messageHandler, {
			suppressToolPromotion,
		});
		if (route.type === "ignored" || route.type === "stopped") {
			return {
				kind: "terminal",
				action: route.type === "stopped" ? "STOP" : "IGNORE",
				messageHandler,
				state: args.state,
			};
		}

		if (route.type === "final_reply") {
			// The simple-context reply IS the answer: Stage 1 emits `replyText` (→
			// `route.reply`) inline as part of the required HANDLE_RESPONSE envelope,
			// uncapped for direct channels. There is no separate fast-path model
			// call. When that text is unusable — empty, or a known low-quality
			// scaffold/fragment from strict-JSON generation — ship a clear deferral
			// instead of a blank/garbled bubble, but keep a valid-but-terse answer
			// (e.g. "144" to a math question).
			let reply = route.reply;
			// Fail-closed guard (#11712): never ship the raw HANDLE_RESPONSE field
			// transcript to a user channel. If the reply still carries the
			// `shouldRespond:/replyText:/...` skeleton (a parse fell through
			// somewhere upstream), extract the intended replyText value; if that
			// can't be recovered, drop it and let the unusable-reply deferral below
			// take over. Cheap: line scan only, no full parse on the common path.
			// Replies that merely QUOTE a transcript — prose preamble before the
			// first field line, or field lines inside a code fence (the agent
			// diagnosing a transcript the user pasted) — are exempt: the detector
			// fires only when the skeleton IS the reply, so a legitimate diagnosis
			// is never rewritten down to its quoted replyText tail.
			if (looksLikeRawFieldTranscript(reply)) {
				const recovered = extractReplyTextFromTranscript(reply);
				args.runtime.logger?.warn?.(
					{
						src: "service:message",
						agentId: args.runtime.agentId,
						recovered: recovered !== null,
					},
					"[message] Blocked raw response-handler field transcript at send boundary; extracting replyText",
				);
				// Fail closed: never send the raw transcript. When extraction cannot
				// recover a reply, blank it so the unusable-reply guard below owns
				// the failure path (already logged above).
				reply = recovered !== null ? recovered : "";
			}
			if (
				isUnusableStage1Reply(reply) &&
				!isTerseReplyWorthKeeping({
					reply,
					messageText: getUserMessageText(args.message),
				})
			) {
				reply = "I'm not sure how to answer that.";
			}
			if (
				shouldReplaceUnavailableLiveLookupAck({
					message: args.message,
					actions: args.runtime.actions ?? [],
					reply,
				})
			) {
				reply = LIVE_LOOKUP_UNAVAILABLE_REPLY;
			}
			return {
				kind: "direct_reply",
				messageHandler,
				result: createV5ReplyStrategyResult({
					...args,
					text: reply,
					thought: messageHandler.thought,
				}),
			};
		}

		const selectedContexts =
			route.type === "planning_needed" ? route.contexts : [];
		const routedResponseHandlerReply = getMessageHandlerReply(messageHandler);
		const earlyReplyText =
			routedResponseHandlerReply || parsedResponseHandlerReply;
		const onResponseHandlerEarlyReply = args.onResponseHandlerEarlyReply;
		const earlyReplySent =
			messageHandler.processMessage === "RESPOND" &&
			earlyReplyText.length > 0 &&
			typeof onResponseHandlerEarlyReply === "function";
		if (earlyReplySent && typeof onResponseHandlerEarlyReply === "function") {
			await onResponseHandlerEarlyReply({
				text: restorePiiInUserReplyText(earlyReplyText),
				messageHandler,
			});
		}
		const plannerProviderNames = selectV5PlannerStateProviderNames({
			runtime: args.runtime,
			message: args.message,
			selectedContexts,
			userRoles: [senderRole],
		});
		const recomposedPlannerState =
			typeof args.runtime.composeState === "function"
				? // Reuse what the Stage-1 compose already ran for this message;
					// refresh ONLY RECENT_MESSAGES, which changes after an early reply
					// (the planner must see the just-sent reply). Any planner-only
					// context-gated providers not yet cached are composed too.
					await args.runtime.composeState(
						args.message,
						plannerProviderNames,
						true,
						false,
						["RECENT_MESSAGES"],
					)
				: args.state;
		const selectedContextRoutingState =
			selectedContexts.length > 0
				? {
						[CONTEXT_ROUTING_STATE_KEY]: {
							primaryContext: selectedContexts[0],
							secondaryContexts: selectedContexts.slice(1),
						},
					}
				: undefined;
		const plannerState = withContextRoutingValues(
			attachAvailableContexts(recomposedPlannerState, args.runtime),
			selectedContextRoutingState,
		);
		const directPlannerCandidateActions =
			inferDirectCurrentRequestCandidateActions(
				args.runtime.actions ?? [],
				getUserMessageText(args.message) ?? "",
			);
		if (directPlannerCandidateActions.length > 0) {
			messageHandler.plan.candidateActions = uniqueActionNames([
				...getMessageHandlerCandidateActions(messageHandler),
				...directPlannerCandidateActions,
			]);
		}
		// Full-surface mode (a focused coding sub-agent): skip the relevance/role
		// narrowing entirely and hand the planner EVERY action whose execution gates
		// pass. The narrowing is built for big chat catalogs (retrieve the relevant
		// few); a coding agent's whole small tool set is relevant, and narrowing was
		// returning zero candidates → planner got no native tools → model narrated.
		const fullSurfaceEnv =
			typeof process !== "undefined"
				? process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE?.trim().toLowerCase()
				: undefined;
		const useFullSurface =
			fullSurfaceEnv === "1" ||
			fullSurfaceEnv === "true" ||
			fullSurfaceEnv === "yes" ||
			fullSurfaceEnv === "on";
		const plannerCandidateActions = useFullSurface
			? (args.runtime.actions ?? []).filter(
					(action) =>
						// Full-surface = the eliza-code coding sub-agent (its ACP server
						// sets ELIZA_PLANNER_FULL_ACTION_SURFACE). It must NOT receive the
						// whole chat action catalog (MESSAGE_*/POST_*/…) — 40 tools drowns
						// the model and it never calls FILE. Instead treat the coding
						// contexts (code/files/terminal/automation) as active and run the
						// normal execution gates: that admits the coding tools
						// (FILE/SHELL/WORKTREE, which gate on a coding context) plus
						// context-free control actions (REPLY/STOP/…) and drops the
						// messaging/social chat actions. Role still applies (FILE=ADMIN,
						// SHELL=OWNER; the coding sub-agent runs as OWNER). UI/orchestration
						// parents that pass the gate but a coder never needs are dropped
						// too (see CODING_SUB_AGENT_EXCLUDED_ACTIONS) to keep the request
						// small enough for weaker hosted models to handle large builds.
						!CODING_SUB_AGENT_EXCLUDED_ACTIONS.has(
							normalizeActionIdentifier(action.name),
						) &&
						// Static candidate-action set for a coding sub-agent — no concrete
						// turn message here, so skip the private-action gate; the eventual
						// execution still enforces it through the executor.
						canActionRun(action, {
							activeContexts: CODING_SUB_AGENT_CONTEXTS,
							userRoles: [senderRole],
							skipPrivateGate: true,
						}),
				)
			: await collectV5PlannerCandidateActions({
					runtime: args.runtime,
					message: args.message,
					state: plannerState,
					selectedContexts,
					candidateActions: getMessageHandlerCandidateActions(messageHandler),
					userRoles: [senderRole],
				});
		const localizedExamplesProvider = getLocalizedExamplesProvider(
			args.runtime,
		);
		const localizedExamples = localizedExamplesProvider
			? await localizedExamplesProvider({
					recentMessage: getUserMessageText(args.message),
				})
			: null;
		const actionSurface = buildV5PlannerActionSurface({
			actions: plannerCandidateActions,
			message: args.message,
			state: plannerState,
			messageHandler,
			selectedContexts,
			recorder,
			trajectoryId,
			logger: args.runtime.logger,
			localizedExamples: localizedExamples ?? undefined,
		});
		const exposedPlannerActions = plannerCandidateActions.filter((action) =>
			actionSurface.exposedActionNames.has(
				normalizeActionIdentifier(action.name),
			),
		);
		args.runtime.logger.debug?.(
			{
				src: "service:message",
				actionSurface: actionSurface.summary,
			},
			"Built v5 planner action surface",
		);
		const plannerContext = await createV5MessageContextObject({
			...args,
			state: plannerState,
			selectedContexts,
			includeTools: true,
			userRoles: [senderRole],
			availableContexts,
			preselectedActions: exposedPlannerActions,
			actionSurface,
		});
		const responseHandlerContextSlices = stringArrayProperty(
			(messageHandler.plan as { contextSlices?: unknown }).contextSlices,
		);
		const plannerContextWithDecision = appendContextEvent(plannerContext, {
			id: `message-handler:${messageHandlerEndedAt}`,
			type: "message_handler",
			source: "message-service",
			createdAt: messageHandlerEndedAt,
			...(responseHandlerContextSlices.length > 0
				? { content: responseHandlerContextSlices.join("\n\n") }
				: {}),
			metadata: {
				processMessage: messageHandler.processMessage,
				plan: {
					contexts: messageHandler.plan.contexts,
					...(messageHandler.plan.requiresTool !== undefined
						? { requiresTool: messageHandler.plan.requiresTool }
						: {}),
					candidateActions: getMessageHandlerCandidateActions(messageHandler),
					parentActionHints: getMessageHandlerParentActionHints(messageHandler),
					...(responseHandlerContextSlices.length > 0
						? { contextSlices: responseHandlerContextSlices }
						: {}),
					...(messageHandler.plan.reply !== undefined
						? { reply: messageHandler.plan.reply }
						: {}),
					...(responseHandlerEvaluation.appliedPatches.length > 0
						? {
								responseHandlerPatches:
									responseHandlerEvaluation.appliedPatches.map((patch) => ({
										evaluatorName: patch.evaluatorName,
										changed: patch.changed,
										debug: patch.debug,
									})),
							}
						: {}),
					actionSurface: actionSurface.summary,
				} as JsonValue,
				thought: messageHandler.thought,
			},
		});
		const runtimeWithOptionalServices = args.runtime as typeof args.runtime & {
			getService?: (service: string) => unknown;
		};
		const plannerRuntime: PlannerRuntime = {
			getService: (service) =>
				typeof runtimeWithOptionalServices.getService === "function"
					? runtimeWithOptionalServices.getService(service)
					: null,
			useModel: (modelType, modelParams, provider) =>
				args.runtime.useModel(
					modelType,
					modelParams as GenerateTextParams,
					provider,
				),
			logger: args.runtime.logger as PlannerRuntime["logger"],
		};
		const plannerTools = collectPlannerTools(plannerContextWithDecision);
		const benchmarkForcingToolCall = isBenchmarkForcingToolCall(args.message);
		// Only HARD-enforce a non-terminal tool when Stage 1 both flagged the turn
		// tool-required AND named at least one candidate action. A bare
		// `requiresTool=true` with NO named tool is the Stage-1 classifier
		// over-flagging pure-knowledge and sub-agent-relay turns (verified in the
		// 2026-06-21 deepscan): forcing then makes the planner either loop
		// re-emitting REPLY (rejected up to maxRequiredToolMisses times, answer
		// only via fallback) or run an irrelevant tool (VIEWS / TASKS_HISTORY) just
		// to satisfy the gate. When Stage 1 names no tool, plan with "auto" and
		// trust the planner — it still calls a tool when one genuinely fits and
		// answers directly when none does.
		const stageOneNamedAToolForThisTurn =
			messageHandler.plan.requiresTool === true &&
			(messageHandler.plan.candidateActions?.length ?? 0) > 0;
		const requireNonTerminalToolCall =
			(stageOneNamedAToolForThisTurn || benchmarkForcingToolCall) &&
			plannerTools.length > 0 &&
			!isTextScoredBenchmarkTurn(args.message);
		const effectivePlannerContext = requireNonTerminalToolCall
			? appendContextEvent(plannerContextWithDecision, {
					id: `tool-required:${messageHandlerEndedAt}`,
					type: "instruction",
					source: "message-service",
					createdAt: messageHandlerEndedAt,
					content: benchmarkForcingToolCall
						? "Benchmark harness mode: every turn must invoke a structured tool from the exposed action surface. " +
							"Do not answer with REPLY/RESPOND prose — the harness scores tool calls, not conversation. " +
							"Pick the single best non-terminal action (e.g. MESSAGE, CALENDAR, TODO) that can attempt the request and call it now."
						: "The Stage 1 router marked this current turn as requiring a tool. " +
							"prior_dialogue_policy: " +
							"Do not answer directly from memory, chat history, prior attachments, or prior tool output. " +
							"Call at least one exposed non-terminal tool that can attempt the current request.",
				})
			: plannerContextWithDecision;
		const plannerContextAfterEarlyReply = earlyReplySent
			? appendContextEvent(effectivePlannerContext, {
					id: `early-reply:${messageHandlerEndedAt}`,
					type: "instruction",
					source: "message-service",
					createdAt: Date.now(),
					content:
						"The Stage 1 router already sent this visible reply to the user before planning: " +
						JSON.stringify(earlyReplyText) +
						". Do not repeat it. Send only additional follow-up text if the planner or tool work adds something new.",
				})
			: effectivePlannerContext;
		const evaluatorEffects: EvaluatorEffects = {
			copyToClipboard: () => undefined,
			messageToUser: () => undefined,
		};

		// CONTEXT_BEFORE (blocking): hooks tagged with one of the selected
		// contexts run after Stage 1 routes, before the planner loop begins.
		await args.runtime.runActionsByMode(
			"CONTEXT_BEFORE",
			args.message,
			plannerState,
			{ selectedContexts },
		);
		// CONTEXT_DURING (non-blocking): runs in parallel with the planner.
		// error-policy:J7 diagnostics-must-not-kill-the-loop — a rejection escaping
		// runActionsByMode must not abort the planner, but it must surface.
		void args.runtime
			.runActionsByMode("CONTEXT_DURING", args.message, plannerState, {
				selectedContexts,
			})
			.catch((err) =>
				args.runtime.reportError("MessageService.runActionsByMode", err, {
					mode: "CONTEXT_DURING",
				}),
			);

		let plannerResult: PlannerLoopResult;
		try {
			plannerResult = await runPlannerLoop({
				runtime: plannerRuntime,
				context: plannerContextAfterEarlyReply,
				config: args.plannerLoopConfig,
				tools: plannerTools.length > 0 ? plannerTools : undefined,
				requireNonTerminalToolCall,
				evaluatorEffects,
				recorder,
				trajectoryId,
				executeToolCall: (toolCall, ctx) =>
					executeV5PlannedToolCall({
						runtime: args.runtime,
						toolCall,
						plannerContext: plannerContextAfterEarlyReply,
						executorCtx: buildV5ExecutorContext({
							message: args.message,
							state: plannerState,
							selectedContexts,
							senderRole,
							previousResults: collectPreviousActionResults(ctx.trajectory),
							...(args.callback ? { callback: args.callback } : {}),
						}),
						plannerRuntime,
						executorOptions: { actions: exposedPlannerActions },
						evaluatorEffects,
						recorder,
						trajectoryId,
						plannerLoopConfig: args.plannerLoopConfig,
					}),
				evaluate: ({ runtime: plannerRuntimeForEval, context, trajectory }) =>
					runEvaluator({
						runtime: plannerRuntimeForEval,
						context,
						trajectory,
						effects: evaluatorEffects,
						recorder,
						trajectoryId,
					}),
			});
		} catch (error) {
			const fallbackResult = await runDeterministicPlannerFallback({
				runtime: args.runtime,
				message: args.message,
				plannerState,
				selectedContexts,
				senderRole,
				plannerContext: plannerContextAfterEarlyReply,
				plannerRuntime,
				actions: exposedPlannerActions,
				evaluatorEffects,
				recorder,
				trajectoryId,
				plannerLoopConfig: args.plannerLoopConfig,
				...(args.callback ? { callback: args.callback } : {}),
				plannerError: error,
			});
			if (!fallbackResult) {
				throw error;
			}
			plannerResult = fallbackResult;
		}

		// CONTEXT_AFTER (blocking): hooks fire after the planner loop, before
		// the response is delivered. Lets a context post-process planner
		// output (e.g. enrich the reply with context-specific data).
		await args.runtime.runActionsByMode(
			"CONTEXT_AFTER",
			args.message,
			plannerState,
			{ selectedContexts },
		);

		const actionResults = collectPreviousActionResults(
			plannerResult.trajectory,
		);
		const finalPlannerState =
			actionResults.length > 0
				? withActionResultsForPrompt(plannerState, actionResults)
				: plannerState;
		const plannedTextRaw = String(plannerResult.finalMessage ?? "").trim();
		const deliveredMediaUrls = collectMediaDeliveryUrls(actionResults);
		const plannedText = sanitizeReplyTextAfterMediaDelivery(
			plannedTextRaw,
			deliveredMediaUrls,
		);
		// Some action turns intentionally finish without planner prose. For async
		// work (for example spawning a coding task), still return a non-empty
		// synchronous acknowledgement so HTTP/connector callers don't render a blank
		// "(no response)" while the real work continues in the background. Respect
		// explicit suppressPlannerReply terminal actions (IGNORE/STOP-style flows),
		// which are deliberately silent.
		const suppressesPlannerReply = actionResults.some(
			(result) =>
				(result.data as { suppressPlannerReply?: unknown } | undefined)
					?.suppressPlannerReply === true,
		);
		const ranNonSilentAction =
			actionResults.length > 0 && !suppressesPlannerReply;
		const stageOneAck =
			typeof messageHandler.plan.reply === "string"
				? messageHandler.plan.reply.trim()
				: "";
		const ackFallback =
			!plannedText && !earlyReplySent && !suppressesPlannerReply
				? stageOneAck ||
					(ranNonSilentAction ? "on it, working on that now." : "")
				: "";
		const effectiveReplyText = plannedText || ackFallback;
		const plannedTextRepeatsEarlyReply =
			earlyReplySent &&
			normalizeVisibleTextForDuplicateCheck(effectiveReplyText) ===
				normalizeVisibleTextForDuplicateCheck(earlyReplyText);
		const shouldSendPlannedText =
			Boolean(effectiveReplyText) && !plannedTextRepeatsEarlyReply;

		return {
			kind: "planned_reply",
			messageHandler,
			result: shouldSendPlannedText
				? createV5ReplyStrategyResult({
						...args,
						state: finalPlannerState,
						text: effectiveReplyText,
						thought:
							plannerResult.evaluator?.thought ??
							plannerResult.trajectory.steps.at(-1)?.thought ??
							messageHandler.thought,
					})
				: {
						responseContent: null,
						responseMessages: [],
						state: finalPlannerState,
						mode: "none",
					},
		};
	} catch (err) {
		endStatus = "errored";
		throw err;
	} finally {
		// Finalize the trajectory: record the FACTS_AND_RELATIONSHIPS side-effect
		// stage, then end the trajectory.
		//
		// CRITICAL (latency): factsTask is the FACTS_AND_RELATIONSHIPS stage — a
		// heavy background TEXT_LARGE call that is launched in parallel precisely
		// so it does NOT block the user reply (see the launch comment above). The
		// facts/relationships are persisted *inside* runFactsAndRelationshipsStage
		// independently of this await, so the only thing awaiting it here buys is
		// the trajectory record's facts-stage entry. Awaiting it in `finally`
		// gated EVERY reply on the slow facts model — dedicated cloud agents took
		// 30s+ per turn for a reply that was already ready in ~3s. So run the
		// finalize in the background by default and let the turn return as soon as
		// the reply is decided. Await it only when deterministic trajectory
		// ordering is required (e.g. the scenario-runner) via ELIZA_AWAIT_FACTS_STAGE.
		// finalizeTrajectoryRecording is the lifecycle guard: it bounds the wait
		// on the facts stage and writes the terminal status no matter what, so a
		// hung facts model call can never leave the trajectory stuck `running`.
		const finalizeTrajectory = async () => {
			if (!recorder || !trajectoryId) return;
			await finalizeTrajectoryRecording({
				recorder,
				trajectoryId,
				status: endStatus,
				beforeEnd: async () => {
					const factsOutcome = await factsTask;
					if (factsOutcome) {
						await recordFactsAndRelationshipsStage({
							recorder,
							trajectoryId,
							outcome: factsOutcome,
							logger: args.runtime.logger,
						});
					}
				},
				logger: args.runtime.logger as {
					warn?: (context: unknown, message?: string) => void;
				},
			});
		};
		if (process.env.ELIZA_AWAIT_FACTS_STAGE === "true") {
			await finalizeTrajectory();
		} else {
			void finalizeTrajectory();
		}
	}
}

async function recordMessageHandlerStage(args: {
	recorder: TrajectoryRecorder;
	trajectoryId: string;
	messages?: ChatMessage[];
	tools?: ToolDefinition[];
	toolChoice?: unknown;
	providerOptions?: Record<string, unknown>;
	raw: string | GenerateTextResult;
	parsed?: MessageHandlerResult;
	startedAt: number;
	endedAt: number;
	segmentHashes?: string[];
	prefixHash?: string;
	/**
	 * The provider that actually served the Stage-1 call (resolved from the
	 * runtime after the call completed). Threaded so the recorded stage names
	 * the real provider instead of the fabricated `"default"` literal (#13623).
	 */
	provider?: string;
	logger?: IAgentRuntime["logger"];
}): Promise<void> {
	try {
		const responseText = getMessageHandlerResponseText(args.raw, args.parsed);
		const usage =
			typeof args.raw === "string"
				? undefined
				: extractMessageHandlerUsage(args.raw);
		const modelName = extractMessageHandlerModelName(args.raw);
		await args.recorder.recordStage(args.trajectoryId, {
			stageId: `stage-msghandler-${args.startedAt}`,
			kind: "messageHandler",
			startedAt: args.startedAt,
			endedAt: args.endedAt,
			latencyMs: args.endedAt - args.startedAt,
			model: {
				modelType: String(ModelType.RESPONSE_HANDLER),
				modelName,
				provider: resolveRecordedStageProvider(args.raw, args.provider),
				messages: args.messages,
				tools: args.tools,
				toolChoice: args.toolChoice,
				providerOptions: args.providerOptions,
				response: responseText,
				toolCalls: extractMessageHandlerToolCalls(args.raw),
				usage,
				finishReason: getStage1FinishReason(args.raw) || undefined,
			},
			cache: args.prefixHash
				? {
						segmentHashes: args.segmentHashes ?? [],
						prefixHash: args.prefixHash,
					}
				: undefined,
		});
	} catch (err) {
		args.logger?.warn?.(
			{ err: (err as Error).message, trajectoryId: args.trajectoryId },
			"[TrajectoryRecorder] failed to record messageHandler stage",
		);
	}
}

async function recordFactsAndRelationshipsStage(args: {
	recorder: TrajectoryRecorder;
	trajectoryId: string;
	outcome: {
		startedAt: number;
		endedAt: number;
		result: FactsAndRelationshipsRunResult | null;
		error?: unknown;
	};
	logger?: IAgentRuntime["logger"];
}): Promise<void> {
	try {
		const { startedAt, endedAt, result, error } = args.outcome;
		// The provider is carried WITH the facts call result (captured
		// synchronously at call time) so a parallel/subsequent TEXT_LARGE call
		// can't have overwritten it before this stage is recorded (#13623).
		const factsProvider = result?.provider;
		const candidates = extractCandidatesForRecording(result);
		const kept = result?.parsed
			? {
					facts: result.parsed.facts,
					relationships: result.parsed.relationships,
				}
			: { facts: [], relationships: [] };
		const written = result?.written ?? { facts: 0, relationships: 0 };
		const thought = error
			? `error: ${error instanceof Error ? error.message : String(error)}`
			: (result?.parsed.thought ?? "");
		await args.recorder.recordStage(args.trajectoryId, {
			stageId: `stage-facts-${startedAt}`,
			kind: "factsAndRelationships",
			startedAt,
			endedAt,
			latencyMs: endedAt - startedAt,
			model: result?.rawResponse
				? {
						modelType: String(ModelType.TEXT_LARGE),
						provider: resolveRecordedStageProvider(
							result.rawResponse,
							factsProvider,
						),
						messages: result.messages,
						tools: result.tools,
						toolChoice: "required",
						response:
							typeof result.rawResponse === "string"
								? result.rawResponse
								: JSON.stringify(result.rawResponse),
					}
				: undefined,
			factsAndRelationships: {
				candidates,
				kept,
				written,
				thought,
			},
		});
	} catch (err) {
		args.logger?.warn?.(
			{ err: (err as Error).message, trajectoryId: args.trajectoryId },
			"[TrajectoryRecorder] failed to record factsAndRelationships stage",
		);
	}
}

function extractCandidatesForRecording(
	result: FactsAndRelationshipsRunResult | null,
): {
	facts: string[];
	relationships: Array<{ subject: string; predicate: string; object: string }>;
} {
	const userMessage = result?.messages?.find(
		(message) => message.role === "user",
	);
	const userContent =
		typeof userMessage?.content === "string" ? userMessage.content : "";
	const facts: string[] = [];
	const relationships: Array<{
		subject: string;
		predicate: string;
		object: string;
	}> = [];
	if (!userContent) {
		return { facts, relationships };
	}
	const candidatesBlock = userContent.split("candidates:")[1] ?? "";
	for (const line of candidatesBlock.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("-")) continue;
		const body = trimmed.replace(/^-\s*/, "");
		if (body.startsWith("fact:")) {
			facts.push(body.slice("fact:".length).trim());
		} else if (body.startsWith("relationship:")) {
			const triple = body.slice("relationship:".length).trim().split(/\s+/);
			if (triple.length >= 3) {
				relationships.push({
					subject: triple[0],
					predicate: triple[1],
					object: triple.slice(2).join(" "),
				});
			}
		}
	}
	return { facts, relationships };
}

/**
 * Read the provider name a model result attributes itself to, if the provider
 * adapter surfaced one in `providerMetadata` (e.g. `{ provider }` or
 * `{ providerName }`). Returns undefined when the result is a bare string or
 * carries no self-reported provider — never a fabricated value.
 */
function extractStageResultProvider(
	raw: string | GenerateTextResult | unknown,
): string | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const meta = (raw as { providerMetadata?: unknown }).providerMetadata;
	if (!meta || typeof meta !== "object" || Array.isArray(meta))
		return undefined;
	const record = meta as Record<string, unknown>;
	for (const key of ["provider", "providerName"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

/**
 * Resolve the provider name to record on a trajectory model stage. Prefers a
 * provider the result self-reports, then the runtime-resolved provider that
 * actually served the call, and only falls back to the `"default"` sentinel
 * when neither is known. Before #13623 these stages hardcoded `"default"`,
 * making the trajectory useless as a live-vs-proxy provenance signal.
 */
function resolveRecordedStageProvider(
	raw: string | GenerateTextResult | unknown,
	runtimeResolvedProvider?: string,
): string {
	const selfReported = extractStageResultProvider(raw);
	if (selfReported) return selfReported;
	if (
		typeof runtimeResolvedProvider === "string" &&
		runtimeResolvedProvider.trim().length > 0
	) {
		return runtimeResolvedProvider.trim();
	}
	return "default";
}

function extractMessageHandlerModelName(
	raw: string | GenerateTextResult,
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

function getMessageHandlerResponseText(
	raw: string | GenerateTextResult,
	parsed?: MessageHandlerResult,
): string {
	if (typeof raw === "string") {
		return raw;
	}
	if (typeof raw.text === "string" && raw.text.trim().length > 0) {
		return raw.text;
	}
	const responseText = raw.response;
	if (typeof responseText === "string" && responseText.trim().length > 0) {
		return responseText;
	}
	return parsed ? JSON.stringify(parsed) : "";
}

function extractMessageHandlerToolCalls(
	raw: string | GenerateTextResult,
): Array<{ id?: string; name?: string; args?: Record<string, unknown> }> {
	if (typeof raw === "string" || !Array.isArray(raw.toolCalls)) {
		return [];
	}
	const toolCalls: Array<{
		id?: string;
		name?: string;
		args?: Record<string, unknown>;
	}> = [];
	for (const entry of raw.toolCalls) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			continue;
		}
		const name = String(
			entry.name ?? entry.toolName ?? entry.tool ?? entry.action ?? "",
		).trim();
		const args = parseToolArguments(
			entry.arguments ?? entry.args ?? entry.input ?? entry.params,
		);
		toolCalls.push({
			id:
				typeof entry.id === "string"
					? entry.id
					: typeof entry.toolCallId === "string"
						? entry.toolCallId
						: undefined,
			name: name || undefined,
			args: args ?? undefined,
		});
	}
	return toolCalls;
}

function extractMessageHandlerUsage(raw: GenerateTextResult):
	| {
			promptTokens: number;
			completionTokens: number;
			cacheReadInputTokens?: number;
			cacheCreationInputTokens?: number;
			totalTokens: number;
	  }
	| undefined {
	const usage = raw.usage;
	if (!usage) return undefined;
	const promptTokens = usage.promptTokens ?? 0;
	const completionTokens = usage.completionTokens ?? 0;
	const totalTokens = usage.totalTokens ?? promptTokens + completionTokens;
	const out: {
		promptTokens: number;
		completionTokens: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		totalTokens: number;
	} = { promptTokens, completionTokens, totalTokens };
	if (typeof usage.cacheReadInputTokens === "number") {
		out.cacheReadInputTokens = usage.cacheReadInputTokens;
	} else {
		const cachedPromptTokens =
			"cachedPromptTokens" in usage ? usage.cachedPromptTokens : undefined;
		if (typeof cachedPromptTokens === "number") {
			out.cacheReadInputTokens = cachedPromptTokens;
		}
	}
	if (typeof usage.cacheCreationInputTokens === "number") {
		out.cacheCreationInputTokens = usage.cacheCreationInputTokens;
	}
	return out;
}

/**
 * True when a plugin registered at least one core text delegate (chat / planning).
 * Embeddings-only (local-ai) and TTS do not count — without a matching delegate,
 * `dynamicPromptExecFromState` can fail with "No handler found for delegate type".
 */
export function hasTextGenerationHandler(runtime: IAgentRuntime): boolean {
	const keys: Array<keyof typeof ModelType | string> = [
		ModelType.TEXT_LARGE,
		ModelType.TEXT_SMALL,
		ModelType.TEXT_MEDIUM,
		ModelType.TEXT_NANO,
		ModelType.TEXT_MEGA,
		ModelType.ACTION_PLANNER,
		ModelType.RESPONSE_HANDLER,
	];
	for (const k of keys) {
		if (runtime.getModel(String(k))) return true;
	}
	return false;
}

/**
 * Tracks the latest response ID per agent+room to handle message superseding
 */
const latestResponseIds = new Map<string, Map<string, string>>();
// Sub-agent completions emit follow-up evaluators (URL verification, attachment
// routing, transcript stripping) that legitimately take >5s; 30s gives them
// room without indefinitely blocking response finalization.
const DEFAULT_POST_DELIVERY_SIDE_EFFECT_TIMEOUT_MS = 30_000;

function clearLatestResponseId(
	agentId: UUID,
	roomId: UUID,
	responseId: UUID,
): void {
	const agentMap = latestResponseIds.get(agentId);
	if (!agentMap) {
		return;
	}

	if (agentMap.get(roomId) !== responseId) {
		return;
	}

	agentMap.delete(roomId);
	if (agentMap.size === 0) {
		latestResponseIds.delete(agentId);
	}
}

function resolvePostDeliverySideEffectTimeoutMs(): number {
	const raw = process.env.ELIZA_POST_DELIVERY_SIDE_EFFECT_TIMEOUT_MS?.trim();
	if (!raw) return DEFAULT_POST_DELIVERY_SIDE_EFFECT_TIMEOUT_MS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_POST_DELIVERY_SIDE_EFFECT_TIMEOUT_MS;
	}
	return Math.max(100, parsed);
}

async function runPostDeliverySideEffect(
	runtime: Pick<IAgentRuntime, "logger" | "agentId">,
	label: string,
	task: () => Promise<unknown>,
): Promise<void> {
	const timeoutMs = resolvePostDeliverySideEffectTimeoutMs();
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			Promise.resolve()
				.then(task)
				.then(() => "completed" as const),
			new Promise<"timed_out">((resolve) => {
				timeoutHandle = setTimeout(() => resolve("timed_out"), timeoutMs);
				(timeoutHandle as { unref?: () => void }).unref?.();
			}),
		]);
		if (result === "timed_out") {
			runtime.logger.warn(
				{
					src: "service:message",
					agentId: runtime.agentId,
					label,
					timeoutMs,
				},
				"Post-delivery side effect timed out",
			);
		}
	} catch (err) {
		runtime.logger.warn(
			{
				src: "service:message",
				agentId: runtime.agentId,
				label,
				err: err instanceof Error ? err.message : String(err),
			},
			"Post-delivery side effect failed",
		);
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}
}

function detachPostDeliverySideEffect(
	runtime: Pick<IAgentRuntime, "logger" | "agentId">,
	label: string,
	task: () => Promise<unknown>,
): void {
	void runPostDeliverySideEffect(runtime, label, task);
}

export function isSimpleReplyResponse(
	responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
	return !!(
		responseContent?.actions &&
		responseContent.actions.length === 1 &&
		typeof responseContent.actions[0] === "string" &&
		isReplyActionIdentifier(responseContent.actions[0])
	);
}

function isStopResponse(
	responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
	return !!(
		responseContent?.actions &&
		responseContent.actions.length === 1 &&
		typeof responseContent.actions[0] === "string" &&
		responseContent.actions[0].toUpperCase() === "STOP"
	);
}

function unwrapPlannerIdentifier(value: string): string {
	const safe = value.length > 10_000 ? value.slice(0, 10_000) : value;
	const trimmed = safe
		.trim()
		.replace(/^(?:[-*]|\d+[.)])\s+/, "")
		.replace(/^["'`]+|["'`]+$/g, "");
	if (!trimmed) {
		return "";
	}
	return trimmed;
}

const PROVIDER_FOLLOWUP_PASSIVE_ACTIONS = new Set(
	["REPLY", "RESPOND", "NONE"].map(normalizeActionIdentifier),
);

// Actions the planner selects as explicit delegation / orchestration intent.
// These cannot be evaluated by keyword-overlap against the user's message
// (e.g. "build me an app" does not contain "spawn" or "agent"), so the
// metadata-based corrector must not override them with a keyword-matched
// alternative like a cross-channel send action.
//
// WORKFLOW + its trigger schedule similes are included because the phrase
// structure the planner matches on ("every N minutes", "at 7am daily",
// "schedule a cron task") does not keyword-overlap with the action's
// description the way owner reminder/todo prose does.
// Without these entries, the metadata-overlap correction path routinely
// overrides a correct CREATE_CRON / WORKFLOW pick on
// page-automations with owner task actions based on fuzzy description overlap — breaking
// the scope-gated routing on the page-automations surface.
// CONTACT/ENTITY are explicit umbrella actions for contacts /
// rolodex / follow-up surface. The metadata-based corrector would otherwise
// override a correct contact follow-up pick with
// SCHEDULE_FOLLOW_UP based on keyword overlap ("follow up with X next week"),
// creating a task on the wrong surface. Treat CONTACT and ENTITY as explicit
// planner intent so the corrector does not second-guess them.
//
// START_CODING_TASK is the orchestrator's coding-sub-agent delegation. When a user
// says "build me X" or "implement Y", the planner correctly picks START_CODING_TASK,
// but the user's prose contains zero START_CODING_TASK keywords. Without this entry
// the corrector overrides START_CODING_TASK with whatever role-gated action
// (CALENDAR, MESSAGE, MANAGE_ISSUES) happens to overlap with
// incidental words in the prompt — e.g. a build request that mentions a date
// keyword-rescores CALENDAR over START_CODING_TASK and the user gets
// "Google Calendar is not connected" in response to a code request. Same
// precedent as SPAWN_AGENT, the sibling delegation action that's already
// protected here.
//
// Media and advertising actions are also explicit artifact-producing intent.
// Requests like "generate an image", "make an ad creative", or "publish the
// ad pack" can contain generic workflow/productivity words that fuzzy metadata
// scoring over-values for owner/life actions. If the planner already selected
// a concrete media/ad action, do not rewrite it to LIFE/CALENDAR/etc. based on
// incidental overlap.
export type ActionOwnershipSuggestion = {
	actionName: string;
	score: number;
	secondBestScore: number;
	reasons: string[];
};

function looksLikeActionExplanationRequest(text: string): boolean {
	const normalized = text.toLowerCase().replace(/\s+/gu, " ").trim();
	const asksForExplanation =
		/\b(?:explain|describe|teach|walk\s+me\s+through|what\s+does|what\s+is|how\s+(?:does|do|to)|why)\b/iu.test(
			normalized,
		) ||
		/\b(?:can\s+you\s+)?tell\s+me\s+(?:about|what|why|how)\b/iu.test(
			normalized,
		);
	if (!asksForExplanation) {
		return false;
	}

	const asksToExecuteAfterExplanation =
		/\b(?:and|then|also|after(?:wards)?|next)\s+(?:please\s+)?(?:run|execute)\b/iu.test(
			normalized,
		) ||
		/\b(?:run|execute)\b.*\b(?:after|once)\s+(?:you\s+)?(?:explain|describe|teach|walk\s+me\s+through)\b/iu.test(
			normalized,
		);

	return !asksToExecuteAfterExplanation;
}

// Ask classes a coding delegation can never serve: an explicit "don't spawn",
// an explanation/teaching ask, or creative writing that isn't a coding task.
// Shared by looksLikeCodingWorkRequest (as its exclusion list) and the
// delegation-commitment gate in messageHandlerFromFieldResult.
function looksLikeDelegationExcludedAsk(text: string): boolean {
	const normalized = text.toLowerCase();
	if (!normalized.trim()) {
		return false;
	}
	if (
		/\b(?:do not|don't|dont|without)\s+(?:spawn|delegate|use|start)\s+(?:a\s+)?(?:sub[- ]?agent|task[- ]?agent|coding agent|opencode|codex|claude)\b/iu.test(
			normalized,
		)
	) {
		return true;
	}
	if (looksLikeActionExplanationRequest(normalized)) {
		return true;
	}
	return (
		looksLikeCreativeWritingRequest(normalized) &&
		!looksLikeCreativeCodingWorkRequest(normalized)
	);
}

function looksLikeCodingWorkRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	if (!normalized.trim()) {
		return false;
	}

	if (looksLikeDelegationExcludedAsk(normalized)) {
		return false;
	}

	const asksDelegation = looksLikeExplicitDelegationRequest(normalized);
	if (!asksDelegation && looksLikeInlineCodeSnippetRequest(normalized)) {
		return false;
	}
	const asksCodingWork =
		/\b(?:build|create|make|implement|write|scaffold|fix|edit|modify|update|verify)\b[\s\S]{0,160}\b(?:app|site|website|page|code|file|files|project|cli|script|backend|frontend|repo|feature|bug|url)\b/iu.test(
			normalized,
		) ||
		/\b(?:app|site|website|page|code|file|files|project|cli|script|backend|frontend|repo|feature|bug|url)\b[\s\S]{0,160}\b(?:build|create|make|implement|write|scaffold|fix|edit|modify|update|verify)\b/iu.test(
			normalized,
		);
	return asksDelegation || asksCodingWork;
}

function looksLikeExplicitDelegationRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	return (
		/\b(?:spawn|delegate|use|start|ask|have)\b[\s\S]{0,80}\b(?:sub[- ]?agent|task[- ]?agent|coding agent|opencode|codex|claude)\b/iu.test(
			normalized,
		) ||
		/\b(?:sub[- ]?agent|task[- ]?agent|coding agent|opencode|codex|claude)\b[\s\S]{0,80}\b(?:build|create|make|implement|write|scaffold|fix|edit|modify|verify)\b/iu.test(
			normalized,
		)
	);
}

function looksLikeInlineCodeSnippetRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	if (
		/\b(?:file|files|repo|repository|project|app|site|page|backend|frontend|deploy|build|run|execute|install|test|verify|fix|edit|modify|save|write\s+(?:to|in)\s+(?:\/|\.\/|[a-z]:\\))\b/iu.test(
			normalized,
		)
	) {
		return false;
	}
	const asksForSnippet =
		/\b(?:write|give me|show me|generate|provide|create|make)\b[\s\S]{0,80}\b(?:code block|snippet|function|class|method|example|program|one[- ]?liner|hello world|fibonacci)\b/iu.test(
			normalized,
		) ||
		/\b(?:code block|snippet|function|class|method|example|program|one[- ]?liner|hello world|fibonacci)\b[\s\S]{0,80}\b(?:in|using|for)\s+(?:python|javascript|typescript|java|go|rust|ruby|bash|shell|c\+\+|c#|c\b|php|swift|kotlin)\b/iu.test(
			normalized,
		);
	const hasSmallScope =
		/\b(?:hello world|fibonacci|fib|single|simple|short|small|tiny|example|snippet|function|code block|one[- ]?liner|\d+\s*[- ]?line)\b/iu.test(
			normalized,
		);
	return asksForSnippet && hasSmallScope;
}

function looksLikeCreativeWritingRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	if (!normalized.trim()) return false;
	const creativeObject =
		/\b(?:poem|haiku|sonnet|verse|story|joke|caption|tweet|post|song|lyrics|blurb|tagline)\b/iu.test(
			normalized,
		);
	if (!creativeObject) return false;
	return /\b(?:write|compose|draft|make|create|give me|generate)\b/iu.test(
		normalized,
	);
}

function looksLikeCreativeCodingWorkRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	if (
		/\b(?:poem|haiku|sonnet|verse|story|joke|song|lyrics)\b[\s\S]{0,80}\b(?:about|on|how|that|where|involving)\b[\s\S]{0,80}\b(?:app|site|page|project)\b/iu.test(
			normalized,
		)
	) {
		return false;
	}
	const codingObject =
		/\b(?:app|site|page|code|project|frontend|backend|cli|script)\b/iu;
	const codingVerb =
		/\b(?:build|code|implement|scaffold|program|develop|create|make|write|generate)\b/iu;
	return (
		(codingVerb.test(normalized) && codingObject.test(normalized)) ||
		/\b(?:app|site|page|project)\b[\s\S]{0,160}\b(?:that|which|where|with|for)\b/iu.test(
			normalized,
		)
	);
}

function hasNonPassiveAction(
	responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
	return (
		responseContent?.actions?.some(
			(actionName) =>
				typeof actionName === "string" &&
				!PROVIDER_FOLLOWUP_PASSIVE_ACTIONS.has(
					normalizeActionIdentifier(actionName),
				) &&
				normalizeActionIdentifier(actionName) !==
					normalizeActionIdentifier("IGNORE") &&
				normalizeActionIdentifier(actionName) !==
					normalizeActionIdentifier("STOP"),
		) ?? false
	);
}

/**
 * Returns true when the planner deliberately chose to converse — i.e. the
 * response actions list contains REPLY (or its alias RESPOND).
 *
 * REPLY is a deliberate signal that the LLM judged the message as
 * conversation, not a delegated task. The metadata-overlap rescue path
 * must respect this and not promote REPLY to a privileged action like
 * MESSAGE or MANAGE_ISSUES based on incidental keyword overlap with
 * those actions' example text. Without this gate, a chitchat message
 * containing common scheduling/workflow words ("workflow", "policy",
 * "follow up", "friday", "2026") gets force-routed into a role-gated
 * action and the user sees "Permission denied: only the owner or admin
 * may use inbox actions" in response to plain conversation.
 */
function hasExplicitReplyIntent(
	responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
	const replyId = normalizeActionIdentifier("REPLY");
	const respondId = normalizeActionIdentifier("RESPOND");
	return (
		responseContent?.actions?.some((actionName) => {
			if (typeof actionName !== "string") return false;
			const id = normalizeActionIdentifier(actionName);
			return id === replyId || id === respondId;
		}) ?? false
	);
}

/**
 * Gate for the metadata-rescue path that promotes a passive (REPLY/NONE)
 * response to a privileged action based on keyword overlap. Run only when
 * the planner produced no real action AND no explicit REPLY — i.e. when
 * we genuinely have nothing to say.
 */
export function shouldRunMetadataActionRescue(
	responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
	if (hasNonPassiveAction(responseContent)) return false;
	if (hasExplicitReplyIntent(responseContent)) return false;
	return true;
}

export function shouldPromoteExplicitReplyToOwnedAction(
	responseContent: Pick<Content, "actions"> | null | undefined,
	suggestion: ActionOwnershipSuggestion | null,
	messageText = "",
): boolean {
	if (!suggestion || !hasExplicitReplyIntent(responseContent)) {
		return false;
	}
	if (looksLikeActionExplanationRequest(messageText)) {
		return false;
	}
	return (
		suggestion.reasons.includes("direct:local-shell-check") ||
		suggestion.reasons.includes("direct:web-search")
	);
}

function buildRuntimeActionLookup(runtime: {
	actions?: readonly Action[];
}): Map<string, Action> {
	const actionMap = new Map<string, Action>();
	const actions = runtime.actions ?? [];

	for (const action of actions) {
		const normalized = normalizeActionIdentifier(action.name);
		if (!normalized || actionMap.has(normalized)) {
			continue;
		}
		actionMap.set(normalized, action);
	}

	for (const action of actions) {
		for (const simile of action.similes ?? []) {
			const normalized = normalizeActionIdentifier(simile);
			if (!normalized || actionMap.has(normalized)) {
				continue;
			}
			actionMap.set(normalized, action);
		}
	}

	return actionMap;
}

function resolveRuntimeAction(
	actionLookup: Map<string, Action>,
	actionName: string,
): Action | undefined {
	const normalized = normalizeActionIdentifier(actionName);
	if (!normalized) {
		return undefined;
	}

	return actionLookup.get(normalized);
}

const TERMINAL_ACTION_IDENTIFIERS = new Set(
	[
		"REPLY",
		"IGNORE",
		"STOP",
		"CREATE_TASK",
		"START_CODING_TASK",
		"CODE_TASK",
		"SPAWN_AGENT",
		"SPAWN_CODING_AGENT",
	].map(normalizeActionIdentifier),
);

export type ActionContinuationDecision = {
	shouldContinue: boolean;
	suppressed: boolean;
	continuingActions: string[];
	suppressingActions: string[];
};

export function getActionContinuationDecision(
	runtime: Pick<IAgentRuntime, "actions">,
	responseContent: Content | null | undefined,
): ActionContinuationDecision {
	const actionLookup = buildRuntimeActionLookup(runtime);
	const continuingActions: string[] = [];
	const suppressingActions: string[] = [];

	for (const action of responseContent?.actions ?? []) {
		if (typeof action !== "string") continue;

		const resolvedAction = resolveRuntimeAction(actionLookup, action);
		if (resolvedAction?.suppressPostActionContinuation) {
			suppressingActions.push(resolvedAction.name);
			continue;
		}

		const canonicalAction =
			resolvedAction?.name ??
			canonicalPlannerControlActionName(action) ??
			action;
		if (
			!TERMINAL_ACTION_IDENTIFIERS.has(
				normalizeActionIdentifier(canonicalAction),
			)
		) {
			continuingActions.push(canonicalAction);
		}
	}

	const suppressed = suppressingActions.length > 0;
	return {
		shouldContinue: !suppressed && continuingActions.length > 0,
		suppressed,
		continuingActions,
		suppressingActions,
	};
}

export function actionResultsSuppressPostActionContinuation(
	actionResults: readonly ActionResult[],
): boolean {
	return actionResults.some((result) => {
		const data =
			result?.data &&
			typeof result.data === "object" &&
			!Array.isArray(result.data)
				? (result.data as Record<string, unknown>)
				: null;
		if (!data) {
			return false;
		}

		if (data.suppressPostActionContinuation === true) {
			return true;
		}

		const terminal = data.terminal;
		return (
			terminal !== null &&
			typeof terminal === "object" &&
			!Array.isArray(terminal) &&
			(terminal as Record<string, unknown>).permissionDenied === true
		);
	});
}

/**
 * True when the planner's `text` field should be surfaced to the user as a
 * preamble before action handlers run in actions-mode dispatch. The goal:
 * the user sees "checking your inbox" rather than silence while INBOX/GMAIL
 * do their work.
 *
 * Skipped when the first action is REPLY (the REPLY handler generates its own
 * text), IGNORE (no user-visible response), or STOP (terminal). Also skipped
 * when `text` is empty.
 */
export function shouldEmitPlannerPreamble(
	runtime: IAgentRuntime,
	responseContent: Pick<Content, "text" | "actions"> | null | undefined,
): boolean {
	if (!responseContent) return false;
	const text =
		typeof responseContent.text === "string" ? responseContent.text.trim() : "";
	if (text.length === 0) return false;

	const firstAction =
		typeof responseContent.actions?.[0] === "string"
			? responseContent.actions[0]
			: "";
	if (firstAction.length === 0) return false;

	const actionLookup = buildRuntimeActionLookup(runtime);
	const resolvedAction = resolveRuntimeAction(actionLookup, firstAction);
	if (resolvedAction?.suppressPostActionContinuation) {
		return false;
	}

	const canonicalFirstAction =
		resolvedAction?.name ??
		canonicalPlannerControlActionName(firstAction) ??
		firstAction;
	const normalizedFirstAction = normalizeActionIdentifier(canonicalFirstAction);

	return (
		normalizedFirstAction !== normalizeActionIdentifier("REPLY") &&
		normalizedFirstAction !== normalizeActionIdentifier("IGNORE") &&
		normalizedFirstAction !== normalizeActionIdentifier("STOP")
	);
}

// Actions that are passive bookkeeping / chitchat. Safe to drop when a
// turn-owning action (one that sets suppressPostActionContinuation = true,
// e.g. SPAWN_AGENT) is also picked for the same turn. Keeping them around
// alongside explicit delegation produces duplicate user-visible noise:
// "Created task X" message followed by the actual delegated result.
const PASSIVE_TURN_ACTIONS = new Set(
	["REPLY", "RESPOND", "TASK"].map(normalizeActionIdentifier),
);

export function stripReplyWhenActionOwnsTurn(
	runtime: Pick<IAgentRuntime, "actions" | "logger">,
	actions: readonly string[] | null | undefined,
): string[] {
	if (!actions || actions.length === 0) {
		return [];
	}
	if (actions.length <= 1) {
		return [...actions];
	}

	const actionLookup = buildRuntimeActionLookup(runtime);
	const dedupedActions: string[] = [];
	const seenActionNames = new Set<string>();
	for (const action of actions) {
		const canonicalName =
			resolveRuntimeAction(actionLookup, action)?.name ??
			canonicalPlannerControlActionName(action) ??
			action;
		const normalizedName = normalizeActionIdentifier(canonicalName);
		if (normalizedName && seenActionNames.has(normalizedName)) {
			continue;
		}
		if (normalizedName) {
			seenActionNames.add(normalizedName);
		}
		dedupedActions.push(action);
	}

	if (dedupedActions.length !== actions.length) {
		runtime.logger.info(
			{
				src: "service:message",
				originalActions: actions,
				filteredActions: dedupedActions,
			},
			"Dropped duplicate planner actions before execution",
		);
	}

	if (dedupedActions.length <= 1) {
		return dedupedActions;
	}

	const hasPassive = dedupedActions.some((action) =>
		PASSIVE_TURN_ACTIONS.has(normalizeActionIdentifier(action)),
	);
	if (!hasPassive) {
		return dedupedActions;
	}

	const ownedActions = dedupedActions.filter((action) => {
		const normalized = normalizeActionIdentifier(action);
		if (!normalized || PASSIVE_TURN_ACTIONS.has(normalized)) {
			return false;
		}
		return (
			resolveRuntimeAction(actionLookup, action)
				?.suppressPostActionContinuation === true
		);
	});
	if (ownedActions.length === 0) {
		return dedupedActions;
	}

	const filtered = dedupedActions.filter(
		(action) => !PASSIVE_TURN_ACTIONS.has(normalizeActionIdentifier(action)),
	);
	runtime.logger.info(
		{
			src: "service:message",
			originalActions: dedupedActions,
			filteredActions: filtered,
			suppressedBy: ownedActions,
		},
		"Dropped passive actions because another selected action already owns the turn",
	);
	return filtered.length > 0 ? filtered : ["REPLY"];
}

export function wrapSingleTurnVisibleCallback(
	runtime: Pick<IAgentRuntime, "agentId" | "logger"> &
		Partial<Pick<IAgentRuntime, "character" | "useModel">> & {
			getService?: IAgentRuntime["getService"];
		},
	message: Pick<Memory, "id" | "roomId" | "entityId">,
	callback?: HandlerCallback,
): HandlerCallback | undefined {
	if (!callback) return callback;
	const fullRuntime = runtime as IAgentRuntime;
	const voiceActionReply = async (
		response: Content,
		actionName?: string,
	): Promise<Content> => {
		if (!shouldRewriteActionCallback(response, actionName)) {
			return response;
		}
		const text = response.text?.trim();
		if (!text) return response;
		const rewritten = await rewriteActionCallbackInCharacter({
			runtime: fullRuntime,
			message,
			response,
			actionName: resolveCallbackActionName(response, actionName),
			text,
		});
		return rewritten && rewritten !== text
			? {
					...response,
					text: rewritten,
					data:
						response.data && typeof response.data === "object"
							? {
									...(response.data as Record<string, unknown>),
									rawActionText: text,
									voiceRewritten: true,
								}
							: {
									rawActionText: text,
									voiceRewritten: true,
								},
				}
			: response;
	};

	if (typeof fullRuntime.getService !== "function") {
		return async (response, actionName) =>
			callback(await voiceActionReply(response, actionName), actionName);
	}
	// Resolve verbosity once per turn — cheap because PersonalityStore is
	// in-memory. Returning the original callback when no override is set
	// keeps the hot path zero-cost.
	const store = getPersonalityStore(fullRuntime);
	if (!store) {
		return async (response, actionName) =>
			callback(await voiceActionReply(response, actionName), actionName);
	}
	const userSlot =
		message.entityId && message.entityId !== fullRuntime.agentId
			? store.getSlot(message.entityId)
			: null;
	const globalSlot = store.getSlot("global");
	const verbosity = userSlot?.verbosity ?? globalSlot?.verbosity ?? null;
	if (verbosity !== "terse") {
		return async (response, actionName) =>
			callback(await voiceActionReply(response, actionName), actionName);
	}

	const wrapped: HandlerCallback = async (response, actionName) => {
		response = await voiceActionReply(response, actionName);
		if (typeof response?.text === "string" && response.text.length > 0) {
			const result = enforceVerbosity(response.text, "terse");
			if (result.truncated) {
				fullRuntime.logger.debug(
					{
						src: "service:message",
						messageId: message.id,
						roomId: message.roomId,
						originalTokens: result.originalTokens,
						finalTokens: result.finalTokens,
					},
					"Personality verbosity=terse — truncated response",
				);
				response = { ...response, text: result.text };
			}
		}
		return callback(response, actionName);
	};
	return wrapped;
}

function resolveCallbackActionName(
	response: Content,
	actionName?: string,
): string | undefined {
	if (typeof actionName === "string" && actionName.trim()) {
		return actionName.trim();
	}
	const action = response.action;
	if (typeof action === "string" && action.trim()) {
		return action.trim();
	}
	const actions = response.actions;
	if (Array.isArray(actions)) {
		return actions.find((candidate) => candidate.trim().length > 0)?.trim();
	}
	return undefined;
}

function shouldRewriteActionCallback(
	response: Content | null | undefined,
	actionName?: string,
): response is Content & { text: string } {
	if (!response || typeof response.text !== "string") return false;
	if (!response.text.trim() && !response.attachments?.length) return false;
	// Media actions already produced a file attachment; deliver it directly instead
	// of spending another model call rewriting placeholder text.
	if (response.attachments?.some((media) => Boolean(media?.url))) return false;
	if (!response.text.trim()) return false;
	if (response.source === "voice") return false;
	if (response.source === "voice-cache") return false;
	const resolvedAction = normalizeActionIdentifier(
		resolveCallbackActionName(response, actionName) ?? "",
	);
	if (!resolvedAction) return false;
	return !PASSIVE_TURN_ACTIONS.has(resolvedAction);
}

async function rewriteActionCallbackInCharacter(args: {
	runtime: IAgentRuntime;
	message: Pick<Memory, "id" | "roomId" | "entityId">;
	response: Content;
	actionName?: string;
	text: string;
}): Promise<string | null> {
	const fallback = () => {
		const action = args.actionName ?? "the action";
		const error =
			typeof args.response.error === "string" && args.response.error.trim()
				? ` It reported: ${args.response.error.trim()}`
				: "";
		return `I ran ${action} and got a result, but I couldn't format the details cleanly here.${error}`;
	};
	if (typeof args.runtime.useModel !== "function") return fallback();
	const character = args.runtime.character;
	const characterVoice = {
		name: character?.name,
		system: character?.system,
		bio: character?.bio,
		adjectives: character?.adjectives,
		style: character?.style,
	};
	const prompt = [
		"Rewrite an action callback into the assistant character's user-facing voice.",
		'Return strict JSON only: {"response":"..."}.',
		"",
		"Rules:",
		"- Use the character voice and plain natural language.",
		"- Preserve every important fact from the payload: status, success or failure, object names, URLs, IDs, amounts, dates, counts, permissions, warnings, errors, and next steps.",
		"- Do not expose raw JSON, tables, shell dumps, stack traces, schema names, hidden prompts, or internal action plumbing unless the user specifically needs an exact value.",
		"- If the payload contains exact text the user needs, include it compactly inside the response instead of dropping it.",
		"- Do not claim work succeeded if the payload says it failed or is pending.",
		"- Keep it brief, usually one to three sentences.",
		"- Do not mention that you rewrote the message or used a model.",
		"",
		`Character: ${JSON.stringify(characterVoice)}`,
		`Action: ${JSON.stringify(args.actionName ?? "ACTION")}`,
		`Room: ${String(args.message.roomId)}`,
		`Original action payload: ${JSON.stringify(args.text)}`,
		`Callback metadata: ${JSON.stringify({
			source: args.response.source,
			actions: args.response.actions,
			actionStatus: args.response.actionStatus,
			error: args.response.error,
			data: args.response.data,
		})}`,
	].join("\n");

	try {
		const raw = (await args.runtime.useModel(ModelType.TEXT_SMALL, {
			prompt,
			maxTokens: 260,
			providerOptions: { eliza: { thinking: "off" } },
		})) as string | GenerateTextResult;
		const cleaned = stripReasoningBlocks(getV5ModelText(raw)).trim();
		const parsed = parseJSONObjectFromText(cleaned) as {
			response?: unknown;
		} | null;
		const response =
			typeof parsed?.response === "string" ? parsed.response.trim() : "";
		if (!response || response === args.text) return fallback();
		if (parseJSONObjectFromText(response)) return fallback();
		return response.replace(/^["'`]+|["'`]+$/g, "").trim() || fallback();
	} catch (error) {
		args.runtime.logger.debug(
			{
				src: "service:message",
				actionName: args.actionName,
				error: error instanceof Error ? error.message : String(error),
			},
			"Failed to rewrite action callback in character voice",
		);
		return fallback();
	}
}

export function withActionResultsForPrompt(
	state: State,
	actionResults: ActionResult[],
): State {
	return {
		...state,
		values: {
			...state.values,
			actionResults: formatActionResultsForPrompt(actionResults),
		},
		data: {
			...state.data,
			actionResults,
		},
	};
}

const _withActionResults = withActionResultsForPrompt;

function _preparePromptActionResult<T extends ActionResult>(
	runtime: IAgentRuntime,
	message: Memory,
	result: T,
): T {
	for (const warning of collectActionResultSizeWarnings(result)) {
		runtime.logger.warn(
			{
				src: "service:message",
				agentId: runtime.agentId,
				messageId: message.id,
				roomId: message.roomId,
				action: warning.actionName,
				field: warning.field,
				rawCharLength: warning.rawCharLength,
				estimatedTokens: warning.estimatedTokens,
				thresholdTokens: warning.thresholdTokens,
			},
			"Action result exceeds prompt-size warning threshold",
		);
	}

	return trimActionResultForPromptState(result);
}

function _withTaskCompletion(
	state: State,
	taskCompletion: TaskCompletionAssessment | null | undefined,
): State {
	if (!taskCompletion) {
		return state;
	}

	return {
		...state,
		values: {
			...state.values,
			taskCompletionStatus: formatTaskCompletionStatus(taskCompletion),
			taskCompleted: taskCompletion.completed,
			taskCompletionAssessed: taskCompletion.assessed,
			taskCompletionReason: taskCompletion.reason,
		},
		data: {
			...state.data,
			taskCompletion,
		},
	};
}

type ContextRoutingStateValues = {
	[AVAILABLE_CONTEXTS_STATE_KEY]?: unknown;
	[CONTEXT_ROUTING_STATE_KEY]?: unknown;
};

function withContextRoutingValues(
	state: State,
	contextRoutingStateValues?: ContextRoutingStateValues,
): State {
	if (!contextRoutingStateValues) {
		return state;
	}

	const mergedStateValues = {
		...state.values,
	};

	if (contextRoutingStateValues[AVAILABLE_CONTEXTS_STATE_KEY] !== undefined) {
		mergedStateValues[AVAILABLE_CONTEXTS_STATE_KEY] = contextRoutingStateValues[
			AVAILABLE_CONTEXTS_STATE_KEY
		] as State["values"][string];
	}

	if (contextRoutingStateValues[CONTEXT_ROUTING_STATE_KEY] !== undefined) {
		mergedStateValues[CONTEXT_ROUTING_STATE_KEY] = contextRoutingStateValues[
			CONTEXT_ROUTING_STATE_KEY
		] as State["values"][string];
	}

	return {
		...state,
		values: mergedStateValues,
	};
}

function withInferredContextRoutingFallback(
	routing: ContextRoutingDecision,
	message: Memory,
): ContextRoutingDecision {
	if (getActiveRoutingContexts(routing).length > 0) {
		return routing;
	}
	const inferred = inferContextRoutingFromMessage(message);
	return inferred;
}

async function _composeContinuationDecisionState(
	runtime: IAgentRuntime,
	message: Memory,
	contextRoutingStateValues?: ContextRoutingStateValues,
): Promise<State> {
	// Continuation prompts run after the runtime has already persisted an
	// assistant reply and/or action_result memories. Refresh RECENT_MESSAGES so
	// the follow-up planner does not reuse stale conversation history cached on
	// the original user turn.
	const state = await runtime.composeState(
		message,
		["RECENT_MESSAGES", "ACTIONS"],
		false,
		false,
	);
	const compactedState = await applyMessageHistoryCompactionHook(
		runtime,
		message,
		state,
		"continuation-state",
	);
	return withContextRoutingValues(compactedState, contextRoutingStateValues);
}

/**
 * Default implementation of the MessageService interface.
 * This service handles the complete message processing pipeline including:
 * - Message validation and memory creation
 * - Smart response decision (shouldRespond)
 * - Native planner processing
 * - Action execution and evaluation
 * - Attachment processing
 * - Message deletion and channel clearing
 *
 * This is the standard message handler used by elizaOS and can be replaced
 * with custom implementations via the IMessageService interface.
 */
export class DefaultMessageService implements IMessageService {
	/**
	 * Main message handling entry point
	 */
	async handleMessage(
		runtime: IAgentRuntime,
		message: Memory,
		callback?: HandlerCallback,
		options?: MessageProcessingOptions,
	): Promise<MessageProcessingResult> {
		// Analysis-mode token detection runs BEFORE any planner work so the
		// agent never hallucinates a "performing an analysis" reply. Gated by
		// `ELIZA_ENABLE_ANALYSIS_MODE` / `NODE_ENV=development`. See
		// services/analysis-mode-handler.ts and review #15.
		const analysisActivation = maybeHandleAnalysisActivation({
			text: message.content?.text,
			roomId: message.roomId,
		});
		if (analysisActivation.handled) {
			if (callback && typeof analysisActivation.responseText === "string") {
				await callback({
					text: analysisActivation.responseText,
					thought: "analysis-mode toggle",
				});
			}
			return {
				didRespond: true,
				responseContent: {
					text: analysisActivation.responseText ?? "",
					thought: "analysis-mode toggle",
				},
				responseMessages: [],
				state: { values: {}, data: {}, text: "" } as State,
				mode: "none",
				skipEvaluation: true,
				reason: "analysis-mode-token",
			};
		}

		const source =
			typeof message.content?.source === "string" &&
			message.content.source.trim() !== ""
				? message.content.source
				: "messageService";

		// Root-turn traceId (#13775). On emit-first paths (agent API chat route,
		// connectors) the trajectories MESSAGE_RECEIVED handler already minted and
		// stamped one on message.metadata before we ran — reuse it, or the DB row
		// and the file trajectory would carry different ids. Otherwise mint here
		// (inherited from a spawning parent's env when this runtime is itself a
		// sub-agent, else fresh) and stamp it BEFORE MESSAGE_RECEIVED is emitted
		// below so the DB trajectory handler records the SAME traceId as the file
		// recorder. Placed on the turn's trajectory context below so sub-agent
		// spawns read it too. All stores then join on one traceId.
		const preStampedTraceId =
			typeof message.metadata === "object" &&
			message.metadata !== null &&
			typeof (message.metadata as { traceId?: unknown }).traceId === "string" &&
			(message.metadata as { traceId: string }).traceId.trim() !== ""
				? (message.metadata as { traceId: string }).traceId
				: undefined;
		const traceId =
			preStampedTraceId ??
			resolveTraceCorrelationFromEnv().traceId ??
			asUUID(v4());
		if (!message.metadata) {
			message.metadata = { type: "message" };
		}
		(message.metadata as { traceId?: string }).traceId = traceId;

		let trajectoryStepId =
			typeof message.metadata === "object" &&
			message.metadata !== null &&
			"trajectoryStepId" in message.metadata
				? (message.metadata as { trajectoryStepId?: string }).trajectoryStepId
				: undefined;
		let trajectoryId =
			typeof message.metadata === "object" &&
			message.metadata !== null &&
			"trajectoryId" in message.metadata
				? (message.metadata as { trajectoryId?: string }).trajectoryId
				: undefined;

		if (
			!(typeof trajectoryStepId === "string" && trajectoryStepId.trim() !== "")
		) {
			try {
				await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
					runtime,
					message,
					callback,
					source,
				});
				// ALWAYS_BEFORE (blocking): hooks run for every message before
				// any pipeline work. Use for cheap heuristic preprocessing
				// (identity extraction, dispute detection) whose results may
				// influence Stage 1 routing.
				await runtime.runActionsByMode("ALWAYS_BEFORE", message);
				// ALWAYS_DURING (non-blocking): fire-and-forget alongside the
				// rest of the pipeline. Telemetry, logging, side effects.
				// error-policy:J7 diagnostics-must-not-kill-the-loop — a rejection
				// escaping runActionsByMode must not abort the turn, but it must surface.
				void runtime.runActionsByMode("ALWAYS_DURING", message).catch((err) =>
					runtime.reportError("MessageService.runActionsByMode", err, {
						mode: "ALWAYS_DURING",
					}),
				);
			} catch (error) {
				runtime.logger.warn(
					{
						src: "service:message",
						agentId: runtime.agentId,
						entityId: message.entityId,
						roomId: message.roomId,
						error: error instanceof Error ? error.message : String(error),
					},
					"Failed to emit MESSAGE_RECEIVED before handling message",
				);
			}

			trajectoryStepId =
				typeof message.metadata === "object" &&
				message.metadata !== null &&
				"trajectoryStepId" in message.metadata
					? (message.metadata as { trajectoryStepId?: string }).trajectoryStepId
					: undefined;
			trajectoryId =
				typeof message.metadata === "object" &&
				message.metadata !== null &&
				"trajectoryId" in message.metadata
					? (message.metadata as { trajectoryId?: string }).trajectoryId
					: undefined;
		}

		const senderRole = await resolveStage1SenderRole(runtime, message);
		const trajectoryContextBase = {
			// Minted above (before MESSAGE_RECEIVED) so file, DB, and spawn paths
			// share it for the whole turn (#13775).
			traceId,
			runId: runtime.getCurrentRunId?.(),
			roomId: message.roomId,
			messageId: message.id,
			userRole: senderRole,
		};

		return runWithTrajectoryContext<MessageProcessingResult>(
			typeof trajectoryStepId === "string" && trajectoryStepId.trim() !== ""
				? {
						...trajectoryContextBase,
						...(typeof trajectoryId === "string" && trajectoryId.trim() !== ""
							? { trajectoryId: trajectoryId.trim() }
							: {}),
						trajectoryStepId: trajectoryStepId.trim(),
					}
				: trajectoryContextBase,
			async (): Promise<MessageProcessingResult> => {
				// Determine shouldRespondModel from options or runtime settings
				const shouldRespondModelSetting = runtime.getSetting(
					"SHOULD_RESPOND_MODEL",
				);
				const resolvedShouldRespondModel = normalizeShouldRespondModelType(
					options?.shouldRespondModel ?? shouldRespondModelSetting,
				);

				// Single ID used for tracking, streaming, and the final message (before opts / chunk wrapper).
				const responseId = asUUID(v4());

				// WHY voice detection wraps onStreamChunk here instead of using a
				// separate AsyncLocalStorage streaming context:
				//
				// Previously handleMessage created a second extractor through
				// runWithStreamingContext. Both extractors received the same raw LLM
				// tokens in useModel and emitted independently, causing the
				// dual-extractor garbling bug; consumers saw overlapping deltas that
				// produced unintelligible TTS.
				//
				// The fix: a single structured field extractor in
				// dynamicPromptExecFromState) now provides `accumulated` — the full
				// extracted text — via the third StreamChunkCallback argument. Voice
				// detection wraps the caller's callback to intercept accumulated text
				// for first-sentence detection, then forwards to the original. This
				// keeps voice logic in handleMessage (encapsulation) without adding a
				// second extraction pipeline.
				//
				// The `streamTextFallback` path exists for action handlers or other
				// call sites that don't provide `accumulated` (raw token streams).
				let firstSentenceSent = false;
				let firstSentenceText = "";
				let streamTextFallback = "";
				const userOnStreamChunk = options?.onStreamChunk;
				const wrappedOnStreamChunk: StreamChunkCallback | undefined =
					userOnStreamChunk
						? async (chunk, messageId, accumulated) => {
								let streamText: string;
								// If we have accumulated text, also sync streamTextFallback so the
								// fallback path has accurate state if the stream source later changes.
								if (accumulated !== undefined) {
									streamTextFallback = accumulated;
									streamText = accumulated;
								} else {
									streamTextFallback += chunk;
									streamText = streamTextFallback;
								}

								// Skip when this callback is invoked from `useModel`'s stream loop:
								// `source: "use_model"` already ran for the same raw chunk (Node ALS).
								if (getModelStreamChunkDeliveryDepth() === 0) {
									await runtime.applyPipelineHooks(
										"model_stream_chunk",
										modelStreamChunkPipelineHookContext({
											source: "message_service",
											chunk,
											messageId,
											roomId: message.roomId,
											runId: runtime.getCurrentRunId(),
											responseId,
											accumulated,
										}),
									);
								}

								// First-sentence cloud-TTS path. The local-inference voice loop
								// uses VoiceScheduler/PhraseChunker instead
								// (packages/app-core/src/services/local-inference/voice/scheduler.ts) —
								// this is not duplicated, it's the cloud-deployment counterpart
								// (packages/core can't import packages/app-core; the two paths live
								// at different layers and only one is active per deployment).
								//
								// Only run first-sentence TTS detection when `accumulated` is present.
								// Raw-token streams (no accumulated) may contain partial
								// structured output that would garble hasFirstSentence() and TTS.
								if (
									!firstSentenceSent &&
									accumulated !== undefined &&
									hasFirstSentence(streamText)
								) {
									const { first } = extractFirstSentence(streamText);
									if (first.length > 5) {
										firstSentenceSent = true;
										firstSentenceText = first;

										(async () => {
											try {
												const voiceSettings = runtime.character.settings
													?.voice as
													| {
															model?: string;
															url?: string;
															voiceId?: string;
													  }
													| undefined;

												const model =
													voiceSettings?.model || "en_US-male-medium";
												const voiceId =
													voiceSettings?.url ||
													voiceSettings?.voiceId ||
													"nova";

												let audioBuffer: Buffer | null = null;
												const params: TextToSpeechParams & {
													model?: string;
												} = {
													text: first,
													voice: voiceId,
													model: model,
													...(opts.abortSignal
														? { signal: opts.abortSignal }
														: {}),
												};
												const result = runtime.getModel(
													ModelType.TEXT_TO_SPEECH,
												)
													? await runtime.useModel(
															ModelType.TEXT_TO_SPEECH,
															params,
														)
													: undefined;

												if (
													result instanceof ArrayBuffer ||
													Object.prototype.toString.call(result) ===
														"[object ArrayBuffer]"
												) {
													audioBuffer = Buffer.from(result as ArrayBuffer);
												} else if (Buffer.isBuffer(result)) {
													audioBuffer = result;
												} else if (result instanceof Uint8Array) {
													audioBuffer = Buffer.from(result);
												}

												if (audioBuffer && callback) {
													const audioBase64 = audioBuffer.toString("base64");
													await callback({
														text: "",
														attachments: [
															{
																id: v4(),
																url: `data:audio/wav;base64,${audioBase64}`,
																title: "Voice Response",
																source: "voice-cache",
																description:
																	"Voice response for first sentence",
																text: first,
																contentType: ContentType.AUDIO,
															},
														],
														source: "voice",
													});
												}
											} catch (error) {
												runtime.logger.error(
													{ error },
													"Error generating voice for first sentence",
												);
											}
										})();
									}
								}

								await userOnStreamChunk(chunk, messageId, accumulated);
							}
						: undefined;

				const opts: ResolvedMessageOptions = {
					maxRetries: options?.maxRetries ?? 3,
					timeoutDuration: options?.timeoutDuration ?? 60 * 60 * 1000, // 1 hour
					continueAfterActions:
						options?.continueAfterActions ??
						parseBooleanFromText(
							String(runtime.getSetting("CONTINUE_AFTER_ACTIONS") ?? "true"),
						),
					onStreamChunk: wrappedOnStreamChunk,
					keepExistingResponses:
						options?.keepExistingResponses ??
						parseBooleanFromText(
							String(runtime.getSetting("BASIC_CAPABILITIES_KEEP_RESP") ?? ""),
						),
					shouldRespondModel: resolvedShouldRespondModel,
					...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
				};

				const instrumentedCallback = wrapSingleTurnVisibleCallback(
					runtime,
					message,
					callback,
				);

				// Set up timeout monitoring
				let timeoutId: NodeJS.Timeout | undefined;
				// Declared outside the try so the `finally` can emit the breakdown.
				let inferenceTimer: InferenceTurnTimer | undefined;

				try {
					runtime.logger.info(
						{
							src: "service:message",
							agentId: runtime.agentId,
							entityId: message.entityId,
							roomId: message.roomId,
						},
						"Message received",
					);

					// Track this response ID - ensure map exists for this agent
					let agentResponses = latestResponseIds.get(runtime.agentId);
					if (!agentResponses) {
						agentResponses = new Map<string, string>();
						latestResponseIds.set(runtime.agentId, agentResponses);
					}

					const previousResponseId = agentResponses.get(message.roomId);
					if (previousResponseId) {
						logger.debug(
							{
								src: "service:message",
								roomId: message.roomId,
								previousResponseId,
								responseId,
							},
							"Updating response ID",
						);
					}
					agentResponses.set(message.roomId, responseId);

					// Start run tracking with roomId for proper log association
					const runId = runtime.startRun(message.roomId);
					if (!runId) {
						runtime.logger.error("Failed to start run tracking");
						return {
							didRespond: false,
							responseContent: null,
							responseMessages: [],
							state: { values: {}, data: {}, text: "" } as State,
							mode: "none",
						};
					}
					const startTime = Date.now();

					// Per-turn inference latency timer. Every stage (composeState,
					// useModel round-trips, the cloud HTTP fetch, evaluators) records
					// spans/marks onto this via the inference-timing ALS context; the
					// breakdown is emitted in the `finally` below. Off the hot path
					// when no one reads it (records are bounded + cheap).
					inferenceTimer = new InferenceTurnTimer({
						turnId: nextInferenceTurnId(),
						label: "message-turn",
						roomId: message.roomId,
						t0EpochMs: startTime,
					});

					// Emit run started event
					await runtime.emitEvent(EventType.RUN_STARTED, {
						runtime,
						source: "messageHandler",
						runId,
						messageId: message.id,
						roomId: message.roomId,
						entityId: message.entityId,
						startTime,
						status: "started",
					} as RunEventPayload);

					const timeoutPromise = new Promise<never>((_, reject) => {
						timeoutId = setTimeout(async () => {
							await runtime.emitEvent(EventType.RUN_TIMEOUT, {
								runtime,
								source: "messageHandler",
								runId,
								messageId: message.id,
								roomId: message.roomId,
								entityId: message.entityId,
								startTime,
								status: "timeout",
								endTime: Date.now(),
								duration: Date.now() - startTime,
								error: "Run exceeded timeout",
							} as RunEventPayload);
							reject(new Error("Run exceeded timeout"));
						}, opts.timeoutDuration);
					});

					// Structured streaming is handled by dynamicPromptExecFromState for
					// text fields. Native v5 planner/tool/evaluator events use the same
					// callback with JSON event chunks so UIs can render tool progress.
					// We build the context even when there's no onStreamChunk, as
					// long as we have an abortSignal to propagate — the runtime
					// reads `streamingContext.abortSignal` to plumb cancellation
					// into `runtime.useModel` calls.
					const streamingContext: StreamingContext | undefined =
						opts.onStreamChunk
							? {
									onStreamChunk: opts.onStreamChunk,
									messageId: responseId,
									...(opts.abortSignal
										? { abortSignal: opts.abortSignal }
										: {}),
									onToolCall: async (payload: StreamingToolCallPayload) => {
										await opts.onStreamChunk?.(
											JSON.stringify({ type: "tool_call", ...payload }),
											responseId,
										);
									},
									onToolResult: async (payload: StreamingToolResultPayload) => {
										await opts.onStreamChunk?.(
											JSON.stringify({ type: "tool_result", ...payload }),
											responseId,
										);
									},
									onEvaluation: async (payload: StreamingEvaluationPayload) => {
										await opts.onStreamChunk?.(
											JSON.stringify({ type: "evaluation", ...payload }),
											responseId,
										);
									},
									onContextEvent: async (
										payload: StreamingContextEventPayload,
									) => {
										await opts.onStreamChunk?.(
											JSON.stringify({ type: "context_event", event: payload }),
											responseId,
										);
									},
								}
							: opts.abortSignal
								? {
										// No stream callback but caller provided an abort
										// signal — install a no-op chunk handler so the
										// streaming-context plumbing carries the signal
										// down into `runtime.useModel`. The runtime never
										// invokes onStreamChunk when no streaming is happening.
										onStreamChunk: async () => undefined,
										messageId: responseId,
										abortSignal: opts.abortSignal,
									}
								: undefined;
					const processingPromise = runtime.turnControllers.runWith(
						message.roomId,
						(turnSignal) => {
							const abortSignal = mergeAbortSignals([
								opts.abortSignal,
								turnSignal,
							]);
							const scopedStreamingContext: StreamingContext | undefined =
								streamingContext
									? {
											...streamingContext,
											...(abortSignal ? { abortSignal } : {}),
										}
									: abortSignal
										? {
												onStreamChunk: async () => undefined,
												messageId: responseId,
												abortSignal,
											}
										: undefined;
							return runWithInferenceTiming(inferenceTimer, () =>
								runWithStreamingContext(scopedStreamingContext, () =>
									this.processMessage(
										runtime,
										message,
										instrumentedCallback,
										responseId,
										runId,
										startTime,
										opts,
									),
								),
							);
						},
					);

					const result = await Promise.race([
						processingPromise,
						timeoutPromise,
					]);

					// Clean up timeout
					clearTimeout(timeoutId);

					// Voice: Handle the rest of the message
					if (firstSentenceSent && result.responseContent?.text) {
						const fullText = result.responseContent.text;
						const rest = fullText.replace(firstSentenceText, "").trim();
						if (rest.length > 0) {
							// Generate voice for rest
							// (Async immediately)
							(async () => {
								try {
									const voiceSettings = runtime.character.settings?.voice as
										| {
												model?: string;
												url?: string;
												voiceId?: string;
										  }
										| undefined;
									const model = voiceSettings?.model || "en_US-male-medium";
									const voiceId =
										voiceSettings?.url || voiceSettings?.voiceId || "nova";

									let audioBuffer: Buffer | null = null;
									const params: TextToSpeechParams & {
										model?: string;
									} = {
										text: rest,
										voice: voiceId,
										model: model,
										...(opts.abortSignal ? { signal: opts.abortSignal } : {}),
									};
									const result = runtime.getModel(ModelType.TEXT_TO_SPEECH)
										? await runtime.useModel(ModelType.TEXT_TO_SPEECH, params)
										: undefined;
									if (
										result instanceof ArrayBuffer ||
										Object.prototype.toString.call(result) ===
											"[object ArrayBuffer]"
									) {
										audioBuffer = Buffer.from(result as ArrayBuffer);
									} else if (Buffer.isBuffer(result)) {
										audioBuffer = result;
									} else if (result instanceof Uint8Array) {
										audioBuffer = Buffer.from(result);
									}

									if (audioBuffer && instrumentedCallback) {
										const audioBase64 = audioBuffer.toString("base64");
										await instrumentedCallback({
											text: "",
											attachments: [
												{
													id: v4(),
													url: `data:audio/wav;base64,${audioBase64}`,
													title: "Voice Response",
													source: "voice",
													description: "Voice response for remaining text",
													text: rest,
													contentType: ContentType.AUDIO,
												},
											],
											source: "voice",
										});
									}
								} catch (error) {
									runtime.logger.error(
										{ error },
										"Error generating voice for remaining text",
									);
								}
							})();
						}
					}

					return result;
				} finally {
					clearTimeout(timeoutId);

					// Close + emit the per-turn latency breakdown. Detached side
					// effects (post-turn evaluators) intentionally run after this and
					// are NOT counted in turn latency — that is the proof they don't
					// stall the user-visible reply.
					emitInferenceTiming(inferenceTimer);

					// Ensure latestResponseIds is cleaned up even if processMessage
					// threw before reaching its own cleanup at the end of the method.
					clearLatestResponseId(runtime.agentId, message.roomId, responseId);
					if (message.id) {
						// Evict both per-turn stateCache entries for this message:
						// the action-results scratch key AND the base composed-state
						// key set by composeState (runtime.ts). Without deleting the
						// base key here it is only cleared when an
						// `incoming_before_compose` pipeline hook happens to be
						// registered, so in the common (no-hook) path the Map grew
						// unbounded — one stale State per processed message.
						runtime.stateCache.delete(`${message.id}_action_results`);
						runtime.stateCache.delete(message.id);
					}
				}
			},
		);
	}

	/**
	 * Internal message processing implementation
	 */
	private async processMessage(
		runtime: IAgentRuntime,
		message: Memory,
		callback: HandlerCallback | undefined,
		responseId: UUID,
		runId: UUID,
		startTime: number,
		opts: ResolvedMessageOptions,
	): Promise<MessageProcessingResult> {
		const agentResponses = latestResponseIds.get(runtime.agentId);
		if (!agentResponses) throw new Error("Agent responses map not found");

		// Skip messages from self (unless it's an autonomous message)
		const isAutonomousMessage =
			message.content?.metadata &&
			typeof message.content.metadata === "object" &&
			(message.content.metadata as Record<string, unknown>).isAutonomous ===
				true;

		if (message.entityId === runtime.agentId && !isAutonomousMessage) {
			runtime.logger.debug(
				{ src: "service:message", agentId: runtime.agentId },
				"Skipping message from self",
			);
			await this.emitRunEnded(runtime, runId, message, startTime, "self");
			return {
				didRespond: false,
				responseContent: null,
				responseMessages: [],
				state: { values: {}, data: {}, text: "" } as State,
				mode: "none",
			};
		}

		runtime.logger.debug(
			{
				src: "service:message",
				messagePreview: truncateToCompleteSentence(
					message.content.text || "",
					50,
				),
			},
			"Processing message",
		);

		// ── Save the incoming message to memory ────────────────────────────
		runtime.logger.debug(
			{ src: "service:message" },
			"Saving message to memory",
		);
		let memoryToQueue: Memory;

		if (message.id) {
			const existingMemory = await runtime.getMemoryById(message.id);
			if (existingMemory) {
				runtime.logger.debug(
					{ src: "service:message" },
					"Memory already exists, skipping creation",
				);
				memoryToQueue = existingMemory;
			} else {
				const createdMemoryId = await runtime.createMemory(message, "messages");
				memoryToQueue = { ...message, id: createdMemoryId };
			}
			await runtime.queueEmbeddingGeneration(memoryToQueue, "high");
		} else {
			const memoryId = await runtime.createMemory(message, "messages");
			message.id = memoryId;
			memoryToQueue = { ...message, id: memoryId };
			await runtime.queueEmbeddingGeneration(memoryToQueue, "normal");
		}

		// Check if LLM is off by default
		const agentUserState = await runtime.getParticipantUserState(
			message.roomId,
			runtime.agentId,
		);
		const defLllmOff = parseBooleanFromText(
			String(runtime.getSetting("BASIC_CAPABILITIES_DEFLLMOFF") || ""),
		);

		if (defLllmOff && agentUserState === null) {
			runtime.logger.debug({ src: "service:message" }, "LLM is off by default");
			await this.emitRunEnded(runtime, runId, message, startTime, "off");
			return {
				didRespond: false,
				responseContent: null,
				responseMessages: [],
				state: { values: {}, data: {}, text: "" } as State,
				mode: "none",
			};
		}

		// Effective mute check — room participant state, server-wide world mute,
		// and the timed-mute due-check — independent of any addressing logic. A
		// muted room drops even a direct @mention: on mention-gated deployments
		// (strict mode) every turn reaching this point IS a mention, so a
		// mention bypass here made mute a complete no-op. Unmuting a muted room
		// is done from another room (or DM) via the ROOM action's cross-room
		// targeting.
		const mentionContext = message.content.mentionContext;
		const explicitlyAddressesAgent = messageExplicitlyAddressesAgent(
			runtime,
			message,
		);
		const muteState = await resolveEffectiveMuteState(runtime, {
			roomIds: [message.roomId],
			primaryParticipantState: agentUserState,
			...(message.worldId ? { worldId: message.worldId } : {}),
		});
		if (muteState.muted) {
			runtime.logger.debug(
				{
					src: "service:message",
					roomId: message.roomId,
					scope: muteState.scope,
				},
				"Ignoring muted room",
			);
			await this.emitRunEnded(runtime, runId, message, startTime, "muted");
			return {
				didRespond: false,
				responseContent: null,
				responseMessages: [],
				state: { values: {}, data: {}, text: "" } as State,
				mode: "none",
			};
		}

		// PERSONALITY reply-gate enforcement. Short-circuits BEFORE the planner /
		// model call so a user who said "shut up" or "only when mentioned" does
		// NOT cost tokens this turn. Agent's own messages and autonomous turns
		// are not subject to the gate (already filtered above).
		const personalityStore = getPersonalityStore(runtime);
		if (personalityStore && message.entityId !== runtime.agentId) {
			const userSlot = personalityStore.getSlot(message.entityId);
			const globalSlot = personalityStore.getSlot("global");
			const gateDecision = decideReplyGate({
				userSlot,
				globalSlot,
				messageText: message.content?.text,
				explicitlyAddressesAgent,
			});
			if (gateDecision.allow === false) {
				runtime.logger.debug(
					{
						src: "service:message",
						roomId: message.roomId,
						reason: gateDecision.reason,
						gateMode: gateDecision.gateMode,
						gateScope: gateDecision.scope,
					},
					"Reply suppressed by personality reply_gate",
				);
				await this.emitRunEnded(
					runtime,
					runId,
					message,
					startTime,
					"personality_gate",
				);
				return {
					didRespond: false,
					responseContent: null,
					responseMessages: [],
					state: { values: {}, data: {}, text: "" } as State,
					mode: "none",
				};
			}
		}

		// Cheap-tier triage for unaddressed bot/webhook traffic. A relay channel
		// flooding automated embeds otherwise burns a full composeState + Stage 1
		// RESPONSE_HANDLER call (the most expensive model in the stack — on
		// subscription-backed providers ~1000 IGNOREs/day drain the daily session
		// budget and take the agent down) just to conclude IGNORE. Triage those
		// turns on TEXT_SMALL BEFORE state composition; an IGNORE verdict ends the
		// turn with zero large-tier calls. Addressed/human/private-channel turns
		// never enter this gate, and any triage failure falls open to the full
		// pipeline.
		const botNoiseTriage = await runBotNoiseTriage({
			runtime,
			message,
			explicitlyAddressesAgent,
		});
		if (botNoiseTriage.applied && !botNoiseTriage.respond) {
			runtime.logger.info(
				{
					src: "service:message",
					agentId: runtime.agentId,
					roomId: message.roomId,
					entityId: message.entityId,
				},
				"Unaddressed bot/webhook message ignored by small-model triage (skipped Stage 1)",
			);
			await this.emitRunEnded(
				runtime,
				runId,
				message,
				startTime,
				"bot_noise_triage",
			);
			return {
				didRespond: false,
				responseContent: null,
				responseMessages: [],
				state: { values: {}, data: {}, text: "" } as State,
				mode: "none",
			};
		}

		// Room context for shouldRespond (fetch before compose so providers see
		// post-attachment and post-incoming-hook message state).
		const room = await runtime.getRoom(message.roomId);

		// Process attachments before state composition / incoming hooks
		if (message.content.attachments && message.content.attachments.length > 0) {
			message.content.attachments = await this.processAttachments(
				runtime,
				message.content.attachments,
			);
			if (message.id) {
				await runtime.updateMemory({
					id: message.id,
					content: {
						...message.content,
						attachments: sanitizeAttachmentsForStorage(
							message.content.attachments,
						),
					},
				});
			}
		}

		const preIncomingHookText =
			typeof message.content?.text === "string" ? message.content.text : "";

		await runtime.applyPipelineHooks(
			"incoming_before_compose",
			incomingPipelineHookContext(message, {
				roomId: message.roomId,
				responseId,
				runId,
			}),
		);

		const postIncomingHookText =
			typeof message.content?.text === "string" ? message.content.text : "";

		if (message.id && postIncomingHookText !== preIncomingHookText) {
			await runtime.updateMemory({
				id: message.id,
				content: message.content,
			});
			await runtime.queueEmbeddingGeneration(
				{ ...message, id: message.id },
				"normal",
			);
		}

		// Compose initial state (after incoming hooks so providers/actions text matches this turn)
		let state = await composeResponseState(runtime, message);
		state = attachAvailableContexts(state, runtime);

		const metadata =
			typeof message.content.metadata === "object" &&
			message.content.metadata !== null
				? (message.content.metadata as Record<string, unknown>)
				: null;
		const isAutonomous = metadata?.isAutonomous === true;
		const autonomyMode =
			typeof metadata?.autonomyMode === "string" ? metadata.autonomyMode : null;

		await runtime.applyPipelineHooks(
			"pre_should_respond",
			preShouldRespondPipelineHookContext(message, {
				roomId: message.roomId,
				responseId,
				runId,
				state,
				isAutonomous,
			}),
		);

		let shouldRespondToMessage = true;
		let terminalDecision: "IGNORE" | "STOP" | null = null;
		let routedDecision: ContextRoutingDecision | null = null;
		let strategyResult: StrategyResult | null = null;
		let _usedV5Runtime = false;
		const earlyReplyMessages: Memory[] = [];
		const persistedEarlyReplyIds = new Set<string>();
		const voiceResponseHandlerFastPath = isVoiceChannelMessage(message);
		// Canonicalize the resolved speaker (imprint → entityId) onto
		// `content.metadata.speakerEntityId` for every voice turn that carries one
		// (#8786). Attribution can arrive top-level (in-process engine) or nested
		// (chat clients); collapsing to one spot lets providers/extraction and the
		// facts/relationships stage attribute the turn to the right person.
		if (voiceResponseHandlerFastPath && message.content) {
			const speakerEntityId = getVoiceSpeakerEntityId(message);
			if (speakerEntityId) {
				const md =
					message.content.metadata &&
					typeof message.content.metadata === "object" &&
					!Array.isArray(message.content.metadata)
						? (message.content.metadata as Record<string, unknown>)
						: {};
				if (md.speakerEntityId !== speakerEntityId) {
					message.content.metadata = { ...md, speakerEntityId };
				}
			}
		}
		const deliverResponseHandlerEarlyReply = voiceResponseHandlerFastPath
			? async (event: ResponseHandlerEarlyReplyEvent): Promise<void> => {
					const text = event.text.trim();
					if (!text || !message.id) return;
					const currentResponseId = latestResponseIds
						.get(runtime.agentId)
						?.get(message.roomId);
					if (currentResponseId !== responseId && !opts.keepExistingResponses) {
						runtime.logger.info(
							{
								src: "service:message",
								agentId: runtime.agentId,
								roomId: message.roomId,
								responseId,
								currentResponseId,
							},
							"Response-handler early voice reply discarded - newer message being processed",
						);
						return;
					}
					if (getStreamingContext()?.abortSignal?.aborted) {
						return;
					}
					const earlyResponseId = asUUID(v4());
					const earlyContent: Content = {
						thought: event.messageHandler.thought,
						actions: ["REPLY"],
						text,
						responseId: earlyResponseId,
						inReplyTo: createUniqueUuid(runtime, message.id),
					};
					await runtime.applyPipelineHooks(
						"outgoing_before_deliver",
						outgoingPipelineHookContext(earlyContent, {
							source: "response-handler",
							roomId: message.roomId,
							message,
							responseId: earlyResponseId,
						}),
					);
					const earlyMemory: Memory = {
						id: earlyResponseId,
						entityId: runtime.agentId,
						agentId: runtime.agentId,
						content: earlyContent,
						roomId: message.roomId,
						createdAt: Date.now(),
					};
					await runtime.createMemory(earlyMemory, "messages");
					await this.emitMessageSent(
						runtime,
						earlyMemory,
						message.content.source ?? "messageHandler",
					);
					earlyReplyMessages.push(earlyMemory);
					persistedEarlyReplyIds.add(earlyResponseId);
					if (callback) {
						await callback(earlyContent);
					}
				}
			: undefined;

		const parallelJoin: { translatedUserText?: string } = {};
		const setTranslatedUserText = (text: string) => {
			parallelJoin.translatedUserText = text;
		};
		const parallelHookCtx = parallelWithShouldRespondPipelineHookContext({
			roomId: message.roomId,
			responseId,
			runId,
			message,
			state,
			room: room ?? undefined,
			mentionContext,
			isAutonomous,
			setTranslatedUserText,
		});

		// #8791: pre-LLM action shortcut gate runs FIRST — before the planner or
		// model call. An explicit slash/`!` command (always-on) or a
		// confident natural-language shortcut resolves to a deterministic action
		// reply with zero inference. Placed here (ahead of the pre-LLM
		// conditional v5 stage) so a slash command can
		// never be pre-empted by another handler.
		if (!strategyResult) {
			const shortcutSenderRole = await resolveStage1SenderRole(
				runtime,
				message,
			);
			const shortcutOutcome = await runShortcutGate({
				runtime,
				message,
				state,
				responseId,
				senderRole: shortcutSenderRole,
			});
			if (shortcutOutcome && shortcutOutcome.kind === "direct_reply") {
				strategyResult = shortcutOutcome.result;
				_usedV5Runtime = true;
				runtime.logger?.debug?.(
					{ src: "service:message", agentId: runtime.agentId },
					"Message resolved via pre-LLM shortcut gate",
				);
			}
		}

		if (!strategyResult && hasTextGenerationHandler(runtime)) {
			if (isAutonomous) {
				runtime.logger.debug(
					{ src: "service:message", autonomyMode },
					"Autonomy message using v5 messageHandler/planner runtime",
				);
			}
			try {
				const [outcome] = await Promise.all([
					runV5MessageRuntimeStage1({
						runtime,
						message,
						state,
						responseId,
						...(callback ? { callback } : {}),
						onResponseHandlerEarlyReply: deliverResponseHandlerEarlyReply,
					}),
					runtime.applyPipelineHooks(
						"parallel_with_should_respond",
						parallelHookCtx,
					),
				]);
				const routedContexts = outcome.messageHandler.plan.contexts;
				routedDecision =
					routedContexts.length > 0
						? {
								primaryContext: routedContexts[0],
								secondaryContexts: routedContexts.slice(1),
							}
						: {};
				setContextRoutingMetadata(message, routedDecision);

				if (outcome.kind === "terminal") {
					shouldRespondToMessage = false;
					terminalDecision = outcome.action;
					state = outcome.state;
				} else {
					shouldRespondToMessage = true;
					terminalDecision = null;
					strategyResult = outcome.result;
					_usedV5Runtime = true;
					state = outcome.result.state;
				}
			} catch (error) {
				if (
					error instanceof TurnAbortedError ||
					(isRecord(error) && error.code === "TURN_ABORTED")
				) {
					throw error;
				}
				const errMsg = error instanceof Error ? error.message : String(error);
				const errStack = error instanceof Error ? error.stack : undefined;
				runtime.logger.warn(
					{
						src: "service:message",
						agentId: runtime.agentId,
						error: errMsg,
						stack: errStack,
					},
					"v5 message runtime failed",
				);
				// Mirror to process.stderr so bench / orchestrator runs can see
				// the underlying cause when runtime.logger output is buffered or
				// silenced. The previous behavior swallowed the stack and only
				// the user-facing "something flaked" template appeared in
				// trajectories — making the cold-start failure-fallback issue
				// invisible in bench server logs.
				try {
					process.stderr.write(
						`[v5-runtime-failed] agentId=${runtime.agentId} ` +
							`error=${errMsg}\n${errStack ?? ""}\n`,
					);
				} catch {
					// stderr write must never throw the runtime.
				}
				// Rate limits and provider outages throw from the Stage 1 model
				// call itself — before any RESPOND/IGNORE decision exists. For
				// ambiguous group traffic the pre-failure outcome would have been
				// IGNORE, so an unconditional failure reply spams rooms that never
				// addressed the agent (observed live: 91 canned-failure sends in
				// 2 days into relay rooms during a rate-limit window). Surface
				// failure text only when the turn deterministically addressed the
				// agent (DM/API/SELF channel, platform mention/reply, whitelisted
				// source, name+tag address), the turn is autonomous, or an early
				// ack already went out (the user saw the bot engage). Everything
				// else stays silent, matching the IGNORE it would have gotten.
				const failureGate = this.shouldRespond(
					runtime,
					message,
					room ?? undefined,
					mentionContext,
				);
				const addressedForFailureReply =
					failureGate.shouldRespond ||
					mentionContext?.isMention === true ||
					mentionContext?.isReply === true ||
					isAutonomous ||
					earlyReplyMessages.length > 0;
				if (addressedForFailureReply) {
					shouldRespondToMessage = true;
					terminalDecision = null;
					strategyResult = await this.buildStructuredFailureReply(
						runtime,
						message,
						state,
						responseId,
						"running the native tool message runtime",
					);
					_usedV5Runtime = true;
					state = strategyResult.state;
				} else {
					runtime.logger.info(
						{
							src: "service:message",
							agentId: runtime.agentId,
							roomId: message.roomId,
							reason: failureGate.reason,
						},
						"v5 runtime failed before a respond decision on an unaddressed message; suppressing failure reply",
					);
					shouldRespondToMessage = false;
					terminalDecision = "IGNORE";
				}
			}
		} else if (!hasTextGenerationHandler(runtime)) {
			await runtime.applyPipelineHooks(
				"parallel_with_should_respond",
				parallelHookCtx,
			);
			// Without a text delegate, apply only deterministic gates. Ambiguous
			// group traffic that needs model judgment must not auto-reply with
			// NO_LLM_PROVIDER_REPLY.
			const checkShouldRespondEnabled = runtime.isCheckShouldRespondEnabled();
			const responseDecision = this.shouldRespond(
				runtime,
				message,
				room ?? undefined,
				mentionContext,
			);
			if (!checkShouldRespondEnabled) {
				routedDecision = withInferredContextRoutingFallback({}, message);
				setContextRoutingMetadata(message, routedDecision);
				shouldRespondToMessage = true;
			} else if (responseDecision.skipEvaluation) {
				routedDecision = withInferredContextRoutingFallback(
					parseContextRoutingMetadata(responseDecision),
					message,
				);
				setContextRoutingMetadata(message, routedDecision);
				shouldRespondToMessage = responseDecision.shouldRespond;
			} else {
				runtime.logger.debug(
					{
						src: "service:message",
						agentId: runtime.agentId,
						reason: responseDecision.reason,
					},
					"No text-generation handler: skipping message that requires LLM should-respond",
				);
				shouldRespondToMessage = false;
			}
			terminalDecision = null;
			if (shouldRespondToMessage) {
				strategyResult = this.buildNoModelProviderReply(
					runtime,
					message,
					state,
					responseId,
					"v5 message handling",
				);
				_usedV5Runtime = true;
			}
		}

		// #9949: role-keyed injection / social-engineering verify gate. The
		// deterministic RiskFactors were stamped during the
		// parallel_with_should_respond phase; here — and only when we are about
		// to respond — escalate a borderline USER/GUEST message to a single
		// TEXT_LARGE adjudication. OWNER/ADMIN bypass; benign traffic short-circuits
		// before any model call. A blocked verdict suppresses the response.
		if (shouldRespondToMessage) {
			const injectionGate = await runShouldRespondInjectionGate({
				runtime,
				message,
				resolveSenderRole: () => resolveStage1SenderRole(runtime, message),
			});
			if (injectionGate.blocked) {
				shouldRespondToMessage = false;
				terminalDecision = null;
				strategyResult = null;
				runtime.logger.warn(
					{
						src: "service:message",
						agentId: runtime.agentId,
						reason: injectionGate.reason,
						score: injectionGate.score,
					},
					"[ShouldRespondRiskGate] suppressing response: injection/social-engineering verify blocked",
				);
			}
		}

		const joinedTranslation =
			typeof parallelJoin.translatedUserText === "string"
				? parallelJoin.translatedUserText
				: undefined;
		if (
			joinedTranslation !== undefined &&
			joinedTranslation !== message.content.text
		) {
			message.content.text = joinedTranslation;
			if (message.id) {
				await runtime.updateMemory({
					id: message.id,
					content: message.content,
				});
				await runtime.queueEmbeddingGeneration(
					{ ...message, id: message.id },
					"normal",
				);
			}
			if (message.id) {
				runtime.stateCache.delete(message.id);
				runtime.stateCache.delete(`${message.id}_action_results`);
			}
			state = await composeResponseState(runtime, message);
			state = attachAvailableContexts(state, runtime);
		}

		let responseContent: Content | null = null;
		let responseMessages: Memory[] = [];
		let mode: StrategyMode = "none";
		let simpleReplyDelivered = false;

		if (shouldRespondToMessage) {
			let result: StrategyResult;
			if (strategyResult) {
				result = strategyResult;
			} else {
				_usedV5Runtime = true;
				result = await this.buildStructuredFailureReply(
					runtime,
					message,
					state,
					responseId,
					"running the native tool message runtime",
				);
			}

			responseContent = result.responseContent;
			responseMessages =
				earlyReplyMessages.length > 0
					? [...earlyReplyMessages, ...result.responseMessages]
					: result.responseMessages;
			state = result.state;
			mode = result.mode;

			// Race check before we send anything.
			//
			// When a newer message arrives in the same room while we were
			// generating a response, the default behavior is to drop the older
			// response so the bot only replies to the freshest input.
			//
			// Exception: keep the response when the planner picked an explicit
			// REPLY/RESPOND action. That's a deliberate conversational signal
			// (often a direct @-mention) and dropping it leaves the user looking
			// at silence on a tagged message, which the character contract
			// treats as a bug. The newer message will get its own turn through
			// the normal pipeline; sending the older REPLY first does not
			// duplicate either response.
			const currentResponseId = agentResponses.get(message.roomId);
			if (currentResponseId !== responseId && !opts.keepExistingResponses) {
				if (hasExplicitReplyIntent(responseContent)) {
					runtime.logger.info(
						{
							src: "service:message",
							agentId: runtime.agentId,
							roomId: message.roomId,
						},
						"Race detected but keeping response (explicit REPLY for an addressed message)",
					);
				} else {
					runtime.logger.info(
						{
							src: "service:message",
							agentId: runtime.agentId,
							roomId: message.roomId,
						},
						"Response discarded - newer message being processed",
					);
					return {
						didRespond: false,
						responseContent: null,
						responseMessages: [],
						state,
						mode: "none",
					};
				}
			}

			if (responseContent && message.id) {
				responseContent.inReplyTo = createUniqueUuid(runtime, message.id);
			}

			// Save response memory to database.
			// - simple mode: persists after hooks in the branch below.
			// - actions mode: do NOT persist the initial LLM text here.
			//   The action callbacks produce the real user-facing messages;
			//   saving the planner text now would emit a premature reply that
			//   may be contradicted once the action completes or fails.
			// - other non-simple modes (e.g. "none"): persist immediately.
			if (
				responseMessages.length > 0 &&
				mode !== "simple" &&
				mode !== "actions"
			) {
				for (const responseMemory of responseMessages) {
					if (
						responseMemory.id &&
						persistedEarlyReplyIds.has(responseMemory.id)
					) {
						continue;
					}
					// Update the content in case inReplyTo was added
					if (responseContent) {
						responseMemory.content = responseContent;
					}
					if (shouldSkipResponseMemoryPersistence(responseMemory)) {
						runtime.logger.debug(
							{ src: "service:message", memoryId: responseMemory.id },
							"Skipping transient response memory persistence",
						);
						continue;
					}
					runtime.logger.debug(
						{ src: "service:message", memoryId: responseMemory.id },
						"Saving response to memory",
					);
					await runtime.createMemory(responseMemory, "messages");

					await this.emitMessageSent(
						runtime,
						responseMemory,
						message.content.source ?? "messageHandler",
					);
				}
			}

			if (responseContent) {
				if (mode === "simple") {
					// Keep content hooks and DB write before delivery so the wire
					// response and stored memory match. Do not put MESSAGE_SENT
					// handlers or post-turn evaluators before the callback; they are
					// side effects and must not stall user-visible streaming.
					await runtime.applyPipelineHooks(
						"outgoing_before_deliver",
						outgoingPipelineHookContext(responseContent, {
							source: "simple",
							roomId: message.roomId,
							message,
							responseId: responseContent.responseId ?? responseMessages[0]?.id,
						}),
					);
					if (responseMessages.length > 0) {
						for (const responseMemory of responseMessages) {
							if (
								responseMemory.id &&
								persistedEarlyReplyIds.has(responseMemory.id)
							) {
								continue;
							}
							if (responseContent) {
								responseMemory.content = responseContent;
							}
							if (shouldSkipResponseMemoryPersistence(responseMemory)) {
								runtime.logger.debug(
									{ src: "service:message", memoryId: responseMemory.id },
									"Skipping transient response memory persistence",
								);
								continue;
							}
							runtime.logger.debug(
								{ src: "service:message", memoryId: responseMemory.id },
								"Saving response to memory",
							);
							await runtime.createMemory(responseMemory, "messages");

							detachPostDeliverySideEffect(runtime, "MESSAGE_SENT", () =>
								this.emitMessageSent(
									runtime,
									responseMemory,
									message.content.source ?? "messageHandler",
								),
							);
						}
					}
					if (callback) {
						if (responseContent) {
							await callback(responseContent);
							simpleReplyDelivered = true;
							markInference(INFERENCE_MARKS.replyDelivered);
						}
					}
				}
			}
		} else {
			// Agent decided not to respond
			runtime.logger.debug(
				{ src: "service:message" },
				"Agent decided not to respond",
			);

			// Check if we still have the latest response ID
			const currentResponseId = agentResponses.get(message.roomId);

			if (currentResponseId !== responseId && !opts.keepExistingResponses) {
				runtime.logger.info(
					{
						src: "service:message",
						agentId: runtime.agentId,
						roomId: message.roomId,
					},
					"Ignore response discarded - newer message being processed",
				);
				await this.emitRunEnded(runtime, runId, message, startTime, "replaced");
				return {
					didRespond: false,
					responseContent: null,
					responseMessages: [],
					state,
					mode: "none",
				};
			}

			if (!message.id) {
				runtime.logger.error(
					{ src: "service:message", agentId: runtime.agentId },
					"Message ID is missing, cannot create ignore response",
				);
				await this.emitRunEnded(
					runtime,
					runId,
					message,
					startTime,
					"noMessageId",
				);
				return {
					didRespond: false,
					responseContent: null,
					responseMessages: [],
					state,
					mode: "none",
				};
			}

			// Construct a minimal content object indicating the terminal decision
			const terminalAction = terminalDecision ?? "IGNORE";
			const terminalContent: Content = {
				thought:
					terminalAction === "STOP"
						? "Agent decided to stop and end the run."
						: "Agent decided not to respond to this message.",
				actions: [terminalAction],
				inReplyTo: createUniqueUuid(runtime, message.id),
			};

			await runtime.applyPipelineHooks(
				"outgoing_before_deliver",
				outgoingPipelineHookContext(terminalContent, {
					source: "excluded",
					roomId: message.roomId,
					message,
				}),
			);

			const terminalMemory: Memory = {
				id: asUUID(v4()),
				entityId: runtime.agentId,
				agentId: runtime.agentId,
				content: terminalContent,
				roomId: message.roomId,
				createdAt: Date.now(),
			};
			await runtime.createMemory(terminalMemory, "messages");
			await this.emitMessageSent(
				runtime,
				terminalMemory,
				message.content.source ?? "messageHandler",
			);
			runtime.logger.debug(
				{ src: "service:message", memoryId: terminalMemory.id },
				"Saved terminal response to memory",
			);

			if (
				callback &&
				!(terminalAction === "IGNORE" && isVoiceChannelMessage(message))
			) {
				await callback(terminalContent);
			}
		}

		// Clean up the response ID
		clearLatestResponseId(runtime.agentId, message.roomId, responseId);

		// Post-turn evaluation runs first as one structured call over registered
		// evaluator items. ALWAYS_AFTER actions remain available for plugin hooks
		// that are not part of the unified evaluator service.
		const didRespondGate =
			shouldRespondToMessage && !isStopResponse(responseContent);
		if (simpleReplyDelivered) {
			void (async () => {
				await runPostDeliverySideEffect(runtime, "post_turn_evaluators", () =>
					runPostTurnEvaluators(runtime, message, state, {
						didRespond: didRespondGate,
						responses: responseMessages,
					}),
				);
				await runPostDeliverySideEffect(runtime, "ALWAYS_AFTER", () =>
					runtime.runActionsByMode("ALWAYS_AFTER", message, state, {
						didRespond: didRespondGate,
						responses: responseMessages,
					}),
				);
			})();
		} else {
			await runPostTurnEvaluators(runtime, message, state, {
				didRespond: didRespondGate,
				responses: responseMessages,
			});
			await runtime.runActionsByMode("ALWAYS_AFTER", message, state, {
				didRespond: didRespondGate,
				responses: responseMessages,
			});
		}

		const didRespond =
			responseMessages.length > 0 && !isStopResponse(responseContent);

		// Collect metadata for logging
		let entityName = "noname";
		if (
			message.metadata &&
			"entityName" in message.metadata &&
			typeof message.metadata.entityName === "string"
		) {
			entityName = message.metadata.entityName;
		}

		const isDM =
			message.content && message.content.channelType === ChannelType.DM;
		let roomName = entityName;

		if (!isDM) {
			const roomDatas = await runtime.getRoomsByIds([message.roomId]);
			if (roomDatas?.length) {
				const roomData = roomDatas[0];
				if (roomData.name) {
					roomName = roomData.name;
				}
				if (roomData.worldId) {
					const worldData = await runtime.getWorld(roomData.worldId);
					if (worldData) {
						roomName = `${worldData.name}-${roomName}`;
					}
				}
			}
		}

		const date = new Date();
		// Extract available actions from provider data
		const stateData = state.data;
		const stateDataProviders = stateData?.providers;
		const actionsProvider = stateDataProviders?.ACTIONS;
		const actionsProviderData = actionsProvider?.data;
		const actionsData =
			actionsProviderData && "actionsData" in actionsProviderData
				? (actionsProviderData.actionsData as Array<{ name: string }>)
				: undefined;
		const availableActions = actionsData?.map((a) => a.name) ?? [];

		const _logData = {
			at: date.toString(),
			timestamp: Math.floor(date.getTime() / 1000),
			messageId: message.id,
			userEntityId: message.entityId,
			input: message.content.text,
			thought: responseContent?.thought,
			availableActions,
			actions: responseContent?.actions,
			providers: responseContent?.providers,
			irt: responseContent?.inReplyTo,
			output: responseContent?.text,
			entityName,
			source: message.content.source,
			channelType: message.content.channelType,
			roomName,
		};

		// Emit run ended event
		await runtime.emitEvent(EventType.RUN_ENDED, {
			runtime,
			source: "messageHandler",
			runId,
			messageId: message.id,
			roomId: message.roomId,
			entityId: message.entityId,
			startTime,
			status: "completed",
			endTime: Date.now(),
			duration: Date.now() - startTime,
		} as RunEventPayload);

		return {
			didRespond,
			responseContent,
			responseMessages,
			state,
			mode,
		};
	}

	/**
	 * Determines whether the agent should respond to a message.
	 * Uses simple rules for obvious cases (DM, mentions) and defers to LLM for ambiguous cases.
	 */
	shouldRespond(
		runtime: IAgentRuntime,
		message: Memory,
		room?: Room,
		mentionContext?: MentionContext,
	): ContextRoutedResponseDecision {
		if (!room) {
			return {
				shouldRespond: false,
				skipEvaluation: true,
				reason: "no room context",
			};
		}

		function normalizeEnvList(value: unknown): string[] {
			if (!value || typeof value !== "string") return [];
			const cleaned = value.trim().replace(/^\[|\]$/g, "");
			return cleaned
				.split(",")
				.map((v) => v.trim())
				.filter(Boolean);
		}

		// Channel types that always trigger a response (private channels)
		const alwaysRespondChannels = [
			ChannelType.DM,
			ChannelType.VOICE_DM,
			ChannelType.SELF,
			ChannelType.API,
		];

		// Sources that always trigger a response
		const alwaysRespondSources = [MESSAGE_SOURCE_CLIENT_CHAT];

		// Support runtime-configurable overrides via env settings
		const customChannels = normalizeEnvList(
			runtime.getSetting("ALWAYS_RESPOND_CHANNELS") ??
				runtime.getSetting("SHOULD_RESPOND_BYPASS_TYPES"),
		);
		const customSources = normalizeEnvList(
			runtime.getSetting("ALWAYS_RESPOND_SOURCES") ??
				runtime.getSetting("SHOULD_RESPOND_BYPASS_SOURCES"),
		);

		const respondChannels = new Set(
			[
				...alwaysRespondChannels.map((t) => t.toString()),
				...customChannels,
			].map((s: string) => s.trim().toLowerCase()),
		);

		const respondSources = [...alwaysRespondSources, ...customSources].map(
			(s: string) => s.trim().toLowerCase(),
		);

		const roomType = room.type?.toString().toLowerCase();
		const sourceStr = message.content.source?.toLowerCase() || "";
		const textMentionsAgentByName = textContainsAgentName(
			message.content.text,
			[runtime.character.name, runtime.character.username],
		);
		const textMentionsTaggedParticipants = textContainsUserTag(
			message.content.text,
		);

		// 1. DM/VOICE_DM/API channels: always respond (private channels)
		if (respondChannels.has(roomType)) {
			return {
				shouldRespond: true,
				skipEvaluation: true,
				reason: `private channel: ${roomType}`,
			};
		}

		// 2. Specific sources (e.g., client_chat): always respond
		if (respondSources.some((pattern) => sourceStr.includes(pattern))) {
			return {
				shouldRespond: true,
				skipEvaluation: true,
				reason: `whitelisted source: ${sourceStr}`,
			};
		}

		// 3. Platform mentions and replies: always respond
		const hasPlatformMention = !!(
			mentionContext?.isMention || mentionContext?.isReply
		);
		if (hasPlatformMention) {
			const mentionType = mentionContext?.isMention ? "mention" : "reply";
			return {
				shouldRespond: true,
				skipEvaluation: true,
				reason: `platform ${mentionType}`,
			};
		}

		// 4. Mixed-address messages should still reach the agent when the text
		// explicitly names it alongside other tagged participants.
		if (textMentionsTaggedParticipants && textMentionsAgentByName) {
			return {
				shouldRespond: true,
				skipEvaluation: true,
				reason: "text address with tagged participants",
			};
		}

		// 5. All other cases are ambiguous enough to need the classifier.
		// Lack of a platform mention is not proof the message isn't directed
		// at the agent in a fast-moving group conversation.
		return {
			shouldRespond: false,
			skipEvaluation: false,
			reason: textMentionsAgentByName
				? "agent named in text requires LLM evaluation"
				: "needs LLM evaluation",
			primaryContext: "general",
		};
	}

	/**
	 * Processes attachments by generating descriptions for supported media types.
	 */
	async processAttachments(
		runtime: IAgentRuntime,
		attachments: Media[],
	): Promise<Media[]> {
		if (!attachments || attachments.length === 0) {
			return [];
		}
		runtime.logger.debug(
			{ src: "service:message", count: attachments.length },
			"Processing attachments",
		);

		const processedAttachments = await Promise.all(
			attachments.map(async (attachment) => {
				const processedAttachment: Media = { ...attachment };

				const isRemote = /^(http|https):\/\//.test(attachment.url);
				const url = isRemote
					? attachment.url
					: getLocalServerUrl(attachment.url);

				try {
					// Only process images that don't already have descriptions
					if (
						attachment.contentType === ContentType.IMAGE &&
						!attachment.description
					) {
						// Skip image analysis when vision / image-description is explicitly
						// disabled (e.g. the user toggled the Vision capability off).
						const disableImageDesc = runtime.getSetting(
							"DISABLE_IMAGE_DESCRIPTION",
						);
						if (disableImageDesc === true || disableImageDesc === "true") {
							return processedAttachment;
						}

						runtime.logger.debug(
							{ src: "service:message", imageUrl: attachment.url },
							"Generating image description",
						);

						let imageUrl = url;
						const inlineData = attachment as MediaWithInlineData;

						if (
							typeof inlineData._data === "string" &&
							inlineData._data.trim() &&
							typeof inlineData._mimeType === "string" &&
							inlineData._mimeType.trim()
						) {
							imageUrl = `data:${inlineData._mimeType};base64,${inlineData._data}`;
						} else {
							// Inline the bytes as a data URL so the vision model never fetches
							// an attacker-controlled URL itself. Remote bytes go through the
							// SSRF-guarded fetcher (blocks private/loopback hosts); local
							// media-store URLs use the trusted runtime fetch.
							const { buffer, contentType } = await this.fetchAttachmentBytes(
								runtime,
								attachment.url,
								url,
								isRemote,
							);
							imageUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
						}

						// Describe via the shared content-addressed cache: identical image
						// bytes reuse one stored description across messages and across the
						// other describe paths (read action, basic-capabilities helper)
						// instead of re-invoking the vision model every turn.
						const resolvedImagePrompt = resolveOptimizedPromptForRuntime(
							runtime,
							"media_description",
							imageDescriptionTemplate,
						);
						const described = await describeImageCached(
							runtime,
							imageUrl,
							resolvedImagePrompt,
						);
						if (described) {
							processedAttachment.description = described.description;
							processedAttachment.title = described.title || "Image";
							processedAttachment.text = described.text;
							runtime.logger.debug(
								{
									src: "service:message",
									descriptionPreview: described.description?.substring(0, 100),
								},
								"Generated image description",
							);
						} else {
							processedAttachment.notProcessed =
								"Image description unavailable (vision backend returned no result)";
							runtime.logger.warn(
								{ src: "service:message" },
								"Image description unavailable for attachment",
							);
						}
					} else if (
						attachment.contentType === ContentType.DOCUMENT &&
						!attachment.text
					) {
						const { buffer, contentType } = await this.fetchAttachmentBytes(
							runtime,
							attachment.url,
							url,
							isRemote,
						);
						// Any text/* document (plain, csv, markdown) and application/json —
						// all on the chat upload allow-list — is readable as UTF-8 text;
						// PDFs are extracted via unpdf. Previously only text/plain was
						// handled, so csv/markdown/pdf were skipped and never seen by the
						// agent (#10714).
						const isText =
							contentType.startsWith("text/") ||
							contentType.startsWith("application/json");
						const isPdf = contentType.startsWith("application/pdf");

						if (isText) {
							runtime.logger.debug(
								{ src: "service:message", documentUrl: attachment.url },
								"Processing text document",
							);

							const textContent = buffer.toString("utf8");
							processedAttachment.text = textContent;
							processedAttachment.title =
								processedAttachment.title || "Text File";

							runtime.logger.debug(
								{
									src: "service:message",
									textPreview: processedAttachment.text?.substring(0, 100),
								},
								"Extracted text content",
							);
						} else if (isPdf) {
							const { convertPdfToTextFromBuffer } = await import(
								"../features/documents/utils.ts"
							);
							const textContent = await convertPdfToTextFromBuffer(
								buffer,
								processedAttachment.title ?? undefined,
							);
							processedAttachment.text = textContent;
							processedAttachment.title =
								processedAttachment.title || "PDF Document";

							runtime.logger.debug(
								{
									src: "service:message",
									textLength: textContent.length,
									textPreview: textContent.substring(0, 100),
								},
								"Extracted PDF text content",
							);
						} else {
							processedAttachment.notProcessed = `Unsupported document type (${contentType}); stored but text not extracted`;
							runtime.logger.warn(
								{ src: "service:message", contentType },
								"Skipping unsupported document type",
							);
						}
					} else if (
						attachment.contentType === ContentType.AUDIO &&
						!attachment.text
					) {
						runtime.logger.debug(
							{ src: "service:message", audioUrl: attachment.url },
							"Transcribing audio attachment",
						);

						try {
							// Fetch the bytes (remote → SSRF-guarded, size-capped) and pass
							// the buffer to the transcription model so it never fetches an
							// attacker-controlled URL itself.
							const { buffer } = await this.fetchAttachmentBytes(
								runtime,
								attachment.url,
								url,
								isRemote,
							);

							const transcript = await runtime.useModel(
								ModelType.TRANSCRIPTION,
								buffer,
							);

							if (typeof transcript === "string" && transcript.trim()) {
								processedAttachment.text = transcript.trim();
								processedAttachment.title =
									processedAttachment.title || "Audio";
								processedAttachment.description = `Transcript: ${transcript.trim()}`;

								runtime.logger.debug(
									{
										src: "service:message",
										transcriptPreview: processedAttachment.text?.substring(
											0,
											100,
										),
									},
									"Transcribed audio attachment",
								);
							} else {
								processedAttachment.notProcessed =
									"Audio transcription returned no text (empty or no speech detected)";
							}
						} catch (err) {
							processedAttachment.notProcessed = `Audio transcription unavailable: ${err instanceof Error ? err.message : String(err)}`;
							runtime.logger.warn(
								{ src: "service:message", err },
								"Audio transcription failed, continuing without transcript",
							);
						}
					} else if (
						attachment.contentType === ContentType.VIDEO &&
						!attachment.text
					) {
						runtime.logger.debug(
							{ src: "service:message", videoUrl: attachment.url },
							"Transcribing video attachment",
						);

						try {
							// Fetch the bytes (remote → SSRF-guarded, size-capped) and pass
							// the buffer to the transcription model so it never fetches an
							// attacker-controlled URL itself.
							const { buffer } = await this.fetchAttachmentBytes(
								runtime,
								attachment.url,
								url,
								isRemote,
							);

							const transcript = await runtime.useModel(
								ModelType.TRANSCRIPTION,
								buffer,
							);

							if (typeof transcript === "string" && transcript.trim()) {
								processedAttachment.text = transcript.trim();
								processedAttachment.title =
									processedAttachment.title || "Video";
								processedAttachment.description = `Transcript: ${transcript.trim()}`;

								runtime.logger.debug(
									{
										src: "service:message",
										transcriptPreview: processedAttachment.text?.substring(
											0,
											100,
										),
									},
									"Transcribed video attachment",
								);
							} else {
								processedAttachment.notProcessed =
									"Video transcription returned no text (empty or no speech detected)";
							}
						} catch (err) {
							processedAttachment.notProcessed = `Video transcription unavailable: ${err instanceof Error ? err.message : String(err)}`;
							runtime.logger.warn(
								{ src: "service:message", err },
								"Video transcription failed, continuing without transcript",
							);
						}
					}

					return processedAttachment;
				} catch (err) {
					// One bad attachment must never drop the others or the message text.
					// Degrade to the un-enriched attachment (marking remote ones
					// ephemeral so the UI can offer a retry) and keep processing.
					runtime.logger.warn(
						{ src: "service:message", url: attachment.url, err },
						"Attachment processing failed; keeping un-enriched attachment",
					);
					return {
						...attachment,
						ephemeral: isRemote ? true : attachment.ephemeral,
					};
				}
			}),
		);

		return processedAttachments;
	}

	/**
	 * Fetch an attachment's bytes for enrichment with a hard size cap. Remote
	 * (attacker-influenceable) URLs go through the SSRF-guarded fetcher, which
	 * blocks private/loopback/link-local hosts; trusted local media-store URLs
	 * (built from a path-validated relative URL) use the runtime fetch. This is
	 * the ONLY place a raw fetch is used during attachment enrichment.
	 */
	private async fetchAttachmentBytes(
		runtime: IAgentRuntime,
		rawUrl: string,
		resolvedLocalUrl: string,
		isRemote: boolean,
	): Promise<{ buffer: Buffer; contentType: string }> {
		if (isRemote) {
			const { buffer, contentType } = await fetchRemoteMedia({
				url: rawUrl,
				maxBytes: ATTACHMENT_FETCH_MAX_BYTES,
			});
			return {
				buffer,
				contentType: contentType ?? "application/octet-stream",
			};
		}
		const runtimeFetch = runtime.fetch ?? globalThis.fetch;
		const res = await runtimeFetch(resolvedLocalUrl);
		if (!res.ok) {
			throw new Error(`Failed to fetch attachment: ${res.statusText}`);
		}
		const buffer = Buffer.from(await res.arrayBuffer());
		if (buffer.length > ATTACHMENT_FETCH_MAX_BYTES) {
			throw new Error(`Attachment exceeds ${ATTACHMENT_FETCH_MAX_BYTES} bytes`);
		}
		const contentType =
			res.headers.get("content-type") || "application/octet-stream";
		return { buffer, contentType };
	}

	private resolveRecentMessagesForFailureReply(
		state: State,
		message: Memory,
	): string {
		if (
			typeof state.values?.recentMessages === "string" &&
			state.values.recentMessages.trim().length > 0
		) {
			return state.values.recentMessages;
		}
		if (typeof state.text === "string" && state.text.trim().length > 0) {
			return state.text;
		}
		if (typeof message.content.text === "string") {
			return message.content.text;
		}
		return "(unavailable)";
	}

	private async generateFailureReplyText(
		runtime: IAgentRuntime,
		prompt: string,
		stage: string,
	): Promise<FailureReplyAttempt> {
		let sawCreditsExhausted = false;
		let sawRateLimit = false;
		let sawAuthError = false;
		for (const modelType of [
			ModelType.TEXT_LARGE,
			ModelType.RESPONSE_HANDLER,
			ModelType.TEXT_SMALL,
			ModelType.TEXT_NANO,
		] as const) {
			try {
				const response = await runtime.useModel(modelType, { prompt });
				if (typeof response !== "string") {
					continue;
				}

				const cleaned = stripReasoningBlocks(response);
				const looksStructuredReply =
					cleaned.startsWith("{") && cleaned.includes("}");
				const parsed = looksStructuredReply
					? parseJSONObjectFromText(cleaned)
					: null;
				const replyText =
					typeof parsed?.text === "string" && parsed.text.trim().length > 0
						? parsed.text.trim()
						: cleaned;
				if (replyText) {
					return { kind: "text", value: replyText };
				}
			} catch (error) {
				// If the runtime reports no LLM provider is configured at all,
				// no further model attempts will succeed. Surface the actionable
				// hint instead of the generic transient-failure message. See
				// elizaOS/eliza#7203.
				if (
					error instanceof Error &&
					error.name === "NoModelProviderConfiguredError"
				) {
					return { kind: "noProvider" };
				}
				// Credit exhaustion is sticky across slots because no later
				// fallback model can make a drained account retryable. The
				// rate/auth flags still track the most recent slot's cause:
				// reporting "rate-limited" only when the LAST attempted slot was
				// a 429 avoids misleading the user in a mixed-failure run.
				// Credits are classified before rate limits below: a 429 *with*
				// billing context is a drained balance ("top up"), not a
				// transient throttle ("try again in a few seconds").
				sawCreditsExhausted ||= isInsufficientCreditsError(error);
				sawRateLimit = isRateLimitError(error);
				sawAuthError = isAuthError(error);
				runtime.logger.warn(
					{
						src: "service:message",
						stage,
						modelType,
						error: error instanceof Error ? error.message : String(error),
					},
					"Structured failure reply generation failed for model",
				);
			}
		}
		// Every model slot failed without a usable reply. When the final cause
		// was credit exhaustion (402/insufficient_credits), the condition is
		// permanent until the user tops up — "try again" can never succeed, so
		// surface the actionable top-up message.
		if (sawCreditsExhausted) {
			return { kind: "creditsExhausted" };
		}
		// When the final cause was provider rate-limiting (429), tell the user
		// that plainly instead of the opaque generic message — the honest
		// signal is "try again shortly", not "something broke".
		if (sawRateLimit) {
			return { kind: "rateLimited" };
		}
		// An auth failure (bad/expired/unauthorized cloud key) is actionable —
		// tell the user to fix their key/credits, not the opaque generic message.
		if (sawAuthError) {
			return { kind: "authFailed" };
		}
		return { kind: "text", value: "" };
	}

	private async buildStructuredFailureReply(
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		responseId: UUID,
		stage: string,
	): Promise<StrategyResult> {
		// Short-circuit when no LLM provider is configured at all. The fallback
		// model loop below would just throw `NoModelProviderConfiguredError` for
		// every model type and surface a misleading generic failure to the user.
		// Instead, render an actionable hint directly. See elizaOS/eliza#7203.
		if (!hasTextGenerationHandler(runtime)) {
			return this.buildNoModelProviderReply(
				runtime,
				message,
				state,
				responseId,
				stage,
			);
		}

		const recentMessages = this.resolveRecentMessagesForFailureReply(
			state,
			message,
		);
		const failurePrompt = buildFailureReplyPrompt(recentMessages);

		const attempt = await this.generateFailureReplyText(
			runtime,
			failurePrompt,
			stage,
		);
		if (attempt.kind === "noProvider") {
			return this.buildNoModelProviderReply(
				runtime,
				message,
				state,
				responseId,
				stage,
			);
		}

		let replyText = attempt.kind === "text" ? attempt.value : "";
		if (!replyText) {
			// Last-ditch fallback when every model call above also failed.
			// Voice-neutral so any character can ship this default; characters
			// can override with their own phrasing via
			// character.templates.transientFailureReply (or
			// rateLimitedReply / insufficientCreditsReply for the specific
			// cases).
			if (attempt.kind === "creditsExhausted") {
				const tmpl = runtime.character.templates?.insufficientCreditsReply;
				replyText =
					(typeof tmpl === "function" ? tmpl({ state }) : tmpl) ||
					INSUFFICIENT_CREDITS_REPLY;
			} else if (attempt.kind === "rateLimited") {
				const tmpl = runtime.character.templates?.rateLimitedReply;
				replyText =
					(typeof tmpl === "function" ? tmpl({ state }) : tmpl) ||
					"My model provider is rate-limiting me right now — give it a few seconds and try again.";
			} else if (attempt.kind === "authFailed") {
				const tmpl = runtime.character.templates?.authFailedReply;
				replyText =
					(typeof tmpl === "function" ? tmpl({ state }) : tmpl) ||
					"My Eliza Cloud key isn't authorized for inference right now — check that your cloud key is valid and your account has credits, then try again.";
			} else {
				const tmpl = runtime.character.templates?.transientFailureReply;
				replyText =
					(typeof tmpl === "function" ? tmpl({ state }) : tmpl) ||
					"Something went wrong on my end. Please try again.";
			}
		}

		replyText = truncateToCompleteSentence(replyText.trim(), 2000);

		// Credit exhaustion is not transient — it persists until the user tops
		// up — so the synthetic reply carries the structural kind downstream
		// consumers already key on (chat DTO failureKind gate, recent-messages
		// synthetic-failure filter) instead of masquerading as a blip.
		const responseContent: Content = {
			thought: `Handle a temporary reply failure during ${stage}.`,
			actions: ["REPLY"],
			failureKind:
				attempt.kind === "creditsExhausted"
					? "insufficient_credits"
					: "transient_failure",
			elizaSyntheticFailure: true,
			transient: true,
			doNotPersist: true,
			text: replyText,
			responseId,
		};

		const responseMessages: Memory[] = [
			{
				id: responseId,
				entityId: runtime.agentId,
				agentId: runtime.agentId,
				content: responseContent,
				roomId: message.roomId,
				createdAt: Date.now(),
			},
		];

		return {
			responseContent,
			responseMessages,
			state,
			mode: "simple",
		};
	}

	/**
	 * Render the no-LLM-provider hint as a chat reply. Used when `useModel`
	 * throws `NoModelProviderConfiguredError`, which means no provider plugin
	 * is registered and no fallback model call will ever succeed. The user
	 * sees an actionable message instead of a generic transient-failure
	 * template. See elizaOS/eliza#7203.
	 */
	private buildNoModelProviderReply(
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		responseId: UUID,
		stage: string,
	): StrategyResult {
		const noProviderTmpl = runtime.character.templates?.noModelProviderReply;
		const replyText =
			(typeof noProviderTmpl === "function"
				? noProviderTmpl({ state })
				: noProviderTmpl) ||
			"This agent has no LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY in your environment, or sign in to Eliza Cloud (ELIZAOS_CLOUD_API_KEY).";

		runtime.logger.warn(
			{ src: "service:message", stage },
			"No LLM provider configured; rendering setup hint reply",
		);

		const responseContent: Content = {
			thought: `No LLM provider configured during ${stage}.`,
			actions: ["REPLY"],
			failureKind: "no_provider",
			text: replyText,
			responseId,
		};

		const responseMessages: Memory[] = [
			{
				id: responseId,
				entityId: runtime.agentId,
				agentId: runtime.agentId,
				content: responseContent,
				roomId: message.roomId,
				createdAt: Date.now(),
			},
		];

		return {
			responseContent,
			responseMessages,
			state,
			mode: "simple",
		};
	}

	/**
	 * Helper to emit run ended events
	 */
	private async emitRunEnded(
		runtime: IAgentRuntime,
		runId: UUID,
		message: Memory,
		startTime: number,
		status: string,
	): Promise<void> {
		await runtime.emitEvent(EventType.RUN_ENDED, {
			runtime,
			source: "messageHandler",
			runId,
			messageId: message.id,
			roomId: message.roomId,
			entityId: message.entityId,
			startTime,
			status: status as "completed" | "timeout",
			endTime: Date.now(),
			duration: Date.now() - startTime,
		} as RunEventPayload);
	}

	private async emitMessageSent(
		runtime: IAgentRuntime,
		message: Memory,
		source: string,
	): Promise<void> {
		await runtime.emitEvent(EventType.MESSAGE_SENT, {
			runtime,
			message,
			source,
		});
	}

	/**
	 * Deletes a message from the agent's memory.
	 *
	 * @param runtime - The agent runtime instance
	 * @param message - The message memory to delete
	 * @returns Promise resolving when deletion is complete
	 */
	async deleteMessage(runtime: IAgentRuntime, message: Memory): Promise<void> {
		if (!message.id) {
			runtime.logger.error(
				{ src: "service:message", agentId: runtime.agentId },
				"Cannot delete memory: message ID is missing",
			);
			return;
		}

		runtime.logger.info(
			{
				src: "service:message",
				agentId: runtime.agentId,
				messageId: message.id,
				roomId: message.roomId,
			},
			"Deleting memory",
		);
		await runtime.deleteMemory(message.id);
		runtime.logger.debug(
			{ src: "service:message", messageId: message.id },
			"Successfully deleted memory",
		);
	}

	/**
	 * Clears all messages from a channel/room.
	 * This method handles bulk deletion of all message memories in a room.
	 *
	 * @param runtime - The agent runtime instance
	 * @param roomId - The room ID to clear messages from
	 * @param channelId - The original channel ID (for logging)
	 * @returns Promise resolving when channel is cleared
	 */
	async clearChannel(
		runtime: IAgentRuntime,
		roomId: UUID,
		channelId: string,
	): Promise<void> {
		runtime.logger.info(
			{ src: "service:message", agentId: runtime.agentId, channelId, roomId },
			"Clearing message memories from channel",
		);

		// Get all message memories for this room
		const memories = await runtime.getMemoriesByRoomIds({
			tableName: "messages",
			roomIds: [roomId],
		});

		runtime.logger.debug(
			{ src: "service:message", channelId, count: memories.length },
			"Found message memories to delete",
		);

		// Delete each message memory
		let deletedCount = 0;
		for (const memory of memories) {
			if (memory.id) {
				try {
					await runtime.deleteMemory(memory.id);
					deletedCount++;
				} catch (error) {
					runtime.logger.warn(
						{ src: "service:message", error, memoryId: memory.id },
						"Failed to delete message memory",
					);
				}
			}
		}

		runtime.logger.info(
			{
				src: "service:message",
				agentId: runtime.agentId,
				channelId,
				deletedCount,
				totalCount: memories.length,
			},
			"Cleared message memories from channel",
		);
	}
}
