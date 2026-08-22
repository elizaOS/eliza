/**
 * Built-in `DefaultMessageService` (the runtime's `IMessageService` singleton) and
 * the helpers it composes, implementing the full inbound-message pipeline: memory
 * creation, should-respond gating, the pre-LLM shortcut gate, Stage-1 response
 * generation with its retry and explicit cutoff policy, the planner loop over tiered
 * actions, attachment enrichment, voice-turn arbitration, and post-turn evaluation
 * — turning a received `Memory` into a response plus any executed actions. The
 * runtime message loop drives it; a host may swap in an alternate `IMessageService`
 * to replace it wholesale.
 */
import { v4 } from "uuid";
import {
	parseEgressDisclosureSubject,
	resolveEgressAudienceAdmission,
} from "../access-control/audience-egress";
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
import { ElizaError } from "../errors";
import {
	formatTaskCompletionStatus,
	type TaskCompletionAssessment,
} from "../features/advanced-capabilities/evaluators/task-completion";
import {
	decideReplyGate,
	type ReplyGateMode,
	resolveEffectiveReplyGate,
} from "../features/advanced-capabilities/personality";
import { getPersonalityStore } from "../features/advanced-capabilities/personality/services/personality-store.ts";
import { isRestartResolvableContentReference } from "../features/advanced-memory/session-summary-content-manifest.ts";
import {
	aliasRecallQuery,
	embedRecallQuery,
} from "../features/documents/recall-embed";
import { runShouldRespondInjectionGate } from "../features/trust/should-respond-risk-gate";
import {
	emitInferenceTiming,
	getInferenceTimer,
	INFERENCE_MARKS,
	type InferenceTurnSummary,
	InferenceTurnTimer,
	markInference,
	nextInferenceTurnId,
	recordInferenceSpan,
	runWithInferenceTiming,
	timeInferenceSpan,
} from "../inference-timing";
import { logger } from "../logger";
import { describeImageCached } from "../media";
import {
	fetchRemoteMedia,
	MediaFetchError,
	readResponseWithLimit,
} from "../media/fetch";
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
	normalizeActionName,
} from "../runtime/action-catalog";
import {
	actionGateFailure,
	actionGateRejection,
	canActionRun,
} from "../runtime/action-gate";
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
import { isCanonicalModelCapabilityDisabled } from "../runtime/canonical-model-capabilities.ts";
import { deriveCompactionContentManifest } from "../runtime/content-access-manifest";
import { isProgressiveContentProjectionEnabled } from "../runtime/content-projection-policy";
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
	type DirectActionRoutingRule,
	getDirectActionRoutingRules,
} from "../runtime/direct-action-routing";
import {
	bindEffectDelivery,
	effectDeliveryBindingIsValid,
	effectDeliveryBindingProvesApplication,
	getEffectDeliveryBinding,
	stripEffectDeliveryBinding,
} from "../runtime/effect-delivery";
import {
	type EvaluatorEffects,
	type EvaluatorOutput,
	runEvaluator,
} from "../runtime/evaluator";
import {
	type ExecutePlannedToolCallContext,
	type ExecutePlannedToolCallOptions,
	executePlannedToolCall,
	projectActionResultForClipboard,
	shouldSuppressActionResultClipboard,
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
	FAILED_TOOL_FALLBACK_MESSAGE,
	isTerminalPlannerToolName,
	type PlannerLoopParams,
	type PlannerLoopResult,
	type PlannerRuntime,
	type PlannerToolCall,
	type PlannerToolResult,
	type PlannerTrajectory,
	PROGRESS_ONLY_ANSWER_REJECT,
	PROGRESS_ONLY_REPLY_OPENERS_PATTERN,
	runPlannerLoop,
	summarizeActionResultForPlanner,
} from "../runtime/planner-loop";
import { renderActionResultsForModel } from "../runtime/planner-rendering";
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
	ResponseHandlerFieldRunResult,
	ResponseHandlerResult,
	ResponseHandlerSenderRole,
} from "../runtime/response-handler-field-evaluator";
import type { RoomHandlerLease } from "../runtime/room-handler-queue";
import type { ShortcutRegistry } from "../runtime/shortcut-registry";
import {
	actionHasSubActions,
	runSubPlanner,
	subPlannerCallDigest,
} from "../runtime/sub-planner";
import {
	buildCanonicalSystemPrompt,
	buildCharacterStyleDirections,
} from "../runtime/system-prompt";
import { resolveTraceCorrelationFromEnv } from "../runtime/trace-correlation";
import {
	buildProviderAttributionsFromState,
	flattenTrajectoryMessages,
} from "../runtime/trajectory-provider-attribution";
import {
	captureToolStageIO,
	createJsonFileTrajectoryRecorder,
	finalizeTrajectoryRecording,
	isTrajectoryRecordingEnabled,
	type RecordedStage,
	type TrajectoryRecorder,
} from "../runtime/trajectory-recorder";
import { withSemanticStageFanOut } from "../runtime/trajectory-semantic-stage-sink";
import { TurnAbortedError } from "../runtime/turn-controller";
import {
	sanitizeUserVisibleModelOutput,
	type UserVisibleModelOutput,
} from "../runtime/user-visible-model-output";
import { containsExternalEnvelopeMaterial } from "../security/external-content";
import {
	createOutboundEnvelopeStreamLatch,
	guardOutboundEnvelopeAttachments,
	guardOutboundEnvelopeText,
	reportOutboundEnvelopeBlock,
} from "../security/outbound-envelope-guard";
import {
	attestDeliveryAudienceFromCanonicalRoom,
	getTrustedDeliveryAudience,
	ownerExclusiveDisclosureWasUsed,
	PRIVACY_DENIED_TEXT,
	revalidateOwnerExclusiveDisclosure,
	trustedDeliveryAudienceIsBoundToRuntime,
} from "../security/trusted-delivery-audience";
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
import { withEvaluatorStep } from "../trajectory-utils";
import type { CharacterSettings } from "../types/agent";
import type {
	Action,
	ActionResult,
	AgentContext,
	HandlerCallback,
	MessageHandlerResult,
	Provider,
	ProviderValue,
	StreamChunkCallback,
} from "../types/components";
import type { ContextEvent, ContextObject } from "../types/context-object";
import type { ContextDefinition, RoleGateRole } from "../types/contexts";
import {
	mergeEffectReceipts,
	resolveAppliedUserFacingEffectReceipts,
	resolveUserFacingEffectReceipts,
} from "../types/effects";
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
import {
	MESSAGE_SOURCE_CLIENT_CHAT,
	MESSAGE_SOURCE_SUB_AGENT,
	MESSAGE_SOURCE_TRIGGER_PROMPT,
} from "../types/message-source";
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
import {
	getUserMessageText,
	stripAugmentationForPersistence,
} from "../utils/message-text";
import { modelProviderErrorDetail } from "../utils/model-errors";
import { readEnv } from "../utils/read-env";
import {
	createFirstSentenceStreamTracker,
	extractFirstSentence,
} from "../utils/text-splitting";
import { isObjectRecord as isRecord } from "../utils/type-guards";
import { toWellFormedUnicode } from "../utils/well-formed";
import { maybeHandleAnalysisActivation } from "./analysis-mode-handler";
import { ChannelTopicsService } from "./channel-topics";
import { runPostTurnEvaluators } from "./evaluator";
import { runBotNoiseTriage } from "./message/bot-noise-triage";
import {
	type DirectCurrentRequestCandidateInference,
	findCodingDelegationActionName,
	findShellDirectActionName,
	findWebLookupActionName,
	findWebLookupActionNames,
	inferDirectCurrentRequestCandidateActions as inferDirectCurrentRequestCandidateActionsFromHeuristics,
	inferDirectCurrentRequestCandidateInference as inferDirectCurrentRequestCandidateInferenceFromHeuristics,
	inferLocalShellCommandFromMessageText,
	inferWebSearchQueryFromMessageText,
	isShellDirectActionName,
	isToolDerivedAssistantContent,
	LEGACY_CODING_DELEGATION_ACTION_NAMES,
	looksLikeBareLinkShare,
	looksLikeLocalShellRequest,
	looksLikeWebSearchRequest,
	normalizeActionIdentifier,
	resolveExplicitContinuationRequestText,
} from "./message/direct-action-heuristics";
import {
	buildFailureReplyPrompt,
	classifyStructuredFailureCause,
	INSUFFICIENT_CREDITS_REPLY,
	isAuthError,
	isInsufficientCreditsError,
	isRateLimitError,
	type StructuredFailureCause,
	stripReasoningBlocks,
} from "./message/fallback-reply";
import {
	extractGenerateTextContentText,
	getV5ModelText,
} from "./message/generate-text-result";
import { resolveEffectiveMuteState } from "./message/mute-state";
import { sanitizeOutboundText } from "./message/outbound-sanitize";
import { isUnaddressedTextGroupTurn } from "./message/stage1-prompt-tier";
import type { OptimizedPromptTask } from "./optimized-prompt";
import {
	type OptimizedPromptRuntimeLike,
	resolveOptimizedPromptForRuntime,
} from "./optimized-prompt-resolver";
import { trackPostDeliveryTask } from "./post-delivery-task-tracker.ts";

export {
	findWebLookupActionName,
	findWebLookupActionNames,
	inferLocalShellCommandFromMessageText,
	inferWebSearchQueryFromMessageText,
};

const DEFAULT_STAGE1_MAX_TOKENS = 2048;

/**
 * Per-agent reply-length budget (#16395): a positive-integer `max_tokens`
 * ceiling applied to the Stage-1/synthesis call so operators can pin terse
 * replies (e.g. group-chat turns) without rewriting the persona, and have it
 * enforced by the provider rather than requested politely in `system`.
 * `characterSchema` validates the field (`z.number().int().positive()`); the
 * integer guard here only covers characters constructed without validation.
 * Unset or invalid → undefined, i.e. the unchanged channel default applies.
 */
function resolveMaxReplyTokens(
	settings: CharacterSettings | undefined,
): number | undefined {
	const raw = settings?.maxReplyTokens;
	return typeof raw === "number" && Number.isInteger(raw) && raw > 0
		? raw
		: undefined;
}

const STAGE1_COMPLETION_LIMIT_REPLY =
	"That answer got cut off before I could finish it. Please try again with a shorter request or ask for a narrower format.";
const CODE_SNIPPET_VALIDITY_INSTRUCTION =
	"For code snippets, prioritize syntactically valid runnable code over impossible formatting constraints. If a tight line count would require invalid syntax, provide a valid version and briefly note the constraint tradeoff.";

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

	return /<@!?[^>]+>|@\w+/u.test(text);
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

/**
 * Resolves the sender's effective personality `reply_gate` mode (user slot →
 * global slot) for the post-Stage-1 engagement addressing gate. An explicit
 * `"always"` is the deliberate opt-out that keeps intentionally-chatty agents
 * replying even to turns addressed to another participant; every other mode —
 * including the default unset state — leaves that gate armed.
 */
function resolveStage1ReplyGateMode(
	runtime: IAgentRuntime,
	message: Memory,
): ReplyGateMode | null {
	const store = getPersonalityStore(runtime);
	if (!store || message.entityId === runtime.agentId) {
		return null;
	}
	return resolveEffectiveReplyGate(
		store.getSlot(message.entityId),
		store.getSlot("global"),
	).mode;
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
		// error-policy:J3 inline planner parameters are untrusted model input;
		// malformed JSON is an explicit invalid result.
		return null;
	}
}

function splitInlinePlannerParams(
	value: string,
): { name: string; body: string } | null {
	const lower = value.toLowerCase();
	let open = lower.indexOf("<params");
	while (open >= 0) {
		const boundary = lower[open + "<params".length];
		if (!boundary || !/[a-z0-9_]/i.test(boundary)) break;
		open = lower.indexOf("<params", open + "<params".length);
	}
	if (open < 0) return null;
	const bodyStart = value.indexOf(">", open + "<params".length);
	if (bodyStart < 0) return null;
	const close = lower.indexOf("</params>", bodyStart + 1);
	if (close < 0 || value.slice(close + "</params>".length).trim() !== "") {
		return null;
	}
	return {
		name: value.slice(0, open).trimEnd(),
		body: value.slice(bodyStart + 1, close),
	};
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

	const inlineParams = splitInlinePlannerParams(value);
	if (inlineParams) {
		return {
			name: unwrapPlannerIdentifier(inlineParams.name),
			params: parseInlinePlannerParams(inlineParams.body) ?? undefined,
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
	// FACTS is dynamic and would otherwise never run during response
	// composition. Stage 1 keeps it rendered so durable user facts
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
 *   - CHARACTER: identity is already rendered via `staticPrefix.systemPrompt`
 *     (system + bio + role) and chat style directions via
 *     `staticPrefix.characterPrompt`, so the text-block CHARACTER provider
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

const AMBIENT_TURN_PROVIDER_EXCLUSIONS = ["RECENT_ERRORS"] as const;

function ambientTurnProviderExclusions(
	runtime: IAgentRuntime,
	message: Memory,
): readonly string[] {
	return isUnaddressedTextGroupTurn(
		message,
		messageExplicitlyAddressesAgent(runtime, message),
	)
		? AMBIENT_TURN_PROVIDER_EXCLUSIONS
		: [];
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

function isOwnerLifeManagementToolCandidate(actionName: string): boolean {
	return new Set(
		[
			"CALENDAR",
			"CALENDAR_CREATE_EVENT",
			"OWNER_ALARMS",
			"OWNER_ALARMS_CREATE",
			"OWNER_GOALS",
			"OWNER_GOALS_CREATE",
			"OWNER_REMINDERS",
			"OWNER_REMINDERS_CREATE",
			"OWNER_ROUTINES",
			"OWNER_ROUTINES_CREATE",
			"OWNER_TODOS",
			"OWNER_TODOS_CREATE",
			"SCHEDULED_TASKS",
			"SCHEDULED_TASKS_CREATE",
		].map(normalizeActionIdentifier),
	).has(normalizeActionIdentifier(actionName));
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

/**
 * The provider include list for Stage-1 response-state composition: the core
 * response providers plus always-on plugin providers. Exported for tests.
 */
export function stage1ResponseStateProviderNames(
	runtime: IAgentRuntime,
	message: Memory,
): string[] {
	const excluded = new Set(ambientTurnProviderExclusions(runtime, message));
	return [
		...CORE_RESPONSE_STATE_PROVIDERS,
		...alwaysOnResponseStateProviderNames(runtime),
		...(hasInboundBenchmarkContext(message) ? ["CONTEXT_BENCH"] : []),
	].filter((name) => !excluded.has(name));
}

async function composeResponseState(
	runtime: IAgentRuntime,
	message: Memory,
	skipCache = false,
): Promise<State> {
	const providers = stage1ResponseStateProviderNames(runtime, message);
	if (hasPageScopedRoutingMetadata(message)) {
		return runtime.composeState(
			message,
			[...providers, "page-scoped-context"],
			true,
			skipCache,
		);
	}
	return runtime.composeState(message, providers, true, skipCache);
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

	for (const excluded of ambientTurnProviderExclusions(
		args.runtime,
		args.message,
	)) {
		providerNames.delete(excluded);
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

/** Aggregate bytes admitted to enrichment for one message turn. */
const ATTACHMENT_TURN_MAX_BYTES = 100 * 1024 * 1024;

type AttachmentByteBudget = { remaining: number };

function attachmentFailure(
	phase: NonNullable<Media["enrichmentFailure"]>["phase"],
	code: NonNullable<Media["enrichmentFailure"]>["code"],
	retryable: boolean,
	message: string,
): Pick<Media, "notProcessed" | "enrichmentFailure"> {
	return {
		notProcessed: message,
		enrichmentFailure: { phase, code, retryable },
	};
}

function sanitizedAttachmentDiagnostic(
	code: string,
	message: string,
	attachment: Media,
): ElizaError {
	return new ElizaError(message, {
		code,
		severity: "ephemeral",
		context: {
			attachmentId: attachment.id,
			contentType: attachment.contentType,
		},
	});
}

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
	roomHandlerLease?: RoomHandlerLease;
	onSettledActionResult?: (result: ActionResult) => void;
	onTrajectoryTerminalOwner?: (owner: "run") => void;
	onInferenceTimingSummary?: (summary: InferenceTurnSummary) => void;
	runTerminalOwner?: MessageRunTerminalOwner;
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
	actionResults?: ActionResult[];
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
	classifyStructuredFailureCause,
	INSUFFICIENT_CREDITS_REPLY,
	isAuthError,
	isInsufficientCreditsError,
	isInsufficientCreditsMessage,
	isModelProviderFallbackError,
	isRateLimitError,
	type StructuredFailureCause,
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
export {
	buildVoiceGatePrompt,
	type EnsureAgentVoiceOptions,
	ensureAgentVoice,
} from "./message/voice-gate";

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

/**
 * Canonical form for delivered-text dedup: callers that thread
 * `deliveredVisibleTexts` into `runV5MessageRuntimeStage1` must add entries in
 * this form for the action-echo suppression to match them.
 */
export function normalizeVisibleTextForDuplicateCheck(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * True when a text already delivered through an action callback covers the
 * (normalized) planned reply — either verbatim or as a strict superset ending
 * at a non-word boundary, so a short prefix never swallows an unrelated longer
 * line ("created" must not match "created issue …"). Shared by the planner
 * echo suppression and the reply-egress claim gate so both agree on what
 * "the user already saw this" means.
 */
function deliveredTextsCoverReply(
	deliveredVisibleTexts: ReadonlySet<string>,
	normalizedReply: string,
): boolean {
	if (normalizedReply.length === 0) return false;
	for (const delivered of deliveredVisibleTexts) {
		if (
			delivered === normalizedReply ||
			(delivered.startsWith(normalizedReply) &&
				/[^a-z0-9]/i.test(delivered.charAt(normalizedReply.length)))
		) {
			return true;
		}
	}
	return false;
}

/**
 * Records a settled planner tool result on the turn-scoped list the
 * planner-loop failure catch reads, returning the result unchanged so the
 * capture composes inline with the executor call.
 */
function trackSettledPlannerToolResult(
	settled: Array<{ name: string; result: PlannerToolResult }>,
	name: string,
	result: PlannerToolResult,
): PlannerToolResult {
	settled.push({ name, result });
	return result;
}

/**
 * The completed-result body of a sub-agent `task_complete` relay message, or
 * undefined when the text is not such a relay or carries no body. The relay
 * format is `[sub-agent: … — task_complete — …]\n<result body>` (see
 * plugin-agent-orchestrator's sub-agent-router): the bracketed first segment
 * is a planner-only directive and never user-facing; the body below it is the
 * sub-agent's finished result, already composed for user delivery. Lets a
 * failed relay turn deliver the completed result instead of discarding it for
 * the generic failed-tool fallback (#18208).
 */
export function subAgentCompletionRelayBody(
	text: string | undefined,
): string | undefined {
	const parsed = parseSubAgentTaskCompleteRelay(text);
	if (!parsed) return undefined;
	const { trimmed, headerEnd } = parsed;
	const body = trimmed.slice(headerEnd + 1).trim();
	if (!body) return undefined;
	return toWellFormedUnicode(body);
}

/**
 * Parses the complete bracketed status header emitted by the sub-agent router.
 * Status matching stays inside that header and requires either the compact
 * legacy form or the router's delimited status field; task text and result
 * bodies are untrusted prose and cannot classify a relay as complete.
 */
function parseSubAgentTaskCompleteRelay(
	text: string | undefined,
): { trimmed: string; headerEnd: number } | undefined {
	if (!text) return undefined;
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("[sub-agent:")) return undefined;
	const compactHeader = "[sub-agent:task_complete]";
	if (trimmed.startsWith(compactHeader)) {
		return { trimmed, headerEnd: compactHeader.length - 1 };
	}
	const lineEnd = trimmed.indexOf("\n");
	if (lineEnd < 0) return undefined;
	const headerLine = trimmed.slice(0, lineEnd).trimEnd();
	if (!headerLine.endsWith("]")) return undefined;
	const headerEnd = headerLine.length - 1;
	const header = trimmed.slice(0, headerEnd + 1);
	const inner = header.slice("[sub-agent:".length, -1).trim();
	const routeDelimiters = [...inner.matchAll(/\([^()\r\n]+\)\s—\s*/gu)];
	const finalDelimiter = routeDelimiters.at(-1);
	if (finalDelimiter?.index === undefined) return undefined;
	const routedStatus = inner.slice(
		finalDelimiter.index + finalDelimiter[0].length,
	);
	return /^task_complete(?:\s—|$)/iu.test(routedStatus)
		? { trimmed, headerEnd }
		: undefined;
}

/**
 * The most recent completed tool result whose `userFacingText` can still
 * rescue a turn after the planner loop dies: successful, non-terminal, and not
 * already delivered to the user through an action callback. Diagnostic
 * `text` is never a candidate — the wire contract says it must not render as
 * assistant prose — so a turn whose tools produced only diagnostics still
 * falls through to the caller's failure handling.
 */
export function preservedSettledToolResult(
	settled: ReadonlyArray<{ name: string; result: PlannerToolResult }>,
	deliveredVisibleTexts: ReadonlySet<string>,
): (PlannerToolResult & { userFacingText: string }) | undefined {
	for (let index = settled.length - 1; index >= 0; index--) {
		const entry = settled[index];
		if (entry?.result.success !== true) continue;
		if (isTerminalPlannerToolName(entry.name)) continue;
		const candidate = entry.result.userFacingText?.trim();
		if (!candidate) continue;
		// A text the user already saw via an action callback must not be
		// re-sent; keep scanning for an undelivered result.
		if (
			deliveredTextsCoverReply(
				deliveredVisibleTexts,
				normalizeVisibleTextForDuplicateCheck(candidate),
			)
		) {
			continue;
		}
		return { ...entry.result, userFacingText: candidate };
	}
	return undefined;
}

export const NO_REPORTABLE_TOOL_OUTCOME_MESSAGE =
	"I ran that, but it finished without producing a result I can report back.";

const ASYNC_HANDOFF_ACK_MESSAGE = "on it, working on that now.";

function preservedVerifiedFailure(
	settled: ReadonlyArray<{ name: string; result: PlannerToolResult }>,
	deliveredVisibleTexts: ReadonlySet<string>,
): string | undefined {
	for (let index = settled.length - 1; index >= 0; index--) {
		const entry = settled[index];
		if (entry?.result.success !== false) continue;
		if (entry.result.verifiedUserFacing !== true) continue;
		if (isTerminalPlannerToolName(entry.name)) continue;
		const candidate = entry.result.userFacingText?.trim();
		if (!candidate) continue;
		if (
			deliveredTextsCoverReply(
				deliveredVisibleTexts,
				normalizeVisibleTextForDuplicateCheck(candidate),
			)
		) {
			continue;
		}
		return candidate;
	}
	return undefined;
}

function hasAcceptedAsyncHandoff(result: ActionResult): boolean {
	if (result.success !== true) return false;
	return (
		result.effectReceipts?.some(
			(receipt) =>
				receipt.outcome === "applied" &&
				receipt.commit !== undefined &&
				receipt.commit.id.trim().length > 0,
		) === true
	);
}

/**
 * Terminal report for a tool turn whose planner produced no prose. A
 * pre-tool acknowledgement is retained only when a successful action carries
 * authoritative acceptance proof that work continues beyond this turn.
 */
export function answerlessToolTurnReport(args: {
	settledToolResults: ReadonlyArray<{
		name: string;
		result: PlannerToolResult;
	}>;
	deliveredVisibleTexts: ReadonlySet<string>;
	actionResults: readonly ActionResult[];
	actions: readonly Action[] | undefined;
	stageOneAck: string;
}): string {
	const successful = preservedSettledToolResult(
		args.settledToolResults,
		args.deliveredVisibleTexts,
	);
	if (successful) return successful.userFacingText;
	const failed = preservedVerifiedFailure(
		args.settledToolResults,
		args.deliveredVisibleTexts,
	);
	if (failed) return failed;
	if (args.deliveredVisibleTexts.size > 0) return "";
	const acceptedActionNames = args.actionResults
		.filter(hasAcceptedAsyncHandoff)
		.map((result) =>
			typeof result.data?.actionName === "string" ? result.data.actionName : "",
		)
		.filter((name) => name.length > 0);
	if (candidateActionsIncludeAsyncHandoff(args.actions, acceptedActionNames)) {
		return args.stageOneAck || ASYNC_HANDOFF_ACK_MESSAGE;
	}
	return NO_REPORTABLE_TOOL_OUTCOME_MESSAGE;
}

/** Where the zero-delivery recovery sourced its terminal reply from. */
export type ZeroDeliveryRecoverySource =
	| "plannedText"
	| "actionUserFacingText"
	| "stageOneAck"
	| "fallbackText";

/**
 * Decides whether — and with what text — a RESPOND turn that ran tools but
 * delivered nothing terminal recovers instead of ending silent (#20083,
 * corrected by #20086). Source precedence: the planner's surviving terminal
 * text, then the last explicit action-owned `userFacingText`, then the
 * Stage-1 ack ONLY when no early ack already shipped it, then a hardcoded
 * fallback whose wording is failure-aware — it claims completion only when at
 * least one tool actually succeeded. After an early progress ack the turn
 * recovers only when grounded text exists or any tool failed: a successful
 * async handoff reports through a later completion relay, so manufacturing a
 * "finished" line behind its ack would be a lie, while a failed handoff will
 * never relay anything and the ack's promise must be corrected.
 * `plannedText` must arrive pre-blanked when it merely repeats the early ack.
 */
export function resolveZeroDeliveryRecovery(args: {
	plannedText: string;
	actionResults: ReadonlyArray<
		Pick<ActionResult, "success" | "userFacingText">
	>;
	stageOneAck: string;
	earlyReplySent: boolean;
}): {
	recover: boolean;
	text: string;
	source: ZeroDeliveryRecoverySource;
	actionSuccessCount: number;
	actionFailureCount: number;
} {
	const actionSuccessCount = args.actionResults.filter(
		(result) => result.success === true,
	).length;
	const actionFailureCount = args.actionResults.filter(
		(result) => result.success === false,
	).length;
	const lastActionUserFacingText =
		args.actionResults
			.map((result) =>
				typeof result.userFacingText === "string"
					? result.userFacingText.trim()
					: "",
			)
			.filter((ownedText) => ownedText.length > 0)
			.at(-1) ?? "";
	const ackRecoveryText = args.earlyReplySent ? "" : args.stageOneAck;
	const fallbackRecoveryText =
		actionSuccessCount > 0 && actionFailureCount > 0
			? "Some steps completed and some failed, but I could not produce a reliable summary. Check the current state before deciding whether to retry."
			: actionSuccessCount > 0
				? "The requested steps completed, but I could not produce a reliable summary. Check the current state before retrying."
				: "I ran the steps for that but they failed, and I could not compose a useful report — ask again and I will retry.";
	const text =
		args.plannedText ||
		lastActionUserFacingText ||
		ackRecoveryText ||
		fallbackRecoveryText;
	const source: ZeroDeliveryRecoverySource = args.plannedText
		? "plannedText"
		: lastActionUserFacingText
			? "actionUserFacingText"
			: ackRecoveryText
				? "stageOneAck"
				: "fallbackText";
	const recover =
		!args.earlyReplySent ||
		Boolean(args.plannedText) ||
		lastActionUserFacingText.length > 0 ||
		actionFailureCount > 0;
	return { recover, text, source, actionSuccessCount, actionFailureCount };
}

function mediaContentUrlRegions(
	text: string,
): Array<{ start: number; end: number }> {
	const regions: Array<{ start: number; end: number }> = [];
	const lowerText = text.toLowerCase();
	let cursor = 0;
	while (cursor < text.length) {
		const http = lowerText.indexOf("http", cursor);
		if (http < 0) break;
		let end = http;
		while (
			end < text.length &&
			!/\s/u.test(text[end]) &&
			text[end] !== "<" &&
			text[end] !== ">"
		)
			end += 1;
		const lower = lowerText.slice(http, end);
		const scheme = lower.startsWith("https://")
			? 8
			: lower.startsWith("http://")
				? 7
				: 0;
		if (scheme) {
			// The endpoint may sit mid-token (trailing punctuation, query strings)
			// and after any of several `/v1/` segments; the region ends right after
			// `/content` so surrounding punctuation survives for later cleanup.
			let matchEnd = -1;
			let marker = lower.indexOf("/v1/", scheme);
			while (marker >= 0) {
				const kindEnd = lower.indexOf("/", marker + 4);
				if (kindEnd >= 0) {
					const kind = lower.slice(marker + 4, kindEnd);
					const idEnd = lower.indexOf("/", kindEnd + 1);
					if (
						["videos", "images", "audio"].includes(kind) &&
						idEnd > kindEnd + 1 &&
						lower.startsWith("content", idEnd + 1)
					) {
						matchEnd = idEnd + 1 + "content".length;
					}
				}
				marker = lower.indexOf("/v1/", marker + 4);
			}
			if (matchEnd > 0) {
				regions.push({ start: http, end: http + matchEnd });
			}
		}
		cursor = Math.max(end, http + 1);
	}
	return regions;
}

function removeRegions(
	text: string,
	regions: Array<{ start: number; end: number }>,
): string {
	if (regions.length === 0) return text;
	const chunks: string[] = [];
	let cursor = 0;
	for (const region of regions) {
		let start = region.start;
		let end = region.end;
		while (start > cursor && /\s/u.test(text[start - 1])) start -= 1;
		if (text[start - 1] === "<") start -= 1;
		while (end < text.length && /\s/u.test(text[end])) end += 1;
		if (text[end] === ">") end += 1;
		chunks.push(text.slice(cursor, start));
		cursor = end;
	}
	chunks.push(text.slice(cursor));
	return chunks.join("");
}

function removeDeliveredUrl(text: string, url: string): string {
	const regions: Array<{ start: number; end: number }> = [];
	const lower = text.toLowerCase();
	const needle = url.toLowerCase();
	let cursor = 0;
	while (needle && cursor < text.length) {
		const start = lower.indexOf(needle, cursor);
		if (start < 0) break;
		regions.push({ start, end: start + url.length });
		cursor = start + url.length;
	}
	return removeRegions(text, regions);
}

const MEDIA_DELIVERY_PREAMBLES = [
	...["here", "here's", "here is", "here you go"].flatMap((base) => [
		`${base} it is`,
		base,
	]),
	"done.",
	...["video", "video'", "videos", "video's"].flatMap((subject) =>
		["up", "live", "ready"].map((state) => `done ${subject} ${state}`),
	),
	"done",
	"your video is ready",
	"your video",
].sort((left, right) => right.length - left.length);

function stripMediaDeliveryPreamble(text: string): string {
	const lower = text.toLowerCase();
	for (const prefix of MEDIA_DELIVERY_PREAMBLES) {
		if (!lower.startsWith(prefix)) continue;
		let cursor = prefix.length;
		if (
			cursor < text.length &&
			!/\s/u.test(text[cursor]) &&
			text[cursor] !== ":"
		)
			continue;
		while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1;
		if (text[cursor] === ":") cursor += 1;
		while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1;
		return text.slice(cursor);
	}
	return text;
}
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
	const embeddedRegions = mediaContentUrlRegions(cleaned);
	const hasEmbeddedMediaUrl = embeddedRegions.length > 0;
	if (deliveredUrls.length === 0 && !hasEmbeddedMediaUrl) {
		return cleaned;
	}

	for (const url of deliveredUrls) {
		cleaned = removeDeliveredUrl(cleaned, url);
	}
	cleaned = removeRegions(cleaned, mediaContentUrlRegions(cleaned));
	cleaned = cleaned
		.replace(/:\s*$/g, "")
		.replace(/<\s*>/g, "")
		.replace(/\(\s*\)/g, "")
		// Collapse only same-line whitespace gaps left by URL removal —
		// newlines are reply formatting and must survive.
		.replace(/[^\S\n]{2,}/g, " ")
		.trim();
	cleaned = stripMediaDeliveryPreamble(cleaned).trim();

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
	transcriptVisibility?: "internal";
	/** Applied receipt IDs grounding this exact text at the final send boundary. */
	effectReceiptIds?: readonly string[];
	/**
	 * Provenance for the humanness voice gate (#14873): `true` when `text` is
	 * already final user-facing copy — either the model's own composed reply or
	 * a byte-exact canonical `verifiedUserFacing` action result. Gated transports
	 * (`sendMessageToTarget`) then preserve it instead of spending a blocking
	 * TEXT_SMALL re-voice that could alter exact names, punctuation, or values.
	 * Leave unset for templates, ordinary tool output, and mixed-provenance
	 * planner text so the gate can still rewrite canned strings.
	 */
	agentVoiced?: boolean;
	/** Body-free continuation ledger copied onto the persisted dialogue memory. */
	metadata?: Record<string, JsonValue>;
}): StrategyResult {
	let responseContent: Content = {
		thought: args.thought,
		actions: ["REPLY"],
		text: restorePiiInUserReplyText(args.text),
		simple: args.mode !== "actions",
		responseId: args.responseId,
		...(args.agentVoiced === true ? { agentVoiced: true } : {}),
		...(args.attachments?.length ? { attachments: args.attachments } : {}),
		...(args.transcriptVisibility
			? { transcriptVisibility: args.transcriptVisibility }
			: {}),
		...(args.effectReceiptIds?.length
			? { effectReceiptIds: [...args.effectReceiptIds] }
			: {}),
	};
	if (args.effectReceiptIds?.length && responseContent.text) {
		responseContent = bindEffectDelivery(
			responseContent,
			responseContent.text,
			args.effectReceiptIds,
			true,
		);
	}

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
				...(args.metadata ? { metadata: args.metadata } : {}),
			},
		],
		state: args.state,
		mode: args.mode ?? "simple",
	};
}

const PROGRESSIVE_CONTENT_METADATA_KEY = "elizaos:progressiveContent";

function jsonValuesEqual(
	left: JsonValue | undefined,
	right: JsonValue,
): boolean {
	if (left === right) return true;
	if (left === null || right === null) return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => jsonValuesEqual(value, right[index]))
		);
	}
	if (typeof left !== "object" || typeof right !== "object") return false;
	const leftRecord = left as Record<string, JsonValue>;
	const rightRecord = right as Record<string, JsonValue>;
	const leftKeys = Object.keys(leftRecord).sort();
	const rightKeys = Object.keys(rightRecord).sort();
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(
			(key, index) =>
				key === rightKeys[index] &&
				jsonValuesEqual(leftRecord[key], rightRecord[key] as JsonValue),
		)
	);
}

/**
 * Build dialogue-memory metadata that the rolling-summary evaluator can merge.
 * FILE references are path hashes while FILE reads require `file_path`; Gmail
 * and attachment references currently require room scans or in-process lookup
 * maps; tool-result has no durable resolver. Excluding those kinds is deliberate: persisting an
 * opaque token is not the same thing as preserving authorized recoverability.
 */
export function plannerTrajectoryContentManifestMetadata(args: {
	trajectory: PlannerTrajectory;
	enabled: boolean;
	lastUsedAt: string;
}): Record<string, JsonValue> | undefined {
	if (!args.enabled) return undefined;
	const manifest = deriveCompactionContentManifest(args.trajectory, {
		lastUsedAt: args.lastUsedAt,
		includeReference: isRestartResolvableContentReference,
	});
	if (
		manifest.contentRefs.length === 0 &&
		manifest.modifiedFiles.length === 0 &&
		manifest.pendingProcesses.length === 0
	) {
		return undefined;
	}
	return {
		[PROGRESSIVE_CONTENT_METADATA_KEY]: {
			schemaVersion: 1,
			contentManifest: manifest,
		} as unknown as JsonValue,
	};
}

/** Attach the ledger to the live message and synchronously persist it for the
 * post-turn summary query. Failed or unverifiable persistence is reported while
 * the returned metadata still follows the assistant response memory path. */
export async function persistPlannerTrajectoryContentManifest(args: {
	runtime: IAgentRuntime;
	message: Memory;
	trajectory: PlannerTrajectory;
	lastUsedAt: string;
}): Promise<Record<string, JsonValue> | undefined> {
	let contentManifestMetadata: Record<string, JsonValue> | undefined;
	try {
		contentManifestMetadata = plannerTrajectoryContentManifestMetadata({
			trajectory: args.trajectory,
			enabled: isProgressiveContentProjectionEnabled(args.runtime),
			lastUsedAt: args.lastUsedAt,
		});
	} catch (cause) {
		// error-policy:J4 manifest continuity is auxiliary to the completed planner
		// turn, so a bounded-derivation failure is reported without replaying effects.
		const derivationError = new ElizaError(
			"Planner content manifest derivation failed",
			{
				code: "CONTENT_MANIFEST_DERIVATION_FAILED",
				context: { messageId: args.message.id },
				cause,
			},
		);
		args.runtime.reportError(
			"MessageService.persistContentManifest",
			derivationError,
			{ messageId: args.message.id },
		);
		args.runtime.logger.warn(
			{ src: "service:message", messageId: args.message.id },
			"Planner content manifest could not be derived",
		);
		return undefined;
	}
	if (!contentManifestMetadata || !args.message.id) {
		return contentManifestMetadata;
	}
	const metadata = {
		...(args.message.metadata ?? {}),
		type: "message" as const,
		...contentManifestMetadata,
	};
	args.message.metadata = metadata;
	let persistenceError: ElizaError | undefined;
	try {
		const persisted = await args.runtime.updateMemory({
			id: args.message.id,
			metadata,
		});
		const readback = persisted
			? await args.runtime.getMemoryById(args.message.id)
			: null;
		const expectedEnvelope = contentManifestMetadata[
			PROGRESSIVE_CONTENT_METADATA_KEY
		] as JsonValue;
		const actualEnvelope = (
			readback?.metadata as Record<string, JsonValue> | undefined
		)?.[PROGRESSIVE_CONTENT_METADATA_KEY];
		if (!persisted || !jsonValuesEqual(actualEnvelope, expectedEnvelope)) {
			persistenceError = new ElizaError(
				"Planner content manifest persistence could not be verified",
				{
					code: "CONTENT_MANIFEST_PERSISTENCE_FAILED",
					context: { messageId: args.message.id },
				},
			);
		}
	} catch (cause) {
		// error-policy:J4 the completed planner turn still returns its response;
		// diagnostics make the continuity loss explicit and the assistant reply
		// carries the same manifest through its normal persistence path.
		persistenceError = new ElizaError(
			"Planner content manifest persistence failed",
			{
				code: "CONTENT_MANIFEST_PERSISTENCE_FAILED",
				context: { messageId: args.message.id },
				cause,
			},
		);
	}
	if (persistenceError) {
		args.runtime.reportError(
			"MessageService.persistContentManifest",
			persistenceError,
			{
				messageId: args.message.id,
			},
		);
		args.runtime.logger.warn(
			{ src: "service:message", messageId: args.message.id },
			"Planner content manifest persistence could not be verified",
		);
	}
	return contentManifestMetadata;
}

/**
 * Bind an internal transcript marker only to the exact action diagnostic that
 * became the selected reply. A distinct evaluator or sub-planner summary stays
 * visible even when it follows an internal tool result.
 */
export function resolveActionResultTranscriptVisibility(
	text: string,
	actionResults: readonly ActionResult[] | undefined,
): "internal" | undefined {
	const canonicalize = (value: string) =>
		value
			.split(/\r?\n/)
			.map((line) => line.trim())
			.join("\n")
			.trim();
	const selected = canonicalize(text);
	if (!selected) return undefined;
	return actionResults?.some((result) => {
		if (result.transcriptVisibility !== "internal") return false;
		const candidates = typeof result.text === "string" ? [result.text] : [];
		const subSteps =
			result.data &&
			typeof result.data === "object" &&
			Array.isArray(result.data.subSteps)
				? result.data.subSteps
				: [];
		const terminalSubStep = subSteps.at(-1);
		if (
			terminalSubStep &&
			typeof terminalSubStep === "object" &&
			"internalTranscriptText" in terminalSubStep &&
			typeof terminalSubStep.internalTranscriptText === "string"
		) {
			candidates.push(terminalSubStep.internalTranscriptText);
		}
		return candidates.some((candidate) => canonicalize(candidate) === selected);
	})
		? "internal"
		: undefined;
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

export function cleanPriorDialogueSpeakerName(
	value: unknown,
): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().split(/\s+/).join(" ");
	if (!normalized) return undefined;
	return toWellFormedUnicode(normalized);
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

/**
 * How many of the agent's own prior turns the tool-planner context renders.
 * Enough to cover the pending question/preview plus a short back-and-forth,
 * small enough to keep the stale-answer surface and token cost bounded.
 */
const PLANNER_MAX_OWN_REPLY_TURNS = 4;

/**
 * Structural marker for an assistant memory whose text is a tool-derived
 * answer rather than plain dialogue: it carries merged action-callback
 * history, or its recorded actions include a real tool (anything beyond the
 * reply/none envelope). The planner context excludes these rows so a stale
 * tool-derived answer is never parroted in place of a fresh tool run.
 */
function appendPriorDialogueEvents(
	events: ContextEvent[],
	runtime: IAgentRuntime,
	state: State,
	currentMessage: Memory,
	options?: {
		includeOwnReplies?: boolean;
		/**
		 * Planner mode: keep ordinary own replies (questions, previews, acks —
		 * what "yes"/"finish it" refers to) while excluding tool-derived own
		 * answers structurally (stale-answer hazard) and bounding how many own
		 * turns render.
		 */
		excludeToolDerivedOwnReplies?: boolean;
		maxOwnReplies?: number;
	},
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
			// previously said. The tool planner keeps ordinary own dialogue too
			// (the question/preview a continuation turn refers to) but excludes
			// tool-derived own answers structurally so it never parrots a stale
			// tool result instead of running the fresh check. The artifact guards
			// below still strip non-dialogue agent output for every sender.
			if (m.entityId === runtime.agentId) {
				if (!includeOwnReplies) return false;
				if (
					options?.excludeToolDerivedOwnReplies === true &&
					isToolDerivedAssistantContent(m.content)
				) {
					return false;
				}
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
	// Bound how many of the agent's own turns render (newest win): the planner
	// needs the immediate question/preview a continuation refers to, not the
	// agent's whole side of a long conversation.
	const maxOwnReplies = options?.maxOwnReplies;
	if (maxOwnReplies !== undefined) {
		let ownRepliesKept = 0;
		for (let index = dialogue.length - 1; index >= 0; index--) {
			if (dialogue[index]?.entityId !== runtime.agentId) continue;
			ownRepliesKept++;
			if (ownRepliesKept > maxOwnReplies) {
				dialogue.splice(index, 1);
			}
		}
	}
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
		content.metadata &&
		typeof content.metadata === "object" &&
		!Array.isArray(content.metadata)
			? (content.metadata as Record<string, unknown>)
			: undefined;
	const source = typeof content.source === "string" ? content.source : "";
	return source === MESSAGE_SOURCE_SUB_AGENT && metadata?.subAgent === true;
}

function looksLikePriorDialogueArtifact(text: string): boolean {
	if (!text) return false;
	return /^\s*\[(?:sub-agent|tool output|tool result|command output)\b/im.test(
		text,
	);
}

function getStructuredRecentMessages(
	state: State | undefined,
): Memory[] | null {
	const providers = state?.data?.providers;
	if (!providers || typeof providers !== "object") {
		return null;
	}
	const recent = (providers as Record<string, unknown>).RECENT_MESSAGES;
	if (!recent || typeof recent !== "object") {
		return null;
	}
	const data = (recent as { data?: unknown }).data;
	const recentMessages =
		data && typeof data === "object" && "recentMessages" in data
			? (data as { recentMessages?: unknown }).recentMessages
			: undefined;
	return Array.isArray(recentMessages) ? (recentMessages as Memory[]) : null;
}

function hasStructuredRecentMessagesProvider(state: State): boolean {
	return getStructuredRecentMessages(state) !== null;
}

/**
 * Resolves an explicit continuation turn ("finish my request", "that is
 * good") to the nearest prior user request from the composed RECENT_MESSAGES
 * window so candidate inference reruns against the request the turn refers
 * to. Returns null for every non-continuation turn (topic switches, fresh
 * asks, and turns without structured history are untouched); the resolved
 * text feeds ONLY action-candidate inference — the prompt keeps the user's
 * literal message.
 */
function resolveContinuationInferenceMessageText(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
): string | null {
	const currentText = getUserMessageText(message);
	if (!currentText?.trim()) return null;
	const recentMessages = getStructuredRecentMessages(state);
	if (!recentMessages) return null;
	return resolveExplicitContinuationRequestText(
		currentText,
		recentMessages,
		runtime.agentId,
		message.entityId,
		message.id,
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
		.map((memory) => memory.content.text.trim())
		.filter(Boolean);
}

function appendStateProviderEvents(
	events: ContextEvent[],
	state: State,
	excludedProviderNames?: readonly string[],
	providerDefinitions?: readonly { name: string; cacheStable?: boolean }[],
): void {
	const providers = state.data?.providers;
	const excluded = excludedProviderNames
		? new Set(excludedProviderNames.map((name) => name.toUpperCase()))
		: null;
	// Provider.cacheStable lives on the registered provider definition, not on
	// composeState's per-call ProviderResult, so resolve it by name here and
	// stamp it on the event for context-renderer.ts to read.
	const cacheStableByName = new Map<string, boolean>();
	if (providerDefinitions) {
		for (const def of providerDefinitions) {
			if (typeof def.cacheStable === "boolean") {
				cacheStableByName.set(def.name.toUpperCase(), def.cacheStable);
			}
		}
	}
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
		const resolvedName =
			typeof provider.providerName === "string"
				? provider.providerName
				: providerName;
		events.push({
			id: `provider:${providerName}`,
			type: "provider",
			source: "composeState",
			name: resolvedName,
			text,
			cacheStable: cacheStableByName.get(resolvedName.toUpperCase()),
		});
	}
}

type V5PlannerActionSurfaceSummary = {
	mode: "full" | "tiered" | "relay-delivery";
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
	/** Out-param: normalized names and reasons for EXPLICIT stage-1 candidates
	 * rejected by the owner-exclusive disclosure gate.
	 * Lets the planner entry distinguish "capability exists but is gated on
	 * this surface" from ordinary no-match, and answer honestly instead of
	 * planning against an unrelated retrieval surface. */
	diagnostics?: {
		disclosureRejectedExplicitCandidates: string[];
		/** The disclosure reason per rejected explicit candidate, so the
		 * privacy short-circuit can answer accurately: a non-owner
		 * (`owner_mismatch`) needs a permission-truthful decline, while an owner
		 * on a group surface (`participant_mismatch`) needs the "ask me in a DM"
		 * routing hint. Same index order as
		 * `disclosureRejectedExplicitCandidates`. */
		disclosureRejectedReasons: string[];
		/** Normalized names of EXPLICIT stage-1 candidates rejected by a
		 * NON-disclosure gate: role/context/private-action (#20679), plus
		 * connector-account-policy denials, unavailable explicit capabilities,
		 * `validate() === false`, and failed policy/validation checks (#20869). A
		 * privacy denial only proves a disclosure boundary; when the same turn also
		 * has a non-disclosure rejection the request is compound, so the privacy
		 * short-circuit must stand down and let the planner/recovery path answer the
		 * non-disclosure limitation honestly. */
		nonDisclosureRejectedExplicitCandidates: string[];
	};
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
		explicitCandidateName?: string,
	): Promise<boolean> => {
		const normalizedName = normalizeActionIdentifier(action.name);
		if (!normalizedName || seen.has(normalizedName)) {
			return false;
		}
		// One gate for exposure and execution (#12087 Item 9): private-action gate
		// (private actions never reach the planner on a user turn) + ACTION_ROLE_POLICY
		// + contextGate + roleGate, all via the shared chokepoint.
		// Explicit Stage-1 hints need a diagnostic when their resolved action is
		// rejected. The all-action pass stays quiet because ordinary gate misses
		// are expected while building a narrowed surface.
		const gateRejection = actionGateRejection(action, {
			message: args.message,
			activeContexts,
			userRoles: args.userRoles,
		});
		if (gateRejection !== undefined) {
			if (explicitCandidateName) {
				if (gateRejection.kind === "disclosure") {
					args.diagnostics?.disclosureRejectedExplicitCandidates.push(
						action.name,
					);
					args.diagnostics?.disclosureRejectedReasons.push(
						gateRejection.reason,
					);
				} else {
					args.diagnostics?.nonDisclosureRejectedExplicitCandidates.push(
						action.name,
					);
				}
				args.runtime.logger.warn(
					{
						src: "service:message",
						action: action.name,
						candidate: explicitCandidateName,
						gate: "action-gate",
						reason: gateRejection.reason,
					},
					"Explicit stage-1 candidate rejected at the action gate",
				);
			}
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
				if (explicitCandidateName) {
					// An account-policy denial is a non-disclosure rejection: record it
					// so a mixed {disclosure + policy} set is visible to the privacy
					// short-circuit's onlyDisclosureRejections conjunct (#20869).
					args.diagnostics?.nonDisclosureRejectedExplicitCandidates.push(
						action.name,
					);
					args.runtime.logger.warn(
						{
							src: "service:message",
							action: action.name,
							candidate: explicitCandidateName,
							gate: "connector-account-policy",
							reason: accountPolicy.reason,
						},
						"Explicit stage-1 candidate rejected by connector account policy",
					);
				}
				return false;
			}
			if (action.validate) {
				const valid = await action.validate(
					args.runtime,
					args.message,
					args.state,
				);
				if (!valid) {
					if (explicitCandidateName) {
						// validate()===false is likewise a non-disclosure rejection
						// (#20869); without this record the mixed set short-circuits to
						// the privacy template — the #20679 mislabel class.
						args.diagnostics?.nonDisclosureRejectedExplicitCandidates.push(
							action.name,
						);
						args.runtime.logger.warn(
							{
								src: "service:message",
								action: action.name,
								candidate: explicitCandidateName,
								gate: "validate-returned-false",
								reason: `Action ${action.name} is not available for the current state`,
							},
							"Explicit stage-1 candidate rejected by action validate()",
						);
					}
					return false;
				}
			}
			seen.add(normalizedName);
			selectedActions.push(action);
			return true;
		} catch (error) {
			if (explicitCandidateName) {
				// Provider-policy and validate exceptions are fail-closed capability
				// rejections, not disclosure decisions. Preserve that distinction so
				// a sibling disclosure denial cannot mislabel the compound turn as
				// purely private.
				args.diagnostics?.nonDisclosureRejectedExplicitCandidates.push(
					action.name,
				);
			}
			// error-policy:J1 planner exposure fails closed for the affected action
			// while reporting the validation failure to the agent.
			args.runtime.reportError(
				"MessageService.plannerActionValidation",
				error,
				{
					action: action.name,
					parentAction: parentActionName,
				},
			);
			return false;
		}
	};

	for (const action of allRuntimeActions) {
		await appendIfAllowed(action);
	}

	const explicitCandidateActions = Array.isArray(args.candidateActions)
		? args.candidateActions
		: [];
	for (const candidateName of explicitCandidateActions) {
		// Resolve the synthetic candidate name Stage-1 invents to real actions:
		// first by exact name/simile, then by the shared parent-alias map that
		// retrieval already uses. The alias fallback lets an explicit permission
		// ask surface its writer (SETTINGS) even when Stage-1 mis-scoped the turn's
		// context (e.g. classified "revoke network access for the weather app" as
		// terminal/general): the candidate is an intent hint, so the resolved
		// parent is admitted under ITS OWN contexts — still gated on
		// role/private/context via appendIfAllowed (#14622).
		const direct = resolveRuntimeAction(actionLookup, candidateName);
		let resolved = direct
			? [direct]
			: parentAliasesForCandidateAction(candidateName)
					.map((alias) => resolveRuntimeAction(actionLookup, alias))
					.filter((action): action is Action => action !== undefined);
		if (resolved.length === 0) {
			// Stage-1 models emit reversed compound names (live 2026-08-19:
			// `CANCEL_TASKS` for `TASKS_CANCEL`). Same tokens, any order — admit
			// only an unambiguous single match; ambiguity keeps the warn below.
			const candidateTokenKey = actionNameTokenKey(candidateName);
			const tokenMatches = allRuntimeActions.filter(
				(action) => actionNameTokenKey(action.name) === candidateTokenKey,
			);
			if (tokenMatches.length === 1) {
				resolved = tokenMatches;
			}
		}
		if (resolved.length === 0) {
			const normalizedCandidate = normalizeActionIdentifier(candidateName);
			if (normalizedCandidate) {
				// A missing capability is another non-disclosure limitation. Recording
				// it keeps a simultaneous disclosure rejection from short-circuiting
				// the planner with an unrelated privacy-only response.
				args.diagnostics?.nonDisclosureRejectedExplicitCandidates.push(
					normalizedCandidate,
				);
			}
			args.runtime.logger.warn(
				{
					src: "service:message",
					candidate: candidateName,
					gate: "resolved-to-no-runtime-action",
				},
				"Explicit stage-1 candidate resolved to no runtime action",
			);
			continue;
		}
		for (const action of resolved) {
			await appendIfAllowed(
				action,
				undefined,
				mergeAgentContexts(args.selectedContexts, action.contexts),
				candidateName,
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

function actionNameTokenKey(name: string): string {
	return normalizeActionName(name).split("_").filter(Boolean).sort().join("_");
}

function getMessageHandlerCandidateActions(
	messageHandler: MessageHandlerResult,
): string[] {
	return stringArrayProperty(
		(messageHandler.plan as { candidateActions?: unknown }).candidateActions,
	);
}

// The two stage-1 plan fields the escalation predicates read as plain values.
// `candidateActions` stays per call site because the backstop path cleans it
// through `getMessageHandlerCandidateActions` while the evaluator path forwards
// the raw list. A stage-1 plan legitimately may carry no contexts and no reply,
// so an absent optional field normalizes to the empty shape those pure
// predicates already treat as "nothing there" — normalized here once instead of
// at every call site.
/**
 * Choose the honest decline for a gated owner-private ask, driven by the actual
 * gate-failure reason instead of a single hardcoded line. The old fixed reply
 * ("ask me in a DM") is correct ONLY when the asker is the owner on a shared
 * surface — for a genuine non-owner it is misleading advice, since a DM would
 * be denied too. Reasons come from `actionGateFailure` and end in the disclosure
 * decision reason (`participant_mismatch`, `owner_mismatch`, …).
 *
 *  - owner on a group/shared surface (`participant_mismatch` /
 *    `destination_not_private`) → the DM routing hint is accurate.
 *  - not the owner (`owner_mismatch`) → a permission-truthful decline with NO
 *    DM hint, because access, not surface, is missing.
 */
export function privacyDenialReplyForReasons(
	reasons: readonly string[],
): string {
	const joined = reasons.join(" | ").toLowerCase();
	const ownerOnWrongSurface =
		/participant_mismatch|destination_not_private/.test(joined);
	const notTheOwner = /owner_mismatch/.test(joined);
	// Owner-on-a-group takes precedence when multiple disclosure-gated candidates
	// fail for different audience reasons.
	if (ownerOnWrongSurface && !notTheOwner) {
		return "that's private, so i can't pull it up in a shared channel — ask me in a DM and i'll handle it there.";
	}
	if (notTheOwner) {
		return "that's the owner's private info, so i can't share it — it's only available to them.";
	}
	return "i can't share that private information in this conversation.";
}

function messageHandlerStageOneReplyContexts(
	messageHandler: MessageHandlerResult,
): { stageOneContexts: readonly string[]; stageOneReplyText: string } {
	return {
		stageOneContexts: messageHandler.plan.contexts ?? [],
		stageOneReplyText: String(messageHandler.plan.reply ?? ""),
	};
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
	restrictToCandidateActions?: boolean;
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
	reportError?: IAgentRuntime["reportError"];
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
	// A task_complete relay's only job is delivering the finished result. Any
	// catalog tool on this synthetic turn invites task-management
	// improvisation over the completed work (live 2026-08-19: the planner
	// ARCHIVED the just-completed task and told the user "Archived" instead
	// of relaying the result). Protocol tools (REPLY/IGNORE/STOP) remain.
	// Blocked/question/coordination relays keep the full surface — those turns
	// may legitimately act (answer a child, coordinate a sibling).
	if (
		isSubAgentCompletionArtifact(params.message) &&
		parseSubAgentTaskCompleteRelay(String(params.message.content?.text ?? ""))
	) {
		return {
			exposedActionNames: new Set<string>(),
			summary: {
				mode: "relay-delivery",
				candidateActionCount: params.actions.length,
				catalogParentCount: 0,
				exposedActionCount: 0,
				tierAParents: [],
				tierAChildrenByParent: {},
				tierBParents: [],
				omittedParentCount: 0,
				omittedParentNamesPreview: [],
				actionSurfaceHash: "relay-delivery",
				warnings: 0,
				queryTokens: [],
				candidateActions: [],
				parentActionHints: [],
			},
		};
	}
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
	if (params.restrictToCandidateActions && candidateActions.length > 0) {
		const allowed = new Set(candidateActions.map(normalizeActionIdentifier));
		for (const exposed of exposedActionNames) {
			if (!allowed.has(exposed)) exposedActionNames.delete(exposed);
		}
	}

	let fallback: string | undefined;
	if (
		params.actions.every(
			(action) =>
				!exposedActionNames.has(normalizeActionIdentifier(action.name)),
		)
	) {
		let addedFallbackAction = false;
		for (const result of retrieval.results) {
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

	// Selected-context representation guarantee: stage-1 routed this turn to
	// specific contexts, and a narrowed surface with ZERO callable actions for
	// a selected context contradicts that routing — the planner then improvises
	// with off-context tools (observed live: a web+notes composite surfaced
	// WEB_FETCH/WEB_SEARCH only, so the "save a note" half of the ask was
	// impossible and the turn ended on an in-flight claim with nothing saved).
	// For each selected context with no exposed representative, expose the
	// highest-ranked action that DECLARES the context; `params.actions` is the
	// already gate-checked collection, so this can never expose a gated action.
	for (const context of params.selectedContexts ?? []) {
		const normalizedContext = String(context).trim().toLowerCase();
		if (!normalizedContext || normalizedContext === "simple") continue;
		const declaresContext = (action: Action): boolean =>
			(action.contexts ?? []).some(
				(declared) =>
					String(declared).trim().toLowerCase() === normalizedContext,
			);
		const hasRepresentative = params.actions.some(
			(action) =>
				exposedActionNames.has(normalizeActionIdentifier(action.name)) &&
				declaresContext(action),
		);
		if (hasRepresentative) continue;
		const scoreByName = new Map(
			retrieval.results.map((result) => [
				normalizeActionIdentifier(result.name),
				result.score,
			]),
		);
		const best = params.actions
			.filter(declaresContext)
			.sort(
				(a, b) =>
					(scoreByName.get(normalizeActionIdentifier(b.name)) ?? 0) -
					(scoreByName.get(normalizeActionIdentifier(a.name)) ?? 0),
			)
			.at(0);
		if (best) {
			exposedActionNames.add(normalizeActionIdentifier(best.name));
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
					results: retrieval.results.map((r, idx) => ({
						name: r.name,
						score: r.score,
						rank: idx,
						rrfScore: r.rrfScore,
						matchedBy: r.matchedBy,
						// stageScores is Partial<Record<RetrievalStageName, number>>;
						// the telemetry field is the structurally-identical
						// Record<string, number>, so a plain cast is enough.
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
				// error-policy:J7 Tool-search recording is diagnostic; report the
				// missing stage without changing the selected action surface.
				params.reportError?.("MessageService.toolSearchStage", err, {
					trajectoryId,
				});
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
			omittedParentNamesPreview: tieredSurface.omittedParentNames,
			actionSurfaceHash: tieredSurface.actionSurfaceHash,
			warnings: catalog.warnings.length,
			queryTokens: retrieval.query.tokens,
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
	/**
	 * Structural "this turn does not address the agent" signal (the
	 * isUnaddressedTextGroupTurn classifier — channel type + addressing +
	 * source metadata, never message text). When set, the rendered context
	 * carries the ambient-turn policy instruction; absent/false renders
	 * byte-identical to before, so addressed turns are untouched.
	 */
	ambientTurn?: boolean;
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
	appendStateProviderEvents(
		events,
		args.state,
		renderExclusions,
		args.runtime.providers,
	);

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
		// chat recall ("did you tell me X?"). The tool planner needs the
		// ordinary ones too — the question/preview a continuation turn ("finish
		// it", "that is good") refers to — but role-wide inclusion resurrects
		// the stale-answer hazard, so the planner's window is bounded and
		// excludes tool-derived own answers structurally.
		includeOwnReplies: true,
		...(args.includeTools
			? {
					excludeToolDerivedOwnReplies: true,
					maxOwnReplies: PLANNER_MAX_OWN_REPLY_TURNS,
				}
			: {}),
	});

	// Contexts are routing taxonomy, not proof that a handler exists. Promise
	// beyond-window recall only when this role can execute the registered MEMORY
	// action and its declared discriminator explicitly includes search; custom
	// runtimes that register only the context must keep the honest bounded-window
	// response instead of escalating to a tool the planner cannot expose.
	const hasMemoryRecallSurface =
		(args.availableContexts ?? []).some((context) => context.id === "memory") &&
		(args.runtime.actions ?? []).some((action) => {
			if (normalizeActionIdentifier(action.name) !== "MEMORY") {
				return false;
			}
			const searchDiscriminator = action.parameters?.some((parameter) => {
				const name = normalizeActionIdentifier(parameter.name);
				if (name !== "ACTION" && name !== "OP") {
					return false;
				}
				// schema is required by ActionParameter, but an untyped third-party
				// plugin can register a malformed parameter; a capability probe must
				// not throw on it.
				return [
					...(parameter.schema?.enum ?? []),
					...(parameter.schema?.enumValues ?? []),
				].some((value) => normalizeActionIdentifier(value) === "SEARCH");
			});
			return (
				searchDiscriminator === true &&
				canActionRun(action, {
					message: args.message,
					activeContexts: ["memory"],
					userRoles: args.userRoles,
				})
			);
		});
	events.push({
		id: "current-turn-boundary",
		type: "instruction",
		source: "message-service",
		stable: false,
		content: args.includeTools
			? 'current_turn_boundary: Plan and execute only the final message:user. Prior messages and reply_reference are context for resolving references, never pending commands. The prior_message:agent blocks are your own earlier replies, shown only so you can resolve what a continuation like "finish it", "yes", or "that is good" refers to — treat every fact in them as stale. Stage 1 already decided this turn needs tools; use current tool results for live data and side effects, never answer by repeating a prior reply in place of executing the fresh check, and never claim work that no tool result proves.'
			: 'current_turn_boundary: The prior_message blocks above are context only. If a reply_reference block follows, it is the platform message that the final message:user is replying to; use it only to resolve references such as this/that/it. Execute and answer only the final message:user below. Do not merge separate prior requests into the current task unless the final message explicitly references them. Exception for visible-context recall: when the final message asks a recall question about what was said in this conversation (who mentioned X, did anyone bring up Y, what did I say about Z, what was the last message, did you yourself say W), you may scan the prior_message blocks above and answer from what is literally visible there. This recall exception covers only what was literally SAID in the visible chat. It does NOT cover the user\'s tracked work: a recap, status, or what-did-I-get-done ask about their todos, tasks, reminders, habits, goals, notes, or day ("recap my day", "what\'s left today", "did I finish everything", "how did I do this week") is a live tasks lookup, not chat recall — route it to the tasks tools and answer from what they return; never report an empty or missing day from the visible window alone.' +
				// Only the chat-recall context renders the agent's own prior turns;
				// the tool-planner context deliberately omits them (stale-answer
				// hazard), so this grounding sentence would be false there.
				(args.includeTools
					? ""
					: " Your own prior replies are the prior_message:agent blocks: when asked what YOU said, told, or promised earlier, answer only from those blocks — never assert you said something that does not appear in them, and never deny saying something that does.") +
				' Before saying you cannot find something, read the final message:user itself: if the asker states a fact and asks about it in the same message ("my favorite color is teal, what is my favorite color?"), answer from the current message directly.' +
				(hasMemoryRecallSurface
					? ' The prior_message blocks are only the most recent window of a longer stored conversation — older messages may exist that are not shown here, and the memory context can search them. When the asked-about token appears neither in the current message nor in any visible prior_message block, or the question asks about the conversation beyond the visible window ("how many times have I mentioned X", "have I ever told you about Y"), that is a live lookup over the stored record: route it to the memory context (set requiresTool) so the stored history is actually searched this turn. Never answer a beyond-window recall or count question from the visible window alone, never present the visible window as the whole conversation, and never claim you searched anything a tool did not return this turn. Run status is equally checkable: when the final message asks "what happened with [the build/app/task]" or disputes whether something you ran actually worked, treat it as a live verification request (set requiresTool) and CHECK the current task/sub-agent status with a tool before reporting, disclaiming, or conceding — never say you cannot verify a run you can look up.'
					: ' The prior_message blocks are the only conversation window you have, and there is no separate chat-history search tool. Only when the asked-about token appears neither in the current message nor in any visible prior_message block, say so plainly ("I don\'t see X in the recent messages I can see") rather than claiming you searched beyond the visible window or fabricating an action. If the user asks for a whole-conversation count or another exhaustive history claim ("how many times have I mentioned X", "have I ever told you Y"), never present visible matches as the full-history answer: either decline to give a total, or explicitly label any observation as limited to the recent messages you can see and say older history cannot be verified. This "no chat-history search" limit is about CHAT recall ONLY. It does NOT apply to what a task, build, deploy, or sub-agent YOU ran actually did: that run status IS verifiable with the task/sub-agent tools. So when the final message asks "what happened with [the build/app/task]" or disputes whether something you ran actually worked, treat it as a live verification request (set requiresTool) and CHECK the current task/sub-agent status with a tool before reporting, disclaiming, or conceding — never say you cannot verify a run you can look up.'),
	});

	// Prompt automations execute without a visible human message; their reply is
	// the delivered result. Make that boundary explicit so the model performs
	// the instruction instead of acknowledging framing the recipient never sees.
	if (args.message.content.source === MESSAGE_SOURCE_TRIGGER_PROMPT) {
		events.push({
			id: "trigger-automation-policy",
			type: "instruction",
			source: "message-service",
			stable: false,
			content:
				'trigger_automation_policy: The final message:user below is a scheduled automation of yours firing, not a person talking to you. Its "Do this now:" clause is the instruction you must carry out on this turn, and whatever you reply is delivered to the user as the automation\'s output. Produce that output: if the instruction is to remind, the reply IS the reminder addressed to the user — phrase it in your voice so it reads as a reminder arriving (lead with something like "reminder:" or equivalent), never a bare echo of the item text alone; if it is to check or report something, run the needed tools and reply with the result. Never reply with an acknowledgement of the instruction itself ("noted.", "got it", "will do") — the user never sees the instruction, so an acknowledgement reaches them as a bare non-sequitur.',
		});
	}

	// Ambient-turn policy (live incident tj-f637475edcb7bd): on an unaddressed
	// group turn the planner ran, produced no tool activity, and still shipped
	// the filler completion "I handled the available step." as the reply. The
	// planner prompt never told the model the turn was ambient, so it treated
	// "end the turn" as "compose a status". Rendered only when the caller's
	// structural classifier flagged the turn ambient — addressed turns (and
	// callers that do not pass the flag) render byte-identical context, and
	// the IGNORE terminal invoked here already flows to deliberate,
	// recorded non-delivery (see the planner deliberate-silence terminal in
	// runV5MessageRuntimeStage1).
	if (args.ambientTurn) {
		events.push({
			id: "ambient-turn-policy",
			type: "instruction",
			source: "message-service",
			stable: false,
			content:
				'ambient_turn_policy: The final message:user below was not addressed to you — it is other participants talking to each other, and no reply is expected from you. Contribute only if this turn\'s work produced something concrete and useful to those participants (a tool result, a substantive answer to what they are discussing). If your work yields nothing concrete to contribute, end the turn by calling the IGNORE tool — deliberate silence — instead of composing a reply. Never send a status update, a progress note, or a description of your own process (for example "I handled the available step") as the reply: on an unaddressed message, an empty outcome means silence.',
		});
	}

	// A fired prompt-automation is an INSTRUCTION to carry out now, not a
	// notification to acknowledge. Live incident 2026-08-05 01:00: a "take
	// vitamins" reminder fired and the turn replied "noted." — the model read
	// "Scheduled trigger ... fired. Do this now: <instructions>" as a status
	// message about itself and acknowledged it, so the user got an
	// acknowledgement instead of the reminder. Gated on the connector-set
	// source (never on message text), the same structural shape the ambient
	// classifier uses: the reply of an automation turn IS its user-facing
	// output.
	if (args.message.content.source === MESSAGE_SOURCE_TRIGGER_PROMPT) {
		events.push({
			id: "trigger-automation-policy",
			type: "instruction",
			source: "message-service",
			stable: false,
			content:
				'trigger_automation_policy: The final message:user below is a scheduled automation of yours firing, not a person talking to you. Its "Do this now:" clause is the instruction you must carry out on this turn, and whatever you reply is delivered to the user as the automation\'s output. Produce that output: if the instruction is to remind, the reply IS the reminder addressed to the user — phrase it in your voice so it reads as a reminder arriving (lead with something like "reminder:" or equivalent), never a bare echo of the item text alone; if it is to check or report something, run the needed tools and reply with the result. Never reply with an acknowledgement of the instruction itself ("noted.", "got it", "will do") — the user never sees the instruction, so an acknowledgement reaches them as a bare non-sequitur.',
		});
	}

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
		}
	}

	const systemPrompt = buildCanonicalSystemPrompt({
		character: args.runtime.character,
		userRole: args.userRoles?.[0],
	});
	// Chat style directions (style.all + style.chat) render exactly once here,
	// in the stable prefix. Computed statically from the character — not via the
	// per-room CHARACTER provider — so the KV-cacheable prefix stays
	// byte-identical across turns (#17026).
	const characterStyleDirections = buildCharacterStyleDirections({
		character: args.runtime.character,
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
			characterPrompt: characterStyleDirections
				? {
						id: "character-style",
						label: "system",
						content: characterStyleDirections,
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

// Shared with the planner-path REPLY guard and the planned-reply egress
// guard; the detectors live in a leaf module so the action can import them
// without pulling in this service.
import {
	replyClaimsCompletedSideEffect,
	replyClaimsEmptyTrackedWorkState,
} from "./message/side-effect-claims.ts";

export { replyClaimsCompletedSideEffect, replyClaimsEmptyTrackedWorkState };

export interface EligibleDirectActionRoute {
	rule: DirectActionRoutingRule;
	action: Action;
}

function routeReplacesStage1Candidate(
	rule: DirectActionRoutingRule,
	candidateActions: readonly string[] | undefined,
): boolean {
	const replacements = rule.replacesActionNames ?? [];
	if (replacements.length === 0 || !candidateActions?.length) return false;
	const candidates = new Set(candidateActions.map(normalizeActionIdentifier));
	return replacements.some((name) =>
		candidates.has(normalizeActionIdentifier(name)),
	);
}

/**
 * Resolve plugin-owned direct routes against the real execution surface for
 * this actor and turn. Context adjacency is deliberately insufficient:
 * CHOOSE_OPTION declares `tasks`, for example, but it neither owns tracked
 * work nor carries a read capability. Name + required tags + the shared action
 * gate + connector policy + validate() must all agree before core forces a
 * simple response into planning.
 */
export async function resolveEligibleDirectActionRoutes(args: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	userRoles?: readonly RoleGateRole[];
}): Promise<EligibleDirectActionRoute[]> {
	const messageText = getUserMessageText(args.message)?.trim() ?? "";
	if (!messageText) return [];
	const actionsByName = new Map(
		(args.runtime.actions ?? []).map((action) => [
			normalizeActionIdentifier(action.name),
			action,
		]),
	);
	const found: EligibleDirectActionRoute[] = [];
	const seen = new Set<string>();
	for (const rule of getDirectActionRoutingRules(args.runtime)) {
		if (!rule.matches(messageText)) continue;
		const requiredTags = new Set(
			rule.requiredActionTags.map((tag) => tag.trim().toLowerCase()),
		);
		for (const actionName of rule.actionNames) {
			const action = actionsByName.get(normalizeActionIdentifier(actionName));
			if (!action) continue;
			const actionTags = new Set(
				(action.tags ?? []).map((tag) => tag.trim().toLowerCase()),
			);
			if (![...requiredTags].every((tag) => actionTags.has(tag))) continue;
			const key = normalizeActionIdentifier(action.name);
			if (
				seen.has(key) ||
				!canActionRun(action, {
					message: args.message,
					activeContexts: mergeAgentContexts(rule.contexts, action.contexts),
					userRoles: args.userRoles,
				})
			) {
				continue;
			}
			try {
				const accountPolicy = await evaluateConnectorAccountPolicies(
					args.runtime,
					action,
					{ message: args.message },
				);
				if (
					!accountPolicy.allowed ||
					!(await action.validate(args.runtime, args.message, args.state))
				) {
					continue;
				}
			} catch (error) {
				// error-policy:J4 explicit user-facing degrade — a route whose
				// availability check fails stays unavailable for this turn; the
				// unchanged Stage-1 answer remains the visible fallback.
				args.runtime.logger.warn(
					{
						src: "service:message",
						route: rule.id,
						action: action.name,
						error,
					},
					"Skipping direct action route whose availability check failed",
				);
				continue;
			}
			seen.add(key);
			found.push({ rule, action });
		}
	}
	return found;
}

export type PlannedReplyClaimKind =
	| "completed_side_effect"
	| "empty_tracked_state";

function appliedEffectReceiptIdsForReply(
	reply: string,
	results: readonly ActionResult[],
): readonly string[] {
	const normalizedReply = reply.trim();
	if (!normalizedReply) return [];
	const allTurnReceipts = mergeEffectReceipts(
		...results.map((result) => result.effectReceipts),
	);
	for (const result of results) {
		if (result.userFacingText?.trim() !== normalizedReply) continue;
		const receipts = resolveAppliedUserFacingEffectReceipts(
			result,
			allTurnReceipts,
		);
		if (receipts) {
			return receipts.map((receipt) => receipt.receiptId);
		}
	}
	return [];
}

function uniqueAppliedCanonicalActionReply(
	results: readonly ActionResult[],
): string | null {
	const allTurnReceipts = mergeEffectReceipts(
		...results.map((result) => result.effectReceipts),
	);
	const candidates = new Set<string>();
	for (const result of results) {
		const text = result.userFacingText?.trim();
		if (result.verifiedUserFacing !== true || !text) continue;
		if (!resolveAppliedUserFacingEffectReceipts(result, allTurnReceipts)) {
			continue;
		}
		candidates.add(text);
	}
	return candidates.size === 1
		? (candidates.values().next().value ?? null)
		: null;
}

/**
 * An action result grounds only the capability it actually proves.
 * Empty tracked-work claims require a `resource:tracked-work` read action.
 * Completion claims require exact action-owned text bound to an active
 * committed receipt from this turn — applied, or a replayed no-op proving the
 * desired state was already committed; bare success, previews, non-replayed
 * no-ops, failures, and rolled-back effects cannot ground them.
 */
export function plannedReplyHasClaimGroundingReceipt(args: {
	kind: PlannedReplyClaimKind;
	reply: string;
	results: readonly ActionResult[];
	actions: readonly Action[];
}): boolean {
	const actionsByName = new Map(
		args.actions.map((action) => [
			normalizeActionIdentifier(action.name),
			action,
		]),
	);
	return args.results.some((result) => {
		const canonicalUserFacingText = result.userFacingText?.trim();
		if (
			result.verifiedUserFacing !== true ||
			!canonicalUserFacingText ||
			canonicalUserFacingText !== args.reply.trim()
		) {
			return false;
		}
		if (args.kind === "completed_side_effect") {
			return (
				appliedEffectReceiptIdsForReply(args.reply, args.results).length > 0
			);
		}
		if (result.success !== true) return false;
		const actionName =
			typeof result.data?.actionName === "string" ? result.data.actionName : "";
		const action = actionsByName.get(normalizeActionIdentifier(actionName));
		if (!action) return false;
		const tags = new Set(
			(action.tags ?? []).map((tag) => tag.trim().toLowerCase()),
		);
		if (args.kind === "empty_tracked_state") {
			if (!tags.has("resource:tracked-work") || !tags.has("capability:read")) {
				return false;
			}
			const isMixedMutationSurface = [
				"capability:write",
				"capability:update",
				"capability:delete",
				"capability:schedule",
			].some((tag) => tags.has(tag));
			if (!isMixedMutationSurface) return true;
			const claimGrounding = result.data?.claimGrounding;
			return (
				Array.isArray(claimGrounding) &&
				claimGrounding.includes("empty_tracked_state")
			);
		}
		return false;
	});
}

/** Egress decision for a planner-composed final reply (see below). */
export type PlannedReplyEgressDecision =
	| { verdict: "allow" }
	| {
			verdict: "reject";
			kind: PlannedReplyClaimKind;
			fallbackReply: string;
	  };

const UNVERIFIED_EFFECT_REPLY =
	"I couldn't verify that the requested change was completed, so I won't claim it was. Want me to try again?";

/**
 * Final planned replies may assert only state proven by a matching action
 * receipt from this trajectory. Rejection degrades to an honest statement at
 * this boundary; it never starts a second planner trajectory, which would lose
 * the first trajectory's results and could replay a partially-applied effect.
 */
export function evaluatePlannedReplyEgress(args: {
	reply: string;
	actionResults: readonly ActionResult[];
	actions: readonly Action[];
}): PlannedReplyEgressDecision {
	const reply = args.reply.trim();
	if (!reply) return { verdict: "allow" };
	if (replyClaimsCompletedSideEffect(reply)) {
		if (
			plannedReplyHasClaimGroundingReceipt({
				kind: "completed_side_effect",
				reply,
				results: args.actionResults,
				actions: args.actions,
			})
		) {
			return { verdict: "allow" };
		}
		return {
			verdict: "reject",
			kind: "completed_side_effect",
			// The planner may paraphrase a receipt-backed action by only punctuation
			// or casing. Preserve the action's exact canonical text instead of
			// replacing a real success with a false verification failure. Multiple
			// distinct effects remain ambiguous and continue to fail closed.
			fallbackReply:
				uniqueAppliedCanonicalActionReply(args.actionResults) ??
				UNVERIFIED_EFFECT_REPLY,
		};
	}
	if (replyClaimsEmptyTrackedWorkState(reply)) {
		if (
			plannedReplyHasClaimGroundingReceipt({
				kind: "empty_tracked_state",
				reply,
				results: args.actionResults,
				actions: args.actions,
			})
		) {
			return { verdict: "allow" };
		}
		return {
			verdict: "reject",
			kind: "empty_tracked_state",
			fallbackReply:
				"I wasn't able to check your tracked tasks and notes just now, so I can't give you an accurate picture of the day. Want me to try again?",
		};
	}
	return { verdict: "allow" };
}

/**
 * True when any of the turn's candidate actions resolves to a registered
 * action flagged `asyncHandoff` — work whose execution continues after the
 * turn returns (sub-agent spawn class). This is the structural gate for the
 * Stage-1 pre-planner early ack: an ack ahead of the final reply is only
 * warranted when the routed work is an async handoff; synchronous retrieval
 * turns deliver a single reply (the answer) on every channel. Candidates are
 * matched against canonical names AND similes because Stage 1 routinely
 * hints an action by one of its similes.
 */
export function candidateActionsIncludeAsyncHandoff(
	actions: readonly Action[] | undefined,
	candidateActionNames: readonly string[],
): boolean {
	if (!actions || actions.length === 0 || candidateActionNames.length === 0) {
		return false;
	}
	const candidates = new Set(
		candidateActionNames.map((name) => normalizeActionIdentifier(name)),
	);
	return actions.some(
		(action) =>
			action.asyncHandoff === true &&
			[action.name, ...(action.similes ?? [])].some((identifier) =>
				candidates.has(normalizeActionIdentifier(identifier)),
			),
	);
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
			name: "core.direct_registered_capability_request",
			description:
				"Promotes or reconciles a plugin-declared current-turn intent only when a matching, capability-tagged action is executable for this actor.",
			priority: 15,
			shouldRun: ({ message, messageHandler, runtime }) => {
				if (messageHandler.processMessage !== "RESPOND") return false;
				if (isSubAgentCompletionArtifact(message)) return false;
				const nonSimpleContexts = (messageHandler.plan.contexts ?? []).filter(
					(context) => context !== SIMPLE_CONTEXT_ID,
				);
				const text = getUserMessageText(message)?.trim() ?? "";
				if (text.length === 0) return false;
				const matchingRules = getDirectActionRoutingRules(runtime).filter(
					(rule) => rule.matches(text),
				);
				if (matchingRules.length === 0) return false;
				// A plugin may reconcile an already-tool-bearing/non-simple plan only
				// for the explicit fallback candidates it owns. All other plans keep
				// their Stage-1 route, even when their text happens to match.
				if (
					messageHandler.plan.requiresTool === true ||
					nonSimpleContexts.length > 0
				) {
					return matchingRules.some((rule) =>
						routeReplacesStage1Candidate(
							rule,
							messageHandler.plan.candidateActions,
						),
					);
				}
				return true;
			},
			evaluate: async ({
				message,
				messageHandler,
				state,
				runtime,
				userRoles,
			}) => {
				const text = getUserMessageText(message)?.trim() ?? "";
				const declaredReplacementRules = new Set(
					getDirectActionRoutingRules(runtime).filter(
						(rule) =>
							rule.matches(text) &&
							routeReplacesStage1Candidate(
								rule,
								messageHandler.plan.candidateActions,
							),
					),
				);
				const routes = await resolveEligibleDirectActionRoutes({
					runtime,
					message,
					state,
					userRoles,
				});
				if (routes.length === 0) return undefined;
				// A declared owner keeps exclusive reconciliation authority even when
				// its action is unavailable. Falling through to a second text-matching
				// direct route could execute adjacent work now instead of preserving the
				// original Stage-1 fallback.
				const replacingRoutes =
					declaredReplacementRules.size > 0
						? routes.filter(({ rule }) => declaredReplacementRules.has(rule))
						: [];
				if (declaredReplacementRules.size > 0 && replacingRoutes.length === 0) {
					return undefined;
				}
				const selectedRoutes =
					replacingRoutes.length > 0 ? replacingRoutes : routes;
				const replacedActionNames = new Set(
					replacingRoutes.flatMap(({ rule }) =>
						(rule.replacesActionNames ?? []).map(normalizeActionIdentifier),
					),
				);
				const retainedStage1Candidates = (
					messageHandler.plan.candidateActions ?? []
				).filter(
					(candidate) =>
						!replacedActionNames.has(normalizeActionIdentifier(candidate)),
				);
				const candidateActions = uniqueActionNames([
					...retainedStage1Candidates,
					...selectedRoutes.map(({ action }) => action.name),
				]);
				const contexts = mergeAgentContexts(
					...selectedRoutes.map(({ rule }) => rule.contexts),
				);
				return {
					requiresTool: true,
					addContexts: contexts,
					addCandidateActions: candidateActions,
					...(replacingRoutes.length > 0
						? { clearCandidateActions: true }
						: {}),
					// A deterministic read route must not emit Stage-1's speculative
					// answer or a progress bubble before the real action responds.
					clearReply: true,
					debug: [
						`current request matched executable direct route(s): ${selectedRoutes.map(({ rule }) => rule.id).join(", ")} -> ${candidateActions.join(", ")}`,
					],
				};
			},
		},
		{
			name: "core.simple_registered_action_request",
			description:
				"Promotes simple-path replies to planning when the current user request matches a registered action's metadata.",
			priority: 20,
			shouldRun: ({ message, messageHandler, runtime, state }) => {
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
				// A continuation turn ("finish it", "that is good") has no
				// inferable intent of its own — rerun inference on the resolved
				// nearest prior user request instead.
				const inferenceText =
					resolveContinuationInferenceMessageText(runtime, message, state) ??
					text;
				const inference = inferDirectCurrentRequestCandidateInference(
					runtime.actions ?? [],
					inferenceText,
				);
				if (inference.names.length === 0) return false;
				// Same escalation valve as messageHandlerFromFieldResult: this
				// evaluator re-runs the text inference on the SIMPLE path, so
				// without the valve it re-promotes the exact answered turn the
				// structured path just declined to force-plan (and clears the
				// finished replyText for a planner turn that may never deliver it).
				return !shouldSuppressInferredCandidateEscalation({
					inference,
					...messageHandlerStageOneReplyContexts(messageHandler),
					stageOneCandidateActions: messageHandler.plan.candidateActions ?? [],
				});
			},
			evaluate: ({ message, messageHandler, runtime, state }) => {
				const text = getUserMessageText(message) ?? "";
				const inferenceText =
					resolveContinuationInferenceMessageText(runtime, message, state) ??
					text;
				const inference = inferDirectCurrentRequestCandidateInference(
					runtime.actions ?? [],
					inferenceText,
				);
				const candidateActions = shouldSuppressInferredCandidateEscalation({
					inference,
					...messageHandlerStageOneReplyContexts(messageHandler),
					stageOneCandidateActions: messageHandler.plan.candidateActions ?? [],
				})
					? []
					: inference.names;
				if (candidateActions.length === 0) return undefined;
				return {
					requiresTool: true,
					addContexts: ["general"],
					addCandidateActions: candidateActions,
					// Escalation is a routing decision, not a delivery: never
					// synthesize user-visible ack text here. The early-reply path and
					// the final-path fallbacks own what (if anything) the user sees.
					clearReply: true,
					debug: [
						`current request matched registered action metadata: ${candidateActions.join(", ")}`,
					],
				};
			},
		},
		{
			// A simple-path turn runs NO tools, so a reply asserting a completed
			// scheduling/save side effect is fabricated by construction. Reroute the
			// turn to the planner so a real action performs the work and the
			// confirmation the user reads is grounded in a tool result. Candidate
			// hints come from the plugin-registered backstop rules (matched against
			// the fabricated claim's own vocabulary), so core stays free of
			// plugin-specific action names.
			name: "core.simple_completed_side_effect_claim",
			description:
				"Blocks simple-path replies that claim an already-completed scheduling/save side effect no tool performed; reroutes the turn to the planner.",
			priority: 30,
			shouldRun: ({ messageHandler }) => {
				if (messageHandler.processMessage !== "RESPOND") return false;
				if (messageHandler.plan.requiresTool === true) return false;
				const nonSimpleContexts = (messageHandler.plan.contexts ?? []).filter(
					(context) => context !== SIMPLE_CONTEXT_ID,
				);
				if (nonSimpleContexts.length > 0) return false;
				const reply =
					typeof messageHandler.plan.reply === "string"
						? messageHandler.plan.reply
						: "";
				return (
					messageHandler.plan.replyEffectStatus === "applied" ||
					replyClaimsCompletedSideEffect(reply)
				);
			},
			evaluate: ({ messageHandler, runtime }) => {
				const reply =
					typeof messageHandler.plan.reply === "string"
						? messageHandler.plan.reply
						: "";
				const candidateActions = [
					...new Set(
						getCandidateActionBackstopRules(runtime)
							.filter((rule) => rule.matches(reply))
							.flatMap((rule) => [...rule.actionNames]),
					),
				];
				return {
					requiresTool: true,
					addContexts: ["general"],
					...(candidateActions.length > 0
						? { addCandidateActions: candidateActions }
						: {}),
					// Escalation is a routing decision, not a delivery: drop the
					// fabricated claim instead of synthesizing an ack in its place.
					clearReply: true,
					debug: [
						`simple reply claimed a completed side effect with no tool run; rerouting to the planner (candidates: ${candidateActions.join(", ") || "none"})`,
					],
				};
			},
		},
		{
			name: "core.simple_empty_tracked_state_claim",
			description:
				"Replaces an empty tracked-work claim with an honest unavailable state when a declared recap route has no executable reader.",
			priority: 30,
			shouldRun: ({ message, messageHandler, runtime }) => {
				if (messageHandler.processMessage !== "RESPOND") return false;
				if (messageHandler.plan.requiresTool === true) return false;
				const nonSimpleContexts = (messageHandler.plan.contexts ?? []).filter(
					(context) => context !== SIMPLE_CONTEXT_ID,
				);
				if (nonSimpleContexts.length > 0) return false;
				const reply =
					typeof messageHandler.plan.reply === "string"
						? messageHandler.plan.reply
						: "";
				if (!replyClaimsEmptyTrackedWorkState(reply)) return false;
				const text = getUserMessageText(message)?.trim();
				return (
					Boolean(text) &&
					getDirectActionRoutingRules(runtime).some((rule) =>
						rule.matches(text ?? ""),
					)
				);
			},
			evaluate: () => {
				return {
					requiresTool: false,
					reply:
						"I wasn't able to check your tracked tasks and notes just now, so I can't give you an accurate picture of the day. Want me to try again?",
					debug: [
						"blocked an empty tracked-work assertion because the declared read route was unavailable",
					],
				};
			},
		},
	];

const VOICE_ENGAGEMENT_RULES = [
	"- shouldRespond=RESPOND for a completed caller question, request, substantive statement, or conversational continuation.",
	"- shouldRespond=IGNORE for content-free acknowledgements, non-speech/noise, or ambient speech clearly not addressed to the agent.",
	"- shouldRespond=STOP only when the caller explicitly asks the agent to disengage or end the conversation.",
	"- Do not use IGNORE merely because the answer is brief, uncertain, or requires a tool.",
].join("\n");

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
 * "respond with the word HELLO", "output PONG!", and the quantified forms
 * "Reply with the single word: PONG" / "reply with one word: PONG" (the
 * acceptance-gate smoke phrasing). The lightweight sibling of
 * {@link parseExactWordsInstruction} (which requires the explicit
 * "...with exactly N words: ..." form). Anchored to the whole message and a
 * single word, so it only fires on a clear "say <token>" request — not
 * "say something nice about cats". Between the verb and the literal only
 * complete connector units may appear ("with", "the word", "the single word",
 * "one word", …) — never bare determiners, so "write a poem" cannot parse as
 * a request to say "poem". Returns the requested literal or null.
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
		/^(?:(?:can|could|would|will)\s+you\s+|please\s+|just\s+|kindly\s+){0,3}(?:say|reply|respond|answer|output|return|write|type|echo|print)(?:\s+(?:with|back|(?:(?:the|a|an)\s+)?(?:single|one)\s+(?:word|phrase|token)|the\s+(?:word|phrase|token))){0,2}\s*:?\s*["'“”‘’]?([\p{L}\p{N}]{1,40})["'“”‘’]?\s*[.!?]*$/iu,
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
		voiceDirectMessage?: boolean;
		responseHandlerFields?: string;
	},
): string {
	const baseline = resolveOptimizedPromptForRuntime(
		runtime,
		selectMessageHandlerTask(availableContexts),
		messageHandlerTemplate,
	);
	const rendered = composePrompt({
		state: {
			directMessage: options?.directMessage ? "true" : "",
			availableContexts: formatAvailableContextsForPrompt(availableContexts),
			handleResponseToolName: HANDLE_RESPONSE_TOOL_NAME,
		},
		template: baseline,
	}).trim();
	const renderedWithVoiceRules = options?.voiceDirectMessage
		? [rendered, "", "voice engagement rules:", VOICE_ENGAGEMENT_RULES].join(
				"\n",
			)
		: rendered;
	const renderedWithSharedRules = [
		renderedWithVoiceRules,
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
		voiceDirectMessage?: boolean;
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
	const currentTurnBoundary = dynamicSegments.filter(
		(segment) => segment.id === "current-turn-boundary",
	);
	const remainingDynamicSegments = dynamicSegments.filter(
		(segment) => segment.id !== "current-turn-boundary",
	);
	const priorDialogueSegments = remainingDynamicSegments.filter(
		(segment) => segment.label?.startsWith("prior_message:") === true,
	);
	const dynamicProviderSegments = remainingDynamicSegments.filter(
		(segment) => segment.label?.startsWith("provider:") === true,
	);
	const turnTailSegments = remainingDynamicSegments.filter(
		(segment) =>
			segment.label?.startsWith("prior_message:") !== true &&
			segment.label?.startsWith("provider:") !== true,
	);
	// The boundary follows untrusted dialogue so stored messages cannot supersede
	// it with structural-looking text. Providers remain adjacent after that
	// boundary, preserving their reusable prefix before the current message.
	const orderedDynamicSegments = [
		...priorDialogueSegments,
		...currentTurnBoundary,
		...dynamicProviderSegments,
		...turnTailSegments,
	];
	const promptSegments = normalizePromptSegments([
		...stableSegments,
		{ content: `message_handler_stage:\n${instructions}`, stable: true },
		...orderedDynamicSegments,
	]);
	const systemContent = normalizePromptSegments([
		...stableSegments,
		{ content: `message_handler_stage:\n${instructions}`, stable: true },
	])
		.map(segmentBlock)
		.join("\n\n");
	const userContent = normalizePromptSegments(orderedDynamicSegments)
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
		extraProviderExclusions: ambientTurnProviderExclusions(
			runtime,
			syntheticMessage,
		),
		// Per-turn exclusions so the stable-prefix render is owned by the same
		// gate as every live render; the synthetic VOICE_DM message classifies
		// as addressed, so today this resolves to the static set.
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

/**
 * Budget for the Stage-1 duplicated-stream canonicalizer. The values walked
 * here are `JSON.parse` products of planner output — `error-policy:J3 planner
 * output is untrusted model input` — so the walk is bounded the way
 * `database/connector-json.ts` bounds connector JSON: a depth cap, a node
 * budget charged BEFORE any per-child allocation, an output-size budget, and a
 * path-local cycle guard that still accepts an honest DAG.
 *
 * Overflow is a typed failure, never a truncated canonical form. A lossy
 * normalizer (`services/trajectory-json.ts` replaces an over-depth branch with
 * `"[MaxDepth]"`) cannot back this comparison: two DIFFERENT over-budget
 * fragments would canonicalize to the same string and the equality check below
 * would accept a stream the model never actually repeated.
 */
const MAX_TOOL_ARGUMENT_CANONICAL_DEPTH = 32;
const MAX_TOOL_ARGUMENT_CANONICAL_NODES = 20_000;
const MAX_TOOL_ARGUMENT_CANONICAL_OUTPUT_CHARS = 4 * 1024 * 1024;
const TOOL_ARGUMENT_CANONICAL_UNBOUNDED = "TOOL_ARGUMENT_CANONICAL_UNBOUNDED";

type CanonicalJsonOverflowReason =
	| "accessor"
	| "chars"
	| "cycle"
	| "depth"
	| "nodes"
	| "reflection";

type CanonicalJsonState = {
	nodes: number;
	chars: number;
	readonly visiting: WeakSet<object>;
};

function createCanonicalJsonState(): CanonicalJsonState {
	return { nodes: 0, chars: 0, visiting: new WeakSet<object>() };
}

function failCanonicalJsonUnbounded(
	reason: CanonicalJsonOverflowReason,
	context: Record<string, unknown> = {},
	cause?: unknown,
): never {
	throw new ElizaError(`planner tool arguments are unbounded (${reason})`, {
		code: TOOL_ARGUMENT_CANONICAL_UNBOUNDED,
		severity: "ephemeral",
		context: {
			reason,
			maxDepth: MAX_TOOL_ARGUMENT_CANONICAL_DEPTH,
			maxNodes: MAX_TOOL_ARGUMENT_CANONICAL_NODES,
			maxOutputChars: MAX_TOOL_ARGUMENT_CANONICAL_OUTPUT_CHARS,
			...context,
		},
		...(cause !== undefined ? { cause } : {}),
	});
}

function isCanonicalJsonUnboundedError(error: unknown): boolean {
	return (
		error instanceof ElizaError &&
		error.code === TOOL_ARGUMENT_CANONICAL_UNBOUNDED
	);
}

function chargeCanonicalNodes(state: CanonicalJsonState, count: number): void {
	state.nodes += count;
	if (state.nodes > MAX_TOOL_ARGUMENT_CANONICAL_NODES) {
		failCanonicalJsonUnbounded("nodes", { nodes: state.nodes });
	}
}

function chargeCanonicalChars(state: CanonicalJsonState, count: number): void {
	state.chars += count;
	if (state.chars > MAX_TOOL_ARGUMENT_CANONICAL_OUTPUT_CHARS) {
		failCanonicalJsonUnbounded("chars", { chars: state.chars });
	}
}

function canonicalOwnDescriptor(
	value: object,
	key: PropertyKey,
): PropertyDescriptor | undefined {
	try {
		return Object.getOwnPropertyDescriptor(value, key);
	} catch (error) {
		// error-policy:J2 a hostile or revoked Proxy can make
		// getOwnPropertyDescriptor throw; rethrow as the typed unbounded
		// failure with the original preserved as `cause`, so the caller sees
		// one failure shape rather than a raw reflection error.
		failCanonicalJsonUnbounded("reflection", { key: String(key) }, error);
	}
}

/**
 * Own enumerable string-keyed data properties, read through descriptors only —
 * a getter is never invoked and a Proxy `get` trap never runs on untrusted
 * input. A `JSON.parse` product carries only data properties, so this selects
 * exactly the same keys `Object.entries` did for every value the live path
 * accepts today.
 */
function canonicalOwnEntries(
	value: object,
	state: CanonicalJsonState,
): Array<[string, unknown]> {
	let keys: readonly PropertyKey[];
	try {
		keys = Reflect.ownKeys(value);
	} catch (error) {
		// error-policy:J2 same shape as the descriptor read above — a revoked
		// Proxy makes Reflect.ownKeys throw, and it is rethrown as the typed
		// unbounded failure with the original as `cause`.
		failCanonicalJsonUnbounded("reflection", {}, error);
	}
	// Width is charged before the entry array is allocated.
	chargeCanonicalNodes(state, keys.length);
	const entries: Array<[string, unknown]> = [];
	for (const key of keys) {
		if (typeof key !== "string") continue;
		const descriptor = canonicalOwnDescriptor(value, key);
		if (!descriptor?.enumerable) continue;
		if (!("value" in descriptor)) {
			failCanonicalJsonUnbounded("accessor", { key });
		}
		entries.push([key, descriptor.value]);
	}
	return entries;
}

function canonicalArrayLength(
	value: object,
	state: CanonicalJsonState,
): number {
	const descriptor = canonicalOwnDescriptor(value, "length");
	if (
		!descriptor ||
		!("value" in descriptor) ||
		typeof descriptor.value !== "number" ||
		!Number.isSafeInteger(descriptor.value) ||
		descriptor.value < 0
	) {
		failCanonicalJsonUnbounded("reflection", { field: "length" });
	}
	// Width is charged before the element array is allocated.
	chargeCanonicalNodes(state, descriptor.value);
	return descriptor.value;
}

function canonicalJsonValue(
	value: unknown,
	state: CanonicalJsonState,
	depth: number,
): string {
	chargeCanonicalNodes(state, 1);
	if (Array.isArray(value)) {
		if (depth >= MAX_TOOL_ARGUMENT_CANONICAL_DEPTH) {
			failCanonicalJsonUnbounded("depth", { depth });
		}
		// Path-local: a repeated sibling reference (an honest DAG) still
		// canonicalizes; only a reference back into the current path is a cycle.
		if (state.visiting.has(value)) {
			failCanonicalJsonUnbounded("cycle", { depth });
		}
		const length = canonicalArrayLength(value, state);
		chargeCanonicalChars(state, 2 + Math.max(0, length - 1));
		state.visiting.add(value);
		try {
			const parts: string[] = [];
			for (let index = 0; index < length; index += 1) {
				const descriptor = canonicalOwnDescriptor(value, String(index));
				if (!descriptor) {
					// A hole: `Array.prototype.map` skipped it and `join` rendered it
					// as the empty string. Preserved byte-for-byte.
					parts.push("");
					continue;
				}
				if (!("value" in descriptor)) {
					failCanonicalJsonUnbounded("accessor", { index });
				}
				parts.push(canonicalJsonValue(descriptor.value, state, depth + 1));
			}
			return `[${parts.join(",")}]`;
		} finally {
			state.visiting.delete(value);
		}
	}
	if (value && typeof value === "object") {
		if (depth >= MAX_TOOL_ARGUMENT_CANONICAL_DEPTH) {
			failCanonicalJsonUnbounded("depth", { depth });
		}
		if (state.visiting.has(value)) {
			failCanonicalJsonUnbounded("cycle", { depth });
		}
		const entries = canonicalOwnEntries(value, state);
		chargeCanonicalChars(state, 2 + Math.max(0, entries.length - 1));
		entries.sort(([left], [right]) => left.localeCompare(right));
		state.visiting.add(value);
		try {
			const parts: string[] = [];
			for (const [key, entry] of entries) {
				const encodedKey = JSON.stringify(key);
				chargeCanonicalChars(state, encodedKey.length + 1);
				parts.push(
					`${encodedKey}:${canonicalJsonValue(entry, state, depth + 1)}`,
				);
			}
			return `{${parts.join(",")}}`;
		} finally {
			state.visiting.delete(value);
		}
	}
	const encoded = JSON.stringify(value) ?? "undefined";
	chargeCanonicalChars(state, encoded.length);
	return encoded;
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
		// error-policy:J3 planner output is untrusted model input; a single-object
		// parse miss continues to the explicit duplicated-stream recovery below.
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
			// error-policy:J3 each recovered fragment is untrusted model input; one
			// malformed object invalidates the duplicated-stream recovery.
			return null;
		}
	});
	if (parsedObjects.some((parsed) => !parsed)) {
		return null;
	}

	const [first, ...rest] = parsedObjects as Record<string, unknown>[];
	try {
		// A fresh budget per fragment: one fragment must never exhaust the budget
		// of the next, or the comparison would depend on stream position.
		const canonical = canonicalJsonValue(first, createCanonicalJsonState(), 0);
		if (
			rest.some(
				(entry) =>
					canonicalJsonValue(entry, createCanonicalJsonState(), 0) !==
					canonical,
			)
		) {
			return null;
		}
	} catch (error) {
		if (!isCanonicalJsonUnboundedError(error)) throw error;
		// error-policy:J3 an over-budget fragment is untrusted model input. The
		// duplicated-stream recovery declines it through the documented `null`
		// failure signal — Stage 1 then classifies the tool call as malformed and
		// runs its recovery chain — instead of exhausting the stack inside
		// `runV5MessageRuntimeStage1`, whose only catch rethrows to the message
		// boundary and ends the turn.
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

function userVisibleOutputClassification(
	output: Exclude<UserVisibleModelOutput, { kind: "empty" }>,
): string {
	if (output.kind === "control") {
		return `${output.malformed ? "malformed-" : ""}${output.envelope}`;
	}
	if (output.kind === "invalid") {
		return output.reason;
	}
	return output.format === "json" ? "unexpected-json" : "unexpected-text";
}

function reportRejectedUserVisibleModelOutput(args: {
	runtime: IAgentRuntime;
	scope: string;
	code: string;
	message: string;
	stage: string;
	output: Exclude<UserVisibleModelOutput, { kind: "empty" }>;
	context?: Record<string, unknown>;
}): void {
	args.runtime.reportError(
		args.scope,
		new ElizaError(args.message, {
			code: args.code,
			context: {
				stage: args.stage,
				classification: userVisibleOutputClassification(args.output),
				fieldPath: args.output.fieldPath,
				...args.context,
			},
			severity: "ephemeral",
		}),
	);
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
	const replyEffectStatus =
		result.replyEffectStatus === "applied" ||
		result.replyEffectStatus === "non_applied"
			? result.replyEffectStatus
			: "none";
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
	const directCurrentInference =
		!subAgentCompletionRelay && currentMessageText.trim().length > 0
			? inferDirectCurrentRequestCandidateInference(
					runtimeContext?.actions ?? [],
					currentMessageText,
				)
			: ({ names: [], kind: null } as DirectCurrentRequestCandidateInference);
	// A weak view-capability token overlap must not force-plan a turn Stage 1
	// already answered (see shouldSuppressInferredCandidateEscalation) — drop
	// the inferred candidates entirely so the turn keeps its direct reply.
	const directCurrentCandidateActions =
		shouldSuppressInferredCandidateEscalation({
			inference: directCurrentInference,
			stageOneContexts: rawContexts,
			stageOneReplyText: replyTextRaw,
			stageOneCandidateActions: rawCandidateActions,
		})
			? []
			: directCurrentInference.names;
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
	const candidateActionsBeforeSnippetGate = preferDirectCurrentCandidateActions
		? directCurrentCandidateActions
		: uniqueActionNames([
				...candidateActions,
				...inferredAckCandidateActions,
				...inferredDirectCandidateActions,
			]);
	// The planner answers a one-line snippet ask itself (inline code, or a
	// quick local FILE/SHELL); a delegation-class candidate would hand it to a
	// coding sub-agent instead. Stripped structurally, never by regex on the
	// reply (see inlineSnippetAsk below for the routing side).
	const effectiveCandidateActions =
		looksLikeInlineCodeSnippetRequest(currentMessageText) &&
		!looksLikeExplicitDelegationRequest(currentMessageText)
			? candidateActionsBeforeSnippetGate.filter(
					(name) =>
						!delegationCandidateNames(runtimeContext?.actions ?? []).has(
							normalizeActionIdentifier(name),
						),
				)
			: candidateActionsBeforeSnippetGate;
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
	// A one-line snippet ask is a class delegation never serves: a 25s
	// sub-agent build for `print("nubs")` whose code the user never even saw
	// (live 2026-08-22). Without an explicit "spawn/delegate" ask the model's
	// routing does not commit the turn to delegation.
	const inlineSnippetAsk =
		looksLikeInlineCodeSnippetRequest(currentMessageText) &&
		!looksLikeExplicitDelegationRequest(currentMessageText);
	const delegationTextGate = modelRoutedPlanningContext
		? !looksLikeDelegationExcludedAsk(currentMessageText) && !inlineSnippetAsk
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
		!looksLikeWebSearchRequest(currentMessageText) &&
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
		replyEffectStatus,
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
	// The model emitted NO candidate of its own (rawCandidateActions is what
	// Stage 1 actually named — an unregistered model candidate is still model
	// evidence, deliberately force-planned so the planner delivers the honest
	// capability decline), so the plan's candidates — and with them the
	// required-tool enforcement — stand on deterministic text inference alone
	// (coding backstop, ack inference, or direct inference). Record that so
	// the planner loop can accept a firmly repeated terminal answer early
	// instead of burning the full miss budget on a heuristic's guess. Coding
	// work is deliberately excluded: that inference is structurally anchored
	// to an operation plus a code artifact, and relaxing it lets a planner ship
	// a repeated progress/fallback answer without ever executing delegation.
	if (
		shouldPlan &&
		planCandidateActions.length > 0 &&
		rawCandidateActions.length === 0 &&
		directCurrentInference.kind !== "coding"
	) {
		plan.requiredToolEvidence = "inferred";
	}
	// The escalation came ONLY from the text-derived view-surface inference on
	// a turn Stage 1 already answered — cap the planner's miss budget so the
	// answer-rescue fires after one rejected reply instead of four (see
	// viewOverlapRequiredToolMissBudget).
	if (shouldPlan && inferredDirectCandidateActions.length > 0) {
		const inferredViewOverlapMissBudget = viewOverlapRequiredToolMissBudget({
			inference: directCurrentInference,
			stageOneContexts: rawContexts,
			stageOneReplyText: replyTextRaw,
			stageOneCandidateActions: rawCandidateActions,
		});
		if (inferredViewOverlapMissBudget !== undefined) {
			plan.requiredToolMissBudget = inferredViewOverlapMissBudget;
		}
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

	const directCurrentInference = inferDirectCurrentRequestCandidateInference(
		runtimeContext.actions,
		currentMessageText,
	);
	const directCurrentCandidateActions = directCurrentInference.names;
	if (directCurrentCandidateActions.length === 0) return messageHandler;
	// Same escalation valve as messageHandlerFromFieldResult: a plain-text
	// Stage-1 answer routed through this backstop must not be force-planned
	// over a weak view-capability token overlap either.
	if (
		shouldSuppressInferredCandidateEscalation({
			inference: directCurrentInference,
			...messageHandlerStageOneReplyContexts(messageHandler),
			stageOneCandidateActions:
				getMessageHandlerCandidateActions(messageHandler),
		})
	) {
		return messageHandler;
	}

	const stageOneCandidateActions =
		getMessageHandlerCandidateActions(messageHandler);
	const composedCandidateActions =
		directCurrentInference.kind === "owner-reads"
			? directCurrentCandidateActions
			: uniqueActionNames([
					...stageOneCandidateActions,
					...directCurrentCandidateActions,
				]);
	const runnableCandidateActions = filterRunnableCandidateActions(
		composedCandidateActions,
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
	// Same view-overlap miss-budget cap as the structured path's plan
	// construction: this backstop is the plain-text Stage-1 shape landing on
	// the identical escalation, so the answered-turn waste is identical too.
	const viewOverlapMissBudget = viewOverlapRequiredToolMissBudget({
		inference: directCurrentInference,
		...messageHandlerStageOneReplyContexts(messageHandler),
		stageOneCandidateActions: getMessageHandlerCandidateActions(messageHandler),
	});
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
			...(viewOverlapMissBudget !== undefined
				? { requiredToolMissBudget: viewOverlapMissBudget }
				: {}),
			// Same relaxable-inference stamp as the structured path. Strong coding
			// work orders keep the full corrective budget so a repeated terminal
			// fallback cannot impersonate completed delegation.
			...(getMessageHandlerCandidateActions(messageHandler).length === 0
				? directCurrentInference.kind !== "coding"
					? { requiredToolEvidence: "inferred" as const }
					: {}
				: {}),
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

// Built from the vocabulary single-sourced in planner-loop.ts (which cannot
// import from this module) so the two progress-reply classifiers — this one
// and the exhaustion-path PROGRESS_ONLY_ANSWER_REJECT — cannot drift apart
// when a new progress verb is added. Case-insensitivity comes from the caller
// lowercasing, not a flag, preserving the original matching exactly.
const PROGRESS_ONLY_REPLY_REGEX = new RegExp(
	`^(?:${PROGRESS_ONLY_REPLY_OPENERS_PATTERN})\\b`,
);

function looksLikeProgressOnlyReply(replyText: string): boolean {
	const normalized = replyText.trim().toLowerCase();
	if (!normalized) return false;
	if (PLANNING_ACK_REPLIES.has(normalized)) return true;
	return PROGRESS_ONLY_REPLY_REGEX.test(normalized);
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
/** Normalized names that hand a turn to a coding sub-agent: the registered
 *  delegation action plus the legacy aliases. Bare "TASKS" is the one alias
 *  that is ambiguous (task-list management as readily as delegation); callers
 *  that need an unambiguous commitment drop it. */
function delegationCandidateNames(
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
	opts?: { requireUnambiguous?: boolean },
): Set<string> {
	const delegationActionName = findCodingDelegationActionName(actions);
	if (!delegationActionName) return new Set();
	const legacyNames = opts?.requireUnambiguous
		? LEGACY_CODING_DELEGATION_ACTION_NAMES.filter((name) => name !== "TASKS")
		: LEGACY_CODING_DELEGATION_ACTION_NAMES;
	return new Set<string>([
		normalizeActionIdentifier(delegationActionName),
		...legacyNames.map(normalizeActionIdentifier),
	]);
}

function modelProvidedRunnableDelegationCandidate(
	candidateActions: readonly string[],
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
	opts?: { requireUnambiguous?: boolean },
): boolean {
	if (candidateActions.length === 0) return false;
	const wanted = delegationCandidateNames(actions, opts);
	if (wanted.size === 0) return false;
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

function inferDirectCurrentRequestCandidateInference(
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
	messageText: string,
): DirectCurrentRequestCandidateInference {
	return inferDirectCurrentRequestCandidateInferenceFromHeuristics(
		actions,
		messageText,
		{
			looksLikeCodingWorkRequest,
			findCodingDelegationActionName,
		},
	);
}

/**
 * True when a text-inferred (never model-emitted) candidate set must NOT
 * escalate this turn to a tool-required planner surface: Stage 1 already
 * ANSWERED the turn (only simple/absent contexts, a non-empty replyText, and
 * zero candidateActionNames of its own) and the only "evidence" for a tool is
 * a weak view-capability token overlap (e.g. "whats 17 TIMES 23" matching the
 * views action's "screen-time" tag via TIME). Observed live on both the app
 * REST surface and Discord (trajectories tj-501e594bfb23a7, tj-5d1c9601f33e8d):
 * the injected VIEWS candidate forced toolChoice=required, the planner's
 * correct terminal answer was rejected maxRequiredToolMisses times, and the
 * user got the generic transient-failure apology instead of the answer.
 *
 * Deliberately narrow — keyed on the Stage-1 plan SHAPE, not the connector:
 * model-emitted candidates always escalate, shell/coding/web inferences keep
 * their backstop behavior (live-info acks still force the fetch), and the
 * strong view inferences (explicit surface nouns, bare-name voice navigation)
 * still escalate so genuine view-switching UX is untouched.
 */
function shouldSuppressInferredCandidateEscalation(args: {
	inference: DirectCurrentRequestCandidateInference;
	stageOneContexts: readonly string[];
	stageOneReplyText: string;
	stageOneCandidateActions: readonly string[];
}): boolean {
	if (args.inference.kind !== "view-capability") return false;
	if (args.stageOneCandidateActions.length > 0) return false;
	if (args.stageOneReplyText.trim().length === 0) return false;
	// An ack-shaped reply ("On it.", "Let me pull that up.") is a delegation
	// commitment, not an answer — suppressing the candidate here would ship the
	// ack as the whole turn with nothing behind it (the ack-rescue paths only
	// cover shell/web/coding, never views). Only a genuinely answer-shaped
	// replyText qualifies the turn as "already answered".
	if (looksLikeProgressOnlyReply(args.stageOneReplyText)) return false;
	return !args.stageOneContexts.some(
		(context) => context.trim().toLowerCase() !== SIMPLE_CONTEXT_ID,
	);
}

/**
 * Per-turn required-tool miss-budget cap for the view-SURFACE flavor of the
 * waste `shouldSuppressInferredCandidateEscalation` suppresses outright for
 * view-capability overlaps. A view-surface inference on an already-answered
 * simple turn (live: "whats the best way to close a window in vim" — WINDOW
 * is a surface noun) must still escalate — a genuine "open the settings
 * window" ask needs the tool — but when the planner then keeps ANSWERING
 * instead of calling the view tool, every rejected answer burns a full
 * planner round and the exhaustion rescue ships the stage-1 answer anyway
 * (observed live: 18.5s, four rejected answers, right answer). Capping the
 * budget to 0 fires that rescue after ONE rejected answer.
 *
 * Two-sided gate keeps genuine view work on the full corrective budget: this
 * side requires the answer shape by the exhaustion path's own
 * PROGRESS_ONLY_ANSWER_REJECT superset (an ack such as "Opening the settings
 * panel." never qualifies), and the planner loop independently ignores the
 * cap unless the stage-1 text passes its answer-shape gate (see
 * PlannerLoopParams.requiredToolMissBudgetOverride). Shell / web / coding
 * inferences and bare-noun view navigation (#9950) never reach here — the
 * kind check excludes them.
 */
function viewOverlapRequiredToolMissBudget(args: {
	inference: DirectCurrentRequestCandidateInference;
	stageOneContexts: readonly string[];
	stageOneReplyText: string;
	stageOneCandidateActions: readonly string[];
}): number | undefined {
	if (args.inference.kind !== "view-surface") return undefined;
	if (args.stageOneCandidateActions.length > 0) return undefined;
	const replyText = args.stageOneReplyText.trim();
	if (replyText.length === 0) return undefined;
	if (PROGRESS_ONLY_ANSWER_REJECT.test(replyText)) return undefined;
	if (
		args.stageOneContexts.some(
			(context) => context.trim().toLowerCase() !== SIMPLE_CONTEXT_ID,
		)
	) {
		return undefined;
	}
	return 0;
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
					// error-policy:J3 Each candidate is untrusted model text;
					// malformed candidates are invalid while scanning continues.
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
	// directly while the guards still cover non-conforming provider output.
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
 * fixed by retrying, but hitting a completion limit cannot: regenerating at
 * the same token cap repeats the failure and burns a full Stage-1 turn. The
 * partial response is rejected explicitly. Exported for unit coverage.
 */
export function shouldRetryStage1Generation(
	reason: ReturnType<typeof getStage1RetryReason>,
	raw: string | GenerateTextResult,
	maxTokens: number | undefined,
): boolean {
	if (!reason) return false;
	return !stage1HitCompletionLimit(raw, maxTokens);
}

function synthesizeStage1CompletionLimitReply(): MessageHandlerResult {
	return {
		processMessage: "RESPOND",
		thought:
			"Stage 1 hit the completion limit and no complete replyText field could be recovered.",
		plan: {
			contexts: [SIMPLE_CONTEXT_ID],
			reply: STAGE1_COMPLETION_LIMIT_REPLY,
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
		// The resolved role decides the entire action surface for the turn, and
		// a silent fall to the floor is indistinguishable from an explicit
		// non-elevated grant without this line. `result === null` means no world
		// resolved for the message — the most common cause of an owner probe
		// landing on the floor.
		runtime.logger.debug(
			{
				src: "service:message",
				entityId: message.entityId,
				roomId: message.roomId,
				worldResolved: result !== null,
				role: result?.role ?? null,
			},
			"Stage 1 sender role resolved",
		);
		if (result?.role) {
			return result.role as RoleGateRole;
		}
	} catch (error) {
		// error-policy:J4 Role resolution fails closed to the source-aware floor.
		runtime.logger.debug(
			{ src: "service:message", error },
			"Stage 1 sender role lookup failed; using unresolved role floor",
		);
		runtime.reportError("MessageService.resolveSenderRole", error, {
			entityId: message.entityId,
			roomId: message.roomId,
		});
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

/**
 * Whether the routed action owns the response-handler's pre-planner reply.
 * A deterministic call is already selected, while relevance candidates are
 * only safe to trust when they all resolve to the same canonical action.
 */
function actionOwnsResponseHandlerEarlyReply(
	runtime: Pick<IAgentRuntime, "actions">,
	messageHandler: MessageHandlerResult,
): boolean {
	const actionLookup = buildRuntimeActionLookup(runtime);
	const deterministicToolCall = messageHandler.plan.deterministicToolCall;
	if (deterministicToolCall) {
		return (
			resolveRuntimeAction(actionLookup, deterministicToolCall.name)
				?.suppressEarlyReply === true
		);
	}

	const candidateNames = messageHandler.plan.candidateActions ?? [];
	if (candidateNames.length === 0) return false;

	const resolvedCandidates = new Map<string, Action>();
	for (const name of candidateNames) {
		if (typeof name !== "string" || !name.trim()) return false;
		const action = resolveRuntimeAction(actionLookup, name);
		if (!action) return false;
		resolvedCandidates.set(normalizeActionIdentifier(action.name), action);
	}

	if (resolvedCandidates.size !== 1) return false;
	return resolvedCandidates.values().next().value?.suppressEarlyReply === true;
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
	/**
	 * Normal planner selection may activate the selected action's routing
	 * contexts after that action was surfaced through the context-filtered tool
	 * set. Deterministic evaluator calls have no such planner-surface proof and
	 * must retain the turn's original contexts for the canonical gate.
	 */
	activateActionContexts?: boolean;
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

/**
 * Providers whose output is a retrieval over the turn's query text, so their
 * turn-cached result goes stale the moment an action introduces new textual
 * evidence mid-turn (an ATTACHMENT page read, a WEB_FETCH body). Names, not
 * references: the agent-side relevant-conversations provider registers by
 * name and core never imports it.
 */
const EVIDENCE_SENSITIVE_PROVIDER_NAMES = [
	"FACTS",
	"relevant-conversations",
] as const;

/**
 * Minimum characters of new action-result text that count as "new textual
 * evidence". Filters out terse control results (REPLY echoes, IGNORE, status
 * one-liners) so ordinary tool turns do not pay the re-retrieval cost.
 */
const EVIDENCE_INVALIDATION_MIN_CHARS = 200;

function actionResultEvidenceTextLength(result: ActionResult): number {
	let length = 0;
	if (typeof result.text === "string") length += result.text.length;
	if (typeof result.userFacingText === "string") {
		length += result.userFacingText.length;
	}
	const content = (result.data as Record<string, unknown> | undefined)?.content;
	if (typeof content === "string") length += content.length;
	return length;
}

/**
 * Within-turn freshness for retrieval providers (the c-node/Zcash gap): when
 * an action settles carrying substantive new text, evict the FACTS and
 * relevant-conversations entries from the turn's cached provider state so the
 * NEXT composeState — planner recompose with maximum reuse, the REPLY
 * action's compose, a continuation compose — re-runs retrieval with the new
 * evidence tokens in scope instead of reusing the pre-action output
 * (`provider-cache:FACTS cacheHit:true` was exactly how "ZCash" on a
 * just-read page never reached fact recall in the same turn). Eviction only;
 * nothing recomputes until a caller actually composes again, and the re-runs
 * are ~tens of ms against multi-second model calls.
 */
function invalidateEvidenceSensitiveProviderCache(
	runtime: IAgentRuntime,
	message: Memory,
	result: ActionResult,
): void {
	if (!message.id) return;
	if (
		actionResultEvidenceTextLength(result) < EVIDENCE_INVALIDATION_MIN_CHARS
	) {
		return;
	}
	const cached = runtime.stateCache?.get?.(message.id);
	const providers = cached?.data?.providers as
		| Record<string, unknown>
		| undefined;
	if (!providers || typeof providers !== "object") return;
	for (const name of EVIDENCE_SENSITIVE_PROVIDER_NAMES) {
		if (name in providers) delete providers[name];
	}
}

export function __invalidateEvidenceSensitiveProviderCacheForTests(
	runtime: IAgentRuntime,
	message: Memory,
	result: ActionResult,
): void {
	invalidateEvidenceSensitiveProviderCache(runtime, message, result);
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
	const executorCtx =
		action && args.activateActionContexts !== false
			? {
					...args.executorCtx,
					activeContexts: mergeAgentContexts(
						args.executorCtx.activeContexts,
						action.contexts,
					),
				}
			: args.executorCtx;
	if (
		action &&
		actionHasSubActions(action) &&
		args.activateActionContexts === false
	) {
		const gateFailure = actionGateFailure(action, executorCtx);
		if (gateFailure) {
			return { success: false, error: gateFailure, text: gateFailure };
		}
	}

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

	const rawActionResult = await executePlannedToolCall(
		args.runtime,
		executorCtx,
		toolCall,
		{ ...(args.executorOptions ?? {}), actions: executionActions },
	);
	invalidateEvidenceSensitiveProviderCache(
		args.runtime,
		args.executorCtx.message,
		rawActionResult,
	);
	const actionResult = projectActionResultForClipboard(
		action,
		rawActionResult,
		toolCall.name,
	);
	return actionResultToPlannerToolResult(actionResult, {
		summary: summarizeActionResultForPlanner(
			action,
			actionResult,
			toolCall.params,
			args.runtime,
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
	callDigest: string;
	retryable: boolean;
	summary?: string;
	internalTranscriptText?: string;
	error?: string;
}

function normalizeSubStepText(text: string): string {
	return toWellFormedUnicode(text.trim());
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
			callDigest: subPlannerCallDigest(step.toolCall),
			retryable: result.data?.retryable !== false,
			...(summarySource
				? { summary: normalizeSubStepText(summarySource) }
				: {}),
			...(result.transcriptVisibility === "internal" &&
			typeof result.text === "string"
				? { internalTranscriptText: result.text }
				: {}),
			...(errorText ? { error: normalizeSubStepText(errorText) } : {}),
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
	const allSteps = [
		...(subResult.trajectory.archivedSteps ?? []),
		...subResult.trajectory.steps,
	];
	const lastStep = allSteps[allSteps.length - 1];
	const success = evaluator?.success ?? lastStep?.result?.success ?? true;
	const userFacingText = subResult.finalMessage ?? evaluator?.messageToUser;
	const internalTerminalPayload =
		lastStep?.result?.transcriptVisibility === "internal" &&
		typeof lastStep.result.text === "string" &&
		typeof userFacingText === "string" &&
		lastStep.result.text.trim() === userFacingText.trim();

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
	const terminalResult = lastStep?.result;
	const terminalData = terminalResult?.data;
	const effectReceipts = mergeEffectReceipts(
		...allSteps.map((step) => step.result?.effectReceipts),
	);
	const terminalUserFacingEffectReceiptIds =
		typeof terminalResult?.userFacingText === "string" &&
		typeof userFacingText === "string" &&
		terminalResult.userFacingText.trim() === userFacingText.trim()
			? terminalResult.userFacingEffectReceiptIds
			: undefined;
	const terminalVerifiedUserFacing =
		!internalTerminalPayload &&
		terminalResult?.verifiedUserFacing === true &&
		Array.isArray(terminalUserFacingEffectReceiptIds) &&
		terminalUserFacingEffectReceiptIds.length > 0 &&
		resolveUserFacingEffectReceipts(terminalResult, effectReceipts) !== null;
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
		transcriptVisibility: lastStep?.result?.transcriptVisibility,
		...(internalTerminalPayload ? {} : { userFacingText }),
		...(effectReceipts.length > 0 ? { effectReceipts } : {}),
		...(terminalUserFacingEffectReceiptIds
			? {
					userFacingEffectReceiptIds: terminalUserFacingEffectReceiptIds,
				}
			: {}),
		...(terminalVerifiedUserFacing ? { verifiedUserFacing: true } : {}),
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
	const actionTools = buildPlannerToolsFromTieredActions(actions, {
		tierAParents,
		actionLookup: new Map(
			actions.map((action) => [action.name, action] as const),
		),
		tierAChildrenByParent: readTierAChildrenByParentFromContext(context),
	});
	const terminalNames = new Set(
		CORE_PLANNER_TERMINALS.map((tool) => normalizeActionIdentifier(tool.name)),
	);
	// REPLY/IGNORE may also be registered runtime actions. The planner-loop owns
	// these protocol terminals, so keep its canonical definitions exactly once;
	// duplicate native tool names waste schema tokens and are ambiguous to model
	// providers that preserve both entries.
	return [
		...actionTools.filter(
			(tool) => !terminalNames.has(normalizeActionIdentifier(tool.name)),
		),
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
	actions: readonly Action[] = [],
): ActionResult[] {
	const actionsByName = new Map<string, Action>();
	for (const action of [
		...collectActionsFromContext(trajectory.context),
		...actions,
	]) {
		actionsByName.set(normalizeActionIdentifier(action.name), action);
	}
	const results: ActionResult[] = [];
	for (const step of [...trajectory.archivedSteps, ...trajectory.steps]) {
		if (!step.result || !step.toolCall) {
			continue;
		}
		const actionName = step.toolCall.name;
		const action = actionsByName.get(normalizeActionIdentifier(actionName));
		if (shouldSuppressActionResultClipboard(action, step.result)) {
			results.push({
				success: step.result.success,
				...(step.result.text !== undefined ? { text: step.result.text } : {}),
				...(step.result.transcriptVisibility !== undefined
					? { transcriptVisibility: step.result.transcriptVisibility }
					: {}),
				...(step.result.userFacingText !== undefined
					? { userFacingText: step.result.userFacingText }
					: {}),
				...(step.result.verifiedUserFacing !== undefined
					? { verifiedUserFacing: step.result.verifiedUserFacing }
					: {}),
				...(step.result.effectReceipts !== undefined
					? { effectReceipts: step.result.effectReceipts }
					: {}),
				...(step.result.userFacingEffectReceiptIds !== undefined
					? {
							userFacingEffectReceiptIds:
								step.result.userFacingEffectReceiptIds,
						}
					: {}),
				// Clipboard suppression drops the planner-facing data payload, but
				// suppressPlannerReply is a turn-delivery contract, not clipboard
				// content — dropping it here re-enabled the evaluator's mimicked
				// ack on out-of-band-acked TASKS_CREATE turns (live 2026-08-19,
				// trajectory data reduced to {actionName} with the flag gone).
				data: {
					actionName,
					...(step.result.data?.suppressPlannerReply === true
						? { suppressPlannerReply: true }
						: {}),
				},
				...(step.result.turnComplete !== undefined
					? { turnComplete: step.result.turnComplete }
					: {}),
				...(step.result.continueChain !== undefined
					? { continueChain: step.result.continueChain }
					: {}),
			});
			continue;
		}
		const plannerData = step.result.data;
		const nestedValues = plannerData?.values;
		const nestedValueEntries =
			nestedValues !== null &&
			typeof nestedValues === "object" &&
			!Array.isArray(nestedValues)
				? Object.entries(nestedValues)
				: [];
		const values =
			nestedValueEntries.length > 0 &&
			nestedValueEntries.every(
				(entry): entry is [string, ProviderValue] =>
					typeof entry[1] !== "function" && typeof entry[1] !== "symbol",
			)
				? Object.fromEntries(nestedValueEntries)
				: undefined;
		const actionData =
			values && plannerData
				? Object.fromEntries(
						Object.entries(plannerData).filter(([key]) => key !== "values"),
					)
				: plannerData;
		const error =
			typeof step.result.error === "string"
				? step.result.error
				: step.result.error instanceof Error
					? step.result.error.message
					: undefined;
		results.push({
			success: step.result.success,
			...(step.result.text !== undefined ? { text: step.result.text } : {}),
			...(step.result.transcriptVisibility !== undefined
				? { transcriptVisibility: step.result.transcriptVisibility }
				: {}),
			...(step.result.userFacingText !== undefined
				? { userFacingText: step.result.userFacingText }
				: {}),
			...(step.result.verifiedUserFacing !== undefined
				? { verifiedUserFacing: step.result.verifiedUserFacing }
				: {}),
			...(step.result.effectReceipts !== undefined
				? { effectReceipts: step.result.effectReceipts }
				: {}),
			...(step.result.userFacingEffectReceiptIds !== undefined
				? {
						userFacingEffectReceiptIds: step.result.userFacingEffectReceiptIds,
					}
				: {}),
			data: {
				...actionData,
				actionName,
			},
			...(values ? { values } : {}),
			...(error !== undefined ? { error } : {}),
			...(step.result.turnComplete !== undefined
				? { turnComplete: step.result.turnComplete }
				: {}),
			...(step.result.continueChain !== undefined
				? { continueChain: step.result.continueChain }
				: {}),
		});
	}
	return results;
}

/**
 * Pre-LLM action shortcut gate (#8791).
 *
 * Matches explicit slash/`!` protocol invocations against the runtime's
 * `ShortcutRegistry` before any model call. Ordinary language is deliberately
 * ineligible here: it must reach the planner even when a plugin registered a
 * natural-language shortcut. On an explicit `action`-target match the action
 * runs and its reply is returned as a `direct_reply` — emitting zero
 * `RESPONSE_HANDLER` tokens. Navigate/client targets are resolved on the client
 * (the slash menu already runs them locally) so the gate ignores them.
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
	onSettledActionResult?: (result: ActionResult) => void;
	runTerminalOwner?: MessageRunTerminalOwner;
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
		allowNatural: false,
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

	let captured: string | undefined;
	// Shortcuts enter the same executor as planner-selected tools so component
	// gates, argument validation, callback buffering, audience revalidation, and
	// action events remain one non-bypassable contract.
	const shortcutActionResult = await executePlannedToolCall(
		args.runtime,
		{
			message: args.message,
			state: args.state,
			userRoles: [args.senderRole],
			activeContexts: ["general"],
			callback: async (content) => {
				if (typeof content?.text === "string" && content.text) {
					captured = content.text;
				}
				return [];
			},
		},
		{
			name: action.name,
			params: { ...target.parameters, ...match.parameters },
		},
		{
			actions: [action],
			...(args.onSettledActionResult
				? { onSettledResult: args.onSettledActionResult }
				: {}),
		},
	);
	if (captured === undefined) {
		const executionError = shortcutActionResult.data?.error;
		if (executionError !== undefined) {
			// A shortcut failure does not enter the planner transcript, so its
			// underlying exception needs a separate observable boundary.
			args.runtime.logger.warn(
				{
					src: "shortcut-gate",
					shortcut: match.shortcut.id,
					action: action.name,
					err: executionError,
				},
				"Shortcut action failed before producing a reply",
			);
		}
		return null;
	}
	let actionResult: ActionResult | undefined;
	if (shouldSuppressActionResultClipboard(action, shortcutActionResult)) {
		actionResult = projectActionResultForClipboard(
			action,
			shortcutActionResult,
			action.name,
		);
	} else {
		actionResult = {
			...shortcutActionResult,
			data: {
				...shortcutActionResult.data,
				actionName: action.name,
			},
		};
	}
	const resultState = actionResult
		? withActionResultsForPrompt(args.state, [actionResult], args.runtime)
		: args.state;
	const shortcutActionResults = actionResult ? [actionResult] : [];
	const shortcutReplyDecision = evaluatePlannedReplyEgress({
		reply: captured,
		actionResults: shortcutActionResults,
		actions: args.runtime.actions,
	});
	const shortcutReply =
		shortcutReplyDecision.verdict === "allow"
			? captured
			: shortcutReplyDecision.fallbackReply;
	const shortcutReplyReceiptIds = appliedEffectReceiptIdsForReply(
		shortcutReply,
		shortcutActionResults,
	);

	// #8792: report the interaction so the proactive-comment decider can react.
	const interactionEvent = emitInteractionEvent(
		args.runtime,
		match,
		args.message,
	);
	if (args.runTerminalOwner) {
		args.runTerminalOwner.adopt("shortcut-interaction-event", interactionEvent);
	} else {
		void interactionEvent;
	}

	const thought = `Shortcut: ${match.shortcut.id}`;
	return {
		kind: "direct_reply",
		messageHandler: {
			processMessage: "RESPOND",
			thought,
			plan: {
				contexts: [SIMPLE_CONTEXT_ID],
				reply: shortcutReply,
				simple: true,
				requiresTool: false,
			},
		},
		result: {
			...createV5ReplyStrategyResult({
				runtime: args.runtime,
				message: args.message,
				state: resultState,
				responseId: args.responseId,
				text: shortcutReply,
				thought,
				...(shortcutReplyReceiptIds.length > 0
					? { effectReceiptIds: shortcutReplyReceiptIds }
					: {}),
			}),
			...(actionResult ? { actionResults: [actionResult] } : {}),
		},
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
		// error-policy:J7 Interaction telemetry must not block the message turn.
		runtime.logger?.debug?.(
			{ src: "shortcut-gate", err },
			"interaction event emit failed",
		);
		runtime.reportError("MessageService.shortcutEvent", err, {
			shortcutId: match.shortcut.id,
			roomId: message.roomId,
		});
	}
}

const INTERMEDIATE_CALLBACK_METADATA_KEYS = new Set([
	"actions",
	"agentVoiced",
	"channelType",
	"effectReceiptIds",
	"inReplyTo",
	"mentionContext",
	"merge",
	"providers",
	"reactedMessageText",
	"responseId",
	"responseMessageId",
	"source",
	"target",
	"thought",
	"transcriptVisibility",
]);

function hasIntermediateCallbackPayload(content: Content): boolean {
	return Object.entries(content).some(([key, value]) => {
		if (key === "text" || INTERMEDIATE_CALLBACK_METADATA_KEYS.has(key)) {
			return false;
		}
		if (value === undefined || value === null) return false;
		if (typeof value === "string") return value.trim().length > 0;
		if (Array.isArray(value)) return value.length > 0;
		if (typeof value === "object") return Object.keys(value).length > 0;
		return true;
	});
}

function withoutIntermediateVisibleText(content: Content): Content | null {
	const filtered = { ...content };
	delete filtered.text;
	return hasIntermediateCallbackPayload(filtered) ? filtered : null;
}

export async function runV5MessageRuntimeStage1(args: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	responseId: UUID;
	callback?: HandlerCallback;
	deliveredVisibleTexts?: Set<string>;
	plannerLoopConfig?: PlannerLoopParams["config"];
	onSettledActionResult?: (result: ActionResult) => void;
	roomHandlerLease?: RoomHandlerLease;
	runTerminalOwner?: MessageRunTerminalOwner;
	/**
	 * Optional pre-planner early-reply delivery seam. A consumer that decides
	 * NOT to deliver the event (e.g. the voice fast path's async-handoff gate)
	 * must return `false` so the producer's `earlyReplySent` bookkeeping —
	 * dedupe, preserved-answer rescue, planner-state refresh — reflects what
	 * the user actually saw. Any other return value counts as delivered.
	 */
	onResponseHandlerEarlyReply?: (
		event: ResponseHandlerEarlyReplyEvent,
	) => Promise<boolean> | Promise<void> | boolean | undefined;
	/**
	 * Fires once Stage 1 routing commits this turn to a response (final reply
	 * or planning). Lets the caller distinguish "runtime died after the model
	 * chose to answer" from "died before any respond decision existed" in its
	 * failure-reply gate.
	 */
	onStage1RespondDecision?: () => void;
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
		extraProviderExclusions: ambientTurnProviderExclusions(
			args.runtime,
			args.message,
		),
		// Per-turn exclusions (not the static list): even if a cached compose
		// left RECENT_ERRORS in state, an unaddressed group turn must not
		// render internal diagnostics into its Stage-1 context.
	});
	const stage1PreprocessStartedAt = performance.now();

	// G10/G11: construct the per-trajectory recorder. No-op when disabled via
	// ELIZA_TRAJECTORY_RECORDING=0. Failures inside the recorder must NEVER
	// propagate up — the recorder is observability, not load-bearing.
	const recordingEnabled = isTrajectoryRecordingEnabled();
	// Every stage emitted below also mirrors into the turn's database
	// trajectory step (#17030) so the app viewer carries the same
	// Stage-1/planner/tool/evaluation semantics as the file trajectory.
	const recorder: TrajectoryRecorder | undefined = recordingEnabled
		? withSemanticStageFanOut(
				createJsonFileTrajectoryRecorder({
					logger: args.runtime.logger as {
						warn?: (context: unknown, message?: string) => void;
					},
					reportError: args.runtime.reportError.bind(args.runtime),
					// Final-persistence tool-diagnostic projection: the recorder always
					// runs the shared tool-shape pattern pass; this adds the runtime's
					// character-configured secret masking on top. Optional-bound because
					// lightweight/test runtimes may not implement redactSecrets — the
					// pattern pass must keep running for them.
					redactSecrets: args.runtime.redactSecrets?.bind(args.runtime),
				}),
				args.runtime,
			)
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
	let settledFactsOutcome: Awaited<typeof factsTask> | undefined;
	let messageHandlerStageTask: Promise<void> = Promise.resolve();
	try {
		const messageHandlerStartedAt = Date.now();
		const directMessageChannel =
			args.message.content?.channelType === ChannelType.DM ||
			args.message.content?.channelType === ChannelType.VOICE_DM ||
			args.message.content?.channelType === ChannelType.API ||
			args.message.content?.channelType === ChannelType.SELF;
		const voiceDirectMessageChannel =
			args.message.content?.channelType === ChannelType.VOICE_DM;
		// Ambient turn = a positively-identified unaddressed text-group turn
		// (structural classifier only — channel type + addressing + source
		// metadata, never message text; anything uncertain fails open to
		// addressed). Drives the planner's ambient-turn policy instruction and
		// the deliberate-silence terminal below, independent of the Stage-1
		const ambientTurn =
			!directMessageChannel &&
			isUnaddressedTextGroupTurn(
				args.message,
				messageExplicitlyAddressesAgent(args.runtime, args.message),
			);
		const stage1TurnSignal =
			getStreamingContext()?.abortSignal ?? new AbortController().signal;

		const responseHandlerFieldContext: ResponseHandlerFieldContext = {
			runtime: args.runtime,
			message: args.message,
			state: args.state,
			senderRole: senderRole as ResponseHandlerSenderRole,
			turnSignal: stage1TurnSignal,
		};
		const selectedResponseHandlerFields =
			args.runtime.responseHandlerFieldRegistry.list();
		const responseHandlerFieldPrompt =
			await args.runtime.responseHandlerFieldRegistry.composePromptSlices(
				responseHandlerFieldContext,
			);
		const responseHandlerSchema =
			args.runtime.responseHandlerFieldRegistry.composeSchema();
		const messageHandlerInput = renderMessageHandlerModelInput(
			args.runtime,
			context,
			availableContexts,
			{
				directMessage: directMessageChannel && !voiceDirectMessageChannel,
				voiceDirectMessage: voiceDirectMessageChannel,
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
		const messageHandlerProviderOptions = withModelInputBudgetProviderOptions(
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
		);

		// RESPONSE_HANDLER_BEFORE (blocking): hooks fire right before the Stage 1 model
		// call. Used to inject providers / facts / relationships into the
		// stable prefix.
		await timeInferenceSpan(
			"actions:response-handler-before",
			() =>
				args.runtime.runActionsByMode(
					"RESPONSE_HANDLER_BEFORE",
					args.message,
					args.state,
				),
			{ mode: "RESPONSE_HANDLER_BEFORE" },
		);

		// RESPONSE_HANDLER_DURING (non-blocking): fire-and-forget alongside the model
		// call. We don't await — the user contract is "during".
		// error-policy:J7 diagnostics-must-not-kill-the-loop — a rejection escaping
		// runActionsByMode must not abort the turn, but it must surface.
		const responseHandlerDuring = args.runtime
			.runActionsByMode("RESPONSE_HANDLER_DURING", args.message, args.state)
			.catch((err) =>
				args.runtime.reportError("MessageService.runActionsByMode", err, {
					mode: "RESPONSE_HANDLER_DURING",
				}),
			);
		if (args.runTerminalOwner) {
			args.runTerminalOwner.adopt(
				"RESPONSE_HANDLER_DURING",
				responseHandlerDuring,
			);
		} else {
			void responseHandlerDuring;
		}

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
					args.runtime.responseHandlerFieldRegistry?.composeSchemaSignature(),
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
		// Per-agent reply-length budget (#16395): when set it caps every channel
		// (including DMs) with a real max_tokens; otherwise the existing per-channel
		// default applies unchanged.
		const maxReplyTokens = resolveMaxReplyTokens(
			args.runtime.character.settings,
		);
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
			maxTokens:
				maxReplyTokens ??
				(directMessageChannel ? undefined : DEFAULT_STAGE1_MAX_TOKENS),
			omitMaxTokens: maxReplyTokens == null && directMessageChannel,
			// Streamed structured generation: the local engine (W4) streams the
			// HANDLE_RESPONSE envelope and parses it incrementally so `shouldRespond`
			// / `contexts` route the moment they are known. User-visible `replyText`
			// remains buffered until routing and effect validation complete. Cloud
			// adapters ignore the flag and return the result whole.
			streamStructured: true,
			// This is the only Stage 1 field intended for the user. Local voice
			// consumes the validated replyText field; planner/evaluator calls leave
			// this unset and therefore cannot leak their structured output to TTS.
			voiceOutput: "user-visible" as const,
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
		recordInferenceSpan(
			"message:stage1:preprocess",
			performance.now() - stage1PreprocessStartedAt,
		);
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
		// An explicit continuation turn ("finish my request", "that is good")
		// carries no inferable intent of its own, so candidate inference runs on
		// the nearest pending prior user request instead. The substitution feeds
		// only routing heuristics — prompts keep the literal user text.
		const continuationResolvedMessageText =
			resolveContinuationInferenceMessageText(
				args.runtime,
				args.message,
				args.state,
			);
		const inferenceMessageText =
			continuationResolvedMessageText ?? getUserMessageText(args.message);
		if (continuationResolvedMessageText) {
			args.runtime.logger?.debug?.(
				{ src: "service:message" },
				"[message] continuation turn resolved to prior user request for candidate inference",
			);
		}
		let fieldRunResult: ResponseHandlerFieldRunResult | null = null;
		let messageHandler: MessageHandlerResult | null = null;
		if (rawFieldParsed) {
			fieldRunResult = await timeInferenceSpan(
				"evaluators:response-handler-fields",
				() =>
					args.runtime.responseHandlerFieldRegistry.dispatch({
						rawParsed: normalizeRawParsedForFieldRegistry(rawFieldParsed),
						runtime: args.runtime,
						message: args.message,
						state: args.state,
						senderRole: senderRole as ResponseHandlerSenderRole,
						turnSignal: stage1TurnSignal,
					}),
			);
			messageHandler = messageHandlerFromFieldResult(
				fieldRunResult.parsed,
				fieldRunResult,
				{
					actions: args.runtime.actions,
					messageText: inferenceMessageText,
					candidateBackstopRules: getCandidateActionBackstopRules(args.runtime),
					subAgentCompletionRelay: isSubAgentCompletionArtifact(args.message),
				},
			);
		}
		if (!messageHandler) {
			messageHandler = parseMessageHandlerModelOutput(rawMessageHandler, {
				actions: args.runtime.actions,
				messageText: inferenceMessageText,
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
		if (stage1CompletionLimitHit) {
			messageHandler = synthesizeStage1CompletionLimitReply();
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
				messageText: inferenceMessageText,
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
		await timeInferenceSpan(
			"actions:response-handler-after",
			() =>
				args.runtime.runActionsByMode(
					"RESPONSE_HANDLER_AFTER",
					args.message,
					args.state,
				),
			{ mode: "RESPONSE_HANDLER_AFTER" },
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
		const stageOneVisibleReply = sanitizeUserVisibleModelOutput(
			getMessageHandlerReply(messageHandler),
		);
		if (stageOneVisibleReply.kind === "text") {
			messageHandler.plan.reply = stageOneVisibleReply.text;
		} else {
			messageHandler.plan.reply = "";
			if (stageOneVisibleReply.kind !== "empty") {
				// error-policy:J3 Stage 1 is an untrusted model boundary. A
				// control/invalid reply becomes an observable invalid signal,
				// never a string that a direct or early-reply channel can send.
				reportRejectedUserVisibleModelOutput({
					runtime: args.runtime,
					scope: "MessageService.runV5MessageRuntimeStage1",
					code: "STAGE1_INVALID_USER_VISIBLE_OUTPUT",
					message:
						"Stage-1 model placed control data in the user-visible reply field",
					stage: "response-handler",
					output: stageOneVisibleReply,
				});
			}
		}
		const parsedResponseHandlerReply = getMessageHandlerReply(messageHandler);

		if (recorder && trajectoryId) {
			messageHandlerStageTask = recordMessageHandlerStage({
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
				state: args.state,
				runtime: args.runtime,
			});
		}

		if (messageHandler.processMessage === "RESPOND") {
			const injectionGate = await timeInferenceSpan(
				"evaluators:injection-risk-gate",
				() =>
					runShouldRespondInjectionGate({
						runtime: args.runtime,
						message: args.message,
						resolveSenderRole: () => senderRole,
					}),
			);
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
		// without blocking the user reply. A result that settles before terminal
		// trajectory persistence is recorded there; slower extraction remains a
		// tracked data task but cannot leave the completed turn marked running.
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
				.catch((error) => {
					// error-policy:J7 Facts persistence is detached from reply delivery;
					// its explicit failed outcome is recorded in the trajectory below.
					args.runtime.reportError(
						"MessageService.factsAndRelationships",
						error,
						{ roomId: args.message.roomId },
					);
					return { startedAt, endedAt: Date.now(), result: null, error };
				})
				.then((outcome) => {
					settledFactsOutcome = outcome;
					return outcome;
				});
			args.runTerminalOwner?.adopt("facts-and-relationships", factsTask);
		}

		// Persist `addressedTo` as relationship edges from the speaker to each
		// addressee. No LLM call: UUIDs pass through verbatim, names resolve
		// against the room's participants. Fire-and-forget like the facts task;
		// failures land in the logger but never block the reply.
		const addressedTo = messageHandler.extract?.addressedTo ?? [];
		if (addressedTo.length > 0) {
			const addressedToTask = applyAddressedTo({
				runtime: args.runtime,
				message: args.message,
				addressedTo,
			}).catch((error) => {
				// error-policy:J7 Relationship enrichment is a detached data write;
				// report failure while preserving the already-produced reply.
				args.runtime.reportError("MessageService.applyAddressedTo", error, {
					messageId: args.message.id,
				});
				args.runtime.logger?.warn?.(
					{
						err: error,
						messageId: args.message.id,
						addressedToCount: addressedTo.length,
					},
					"[message] applyAddressedTo failed",
				);
			});
			if (args.runTerminalOwner) {
				args.runTerminalOwner.adopt("apply-addressed-to", addressedToTask);
			} else {
				void addressedToTask;
			}
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
				const recordTopicsTask = channelTopics
					.recordTopics(args.message.roomId, topics)
					.catch((error) => {
						// error-policy:J7 Channel-topic state is detached enrichment; report
						// failed persistence without dropping the reply.
						args.runtime.reportError("MessageService.recordTopics", error, {
							roomId: args.message.roomId,
						});
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
				if (args.runTerminalOwner) {
					args.runTerminalOwner.adopt(
						"record-channel-topics",
						recordTopicsTask,
					);
				} else {
					void recordTopicsTask;
				}
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
			const stampTopicsTask = args.runtime
				.updateMemory({
					id: args.message.id,
					metadata: {
						...(existingMetadata ?? {}),
						type: "message" as const,
						topics,
					},
				})
				.catch((error) => {
					// error-policy:J7 Transcript topic metadata is detached enrichment;
					// report a failed stamp without changing message delivery.
					args.runtime.reportError("MessageService.stampTopics", error, {
						messageId: args.message.id,
					});
					args.runtime.logger?.warn?.(
						{ err: error, messageId: args.message.id },
						"[message] stamp message topics failed",
					);
				});
			if (args.runTerminalOwner) {
				args.runTerminalOwner.adopt("stamp-message-topics", stampTopicsTask);
			} else {
				void stampTopicsTask;
			}
		}

		// Response-handler evaluators may promote a simple turn to planning and
		// clobber a COMPLETE stage-0 answer with an "On it." ack (observed live:
		// stage-0 held the full contributors answer; the promotion flailed through
		// NOTIFY and the turn ended answerless). Preserve the pre-patch reply so
		// the planner loop's answer rescue and the answerless-final fallback can
		// still deliver it.
		const candidateGateDiagnostics = {
			disclosureRejectedExplicitCandidates: [] as string[],
			disclosureRejectedReasons: [] as string[],
			nonDisclosureRejectedExplicitCandidates: [] as string[],
		};
		const prePatchStageOneReply =
			typeof messageHandler.plan.reply === "string" &&
			messageHandler.plan.reply.trim().length > 0
				? messageHandler.plan.reply
				: undefined;
		const prePatchStageOneReplyEffectStatus =
			messageHandler.plan.replyEffectStatus;
		const prePatchStageOneReplyIsUngroundedAppliedClaim =
			prePatchStageOneReplyEffectStatus === "applied";
		const responseHandlerEvaluation = fieldRunResult?.preempt
			? {
					activeEvaluators: [],
					appliedPatches: [],
					candidateActionsAddedByEvaluators: [],
					candidateActionsClearedByEvaluators: false,
					errors: [],
				}
			: await timeInferenceSpan("evaluators:response-handler", () =>
					runResponseHandlerEvaluators({
						runtime: args.runtime,
						message: args.message,
						state: args.state,
						messageHandler,
						availableContexts,
						userRoles: [senderRole],
						evaluators: BUILTIN_RESPONSE_HANDLER_EVALUATORS,
					}),
				);
		messageHandler.plan.contexts = filterSelectedContextsForRole(
			messageHandler.plan.contexts,
			availableContexts,
		);
		// Full engagement addressing gate (extends #9874 item 1 from tool
		// promotion to reply + planner + early-ack routing): when Stage 1 tagged
		// this turn as explicitly addressed to ANOTHER participant (not us), the
		// agent is overhearing — it must not reply, enter the planner, or
		// fabricate a tool task. Uniform, NOT bot-specific: it fires the same
		// for human and bot addressees (bot-ness is surfaced to the model as
		// transcript context, not handled here). Undirected banter
		// (addressedTo: []) never gates, so chatty agents still interject per
		// their character. Eligibility is bounded by the canonical `ambientTurn`
		// classifier: only positively identified unaddressed text-group traffic
		// can be suppressed. Direct/API/self turns, client chat, autonomous and
		// sub-agent traffic, explicit mentions/replies/names, and unknown channel
		// types all fail open. The sender's effective personality reply_gate also
		// provides a deliberate opt-out when it is explicitly "always".
		//
		// Fail OPEN on any resolution error (DB hiccup in getEntitiesForRoom): a
		// transient failure must NOT convert a normal turn into silence — it
		// just means "don't suppress", matching the conservative contract and
		// the fire-and-forget addressee handling above.
		const addressedToOtherParticipant =
			ambientTurn &&
			addressedTo.length > 0 &&
			resolveStage1ReplyGateMode(args.runtime, args.message) !== "always"
				? await messageAddressedToOtherParticipant({
						runtime: args.runtime,
						message: args.message,
						addressedTo,
					}).catch((error) => {
						// error-policy:J4 an unresolved addressee must not suppress a
						// response, but the failed room lookup remains observable.
						args.runtime.reportError(
							"MessageService.resolveAddressees",
							error,
							{
								roomId: args.message.roomId,
							},
						);
						return false;
					})
				: false;
		if (addressedToOtherParticipant) {
			args.runtime.logger?.debug?.(
				{
					src: "service:message",
					roomId: args.message.roomId,
					addressedToCount: addressedTo.length,
				},
				"[message] Turn addressed to another participant — engagement gate ignores it",
			);
		}
		const route = routeMessageHandlerOutput(messageHandler, {
			addressedToOtherParticipant,
			messageText: getUserMessageText(args.message) ?? "",
		});
		if (route.type === "ignored" || route.type === "stopped") {
			return {
				kind: "terminal",
				action: route.type === "stopped" ? "STOP" : "IGNORE",
				messageHandler,
				state: args.state,
			};
		}

		// Past this point the Stage-1 model has committed this turn to a
		// response (final reply or planning). Surface the per-message decision
		// so a later runtime failure can qualify for a visible failure reply
		// instead of the unaddressed-turn suppression — evaluator-demoted
		// IGNOREs and the injection-gate return above never reach this.
		args.onStage1RespondDecision?.();

		if (route.type === "final_reply") {
			// The simple-context reply IS the answer: Stage 1 emits `replyText` (→
			// `route.reply`) inline as part of the required HANDLE_RESPONSE envelope,
			// uncapped for direct channels. There is no separate fast-path model
			// call. When that text is unusable — empty, or a known low-quality
			// scaffold/fragment from strict-JSON generation — ship a clear deferral
			// instead of a blank/garbled bubble, but keep a valid-but-terse answer
			// (e.g. "144" to a math question).
			let reply = route.reply;
			// Voice-gate provenance (#14873): `route.reply` is the Stage-1
			// RESPONSE_HANDLER model's own composed reply — already genuine agent
			// voice — so it must skip the last-mile re-voice pass. Only the
			// hardcoded deferral substitutions below reset this to false; they are
			// templates the gate still owns.
			let replyIsModelVoice = true;
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
				replyIsModelVoice = false;
			}
			if (
				shouldReplaceUnavailableLiveLookupAck({
					message: args.message,
					actions: args.runtime.actions ?? [],
					reply,
				})
			) {
				reply = LIVE_LOOKUP_UNAVAILABLE_REPLY;
				replyIsModelVoice = false;
			}
			const directReplyEgressDecision = evaluatePlannedReplyEgress({
				reply,
				actionResults: [],
				actions: args.runtime.actions,
			});
			if (directReplyEgressDecision.verdict === "reject") {
				reply = directReplyEgressDecision.fallbackReply;
				replyIsModelVoice = false;
			}
			return {
				kind: "direct_reply",
				messageHandler,
				result: createV5ReplyStrategyResult({
					...args,
					text: reply,
					thought: messageHandler.thought,
					agentVoiced: replyIsModelVoice,
				}),
			};
		}

		const selectedContexts =
			route.type === "planning_needed" ? route.contexts : [];
		// Merge direct-request candidate inference before the early-ack gate so
		// the async-handoff check below sees the turn's full candidate set. An
		// evaluator that cleared Stage-1 candidates has already established an
		// authoritative route from richer runtime state, so the generic text
		// heuristic must not undo that decision.
		const directPlannerInference = inferDirectCurrentRequestCandidateInference(
			args.runtime.actions ?? [],
			inferenceMessageText ?? "",
		);
		const directPlannerCandidateActions = directPlannerInference.names;
		if (
			directPlannerCandidateActions.length > 0 &&
			!responseHandlerEvaluation.candidateActionsClearedByEvaluators
		) {
			messageHandler.plan.candidateActions =
				directPlannerInference.kind === "owner-reads"
					? directPlannerCandidateActions
					: uniqueActionNames([
							...getMessageHandlerCandidateActions(messageHandler),
							...directPlannerCandidateActions,
						]);
		}
		const routedResponseHandlerReply = getMessageHandlerReply(messageHandler);
		let earlyReplyText = actionOwnsResponseHandlerEarlyReply(
			args.runtime,
			messageHandler,
		)
			? ""
			: routedResponseHandlerReply || parsedResponseHandlerReply;
		// `replyEffectStatus: applied` is the model's prediction, not an effect
		// receipt. Keep it buffered until the planner either produces a verified
		// action result or returns the terminal failure; otherwise the client sees a
		// fabricated success flash immediately before the real outcome replaces it.
		if (prePatchStageOneReplyIsUngroundedAppliedClaim) {
			earlyReplyText = "";
		}
		const onResponseHandlerEarlyReply = args.onResponseHandlerEarlyReply;
		if (earlyReplyText.length > 0 && onResponseHandlerEarlyReply) {
			const earlyReplyEgressDecision = evaluatePlannedReplyEgress({
				reply: earlyReplyText,
				actionResults: [],
				actions: args.runtime.actions,
			});
			if (earlyReplyEgressDecision.verdict === "reject") {
				// Planning is still in progress, so an ungrounded completion claim
				// cannot ship. Drop the early reply entirely — the delivery floor
				// must not manufacture a substitute ack; the planner's final reply
				// (or the final-path ack fallback) owns this turn's delivery.
				earlyReplyText = "";
			}
		}
		// The addressing gate above already terminal-routes addressed-to-other
		// turns to ignored, so a gated turn cannot normally reach this planning
		// path — but the early ack ships user-visible text BEFORE the planner,
		// so it is re-checked here as defense in depth: no ack may leak from a
		// gated turn regardless of how routing evolves upstream.
		const earlyReplyEligible =
			!addressedToOtherParticipant &&
			messageHandler.processMessage === "RESPOND" &&
			earlyReplyText.length > 0 &&
			typeof onResponseHandlerEarlyReply === "function";
		let earlyReplySent = false;
		if (
			earlyReplyEligible &&
			typeof onResponseHandlerEarlyReply === "function"
		) {
			// The consumer owns the final delivery decision (the voice fast path
			// gates on async-handoff candidates); an explicit `false` means it
			// dropped the event, so downstream dedupe/rescue bookkeeping must
			// treat the turn as having no delivered early reply.
			const delivered = await onResponseHandlerEarlyReply({
				text: restorePiiInUserReplyText(earlyReplyText),
				messageHandler,
			});
			earlyReplySent = delivered !== false;
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
					// refresh RECENT_MESSAGES only when an early reply actually
					// changed history. An empty refresh set means maximum reuse;
					// planner-only context-gated providers still run because they
					// are not cached yet.
					await args.runtime.composeState(
						args.message,
						plannerProviderNames,
						true,
						false,
						earlyReplySent ? ["RECENT_MESSAGES"] : [],
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
					diagnostics: candidateGateDiagnostics,
				});
		// Surface-privacy short-circuit: stage-1 named a capability that EXISTS
		// but its owner-exclusive disclosure gate rejected this destination, and
		// no named candidate survived into the collected set. Planning anyway
		// hands the model an unrelated retrieval surface and
		// it improvises around the missing capability — observed live on the
		// Discord group channel: a "todos" ask got a WEB_SEARCH surface and
		// shipped a fabricated "todo added" with zero writes, and a todos READ
		// answered a false empty from the orchestrator task store. Answer with an
		// honest surface denial instead. The phrasing confirms nothing about the
		// data — only that the disclosure boundary rejected this requester or
		// destination. Role, context, and autonomy denials keep the ordinary
		// planner path because they do not prove a privacy denial.
		const collectedCandidateNames = new Set(
			plannerCandidateActions.map((action) =>
				normalizeActionIdentifier(action.name),
			),
		);
		const stageOneCandidateLookup = buildRuntimeActionLookup(args.runtime);
		// Resolve candidates exactly the way collection does — direct name/simile
		// first, then the shared parent-alias map. Collection admits an aliased
		// action (Stage-1's invented "SEARCH" → WEB_SEARCH) but a direct-only
		// check here reads that same candidate as resolving to nothing, counts
		// the turn as "no survivors", and the privacy denial fires on a turn
		// whose web capability is sitting in the collected set (observed live:
		// group "search the web … within my budget" — the possessive-budget
		// heuristic's OWNER_FINANCES was rightly privacy-rejected, and the
		// denial swallowed a servable web search).
		const anyNamedStageOneCandidateSurvived = (
			getMessageHandlerCandidateActions(messageHandler) ?? []
		).some((name) => {
			const candidateName = String(name);
			const direct = resolveRuntimeAction(
				stageOneCandidateLookup,
				candidateName,
			);
			const resolvedSet = direct
				? [direct]
				: parentAliasesForCandidateAction(candidateName)
						.map((alias) =>
							resolveRuntimeAction(stageOneCandidateLookup, alias),
						)
						.filter((action): action is Action => action !== undefined);
			return resolvedSet.some((resolved) =>
				collectedCandidateNames.has(normalizeActionIdentifier(resolved.name)),
			);
		});
		// The privacy denial is only terminal when NO ungated sibling can serve
		// the ask. Reminders have one: the agent-level TRIGGER action claims
		// "remind me …" and legitimately works in group channels (observed live:
		// in-channel triggers created and fired there for months; the denial
		// regressed that the moment OWNER_REMINDERS got named as the candidate).
		// When the rejected candidates are reminder/alarm-shaped and TRIGGER
		// survived collection, let the turn plan — the trigger path serves it.
		const rejectedReminderish =
			candidateGateDiagnostics.disclosureRejectedExplicitCandidates.some(
				(name) => {
					const normalized = normalizeActionIdentifier(name);
					return (
						normalized.includes("REMINDER") || normalized.includes("ALARM")
					);
				},
			);
		const ungatedTriggerSiblingAvailable =
			rejectedReminderish && collectedCandidateNames.has("TRIGGER");
		// The privacy denial only proves an owner-exclusive disclosure boundary.
		// A MIXED rejection set — one candidate denied by disclosure AND another
		// explicit candidate denied by a role/context/private-action gate — is a
		// compound request whose non-disclosure limitation the planner/recovery
		// path must answer honestly. Short-circuit ONLY when the rejection set is
		// purely disclosure-based; any non-disclosure rejection stands the privacy
		// template down (#20679, refining #20660).
		const onlyDisclosureRejections =
			candidateGateDiagnostics.nonDisclosureRejectedExplicitCandidates
				.length === 0;
		if (
			candidateGateDiagnostics.disclosureRejectedExplicitCandidates.length >
				0 &&
			onlyDisclosureRejections &&
			!anyNamedStageOneCandidateSurvived &&
			!ungatedTriggerSiblingAvailable
		) {
			return {
				kind: "direct_reply",
				messageHandler,
				result: createV5ReplyStrategyResult({
					...args,
					text: privacyDenialReplyForReasons(
						candidateGateDiagnostics.disclosureRejectedReasons,
					),
					thought: messageHandler.thought,
					agentVoiced: false,
				}),
			};
		}
		// Live-lookup unavailability short-circuit. The progress-ack promotion
		// (routeMessageHandlerOutput, #20249) now routes "On it."-shaped turns
		// into planning, which bypassed the direct-reply egress replacement that
		// used to convert a live-lookup ask with NO registered web action into
		// the honest decline. A planner round cannot conjure the missing
		// capability — its best case is a model-authored decline and its worst
		// case is a shell fallback — so decline deterministically here, exactly
		// like the egress-side replacement. Scope: only turns whose planning
		// round exists purely because of the promotion (stage-1's own plan
		// selected no non-simple context). When stage-1 genuinely routed to a
		// context, or a named candidate survived collection, the planner may
		// hold a registered domain action that serves the ask without web
		// search — those turns still plan.
		const stageOneOwnNonSimpleContexts = (
			messageHandler.plan.contexts ?? []
		).filter((context) => {
			const normalized = String(context).trim().toLowerCase();
			return normalized.length > 0 && normalized !== SIMPLE_CONTEXT_ID;
		});
		if (
			stageOneOwnNonSimpleContexts.length === 0 &&
			!anyNamedStageOneCandidateSurvived &&
			shouldReplaceUnavailableLiveLookupAck({
				message: args.message,
				actions: args.runtime.actions ?? [],
				reply: prePatchStageOneReply ?? "",
			})
		) {
			return {
				kind: "direct_reply",
				messageHandler,
				result: createV5ReplyStrategyResult({
					...args,
					text: LIVE_LOOKUP_UNAVAILABLE_REPLY,
					thought: messageHandler.thought,
					agentVoiced: false,
				}),
			};
		}
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
			restrictToCandidateActions:
				responseHandlerEvaluation.candidateActionsClearedByEvaluators,
			selectedContexts,
			recorder,
			trajectoryId,
			logger: args.runtime.logger,
			reportError: args.runtime.reportError.bind(args.runtime),
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
			ambientTurn,
			extraProviderExclusions: ambientTurnProviderExclusions(
				args.runtime,
				args.message,
			),
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
		// The named candidate must also RESOLVE against the tools actually
		// exposed to the planner this turn: an unresolvable hint (e.g. a
		// web/fetch-style hint on a runtime with no web action) cannot be
		// satisfied, so hard-enforcing it would only burn the required-tool
		// miss budget re-rejecting the planner's honest answer before the
		// exhaustion hatch ships it. The turn still plans — the planner
		// delivers the capability decline in one iteration. Candidates are
		// resolved through the runtime action lookup, not by name alone: Stage 1
		// routinely names a SIMILE of an exposed action (SPAWN_AGENT for TASKS),
		// and a name-only membership test would silently drop enforcement for a
		// tool that IS exposed (the exposedActionMatches doc records the live
		// ack-then-nothing regression that pattern causes).
		const plannerToolNames = new Set(
			plannerTools.map((tool) => normalizeActionIdentifier(tool.name)),
		);
		const stageOneActionLookup = buildRuntimeActionLookup(args.runtime);
		const plannerToolActions = plannerTools.flatMap(
			(tool) => resolveRuntimeAction(stageOneActionLookup, tool.name) ?? [],
		);
		const candidateResolvesToPlannerTool = (name: string): boolean => {
			const normalized = normalizeActionIdentifier(name);
			if (plannerToolNames.has(normalized)) return true;
			// Retrieval can replace an umbrella candidate (TASKS) with the precise
			// promoted child exposed this turn (TASKS_SPAWN_AGENT). Promoted children
			// deliberately carry the parent name as a simile, so resolve against the
			// ACTUAL planner surface before consulting the full runtime. Otherwise the
			// runtime lookup finds the exact parent, which is absent from plannerTools,
			// and incorrectly disables hard-tool enforcement even though its child is
			// exposed and runnable.
			if (exposedActionMatches(plannerToolActions, normalized)) return true;
			const resolved = resolveRuntimeAction(stageOneActionLookup, name);
			return (
				resolved !== undefined &&
				plannerToolNames.has(normalizeActionIdentifier(resolved.name))
			);
		};
		const stageOneNamedAToolForThisTurn =
			messageHandler.plan.requiresTool === true &&
			messageHandler.plan.candidateActions?.some((name) =>
				candidateResolvesToPlannerTool(String(name)),
			) === true;
		const stageOneNamedOwnerLifeManagementTool =
			stageOneNamedAToolForThisTurn &&
			Array.isArray(messageHandler.plan.candidateActions) &&
			messageHandler.plan.candidateActions.some(
				isOwnerLifeManagementToolCandidate,
			);
		const requireNonTerminalToolCall =
			(stageOneNamedAToolForThisTurn || benchmarkForcingToolCall) &&
			plannerTools.length > 0 &&
			(!isTextScoredBenchmarkTurn(args.message) ||
				stageOneNamedOwnerLifeManagementTool);
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
		await timeInferenceSpan(
			"actions:context-before",
			() =>
				args.runtime.runActionsByMode(
					"CONTEXT_BEFORE",
					args.message,
					plannerState,
					{ selectedContexts },
				),
			{ mode: "CONTEXT_BEFORE" },
		);
		// CONTEXT_DURING (non-blocking): runs in parallel with the planner.
		// error-policy:J7 diagnostics-must-not-kill-the-loop — a rejection escaping
		// runActionsByMode must not abort the planner, but it must surface.
		const contextDuring = args.runtime
			.runActionsByMode("CONTEXT_DURING", args.message, plannerState, {
				selectedContexts,
			})
			.catch((err) =>
				args.runtime.reportError("MessageService.runActionsByMode", err, {
					mode: "CONTEXT_DURING",
				}),
			);
		if (args.runTerminalOwner) {
			args.runTerminalOwner.adopt("CONTEXT_DURING", contextDuring);
		} else {
			void contextDuring;
		}

		// Track visible text an action already delivered to the user through the
		// callback during this planner run. The set is populated by the outer
		// instrumented callback after voice rewrite / verbosity shaping, so it
		// matches the string the connector actually sent.
		const deliveredVisibleTexts =
			args.deliveredVisibleTexts ?? new Set<string>();
		const recordingCallback: HandlerCallback | undefined = args.callback
			? async (content, ...rest) => args.callback?.(content, ...rest) ?? []
			: undefined;
		const intermediateCallback: HandlerCallback | undefined = recordingCallback
			? async (content, ...rest) => {
					const nonTextContent = withoutIntermediateVisibleText(content);
					return nonTextContent
						? recordingCallback(nonTextContent, ...rest)
						: [];
				}
			: undefined;

		// Settled planner tool results, in execution order, captured OUTSIDE the
		// loop so they survive a planner/evaluator crash. When the loop dies
		// after a tool already completed, the catch below can still deliver that
		// tool's user-facing text instead of the canned transient-failure reply
		// (observed live 2026-08-07/08: intermittent provider 400s on the
		// post-tool evaluator canned 26 turns whose tool had already succeeded).
		const settledPlannerToolResults: Array<{
			name: string;
			result: PlannerToolResult;
		}> = [];

		const invokeDeterministicToolCall =
			async (): Promise<PlannerLoopResult> => {
				const selected = messageHandler.plan.deterministicToolCall;
				if (!selected) {
					throw new Error(
						"Deterministic tool execution requires a selected call",
					);
				}
				const actionLookup = buildRuntimeActionLookup(args.runtime);
				const action = resolveRuntimeAction(actionLookup, selected.name);
				const toolCall: PlannerToolCall = {
					id: `response-handler:${normalizeActionIdentifier(action?.name ?? selected.name)}`,
					name: action?.name ?? selected.name,
					...(selected.params ? { params: selected.params } : {}),
				};
				const startedAt = Date.now();
				let callbackDelivered = false;
				const deterministicCallback: HandlerCallback | undefined =
					recordingCallback
						? async (...callbackArgs) => {
								callbackDelivered = true;
								return recordingCallback(...callbackArgs);
							}
						: undefined;
				let result: PlannerToolResult;
				try {
					result = trackSettledPlannerToolResult(
						settledPlannerToolResults,
						toolCall.name,
						await executeV5PlannedToolCall({
							runtime: args.runtime,
							toolCall,
							plannerContext: plannerContextAfterEarlyReply,
							executorCtx: buildV5ExecutorContext({
								message: args.message,
								state: plannerState,
								selectedContexts,
								senderRole,
								previousResults: [],
								...(deterministicCallback
									? { callback: deterministicCallback }
									: {}),
							}),
							plannerRuntime,
							executorOptions: {
								// The evaluator selected one exact action. Keep that single-action
								// surface while the canonical executor rechecks role, context,
								// private-action, argument, account, and validate gates.
								actions: action ? [action] : [],
								...(args.onSettledActionResult
									? { onSettledResult: args.onSettledActionResult }
									: {}),
							},
							evaluatorEffects,
							recorder,
							trajectoryId,
							plannerLoopConfig: args.plannerLoopConfig,
							activateActionContexts: false,
						}),
					);
				} catch (error) {
					// error-policy:J1 Match the planner loop's tool boundary: a handler or
					// sub-planner throw becomes one explicit failed result for the normal
					// reply/error path rather than falling through to a second planner call.
					result = trackSettledPlannerToolResult(
						settledPlannerToolResults,
						toolCall.name,
						{
							success: false,
							error,
							text: error instanceof Error ? error.message : String(error),
						},
					);
				}
				const endedAt = Date.now();
				if (recorder && trajectoryId) {
					try {
						const input = selected.params ?? {};
						const io = captureToolStageIO({
							input,
							output: result,
							error: result.error,
						});
						const stage: RecordedStage = {
							stageId: `stage-tool-${toolCall.name}-${startedAt}`,
							kind: "tool",
							startedAt,
							endedAt,
							latencyMs: endedAt - startedAt,
							tool: {
								name: toolCall.name,
								args: input,
								result,
								success: result.success,
								durationMs: endedAt - startedAt,
								description: action?.description,
								input: io.input,
								output: io.output,
								errorText: io.errorText,
							},
						};
						await recorder.recordStage(trajectoryId, stage);
					} catch (error) {
						// error-policy:J7 Trajectory persistence is diagnostic and cannot
						// change the already-settled deterministic action result.
						args.runtime.reportError(
							"MessageService.recordDeterministicTool",
							error,
							{ trajectoryId, tool: toolCall.name },
						);
						args.runtime.logger.warn(
							{
								src: "service:message",
								err: error instanceof Error ? error.message : String(error),
								trajectoryId,
								tool: toolCall.name,
							},
							"Failed to record deterministic tool stage",
						);
					}
				}

				if (
					!callbackDelivered &&
					result.success === true &&
					result.modelReplyRequired === true
				) {
					return runPlannerLoop({
						runtime: plannerRuntime,
						context: plannerContextAfterEarlyReply,
						config: args.plannerLoopConfig,
						postToolReplySeed: { toolCall, result },
						executeToolCall: () => {
							throw new Error(
								"Post-tool reply synthesis cannot execute another tool",
							);
						},
						evaluate: ({
							runtime: plannerRuntimeForEval,
							context,
							trajectory,
						}) =>
							runEvaluator({
								runtime: plannerRuntimeForEval,
								context,
								trajectory,
								effects: evaluatorEffects,
								recorder,
								trajectoryId,
							}),
						evaluatorEffects,
						recorder,
						trajectoryId,
						providerAttributionState: plannerState,
					});
				}

				const reportableResultText = result.userFacingText?.trim();
				const finalMessage =
					!callbackDelivered &&
					reportableResultText &&
					(result.success === true || result.verifiedUserFacing === true)
						? reportableResultText
						: undefined;
				return {
					status: "finished",
					trajectory: {
						context: plannerContextAfterEarlyReply,
						steps: [{ iteration: 0, toolCall, result }],
						archivedSteps: [],
						plannedQueue: [],
						evaluatorOutputs: [],
					},
					...(finalMessage ? { finalMessage } : {}),
				};
			};

		const invokePlannerLoop = (
			loopContext: typeof plannerContextAfterEarlyReply,
		) =>
			timeInferenceSpan("message:planner", () =>
				runPlannerLoop({
					runtime: plannerRuntime,
					context: loopContext,
					config: args.plannerLoopConfig,
					tools: plannerTools.length > 0 ? plannerTools : undefined,
					requireNonTerminalToolCall,
					// Fallback honesty for required-tool exhaustion: Stage 1's own
					// replyText (when answer-shaped) is surfaced instead of the
					// generic transient-failure apology. Duplicate delivery is safe —
					// early-reply turns dedup via plannedTextRepeatsEarlyReply.
					stageOneReplyText: (() => {
						const postPatch =
							typeof messageHandler.plan.reply === "string"
								? messageHandler.plan.reply
								: undefined;
						if (
							prePatchStageOneReplyIsUngroundedAppliedClaim &&
							postPatch === prePatchStageOneReply
						) {
							return undefined;
						}
						// A promotion patch that replaced a substantive stage-0 answer
						// with a bare progress ack must not also disarm the loop's
						// answer rescue — feed the preserved pre-patch answer instead.
						if (
							prePatchStageOneReply &&
							postPatch &&
							postPatch !== prePatchStageOneReply &&
							!prePatchStageOneReplyIsUngroundedAppliedClaim &&
							PROGRESS_ONLY_ANSWER_REJECT.test(postPatch.trim())
						) {
							return prePatchStageOneReply;
						}
						// A promotion patch that CLEARED the answer outright (clearReply,
						// e.g. core.simple_registered_action_request keyword-matching a
						// conversational remark to TASKS) is the same disarm with a worse
						// outcome: the planner sanely refuses the forced tool, the miss
						// cap exhausts with no captured text, and the user gets the
						// canned apology in place of the good answer Stage 1 already
						// wrote ("test the cloud app version" in a group chat → "i'm
						// sorry, i couldn't quite finish that", live 2026-08-21).
						if (
							prePatchStageOneReply &&
							postPatch === undefined &&
							!prePatchStageOneReplyIsUngroundedAppliedClaim
						) {
							return prePatchStageOneReply;
						}
						return postPatch;
					})(),
					// Per-turn miss-budget cap for answered turns escalated only by a
					// view-surface token overlap (see viewOverlapRequiredToolMissBudget);
					// the loop honors it only when stageOneReplyText is answer-shaped.
					...(typeof messageHandler.plan.requiredToolMissBudget === "number"
						? {
								requiredToolMissBudgetOverride:
									messageHandler.plan.requiredToolMissBudget,
							}
						: {}),
					// Provenance of the tool requirement: heuristic-inferred candidates
					// let the loop accept a firmly repeated terminal answer early.
					...(messageHandler.plan.requiredToolEvidence === "inferred"
						? { requiredToolEvidence: "inferred" as const }
						: {}),
					evaluatorEffects,
					recorder,
					trajectoryId,
					providerAttributionState: plannerState,
					executeToolCall: (toolCall, ctx) =>
						timeInferenceSpan(
							"actions:planner-tool",
							async () =>
								trackSettledPlannerToolResult(
									settledPlannerToolResults,
									toolCall.name,
									await executeV5PlannedToolCall({
										runtime: args.runtime,
										toolCall,
										plannerContext: loopContext,
										executorCtx: buildV5ExecutorContext({
											message: args.message,
											state: plannerState,
											selectedContexts,
											senderRole,
											previousResults: collectPreviousActionResults(
												ctx.trajectory,
												exposedPlannerActions,
											),
											// A pending batch has not earned transcript prose, but its
											// media and interactive payloads still belong to the user.
											...(recordingCallback
												? {
														callback:
															ctx.plannerCompleted === false
																? intermediateCallback
																: recordingCallback,
													}
												: {}),
										}),
										plannerRuntime,
										executorOptions: {
											actions: exposedPlannerActions,
											...(args.onSettledActionResult
												? {
														onSettledResult: args.onSettledActionResult,
													}
												: {}),
										},
										evaluatorEffects,
										recorder,
										trajectoryId,
										plannerLoopConfig: args.plannerLoopConfig,
									}),
								),
							{ tool: toolCall.name },
						),
					evaluate: ({ runtime: plannerRuntimeForEval, context, trajectory }) =>
						timeInferenceSpan("evaluators:planner", () =>
							runEvaluator({
								runtime: plannerRuntimeForEval,
								context,
								trajectory,
								effects: evaluatorEffects,
								recorder,
								trajectoryId,
							}),
						),
				}),
			);

		let plannerResult: Awaited<ReturnType<typeof invokePlannerLoop>>;
		try {
			plannerResult = messageHandler.plan.deterministicToolCall
				? await timeInferenceSpan(
						"actions:response-handler-deterministic-tool",
						invokeDeterministicToolCall,
					)
				: await invokePlannerLoop(plannerContextAfterEarlyReply);
		} catch (error) {
			const preservedAnswer = prePatchStageOneReplyIsUngroundedAppliedClaim
				? undefined
				: prePatchStageOneReply?.trim();
			if (
				!preservedAnswer ||
				PROGRESS_ONLY_ANSWER_REJECT.test(preservedAnswer)
			) {
				// No answer-shaped Stage-1 text to rescue with — but a tool that
				// already completed this turn may still own the user-facing result
				// (observed live: the post-tool evaluator died on an intermittent
				// provider 400 and the canned transient-failure reply replaced a
				// result the turn had already produced). Deliver the preserved tool
				// result; the canned line remains only when there is genuinely
				// nothing user-facing to deliver.
				const preservedToolResult = preservedSettledToolResult(
					settledPlannerToolResults,
					deliveredVisibleTexts,
				);
				if (!preservedToolResult) {
					// #18208: a task_complete relay turn carries the sub-agent's
					// finished result in its own body — the last preserved source
					// before conceding to the canned failure reply.
					const relayBody = subAgentCompletionRelayBody(
						args.message?.content?.text,
					);
					if (!relayBody) {
						throw error;
					}
					// error-policy:J4 a completed sub-agent result is a designed
					// degrade when the relay turn's planning fails; report the loop
					// failure and deliver the result the sub-agent already produced.
					endStatus = "errored";
					args.runtime.reportError("MessageService.plannerLoop", error, {
						roomId: args.message.roomId,
					});
					return {
						kind: "direct_reply",
						messageHandler,
						result: createV5ReplyStrategyResult({
							...args,
							state: plannerState,
							text: relayBody,
							thought: messageHandler.thought,
						}),
					};
				}
				// error-policy:J4 a completed tool's user-facing result is a designed
				// degrade when later planning/evaluation fails; report the loop
				// failure and deliver the tool's known-good text.
				endStatus = "errored";
				args.runtime.reportError("MessageService.plannerLoop", error, {
					roomId: args.message.roomId,
				});
				return {
					kind: "direct_reply",
					messageHandler,
					result: createV5ReplyStrategyResult({
						...args,
						state: plannerState,
						text: preservedToolResult.userFacingText,
						thought: messageHandler.thought,
						// Only byte-exact canonical action text may skip the voice
						// gate; ordinary tool output stays eligible for re-voicing.
						...(preservedToolResult.verifiedUserFacing === true
							? { agentVoiced: true }
							: {}),
						...(preservedToolResult.userFacingEffectReceiptIds?.length
							? {
									effectReceiptIds:
										preservedToolResult.userFacingEffectReceiptIds,
								}
							: {}),
					}),
				};
			}
			// error-policy:J4 A completed Stage-1 answer is a designed degrade when
			// later planning fails; report the planner failure and deliver known-good text.
			endStatus = "errored";
			args.runtime.reportError("MessageService.plannerLoop", error, {
				roomId: args.message.roomId,
			});
			return {
				kind: "direct_reply",
				messageHandler,
				result: createV5ReplyStrategyResult({
					...args,
					state: plannerState,
					text: preservedAnswer,
					thought: messageHandler.thought,
					agentVoiced: true,
				}),
			};
		}

		// The planner's terminal prose may ship without executing REPLY. Validate
		// state assertions against capability-specific results from this same
		// trajectory; rejection fails closed here and never starts a fresh loop
		// that could discard results or replay a partial side effect.
		const egressActionResults = collectPreviousActionResults(
			plannerResult.trajectory,
			exposedPlannerActions,
		);
		const plannedReplyEgressDecision = evaluatePlannedReplyEgress({
			reply: String(plannerResult.finalMessage ?? ""),
			actionResults: egressActionResults,
			actions: args.runtime.actions,
		});
		// A reply an action callback already delivered this turn (verbatim or as
		// a strict superset) is a planner echo: the suppression below drops it, so
		// it never egresses. Bouncing it here instead would follow the visible,
		// action-owned confirmation with a contradicting "couldn't verify" bubble.
		const plannedReplyAlreadyDelivered = deliveredTextsCoverReply(
			deliveredVisibleTexts,
			normalizeVisibleTextForDuplicateCheck(
				String(plannerResult.finalMessage ?? ""),
			),
		);
		if (
			plannedReplyEgressDecision.verdict === "reject" &&
			!plannedReplyAlreadyDelivered
		) {
			args.runtime.logger?.warn?.(
				{
					src: "service:message",
					agentId: args.runtime.agentId,
					kind: plannedReplyEgressDecision.kind,
				},
				"[message] replaced a planned reply whose state claim lacked a matching action receipt",
			);
			plannerResult = {
				...plannerResult,
				finalMessage: plannedReplyEgressDecision.fallbackReply,
			};
		}

		// CONTEXT_AFTER (blocking): hooks fire after the planner loop, before
		// the response is delivered. Lets a context post-process planner
		// output (e.g. enrich the reply with context-specific data).
		await timeInferenceSpan(
			"actions:context-after",
			() =>
				args.runtime.runActionsByMode(
					"CONTEXT_AFTER",
					args.message,
					plannerState,
					{ selectedContexts },
				),
			{ mode: "CONTEXT_AFTER" },
		);

		const actionResults = collectPreviousActionResults(
			plannerResult.trajectory,
			exposedPlannerActions,
		);
		const finalPlannerState =
			actionResults.length > 0
				? withActionResultsForPrompt(plannerState, actionResults, args.runtime)
				: plannerState;
		const plannedTextRaw = String(plannerResult.finalMessage ?? "").trim();
		const deliveredMediaUrls = collectMediaDeliveryUrls(actionResults);
		const plannedText = sanitizeReplyTextAfterMediaDelivery(
			plannedTextRaw,
			deliveredMediaUrls,
		);
		// Planner deliberate silence on an ambient turn: the ambient-turn policy
		// instruction tells the planner to end an empty unaddressed turn with
		// IGNORE, so honor that choice the same way a Stage-1 IGNORE is honored —
		// a terminal decision handleMessage records observably (an
		// actions:["IGNORE"] terminal memory + MESSAGE_SENT), not a bare
		// mode-"none" result indistinguishable from a dropped turn. Scoped to
		// turns where nothing reached the user (no early ack, no action results,
		// no planner text): once anything was delivered, the existing
		// planned-reply bookkeeping below must keep owning dedupe and delivery.
		// This also pre-empts the stage-one-ack fallback below — on an ambient
		// turn an undelivered drafted ack is exactly the filler the policy
		// exists to suppress. Addressed turns never take this branch, so the
		// turn-delivery floor (an addressed turn always delivers) is untouched.
		if (
			ambientTurn &&
			plannerResult.endedWithDeliberateSilence === true &&
			!earlyReplySent &&
			actionResults.length === 0 &&
			!plannedText
		) {
			return {
				kind: "terminal",
				action: plannerResult.silentTerminalAction ?? "IGNORE",
				messageHandler,
				state: finalPlannerState,
			};
		}
		// Some action turns intentionally finish without planner prose. For async
		// work (for example spawning a coding task), still return a non-empty
		// synchronous acknowledgement so HTTP/connector callers don't render a blank
		// "(no response)" while the real work continues in the background. Respect
		// explicit suppressPlannerReply terminal actions (IGNORE/STOP-style flows),
		// which are deliberately silent.
		// Ambient deliberate silence counts as suppression even after tool work:
		// the ambient-turn policy invites the planner to attempt work before
		// choosing IGNORE, so a turn that ran a tool and then ended on a silent
		// terminal must not have the ack fallback below "fix" that silence into
		// filler ("on it, working on that now.") — the exact narration the
		// policy suppresses — nor resurrect a preserved stage-0 draft the
		// planner deliberately declined to send.
		const suppressesPlannerReply =
			actionResults.some(
				(result) =>
					(result.data as { suppressPlannerReply?: unknown } | undefined)
						?.suppressPlannerReply === true,
			) ||
			(ambientTurn && plannerResult.endedWithDeliberateSilence === true);
		const ranNonSilentAction =
			actionResults.length > 0 && !suppressesPlannerReply;
		const rawStageOneAck =
			typeof messageHandler.plan.reply === "string"
				? messageHandler.plan.reply.trim()
				: "";
		const stageOneAck =
			prePatchStageOneReplyIsUngroundedAppliedClaim &&
			rawStageOneAck === prePatchStageOneReply?.trim()
				? ""
				: rawStageOneAck;
		// Answerless-final fallback: when the planner loop finished with NO final
		// text, a preserved substantive stage-0 answer is strictly better than
		// silence or filler — deliver it. This applies whether or not an early
		// ack shipped; when one did, the dedup guard keeps the early text from
		// delivering twice. The action dedup guards below still apply.
		const preservedAnswerFallback =
			!plannedText &&
			!suppressesPlannerReply &&
			!messageHandler.plan.deterministicToolCall &&
			prePatchStageOneReply &&
			!prePatchStageOneReplyIsUngroundedAppliedClaim &&
			!PROGRESS_ONLY_ANSWER_REJECT.test(prePatchStageOneReply.trim()) &&
			(!earlyReplySent ||
				normalizeVisibleTextForDuplicateCheck(prePatchStageOneReply) !==
					normalizeVisibleTextForDuplicateCheck(earlyReplyText))
				? prePatchStageOneReply
				: "";
		// The answerless floor reports an undelivered canonical tool outcome, stays
		// silent after a callback delivery, retains an ack only for a successfully
		// accepted async handoff, and otherwise says no result was produced.
		// A media deliverable delivered through an action's own callback
		// (GENERATE_MEDIA posts an attachment-only, text:"" callback) IS the turn's
		// answer. The answerless-final floor must not then resurrect the Stage-1
		// "on it" ack behind the image — a redundant, out-of-order second bubble.
		// deliveredMediaUrls is non-empty only for a SYNCHRONOUSLY delivered media
		// attachment, so a slow/async generation (nothing delivered yet) still acks.
		const mediaDeliverableShipped = deliveredMediaUrls.length > 0;
		const ackFallback =
			!plannedText && !earlyReplySent && !suppressesPlannerReply
				? preservedAnswerFallback ||
					(ranNonSilentAction && !mediaDeliverableShipped
						? answerlessToolTurnReport({
								settledToolResults: settledPlannerToolResults,
								deliveredVisibleTexts,
								actionResults,
								actions: args.runtime.actions,
								stageOneAck,
							})
						: "")
				: preservedAnswerFallback;
		let effectiveReplyText = plannedText || ackFallback;
		// #18208: a failed sub-agent completion relay must not discard the
		// finished result it carries. When the turn ended on the generic
		// failed-tool fallback and the triggering message IS a task_complete
		// relay — whose body is the sub-agent's completed result, composed for
		// user delivery — deliver that body instead of the canned line. Every
		// other failed turn keeps the canned fallback, and the replacement
		// still flows through the egress/dedupe checks below.
		if (
			effectiveReplyText === FAILED_TOOL_FALLBACK_MESSAGE ||
			// Same rescue for the answerless variant: a relay turn whose planner
			// misfired into a rejected tool otherwise shipped "ran that, but no
			// result came back" while the finished result sat in the message body
			// (live 2026-08-19: maze-runner relay → deterministic MODEL_SWITCH
			// role-rejected → filler instead of the build result).
			effectiveReplyText === NO_REPORTABLE_TOOL_OUTCOME_MESSAGE
		) {
			const relayBody = subAgentCompletionRelayBody(
				args.message?.content?.text,
			);
			if (relayBody) {
				logger.debug(
					"[MessageService] failed relay turn degraded to preserved sub-agent result",
				);
				effectiveReplyText = relayBody;
			}
		}
		const finalReplyEgressDecision = evaluatePlannedReplyEgress({
			reply: effectiveReplyText,
			actionResults,
			actions: args.runtime.actions,
		});
		if (finalReplyEgressDecision.verdict === "reject") {
			effectiveReplyText = finalReplyEgressDecision.fallbackReply;
		}
		const effectiveReplyReceiptIds = appliedEffectReceiptIdsForReply(
			effectiveReplyText,
			actionResults,
		);
		const plannedTextRepeatsEarlyReply =
			earlyReplySent &&
			normalizeVisibleTextForDuplicateCheck(effectiveReplyText) ===
				normalizeVisibleTextForDuplicateCheck(earlyReplyText);
		// An action that already delivered this text through its own callback makes
		// the planner's finalMessage a redundant second bubble. Suppress the planner
		// echo when an action already delivered the same text OR a strict superset of
		// it — the action's richer confirmation (a created-issue URL, an id, a "reply
		// yes to confirm" follow-up) carries everything the planner's shorter
		// restatement does and more, so keep the action's text and drop the echo. The
		// non-word-boundary guard stops a short prefix from swallowing an unrelated
		// longer line ("created" must not match "created issue …").
		const normalizedPlannedReply =
			normalizeVisibleTextForDuplicateCheck(effectiveReplyText);
		const plannedTextRepeatsActionReply = deliveredTextsCoverReply(
			deliveredVisibleTexts,
			normalizedPlannedReply,
		);
		// The planner's generic failed-tool fallback exists so a failed turn is
		// never silent. When the failed action's own callback already delivered
		// its user-facing explanation (a confirmation preview, a "cloud-only"
		// boundary notice), appending "I tried … but it failed" contradicts what
		// the user just read — drop the fallback and let the tool's words stand.
		const plannedTextIsRedundantFailureFallback =
			effectiveReplyText === FAILED_TOOL_FALLBACK_MESSAGE &&
			actionResults.some((result) => {
				if (result.success !== false) return false;
				return [result.userFacingText, result.text].some((ownedText) => {
					const normalized = normalizeVisibleTextForDuplicateCheck(
						String(ownedText ?? ""),
					);
					return normalized.length > 0 && deliveredVisibleTexts.has(normalized);
				});
			});
		// The planned ⊇ delivered direction of the suppression above, gated on
		// callback-delivery provenance (the delivered-set membership) not text
		// equality: when a verifiedUserFacing action already sent its userFacingText
		// through its own callback, a planned reply that merely re-renders that block
		// verbatim duplicates a message the user already has. Only a TRIVIAL
		// re-render collapses, though — if the planner appended substantive prose to
		// the verbatim block (the evaluator's grounded answer, #7960: a `df -h` mount
		// table followed by "still 95%, 22G free"), that prose was never
		// callback-delivered and still ships; the remainder check below enforces
		// that. Verified actions that never invoked the callback fail delivered-set
		// membership, so finalMessage remains their sole delivery.
		const plannedTextRepeatsVerifiedActionDelivery = actionResults.some(
			(result) => {
				if (result.verifiedUserFacing !== true) return false;
				const verified =
					typeof result.userFacingText === "string"
						? normalizeVisibleTextForDuplicateCheck(result.userFacingText)
						: "";
				if (verified.length === 0 || !deliveredVisibleTexts.has(verified)) {
					return false;
				}
				if (!normalizedPlannedReply.includes(verified)) return false;
				// Trivial-re-render check the block comment above promises (#7960).
				const remainder = normalizedPlannedReply
					.replace(verified, " ")
					.replace(/```/g, " ");
				return !/[a-z0-9]/.test(remainder);
			},
		);
		// Substantive-remainder counterpart of the suppression above, #7960 kept
		// intact: combinedVerifiedToolTextAndProse deterministically composes
		// `<verified block>\n\n<evaluator prose>` (fencing a multiline verified
		// text), so when the verified block was already callback-delivered the
		// planned reply re-sends a verbatim copy of a message the user has and
		// the prose is the only content they have not seen. Strip the block ONLY
		// in that code-composed leading position, matched byte-exactly (fenced
		// form first, then bare) against the delivered userFacingText. A
		// paraphrased re-render or a mid-prose mention is never touched — the
		// strip must not remove anything it cannot prove was already delivered,
		// and cutting inside flowing prose could mutilate a sentence.
		let strippedPlannedReplyText = effectiveReplyText;
		for (const result of actionResults) {
			if (result.verifiedUserFacing !== true) continue;
			if (typeof result.userFacingText !== "string") continue;
			const rawVerified = result.userFacingText.trim();
			if (
				rawVerified.length === 0 ||
				!deliveredVisibleTexts.has(
					normalizeVisibleTextForDuplicateCheck(rawVerified),
				)
			) {
				continue;
			}
			const fencedVerified = `\`\`\`\n${rawVerified}\n\`\`\``;
			const source = strippedPlannedReplyText;
			if (source.startsWith(`${fencedVerified}\n\n`)) {
				strippedPlannedReplyText = source.slice(fencedVerified.length).trim();
			} else if (source.startsWith(`${rawVerified}\n\n`)) {
				strippedPlannedReplyText = source.slice(rawVerified.length).trim();
			}
		}
		let effectiveDeliveredReplyText =
			strippedPlannedReplyText || effectiveReplyText;
		let shouldSendPlannedText =
			Boolean(effectiveReplyText) &&
			// suppressPlannerReply is the action's declaration that this turn's
			// answer was already delivered outside the planner (out-of-band ack,
			// IGNORE/STOP-style terminal). The flag gated the fallbacks but not
			// the evaluator's own FINISH text, so a mimicked "On it — building
			// that now." trailed the real result (live 2026-08-19, trajectory
			// eval-FINISH evidence across four runs).
			!suppressesPlannerReply &&
			!plannedTextRepeatsEarlyReply &&
			!plannedTextRepeatsActionReply &&
			!plannedTextIsRedundantFailureFallback &&
			!plannedTextRepeatsVerifiedActionDelivery;
		// NEVER-SILENT INVARIANT (matrix F24/F12, tj-bfe764bf544bed /
		// tj-fda9d65e8d04b9): a RESPOND turn that executed tools must not end
		// with zero deliveries. Every suppression above presupposes the user
		// already received the content through some earlier delivery — when
		// NOTHING was delivered this turn (no early ack, empty delivered-set)
		// that premise is false by construction, and an empty
		// `effectiveReplyText` (a FINISH whose message evaporated in the
		// safety chain) otherwise ships `responseContent: null`: the runtime
		// produced a correct answer and the user got silence. Recover with the
		// best grounded text available and name the failure in the log so the
		// upstream emptying path is diagnosable instead of invisible.
		// Three states are NOT recoverable silence: a synchronously delivered
		// media deliverable is a delivery even though it never enters the
		// visible-TEXT set; deliberate silence (suppressPlannerReply
		// terminals, ambient IGNORE after tool work) is a contract this
		// invariant must honor, not a failure for it to "fix" into filler;
		// and a planned reply suppressed because the early ack ALREADY said it
		// verbatim means the terminal content did reach the user. An early
		// PROGRESS ack alone, however, is not a terminal answer — the turn
		// still owes the user its outcome, so `earlyReplySent` by itself does
		// not disarm the recovery; it only removes the ack (and any text that
		// repeats it) from the pool of recovery sources so nothing delivers
		// twice (#20086). One asymmetry is deliberate: the early ack only
		// ships ahead of an async handoff, whose completion arrives through a
		// later relay turn — after an ack, recover only when grounded terminal
		// text exists or any tool failed (a failed handoff will never relay
		// a completion, so the ack's promise must be corrected). A successful
		// ack-then-background turn with nothing grounded to say stays silent.
		const zeroDeliveryRecovery = resolveZeroDeliveryRecovery({
			plannedText: plannedTextRepeatsEarlyReply
				? ""
				: effectiveDeliveredReplyText,
			actionResults,
			stageOneAck,
			earlyReplySent,
		});
		if (
			!shouldSendPlannedText &&
			!suppressesPlannerReply &&
			!(earlyReplySent && plannedTextRepeatsEarlyReply) &&
			zeroDeliveryRecovery.recover &&
			deliveredVisibleTexts.size === 0 &&
			deliveredMediaUrls.length === 0 &&
			// Toolless planner deaths on an ADDRESSED turn are the same
			// recoverable silence: the planner exhausted its retries with no
			// tool call and no usable terminal text, every fallback above
			// rejected the ack-shaped Stage-1 reply, and the user saw nothing
			// (live 2026-08-17: casual-phrased coding asks after the
			// gpt-oss-120b cutover ended [messageHandler, toolSearch, planner]
			// with zero deliveries). Ambient turns keep their silence contract.
			(actionResults.length > 0 || !ambientTurn)
		) {
			args.runtime.logger.warn(
				{
					src: "service:message",
					emptyFinal: !effectiveReplyText,
					earlyReplySent,
					suppressedByEarlyReply: plannedTextRepeatsEarlyReply,
					suppressedByActionReply: plannedTextRepeatsActionReply,
					actionSuccessCount: zeroDeliveryRecovery.actionSuccessCount,
					actionFailureCount: zeroDeliveryRecovery.actionFailureCount,
					recoveredFrom: zeroDeliveryRecovery.source,
				},
				"RESPOND turn reached the reply gate with zero deliveries; recovering instead of ending silent",
			);
			effectiveReplyText = zeroDeliveryRecovery.text;
			strippedPlannedReplyText = zeroDeliveryRecovery.text;
			effectiveDeliveredReplyText = zeroDeliveryRecovery.text;
			shouldSendPlannedText = true;
		}
		// Voice-gate provenance (#14873): the Stage-1 ack has unambiguous model
		// provenance. A byte-exact canonical action result also needs preservation:
		// `verifiedUserFacing` promises do-not-paraphrase semantics, so routing that
		// text through a second model would violate its contract and can corrupt
		// punctuation or exact values. Mixed evaluator/tool prose and hardcoded
		// fallbacks remain unmarked so canned strings still receive the voice pass.
		const effectiveReplyIsModelVoice =
			!plannedText &&
			stageOneAck.length > 0 &&
			effectiveReplyText === stageOneAck;
		const effectiveReplyIsCanonicalActionText = actionResults.some(
			(result) =>
				result.verifiedUserFacing === true &&
				typeof result.userFacingText === "string" &&
				effectiveDeliveredReplyText === result.userFacingText.trim(),
		);
		const transcriptVisibility = resolveActionResultTranscriptVisibility(
			plannedTextRaw || effectiveReplyText,
			actionResults,
		);
		const contentManifestMetadata =
			await persistPlannerTrajectoryContentManifest({
				runtime: args.runtime,
				message: args.message,
				trajectory: plannerResult.trajectory,
				lastUsedAt: new Date().toISOString(),
			});

		return {
			kind: "planned_reply",
			messageHandler,
			result: shouldSendPlannedText
				? {
						...createV5ReplyStrategyResult({
							...args,
							state: finalPlannerState,
							text: effectiveDeliveredReplyText,
							thought:
								plannerResult.evaluator?.thought ??
								plannerResult.trajectory.steps.at(-1)?.thought ??
								messageHandler.thought,
							agentVoiced:
								effectiveReplyIsModelVoice ||
								effectiveReplyIsCanonicalActionText,
							...(effectiveReplyReceiptIds.length > 0
								? { effectReceiptIds: effectiveReplyReceiptIds }
								: {}),
							...(transcriptVisibility ? { transcriptVisibility } : {}),
							...(contentManifestMetadata
								? { metadata: contentManifestMetadata }
								: {}),
						}),
						...(actionResults.length > 0 ? { actionResults } : {}),
					}
				: {
						responseContent: null,
						responseMessages: [],
						state: finalPlannerState,
						mode: "none",
						...(actionResults.length > 0 ? { actionResults } : {}),
					},
		};
	} catch (err) {
		// error-policy:J2 Preserve the failing status for trajectory diagnostics,
		// then rethrow the original failure to the message boundary.
		endStatus = "errored";
		throw err;
	} finally {
		// Trajectory persistence is diagnostic work. Preserve stage ordering in
		// its own task without adding filesystem latency to the user-visible turn.
		const finalizeTrajectory = async (waitForFacts: boolean) => {
			if (!recorder || !trajectoryId) return;
			await messageHandlerStageTask;
			const factsOutcome = waitForFacts ? await factsTask : settledFactsOutcome;
			if (factsOutcome) {
				await recordFactsAndRelationshipsStage({
					recorder,
					trajectoryId,
					outcome: factsOutcome,
					runtime: args.runtime,
				});
			}
			await finalizeTrajectoryRecording({
				recorder,
				trajectoryId,
				status: endStatus,
				reportError: args.runtime.reportError.bind(args.runtime),
				logger: args.runtime.logger as {
					warn?: (context: unknown, message?: string) => void;
				},
			});
		};
		if (process.env.ELIZA_AWAIT_FACTS_STAGE === "true") {
			await finalizeTrajectory(true);
		} else if (recorder && trajectoryId) {
			detachPostDeliverySideEffect(
				args.runtime,
				"trajectory-finalization",
				() => finalizeTrajectory(false),
				"diagnostic",
			);
			if (
				settledFactsOutcome === undefined &&
				args.runTerminalOwner === undefined
			) {
				detachPostDeliverySideEffect(
					args.runtime,
					"facts-and-relationships",
					async () => {
						await factsTask;
					},
					"room-state",
					args.message.roomId,
					args.roomHandlerLease,
				);
			}
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
	state?: State;
	runtime: IAgentRuntime;
}): Promise<void> {
	try {
		const responseText = getMessageHandlerResponseText(args.raw, args.parsed);
		const usage =
			typeof args.raw === "string"
				? undefined
				: extractMessageHandlerUsage(args.raw);
		const modelName = extractMessageHandlerModelName(args.raw);
		// Flatten `messages` only to locate provider spans; the flattened form is
		// not persisted — `messages` is the canonical record and spans index into
		// `flattenTrajectoryMessages(messages)` reconstructed at read time.
		const providerAttribution = buildProviderAttributionsFromState({
			state: args.state,
			prompt: flattenTrajectoryMessages(args.messages),
		});
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
				providerOrder: providerAttribution.providerOrder,
				providerAttributions: providerAttribution.providerAttributions,
			},
			cache: args.prefixHash
				? {
						segmentHashes: args.segmentHashes ?? [],
						prefixHash: args.prefixHash,
					}
				: undefined,
		});
	} catch (err) {
		// error-policy:J7 Trajectory persistence is diagnostic and must surface
		// without changing the user-visible turn.
		args.runtime.logger.warn(
			{ err: (err as Error).message, trajectoryId: args.trajectoryId },
			"[TrajectoryRecorder] failed to record messageHandler stage",
		);
		args.runtime.reportError("MessageService.recordMessageHandlerStage", err, {
			trajectoryId: args.trajectoryId,
		});
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
	runtime: IAgentRuntime;
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
					// The trajectory contract records facts as strings; the speaker
					// attribution is rendered inline so replays can audit it.
					facts: result.parsed.facts.map((fact) =>
						fact.subject && fact.subject !== "user"
							? `[${fact.subject}] ${fact.fact}`
							: fact.fact,
					),
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
		// error-policy:J7 Trajectory persistence is diagnostic and must surface
		// without changing the user-visible turn.
		args.runtime.logger.warn(
			{ err: (err as Error).message, trajectoryId: args.trajectoryId },
			"[TrajectoryRecorder] failed to record factsAndRelationships stage",
		);
		args.runtime.reportError(
			"MessageService.recordFactsAndRelationshipsStage",
			err,
			{ trajectoryId: args.trajectoryId },
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
			reasoningTokens?: number;
			totalTokens: number;
	  }
	| undefined {
	const usage = raw.usage;
	if (!usage) return undefined;
	const promptTokens = usage.promptTokens;
	const completionTokens = usage.completionTokens;
	const totalTokens = usage.totalTokens;
	const out: {
		promptTokens: number;
		completionTokens: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		reasoningTokens?: number;
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
	if (typeof usage.reasoningTokens === "number") {
		out.reasoningTokens = usage.reasoningTokens;
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
const latestResponseIds = new Map<string, Map<string, string[]>>();
const INFERENCE_TIMING_LOG_TYPE = "inference_timing";
const INFERENCE_TIMING_LOG_RETENTION = 4_096;
const INFERENCE_TIMING_LOG_SWEEP_INTERVAL = 64;
const inferenceTimingWritesSinceSweep = new WeakMap<IAgentRuntime, number>();

export async function persistInferenceTimingSummary(
	runtime: IAgentRuntime,
	message: Memory,
	summary: InferenceTurnSummary,
): Promise<void> {
	await runtime.createLogs([
		{
			body: {
				runId: summary.turnId,
				messageId: message.id,
				roomId: message.roomId,
				entityId: runtime.agentId,
				source: INFERENCE_TIMING_LOG_TYPE,
				startTime: summary.t0EpochMs,
				endTime: summary.closedAtEpochMs ?? undefined,
				duration: summary.totalMs ?? undefined,
				metadata: {
					label: summary.label,
					traceId: summary.traceId,
					modelProvider: summary.modelProvider,
					timeToFirstTokenMs: summary.timeToFirstTokenMs,
					timeToFirstVisibleMs: summary.timeToFirstVisibleMs,
					timeToReplyMs: summary.timeToReplyMs,
					timeToResponseFinalizedMs: summary.timeToResponseFinalizedMs,
					spans: summary.spans.map((span) => ({
						name: span.name,
						startMs: span.startMs,
						endMs: span.endMs,
						durationMs: span.durationMs,
						...(span.meta ? { meta: span.meta } : {}),
					})),
					marks: summary.marks.map((mark) => ({
						name: mark.name,
						tMs: mark.tMs,
					})),
					byName: summary.byName,
					anomalies: summary.anomalies,
				},
			},
			entityId: runtime.agentId,
			roomId: message.roomId,
			type: INFERENCE_TIMING_LOG_TYPE,
		},
	]);

	const priorWritesSinceSweep = inferenceTimingWritesSinceSweep.get(runtime);
	const writesSinceSweep =
		(priorWritesSinceSweep === undefined ? 0 : priorWritesSinceSweep) + 1;
	if (writesSinceSweep < INFERENCE_TIMING_LOG_SWEEP_INTERVAL) {
		inferenceTimingWritesSinceSweep.set(runtime, writesSinceSweep);
		return;
	}
	inferenceTimingWritesSinceSweep.set(runtime, 0);
	const rows = await runtime.getLogs({
		type: INFERENCE_TIMING_LOG_TYPE,
		limit: INFERENCE_TIMING_LOG_RETENTION + 1_024,
	});
	const expiredIds = rows
		.slice(INFERENCE_TIMING_LOG_RETENTION)
		.map((row) => row.id)
		.filter((id): id is UUID => typeof id === "string");
	if (expiredIds.length > 0) {
		await runtime.deleteLogs(expiredIds);
	}
}

function clearLatestResponseId(
	agentId: UUID,
	roomId: UUID,
	responseId: UUID,
): void {
	const agentMap = latestResponseIds.get(agentId);
	if (!agentMap) {
		return;
	}

	const roomResponses = agentMap.get(roomId);
	if (!roomResponses) {
		return;
	}
	const responseIndex = roomResponses.lastIndexOf(responseId);
	if (responseIndex < 0) return;
	roomResponses.splice(responseIndex, 1);
	if (roomResponses.length === 0) agentMap.delete(roomId);
	if (agentMap.size === 0) {
		latestResponseIds.delete(agentId);
	}
}

function getLatestResponseId(agentId: UUID, roomId: UUID): string | undefined {
	const roomResponses = latestResponseIds.get(agentId)?.get(roomId);
	return roomResponses?.[roomResponses.length - 1];
}

function detachPostDeliverySideEffect(
	runtime: Pick<IAgentRuntime, "agentId" | "reportError">,
	label: string,
	task: () => Promise<unknown>,
	kind: "room-state" | "diagnostic" = "room-state",
	roomId?: string,
	roomHandlerLease?: RoomHandlerLease,
): Promise<void> {
	return trackPostDeliveryTask(
		runtime,
		label,
		task,
		kind === "diagnostic"
			? { kind }
			: roomId && roomHandlerLease
				? { kind, roomId, roomHandlerLease }
				: { kind },
	);
}

/**
 * Owns asynchronous continuations whose provider, model, or database-trajectory
 * captures belong to one message-service run. Delivery returns as soon as the
 * visible result is ready; the detached terminal waits for this set to quiesce,
 * then emits exactly one `RUN_ENDED` event. File-recorder finalization and
 * bounded inference-timing persistence are diagnostic-only and intentionally
 * drain independently. A run-owned task may not join after terminalization is
 * requested.
 */
class MessageRunTerminalOwner {
	private readonly pending = new Set<Promise<void>>();
	private terminalRequest:
		| {
				status: RunEventPayload["status"];
				error?: unknown;
		  }
		| undefined;
	private terminalTask: Promise<void> | undefined;

	constructor(
		private readonly runtime: IAgentRuntime,
		private readonly runId: UUID,
		private readonly message: Memory,
		private readonly startTime: number,
		private readonly roomHandlerLease?: RoomHandlerLease,
	) {}

	track(label: string, task: () => Promise<unknown>): Promise<void> {
		if (this.terminalRequest) {
			const error = new ElizaError(
				"Run-owned work cannot start after terminalization was requested",
				{
					code: "RUN_TASK_AFTER_TERMINAL",
					context: {
						label,
						runId: this.runId,
						messageId: this.message.id,
					},
				},
			);
			this.runtime.reportError("MessageRunTerminalOwner.track", error, {
				label,
				runId: this.runId,
				messageId: this.message.id,
			});
			return Promise.resolve();
		}

		let tracked!: Promise<void>;
		tracked = Promise.resolve()
			.then(task)
			.then(() => undefined)
			.catch((error) => {
				// error-policy:J1 User delivery is already committed. Preserve the exact
				// child failure while allowing the terminal barrier to release the run.
				this.runtime.reportError("PostDeliveryTask", error, {
					agentId: this.runtime.agentId,
					label,
					runId: this.runId,
				});
			})
			.finally(() => {
				this.pending.delete(tracked);
			});
		this.pending.add(tracked);
		return tracked;
	}

	adopt(label: string, task: Promise<unknown>): Promise<void> {
		return this.track(label, () => task);
	}

	request(status: RunEventPayload["status"], error?: unknown): Promise<void> {
		if (this.terminalRequest) return this.terminalTask ?? Promise.resolve();
		this.terminalRequest = {
			status,
			...(error === undefined ? {} : { error }),
		};
		try {
			this.terminalTask = detachPostDeliverySideEffect(
				this.runtime,
				"RUN_ENDED",
				async () => {
					while (this.pending.size > 0) {
						await Promise.allSettled([...this.pending]);
					}
					const terminal = this.terminalRequest;
					if (!terminal) {
						throw new ElizaError("Run terminal request disappeared", {
							code: "RUN_TERMINAL_REQUEST_MISSING",
							context: { runId: this.runId, messageId: this.message.id },
						});
					}
					await this.runtime.emitEvent(EventType.RUN_ENDED, {
						runtime: this.runtime,
						source: "messageHandler",
						runId: this.runId,
						messageId: this.message.id,
						roomId: this.message.roomId,
						entityId: this.message.entityId,
						startTime: this.startTime,
						status: terminal.status,
						endTime: Date.now(),
						duration: Date.now() - this.startTime,
						...(terminal.error === undefined
							? {}
							: {
									error:
										terminal.error instanceof Error
											? terminal.error
											: String(terminal.error),
								}),
					} as RunEventPayload);
				},
				"room-state",
				this.message.roomId,
				this.roomHandlerLease,
			);
		} catch (terminalScheduleError) {
			this.terminalRequest = undefined;
			throw terminalScheduleError;
		}
		return this.terminalTask;
	}
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

const POST_TURN_SEMANTIC_SIGNAL =
	/(?:https?:\/\/|\b(?:i am|i'm|i have|i've|i feel|i like|i love|i hate|i prefer|i need|i want|my|we|our|remember|friend|partner|wife|husband|relationship|work at|live in|located in|goal|plan)\b)/i;

export function hasPostTurnSemanticSignal(
	message: Pick<Memory, "content">,
	state: Pick<State, "data"> | undefined,
	responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
	if (!isSimpleReplyResponse(responseContent)) return true;
	const actionResults = state?.data?.actionResults;
	if (Array.isArray(actionResults) && actionResults.length > 0) return true;
	const text = message.content.text?.trim() ?? "";
	return POST_TURN_SEMANTIC_SIGNAL.test(text);
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
	const trimmed = value
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
		/\b(?:do not|don't|dont|without)\s+(?:spawn|delegate|use|start)\s+(?:a\s+)?(?:sub[- ]?agent|task[- ]?agent|coding agent|eliza[- ]?code|opencode|codex|claude)\b/iu.test(
			normalized,
		)
	) {
		return true;
	}
	// A shared link with no explicit work imperative is content to react to,
	// not a work order — even when the model itself proposed a spawn candidate
	// off the embed preview text (observed live: bare URL + embed title →
	// TASKS_SPAWN_AGENT with an empty derived task → doomed sub-agent).
	if (looksLikeBareLinkShare(normalized)) {
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

const LEGACY_CODING_WORK_VERB_PATTERN =
	/\b(?:build|create|make|implement|write|scaffold|fix|edit|modify|update|verify)\b/giu;
// Add-family verbs are everyday mutation words ("add a reminder", "delete the
// weather app"), so they pair ONLY with strong code artifacts — never the
// legacy artifact set whose app/site/page tokens belong to view and app
// management asks. Live gap 2026-08-18: "yo can u add a lil one-line
// description to the readme in my <name> repo and put up a pr" carried
// repo+pr artifacts but no legacy verb; no deterministic coding candidate
// fired and Stage-1 answered ["simple"] from stale room history, fabricating
// "a PR is up".
const ADD_FAMILY_CODING_VERB_PATTERN =
	/\b(?:add|append|insert|rename|remove|delete)\b/giu;
const LEGACY_CODING_ARTIFACT_PATTERN =
	/\b(?:app|site|website|page|code|file|files|project|cli|script|backend|frontend|repo|feature|bug|url)\b/giu;
const CODING_OPERATION_VERB_PATTERN =
	/\b(?:refactor|debug|deploy|patch|optimize|migrate|profile)\b/giu;
// Repo-submission verbs pair ONLY with the strong code artifacts: "put up a
// pr", "push a branch", "open a pull request". "open" lives here and NOT in
// the legacy verb set because anchored to pr/repo/branch it is unambiguous,
// while "open the app/page" is view navigation.
const REPO_SUBMIT_VERB_PATTERN =
	/\b(?:put\s+up|open|submit|push|raise|file)\b/giu;
const REVIEW_WORK_VERB_PATTERN =
	/\b(?:review|audit|investigate|analyze|inspect|test|trace|diagnose)\b/giu;
const STRONG_CODE_ARTIFACT_PATTERN =
	/\b(?:code|cli|script|backend|frontend|repo|repository|bug|pr|pull request|commit|branch|stack trace|pipeline|ci|readme|changelog)\b/giu;
const EXPANDED_WORK_ARTIFACT_PATTERN =
	/\b(?:app|site|website|page|code|file|files|project|cli|script|backend|frontend|repo|repository|feature|bug|url|pr|pull request|issue|commit|branch|build|test|error|stack trace|failure|log|docs|documentation|run|pipeline|ci)\b/giu;
const HTTP_URL_PATTERN = /\bhttps?:\/\/[^\s<>()]+/iu;

interface TextSpan {
	start: number;
	end: number;
}

function collectTextSpans(text: string, pattern: RegExp): TextSpan[] {
	return Array.from(text.matchAll(pattern), (match) => ({
		start: match.index,
		end: match.index + match[0].length,
	}));
}

function hasNearbyTerms(
	text: string,
	leftPattern: RegExp,
	rightPattern: RegExp,
	maxGap: number,
): boolean {
	const leftSpans = collectTextSpans(text, leftPattern);
	const rightSpans = collectTextSpans(text, rightPattern);
	return leftSpans.some((left) =>
		rightSpans.some((right) => {
			if (left.end <= right.start) return right.start - left.end <= maxGap;
			if (right.end <= left.start) return left.start - right.end <= maxGap;
			return true;
		}),
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
		// Preserve the pre-#18108 construction/edit contract exactly.
		hasNearbyTerms(
			normalized,
			LEGACY_CODING_WORK_VERB_PATTERN,
			LEGACY_CODING_ARTIFACT_PATTERN,
			160,
		) ||
		// Coding-native operations can safely use the expanded artifact set.
		hasNearbyTerms(
			normalized,
			CODING_OPERATION_VERB_PATTERN,
			EXPANDED_WORK_ARTIFACT_PATTERN,
			160,
		) ||
		// Review-family verbs are common in health, finance, and personal work.
		// Promote them without a URL only when paired with a code-specific noun.
		hasNearbyTerms(
			normalized,
			REVIEW_WORK_VERB_PATTERN,
			STRONG_CODE_ARTIFACT_PATTERN,
			160,
		) ||
		// Submission verbs anchored to strong code artifacts: "put up a pr",
		// "push the branch", "open a pull request".
		hasNearbyTerms(
			normalized,
			REPO_SUBMIT_VERB_PATTERN,
			STRONG_CODE_ARTIFACT_PATTERN,
			160,
		) ||
		// Add-family mutations anchored to strong code artifacts: "add a line
		// to the readme", "rename the branch", "delete the stale commit".
		hasNearbyTerms(
			normalized,
			ADD_FAMILY_CODING_VERB_PATTERN,
			STRONG_CODE_ARTIFACT_PATTERN,
			160,
		) ||
		// A URL plus a nearby review-family verb and work artifact is the
		// deterministic work-order shape reported in #18108. Without the URL,
		// generic nouns such as issue, test, log, or documentation remain planner
		// decisions instead of being mislabeled as coding jobs.
		(HTTP_URL_PATTERN.test(normalized) &&
			hasNearbyTerms(
				normalized,
				REVIEW_WORK_VERB_PATTERN,
				EXPANDED_WORK_ARTIFACT_PATTERN,
				160,
			));
	return asksDelegation || asksCodingWork;
}

function looksLikeExplicitDelegationRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	return (
		/\b(?:spawn|delegate|use|start|ask|have)\b[\s\S]{0,80}\b(?:sub[- ]?agent|task[- ]?agent|coding agent|eliza[- ]?code|opencode|codex|claude)\b/iu.test(
			normalized,
		) ||
		/\b(?:sub[- ]?agent|task[- ]?agent|coding agent|eliza[- ]?code|opencode|codex|claude)\b[\s\S]{0,80}\b(?:build|create|make|implement|write|scaffold|fix|edit|modify|verify)\b/iu.test(
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
	// A script whose whole body is one constant statement ("a python script
	// that just prints nubs") is a snippet the reply can carry inline; routing
	// it through a coding sub-agent spent a 27s build and the user never saw
	// the one line (live 2026-08-22). Scoped by the just/only/simply marker so
	// computed deliverables ("prints a random card") still get built and run.
	const constantOutputScript =
		/\b(?:script|program)\b[\s\S]{0,40}\b(?:just|only|simply)\s+(?:prints?|says?|outputs?|echo(?:es)?|displays?|returns?)\b/iu.test(
			normalized,
		);
	const asksForSnippet =
		constantOutputScript ||
		/\b(?:write|give me|show me|generate|provide|create|make)\b[\s\S]{0,80}\b(?:code block|snippet|function|class|method|example|program|one[- ]?liner|hello world|fibonacci)\b/iu.test(
			normalized,
		) ||
		/\b(?:code block|snippet|function|class|method|example|program|one[- ]?liner|hello world|fibonacci)\b[\s\S]{0,80}\b(?:in|using|for)\s+(?:python|javascript|typescript|java|go|rust|ruby|bash|shell|c\+\+|c#|c\b|php|swift|kotlin)\b/iu.test(
			normalized,
		);
	const hasSmallScope =
		constantOutputScript ||
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
 * Race-keep policy for a finished response that a newer same-room message
 * superseded mid-generation. Returns the human-readable keep reason, or null
 * when the response should be discarded. Kept only when the planner
 * deliberately chose to converse (explicit REPLY/RESPOND): every deliverable
 * response constructor in this pipeline sets `actions:["REPLY"]`, so this is
 * the complete keep set — a discard is always a non-deliverable shape, and it
 * ends the run with the observable "replaced" terminal instead of vanishing.
 */
export function resolveSupersededResponseKeepReason(
	responseContent: Pick<Content, "actions"> | null | undefined,
): string | null {
	if (hasExplicitReplyIntent(responseContent)) {
		return "explicit REPLY for an addressed message";
	}
	return null;
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

function enforceEffectGroundedVisibleContent(
	runtime: Pick<IAgentRuntime, "logger">,
	response: Content,
	actionName?: string,
): Content {
	const hasEffectDeliveryBinding =
		getEffectDeliveryBinding(response) !== undefined;
	if (!hasEffectDeliveryBinding && response.effectReceiptIds !== undefined) {
		response = stripEffectDeliveryBinding(response);
	}
	const effectDeliveryBindingInvalid =
		hasEffectDeliveryBinding && !effectDeliveryBindingIsValid(response);
	if (
		effectDeliveryBindingInvalid ||
		(typeof response.text === "string" &&
			replyClaimsCompletedSideEffect(response.text) &&
			!effectDeliveryBindingProvesApplication(response))
	) {
		runtime.logger.warn(
			{
				src: "service:message",
				actionName: resolveCallbackActionName(response, actionName),
			},
			"Replaced visible completion text that lacked validated effect receipt bindings",
		);
		return {
			...stripEffectDeliveryBinding(response),
			text: UNVERIFIED_EFFECT_REPLY,
			agentVoiced: false,
		};
	}
	return response;
}

/**
 * Withhold a response whose declared disclosure subject the attested delivery
 * audience does not admit in FULL. Built from constants so nothing from the
 * withheld payload survives; `privacyReason` carries `audience_admission` plus
 * the min level the room earned, so the model-visible note and downstream
 * tooling can tell an audience-admission withholding apart from the
 * owner-exclusive revalidation denial.
 */
function audienceAdmissionWithheld(
	runtime: IAgentRuntime,
	message: Memory,
	level: "redacted" | "none",
	blockingCount: number,
): Content {
	runtime.logger.warn(
		{
			src: "service:message",
			messageId: message.id,
			roomId: message.roomId,
			admissionLevel: level,
			blockingCount,
		},
		"Withheld scoped response the delivery audience does not admit in full",
	);
	return {
		text: PRIVACY_DENIED_TEXT,
		actions: ["PRIVACY_DENIED"],
		data: {
			privacyDenied: true,
			privacyReason: `audience_admission:${level}`,
		},
	};
}

/**
 * Enforce min-over-members audience admission at egress for a response that
 * declares the disclosure subject it requires of its recipients
 * (`content.data.disclosureSubject`). The attested delivery audience is joined
 * with the subject through the pure policy core
 * ({@link resolveEgressAudienceAdmission}); anything short of a FULL admission
 * withholds the response. Fail-closed: a declared subject with NO attested
 * audience earns nothing and is withheld, so a scoped reply cannot ship into an
 * unverified room. A response with no declared subject is not narrowed here and
 * falls through to the caller's other egress checks unchanged.
 */
function enforceAudienceAdmissionAtEgress(
	runtime: IAgentRuntime,
	message: Memory,
	response: Content,
): Content {
	const data = isRecord(response.data) ? response.data : undefined;
	if (!data || !("disclosureSubject" in data)) return response;
	const subject = parseEgressDisclosureSubject(data.disclosureSubject);
	// A `disclosureSubject` key present but unparseable never means "unscoped":
	// `parseEgressDisclosureSubject` fails closed to owner-private, so `subject`
	// is defined whenever the key exists. Guard anyway for undefined markers.
	if (!subject) return response;
	const audience = getTrustedDeliveryAudience(message);
	if (!audience) {
		// A scoped response with no attested audience earns nothing — withhold
		// rather than ship into an unverified room. (Not an error-policy case:
		// there is no catch here, and tagging an ordinary guard pollutes the
		// grep that exists to audit retained catches.)
		return audienceAdmissionWithheld(runtime, message, "none", 0);
	}
	const admission = resolveEgressAudienceAdmission(subject, audience);
	if (admission.level === "full") return response;
	return audienceAdmissionWithheld(
		runtime,
		message,
		admission.level,
		admission.blockingEntityIds.length,
	);
}

/**
 * Revalidate a turn that consumed owner-private data immediately before any
 * visible or durable egress. The replacement is constructed from constants so
 * no text, attachment, or structured payload from the private result survives.
 *
 * Two independent, both-fail-closed seams run here: first the per-recipient
 * audience-admission check for a response that declares its own disclosure
 * subject ({@link enforceAudienceAdmissionAtEgress}), then the owner-exclusive
 * revalidation for turns that consumed owner-private context. Either may
 * withhold; a withholding from the first short-circuits the second because its
 * replacement carries no owner-private data to revalidate.
 */
export async function enforceTrustedDeliveryAudienceAtEgress(
	runtime: IAgentRuntime,
	message: Memory,
	response: Content,
): Promise<Content> {
	const admissionChecked = enforceAudienceAdmissionAtEgress(
		runtime,
		message,
		response,
	);
	if (admissionChecked !== response) return admissionChecked;
	if (!ownerExclusiveDisclosureWasUsed(message)) return response;
	const disclosure = await revalidateOwnerExclusiveDisclosure(runtime, message);
	if (disclosure.allowed) return response;
	runtime.logger.warn(
		{
			src: "service:message",
			messageId: message.id,
			roomId: message.roomId,
			reason: disclosure.reason,
		},
		"Suppressed owner-private response after delivery audience changed",
	);
	return {
		text: PRIVACY_DENIED_TEXT,
		actions: ["PRIVACY_DENIED"],
		data: {
			privacyDenied: true,
			privacyReason: disclosure.reason,
		},
	};
}

/**
 * Apply the final audience check to the complete message-service result shape.
 * Actions mode can accumulate several response memories, so a denied turn must
 * replace every one rather than sanitizing only the top-level chat content.
 */
export async function enforceTrustedDeliveryAudienceOnResult(
	runtime: IAgentRuntime,
	message: Memory,
	responseContent: Content | null,
	responseMessages: Memory[],
): Promise<{
	responseContent: Content | null;
	responseMessages: Memory[];
}> {
	// Two egress seams can withhold here: the owner-exclusive revalidation (only
	// relevant when the turn consumed owner-private data) and the per-recipient
	// audience-admission check (relevant whenever the response declares its own
	// disclosure subject). Skip the pass only when NEITHER can fire.
	const declaresDisclosureSubject =
		isRecord(responseContent?.data) &&
		"disclosureSubject" in responseContent.data;
	if (!ownerExclusiveDisclosureWasUsed(message) && !declaresDisclosureSubject) {
		return { responseContent, responseMessages };
	}
	const finalContent = await enforceTrustedDeliveryAudienceAtEgress(
		runtime,
		message,
		responseContent ?? {},
	);
	if (
		!isRecord(finalContent.data) ||
		finalContent.data.privacyDenied !== true
	) {
		return { responseContent, responseMessages };
	}
	return {
		responseContent: finalContent,
		responseMessages: responseMessages.map((responseMemory) => ({
			...responseMemory,
			content: { ...finalContent },
		})),
	};
}

/**
 * Builds provider-neutral TTS input from character settings.
 *
 * Only `voiceId` is a provider voice identifier. The historical `model`
 * field contains Piper voice tags and `url` contains an endpoint, so forwarding
 * either as `voice` breaks OpenAI and cloud provider selection. Omitting
 * `voice` lets the active provider apply its own valid default.
 */
function buildTextToSpeechParams(
	runtime: Pick<IAgentRuntime, "character">,
	text: string,
	signal?: AbortSignal,
): TextToSpeechParams {
	const voiceSettings = runtime.character.settings?.voice as
		| { voiceId?: string }
		| undefined;
	const voiceId = voiceSettings?.voiceId?.trim();
	return {
		text,
		...(voiceId ? { voice: voiceId } : {}),
		...(signal ? { signal } : {}),
	};
}

/**
 * First-sentence cloud-TTS delivery for streaming turns: synthesize the
 * sentence and hand the audio to the callback as a data-URI attachment. The
 * local-inference voice loop uses VoiceScheduler/PhraseChunker instead
 * (packages/app-core/src/services/local-inference/voice/scheduler.ts) — this
 * is not duplicated, it's the cloud-deployment counterpart (packages/core
 * can't import packages/app-core; the two paths live at different layers and
 * only one is active per deployment).
 *
 * Guarded before synthesis: for an envelope echo the "first sentence" IS the
 * security-notice line, and this delivery bypasses the text-only outbound
 * guard entirely (callback text is "", the armor rides in attachment.text and
 * the synthesized audio). Envelope material is never spoken or attached —
 * the delivery is skipped and reported instead. Exported for tests: the
 * stream closure it serves is only reachable through a full handleMessage
 * turn.
 */
export async function deliverFirstSentenceVoice(
	runtime: Pick<
		IAgentRuntime,
		"character" | "getModel" | "useModel" | "logger" | "reportError"
	>,
	first: string,
	callback: HandlerCallback | undefined,
	abortSignal?: AbortSignal,
): Promise<void> {
	if (containsExternalEnvelopeMaterial(first)) {
		reportOutboundEnvelopeBlock(runtime, first, "stream-tts");
		return;
	}
	try {
		let audioBuffer: Buffer | null = null;
		const params = buildTextToSpeechParams(runtime, first, abortSignal);
		const result = runtime.getModel(ModelType.TEXT_TO_SPEECH)
			? await runtime.useModel(ModelType.TEXT_TO_SPEECH, params)
			: undefined;

		if (
			result instanceof ArrayBuffer ||
			Object.prototype.toString.call(result) === "[object ArrayBuffer]"
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
						description: "Voice response for first sentence",
						text: first,
						contentType: ContentType.AUDIO,
					},
				],
				source: "voice",
			});
		}
	} catch (error) {
		// error-policy:J4 voice is an optional enhancement of a streamed turn;
		// a failed synthesis logs and the guarded text reply still delivers.
		runtime.logger.error(
			{ error },
			"Error generating voice for first sentence",
		);
	}
}

export function wrapSingleTurnVisibleCallback(
	// reportError is required: the fail-closed envelope guard inside `deliver`
	// must be able to surface a blocked leak even from partial test runtimes.
	runtime: Pick<IAgentRuntime, "agentId" | "logger" | "reportError"> &
		Partial<Pick<IAgentRuntime, "character" | "useModel">> & {
			getService?: IAgentRuntime["getService"];
		},
	message: Pick<Memory, "id" | "roomId" | "entityId">,
	callback?: HandlerCallback,
	recordDeliveredVisibleText?: (text: string) => void,
): HandlerCallback | undefined {
	if (!callback) return callback;
	const fullRuntime = runtime as IAgentRuntime;
	// Turn-scoped paraphrase suppression: a relay turn can REPLY, run another
	// tool, then REPLY again with a light rewording of the same completion
	// ("added an Install section … (15 lines added)." then "added an
	// **Install** section … (15 insertions)." — live 2026-08-18, double
	// message in the channel). Exact-dupe recording already exists downstream;
	// this catches the paraphrase class at the one funnel every visible
	// delivery passes through. Guarded tightly — ≥8 shared-vocabulary tokens
	// and ≥0.85 Jaccard — so progress updates that differ in the numbers or
	// content keep flowing.
	const deliveredTokenSetsThisTurn: Array<Set<string>> = [];
	const nearDuplicateOfDeliveredThisTurn = (text: string): boolean => {
		const tokens = new Set(
			text
				.toLowerCase()
				.replace(/[*_`~#>]+/g, " ")
				.split(/[^a-z0-9%.]+/)
				.filter((token) => token.length > 0),
		);
		if (tokens.size < 8) return false;
		for (const prior of deliveredTokenSetsThisTurn) {
			if (prior.size < 8) continue;
			let shared = 0;
			for (const token of tokens) if (prior.has(token)) shared++;
			const union = prior.size + tokens.size - shared;
			if (union > 0 && shared / union >= 0.85) return true;
		}
		return false;
	};
	const deliver = async (response: Content, actionName?: string) => {
		const fullMessage = message as Memory;
		response = await enforceTrustedDeliveryAudienceAtEgress(
			fullRuntime,
			fullMessage,
			response,
		);
		if (isRecord(response.data) && response.data.privacyDenied === true) {
			actionName = "PRIVACY_DENIED";
		}
		if (response.transcriptVisibility === "internal") {
			return [];
		}
		let rawUnsanitizedText: string | undefined;
		// Shared post-model, pre-channel sanitization (#15888): every visible
		// delivery — action callbacks, early replies, simple replies, terminal
		// content — funnels through this wrap, so stripping leaked machine
		// syntax here covers every connector without per-connector copies. The
		// envelope guard then fail-closed blocks any security-envelope echo the
		// model produced, replacing it with the honest leak notice.
		if (typeof response?.text === "string" && response.text.length > 0) {
			const guarded = guardOutboundEnvelopeText(
				fullRuntime,
				sanitizeOutboundText(response.text),
				"visible-callback",
			);
			if (guarded !== response.text) {
				// Record the raw form too: planner-echo suppression compares the
				// planner's unsanitized finalMessage against this set, and must
				// still recognize a delivery whose wire text was sanitized.
				rawUnsanitizedText = response.text.trim() ? response.text : undefined;
				response = { ...response, text: guarded };
			}
		}
		// Attachments are a delivery surface the text guard never sees: both
		// voice paths ship the spoken sentence as attachment.text under an empty
		// top-level text, so envelope material must be blocked here too.
		if (
			Array.isArray(response.attachments) &&
			response.attachments.length > 0
		) {
			const guardedAttachments = guardOutboundEnvelopeAttachments(
				fullRuntime,
				response.attachments,
				"visible-callback-attachment",
			);
			if (guardedAttachments !== response.attachments) {
				response = { ...response, attachments: guardedAttachments };
				// When the blocked attachment was the whole payload there is
				// nothing honest left to send — skip the delivery instead of
				// handing connectors an empty message.
				if (
					guardedAttachments.length === 0 &&
					!(typeof response.text === "string" && response.text.trim())
				) {
					return [];
				}
			}
		}
		response = enforceEffectGroundedVisibleContent(
			fullRuntime,
			response,
			actionName,
		);
		if (typeof response?.text === "string" && response.text.trim()) {
			if (nearDuplicateOfDeliveredThisTurn(response.text)) {
				fullRuntime.logger?.debug?.(
					{ actionName, text: response.text.slice(0, 120) },
					"[message] suppressed near-duplicate delivery within the turn",
				);
				recordDeliveredVisibleText?.(response.text);
				return [];
			}
			deliveredTokenSetsThisTurn.push(
				new Set(
					response.text
						.toLowerCase()
						.replace(/[*_`~#>]+/g, " ")
						.split(/[^a-z0-9%.]+/)
						.filter((token) => token.length > 0),
				),
			);
		}
		const delivered = await callback(response, actionName);
		if (rawUnsanitizedText) {
			recordDeliveredVisibleText?.(rawUnsanitizedText);
		}
		if (typeof response?.text === "string" && response.text.trim()) {
			recordDeliveredVisibleText?.(response.text);
		}
		// The voice rewrite (voiceActionReply below) restyles the wire text and
		// stashes the action's original text in data.rawActionText. The planner's
		// finalMessage is composed from that RAW text (a verified tool's
		// userFacingText), so record it too — same rationale as the sanitize-drift
		// recording above: echo suppression must recognize a delivery whose wire
		// form diverged from the text the planner re-selects.
		if (response?.data && typeof response.data === "object") {
			const rawActionText = (response.data as Record<string, unknown>)
				.rawActionText;
			if (typeof rawActionText === "string" && rawActionText.trim()) {
				recordDeliveredVisibleText?.(rawActionText);
			}
		}
		return delivered;
	};
	// The character-voice rewrite spends a TEXT_SMALL call per action callback and
	// restyles the delivered text. Deterministic harnesses (the scenario runner)
	// assert the raw action-callback contract and strict-fixture every model call,
	// so they opt out via ACTION_CALLBACK_VOICE_REWRITE=false; production turns
	// leave it on by default.
	if (!actionCallbackVoiceRewriteEnabled(fullRuntime)) return deliver;
	const voiceActionReply = async (
		response: Content,
		actionName?: string,
	): Promise<Content> => {
		if (response.transcriptVisibility === "internal") {
			return response;
		}
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

	return async (response, actionName) =>
		deliver(await voiceActionReply(response, actionName), actionName);
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

function actionCallbackVoiceRewriteEnabled(runtime: IAgentRuntime): boolean {
	if (typeof runtime.getSetting !== "function") return true;
	const raw = runtime.getSetting("ACTION_CALLBACK_VOICE_REWRITE");
	if (raw === undefined || raw === null) return true;
	const normalized = String(raw).trim();
	if (!normalized) return true;
	return parseBooleanFromText(normalized);
}

function shouldRewriteActionCallback(
	response: Content | null | undefined,
	actionName?: string,
): response is Content & { text: string } {
	if (!response || typeof response.text !== "string") return false;
	// The settlement boundary marks only a byte-exact canonical action reply.
	// Re-voicing it would violate verifiedUserFacing's do-not-paraphrase contract.
	if (response.agentVoiced === true) return false;
	if (getEffectDeliveryBinding(response)) {
		return false;
	}
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
	// Failure contract: a failed rewrite must never fabricate wire text — no
	// meta-narration about formatting ever ships (observed live: a settings
	// action succeeded and the user received an internal formatting apology).
	// Returning null keeps the raw callback text as the delivery: it was
	// already user-destined before the re-voicing attempt. An action-owned
	// error string is diagnostics for runtime.reportError, not chat content.
	const fail = (reason: string): null => {
		const actionError =
			typeof args.response.error === "string" ? args.response.error.trim() : "";
		if (actionError) {
			args.runtime.reportError(
				"MessageService.rewriteActionCallback",
				new Error(actionError),
				{ actionName: args.actionName, roomId: args.message.roomId, reason },
			);
		}
		return null;
	};
	if (typeof args.runtime.useModel !== "function") {
		return fail("model_unavailable");
	}
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
		if (!response || response === args.text) {
			return fail("unusable_model_response");
		}
		if (parseJSONObjectFromText(response)) return fail("json_shaped_response");
		return (
			response.replace(/^["'`]+|["'`]+$/g, "").trim() ||
			fail("unusable_model_response")
		);
	} catch (error) {
		// error-policy:J4 Voice rewriting is an optional presentation layer; the
		// raw action callback text remains the delivered degraded response.
		args.runtime.logger.debug(
			{
				src: "service:message",
				actionName: args.actionName,
				error: error instanceof Error ? error.message : String(error),
			},
			"Failed to rewrite action callback in character voice",
		);
		args.runtime.reportError("MessageService.rewriteActionCallback", error, {
			actionName: args.actionName,
			roomId: args.message.roomId,
		});
		return fail("rewrite_error");
	}
}

export function withActionResultsForPrompt(
	state: State,
	actionResults: ActionResult[],
	runtime?: IAgentRuntime,
): State {
	const promptActionResults = isProgressiveContentProjectionEnabled(runtime)
		? renderActionResultsForModel(actionResults, {
				omitRecoverableText: true,
			}).text
		: formatActionResultsForPrompt(actionResults);
	return {
		...state,
		values: {
			...state.values,
			actionResults: promptActionResults,
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
	return withContextRoutingValues(state, contextRoutingStateValues);
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
	 * Rooms (keyed `${agentId}:${roomId}`) holding a reply that has been handed
	 * to the delivery callback but whose response-memory row is not yet stored
	 * (the simple-path deliver-then-persist window). A follow-up turn triggered
	 * by that delivery must not compose its prompt until the reply row exists,
	 * or RECENT_MESSAGES silently omits the reply the user is answering —
	 * `processMessage` awaits these barriers before any composition. Barriers
	 * always settle (resolve, never reject) whether the persist succeeds or
	 * fails; a persist failure propagates in the owning turn, never to the
	 * waiting turn. Same-room turns otherwise still run concurrently — turn
	 * preemption (`turnControllers.abortTurn` fired from a later message's
	 * Stage-1 field evaluators) depends on that, so this is deliberately a
	 * narrow persistence barrier, not per-room handler serialization.
	 */
	private readonly pendingReplyPersists = new Map<string, Set<Promise<void>>>();

	private pendingReplyPersistKey(runtime: IAgentRuntime, roomId: UUID): string {
		return `${runtime.agentId}:${roomId}`;
	}

	/**
	 * Register a delivered-reply persistence barrier. Must be called BEFORE the
	 * delivery callback fires: the instant the reply reaches the client a
	 * follow-up can arrive, and its compose must find this barrier already
	 * pending. Returns the release fn; call it once the persist settles
	 * (success or failure). Constraint for callback authors: a delivery
	 * callback must never await a same-room `handleMessage` to completion —
	 * that turn waits on a barrier this turn only releases after the callback
	 * returns. Fire-and-forget from a callback is fine.
	 */
	private registerPendingReplyPersist(
		runtime: IAgentRuntime,
		roomId: UUID,
	): () => void {
		const key = this.pendingReplyPersistKey(runtime, roomId);
		let release: (() => void) | undefined;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		let barriers = this.pendingReplyPersists.get(key);
		if (!barriers) {
			barriers = new Set();
			this.pendingReplyPersists.set(key, barriers);
		}
		barriers.add(barrier);
		return () => {
			release?.();
			const set = this.pendingReplyPersists.get(key);
			if (set) {
				set.delete(barrier);
				if (set.size === 0) {
					this.pendingReplyPersists.delete(key);
				}
			}
		};
	}

	/**
	 * Wait until every reply already handed to a delivery callback for this
	 * room has finished persisting. Snapshot semantics: only barriers pending
	 * at call time are awaited — exactly the causal set for a follow-up
	 * reacting to a delivered reply. Rooms with no pending barrier (the
	 * overwhelmingly common case) return without awaiting anything.
	 */
	private async awaitDeliveredReplyPersistence(
		runtime: IAgentRuntime,
		roomId: UUID,
	): Promise<void> {
		const barriers = this.pendingReplyPersists.get(
			this.pendingReplyPersistKey(runtime, roomId),
		);
		if (!barriers || barriers.size === 0) return;
		await timeInferenceSpan("message:compose:reply-persist-barrier", () =>
			Promise.all([...barriers]),
		);
	}

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

		// Central delivery-audience attestation: every connector funnels inbound
		// turns through this seam, so attesting from canonical room state here
		// gives Telegram/iMessage/WhatsApp-style ingress the same evidence the
		// Discord connector mints itself. An attestation remains authoritative
		// only inside the runtime that minted it; a Memory crossing runtime
		// boundaries is re-attested from the active runtime's canonical state.
		if (!trustedDeliveryAudienceIsBoundToRuntime(message, runtime)) {
			try {
				await attestDeliveryAudienceFromCanonicalRoom(runtime, message);
			} catch (error) {
				// error-policy:J4 attestation failure leaves the turn unattested, so
				// every owner-private surface fails closed while ordinary chat
				// continues; the lookup failure surfaces via RECENT_ERRORS.
				runtime.reportError("MessageService.deliveryAudience", error, {
					roomId: message.roomId,
					messageId: message.id,
				});
			}
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

		let alwaysDuringTask: Promise<void> | undefined;
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
			} catch (error) {
				// error-policy:J7 Event delivery is diagnostic; action preprocessing
				// below remains a required data path and is deliberately outside this catch.
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
				runtime.reportError("MessageService.messageReceivedEvent", error, {
					entityId: message.entityId,
					roomId: message.roomId,
				});
			}
			// ALWAYS_BEFORE (blocking): hooks run for every message before
			// any pipeline work. Use for cheap heuristic preprocessing
			// (identity extraction, dispute detection) whose results may
			// influence Stage 1 routing.
			await runtime.runActionsByMode("ALWAYS_BEFORE", message);
			// ALWAYS_DURING begins alongside the response pipeline, but actions may
			// mutate room state. The room owner therefore remains live until this
			// tracked work settles even if the visible response finishes first.
			alwaysDuringTask = detachPostDeliverySideEffect(
				runtime,
				"ALWAYS_DURING",
				() => runtime.runActionsByMode("ALWAYS_DURING", message),
				"room-state",
				message.roomId,
				options?.roomHandlerLease,
			);

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

		const trajectoryContextBase = {
			// Minted above (before MESSAGE_RECEIVED) so file, DB, and spawn paths
			// share it for the whole turn (#13775).
			traceId,
			runId: runtime.getCurrentRunId?.(),
			roomId: message.roomId,
			messageId: message.id,
			turnMemo: new Map<string, Promise<unknown>>(),
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
				const senderRole = await timeInferenceSpan(
					"message:ingress:sender-role",
					() => resolveStage1SenderRole(runtime, message),
				);
				const trajectoryContext = getTrajectoryContext();
				if (trajectoryContext) trajectoryContext.userRole = senderRole;

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
				let firstSentenceChecked = false;
				let firstSentenceText = "";
				const firstSentenceTracker = createFirstSentenceStreamTracker();
				let streamTextFallback = "";
				let runTerminalOwner: MessageRunTerminalOwner | undefined;
				const acceptFirstSentence = (first: string): void => {
					firstSentenceChecked = true;
					if (first.length <= 5) return;
					firstSentenceSent = true;
					firstSentenceText = first;
					// Audio does not stall the text stream, but its model capture
					// remains owned by the run-terminal barrier.
					const deliverVoice = () =>
						deliverFirstSentenceVoice(
							runtime,
							first,
							callback,
							options?.abortSignal,
						);
					if (!runTerminalOwner) {
						throw new ElizaError(
							"Voice streaming requires a live run terminal owner",
							{
								code: "RUN_TERMINAL_OWNER_REQUIRED",
								context: {
									messageId: message.id,
									roomId: message.roomId,
								},
							},
						);
					}
					runTerminalOwner.track("first-sentence-voice", deliverVoice);
				};
				// Envelope-echo latch for this turn's stream: once the accumulated
				// text reads as envelope material, every downstream chunk consumer
				// (model_stream_chunk hook re-emission, first-sentence TTS, the
				// host's stream callback) is cut off. Chunks forwarded before the
				// needle completed are already delivered — that residue is the
				// documented open edge in security/outbound-envelope-guard.ts.
				const streamCarriesEnvelope = createOutboundEnvelopeStreamLatch(
					runtime,
					"stream-chunk",
				);
				const userOnStreamChunk = options?.onStreamChunk;
				const wrappedOnStreamChunk: StreamChunkCallback | undefined =
					userOnStreamChunk
						? async (chunk, messageId, accumulated, streamRevision) => {
								// Sensitive turns deliver once through the final callback,
								// where the audience is re-read. Streaming bytes cannot be
								// recalled if room membership changes mid-generation.
								if (ownerExclusiveDisclosureWasUsed(message)) {
									return;
								}
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

								if (streamCarriesEnvelope(streamText)) {
									return;
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

								// First-sentence cloud-TTS path (deliverFirstSentenceVoice —
								// the local-inference voice loop is a separate layer, see its
								// JSDoc). Only run detection when `accumulated` is present:
								// raw-token streams (no accumulated) may contain partial
								// structured output that would garble sentence detection and
								// TTS.
								if (
									!firstSentenceChecked &&
									accumulated !== undefined &&
									firstSentenceTracker.push(
										chunk,
										accumulated,
										streamRevision,
									) !== undefined
								) {
									const { first } = extractFirstSentence(streamText);
									acceptFirstSentence(first);
								}

								await userOnStreamChunk(
									chunk,
									messageId,
									accumulated,
									streamRevision,
								);
							}
						: undefined;

				const opts: ResolvedMessageOptions = {
					maxRetries: options?.maxRetries ?? 3,
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
					...(options?.roomHandlerLease
						? { roomHandlerLease: options.roomHandlerLease }
						: {}),
					...(options?.onSettledActionResult
						? {
								onSettledActionResult: options.onSettledActionResult,
							}
						: {}),
					...(options?.onTrajectoryTerminalOwner
						? {
								onTrajectoryTerminalOwner: options.onTrajectoryTerminalOwner,
							}
						: {}),
					...(options?.onInferenceTimingSummary
						? {
								onInferenceTimingSummary: options.onInferenceTimingSummary,
							}
						: {}),
				};

				const deliveredVisibleTexts = new Set<string>();
				const recordDeliveredVisibleText = (text: string) => {
					deliveredVisibleTexts.add(
						normalizeVisibleTextForDuplicateCheck(text),
					);
				};
				const instrumentedCallback = wrapSingleTurnVisibleCallback(
					runtime,
					message,
					callback,
					recordDeliveredVisibleText,
				);

				// A host route may open the timer before calling the message service so
				// augmentation and response normalization share this same timeline.
				// Only the layer that creates the timer closes and persists it.
				const inheritedInferenceTimer = getInferenceTimer();
				const ownsInferenceTimer = inheritedInferenceTimer === undefined;
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
						agentResponses = new Map<string, string[]>();
						latestResponseIds.set(runtime.agentId, agentResponses);
					}

					const roomResponses = agentResponses.get(message.roomId) ?? [];
					const previousResponseId = roomResponses[roomResponses.length - 1];
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
					roomResponses.push(responseId);
					agentResponses.set(message.roomId, roomResponses);

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
					inferenceTimer =
						inheritedInferenceTimer ??
						new InferenceTurnTimer({
							turnId: nextInferenceTurnId(),
							label: "message-turn",
							roomId: message.roomId,
							t0EpochMs: startTime,
						});

					runTerminalOwner = new MessageRunTerminalOwner(
						runtime,
						runId,
						message,
						startTime,
						opts.roomHandlerLease,
					);
					opts.runTerminalOwner = runTerminalOwner;
					if (alwaysDuringTask) {
						runTerminalOwner.adopt("ALWAYS_DURING", alwaysDuringTask);
					}
					opts.onTrajectoryTerminalOwner?.("run");

					// The terminal owner exists before listener dispatch because event
					// listeners may partially observe RUN_STARTED before another rejects.
					await runWithInferenceTiming(inferenceTimer, () =>
						timeInferenceSpan("message:lifecycle:run-started", () =>
							runtime.emitEvent(EventType.RUN_STARTED, {
								runtime,
								source: "messageHandler",
								runId,
								messageId: message.id,
								roomId: message.roomId,
								entityId: message.entityId,
								startTime,
								status: "started",
							} as RunEventPayload),
						),
					);
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
									reportError: runtime.reportError.bind(runtime),
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
										// Cancellation-only contexts deliberately omit a chunk
										// consumer. `useModel` treats a present consumer as the
										// request to use its streaming transport and parser.
										messageId: responseId,
										abortSignal: opts.abortSignal,
										reportError: runtime.reportError.bind(runtime),
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
												messageId: responseId,
												abortSignal,
												reportError: runtime.reportError.bind(runtime),
											}
										: undefined;
							return runWithInferenceTiming(inferenceTimer, () =>
								runWithStreamingContext(scopedStreamingContext, () =>
									this.processMessage(
										runtime,
										message,
										instrumentedCallback,
										deliveredVisibleTexts,
										responseId,
										runId,
										opts,
									),
								),
							);
						},
					);

					const result = await processingPromise;
					if (
						!firstSentenceChecked &&
						firstSentenceTracker.finish() !== undefined &&
						result.responseContent?.text
					) {
						acceptFirstSentence(
							extractFirstSentence(result.responseContent.text).first,
						);
					}

					// Voice: Handle the rest of the message
					if (firstSentenceSent && result.responseContent?.text) {
						const fullText = result.responseContent.text;
						const rest = fullText.replace(firstSentenceText, "").trim();
						if (rest.length > 0) {
							// Synthesis remains detached from visible delivery, but its model
							// capture belongs to this run and must settle before RUN_ENDED.
							runTerminalOwner.track("remaining-voice", async () => {
								try {
									let audioBuffer: Buffer | null = null;
									const params = buildTextToSpeechParams(
										runtime,
										rest,
										opts.abortSignal,
									);
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
									// error-policy:J4 The text response is complete even
									// when its optional trailing voice attachment fails.
									runtime.logger.error(
										{ error },
										"Error generating voice for remaining text",
									);
									runtime.reportError("MessageService.remainingVoice", error, {
										roomId: message.roomId,
									});
								}
							});
						}
					}

					runTerminalOwner.request("completed");
					return {
						...result,
						trajectoryTerminalOwner: "run",
					};
				} catch (error) {
					runTerminalOwner?.request("error", error);
					throw error;
				} finally {
					// Close + emit the per-turn latency breakdown. Detached side
					// effects (post-turn evaluators) intentionally run after this and
					// are NOT counted in turn latency — that is the proof they don't
					// stall the user-visible reply.
					const inferenceSummary = ownsInferenceTimer
						? emitInferenceTiming(inferenceTimer)
						: null;
					if (inferenceSummary) {
						try {
							opts.onInferenceTimingSummary?.(inferenceSummary);
						} catch (error) {
							// error-policy:J7 host timing export must not replace the
							// user-visible result whose summary it observes.
							runtime.logger.warn(
								{ error, turnId: inferenceSummary.turnId },
								"Inference timing summary callback failed",
							);
							runtime.reportError(
								"MessageService.inferenceTimingSummary",
								error,
								{ turnId: inferenceSummary.turnId },
							);
						}
						detachPostDeliverySideEffect(
							runtime,
							"persist_inference_timing",
							() =>
								persistInferenceTimingSummary(
									runtime,
									message,
									inferenceSummary,
								),
							"diagnostic",
						);
					}

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
		deliveredVisibleTexts: Set<string>,
		responseId: UUID,
		runId: UUID,
		opts: ResolvedMessageOptions,
	): Promise<MessageProcessingResult> {
		const runTerminalOwner = opts.runTerminalOwner;
		if (!runTerminalOwner) {
			throw new ElizaError(
				"Message processing requires a live run terminal owner",
				{
					code: "RUN_TERMINAL_OWNER_REQUIRED",
					context: { runId, messageId: message.id, roomId: message.roomId },
				},
			);
		}
		// A reply already handed to a delivery callback for this room may still
		// be persisting (deliver-then-persist fast path). Composing now would
		// read RECENT_MESSAGES without the reply this message may be answering,
		// so wait for those persists to settle first. Same room only, a few
		// hundred ms worst case, and a no-op when nothing is pending.
		await this.awaitDeliveredReplyPersistence(runtime, message.roomId);

		if (!latestResponseIds.has(runtime.agentId)) {
			throw new Error("Agent responses map not found");
		}

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
			runTerminalOwner.request("self");
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
		await timeInferenceSpan("message:ingress:persistence", async () => {
			let memoryToQueue: Memory;

			// The document augmentation envelope
			// (`<contextual_documents>...</contextual_documents>` + `<user_request>`)
			// is a model-facing wrapper added just for this turn's LLM prompt. Persist
			// and embed the clean user text so the stored memory does not echo raw
			// wrapper XML back into the user's chat bubble or re-enter context as
			// history on later turns. `message` (used downstream this turn) keeps its
			// wrap.
			const persistableMessage = stripAugmentationForPersistence(message);

			if (message.id) {
				const createdMemoryId = await runtime.createMemory(
					persistableMessage,
					"messages",
				);
				memoryToQueue = { ...persistableMessage, id: createdMemoryId };
				await runtime.queueEmbeddingGeneration(memoryToQueue, "high");
			} else {
				const memoryId = await runtime.createMemory(
					persistableMessage,
					"messages",
				);
				message.id = memoryId;
				memoryToQueue = { ...persistableMessage, id: memoryId };
				await runtime.queueEmbeddingGeneration(memoryToQueue, "normal");
			}
		});

		// Participant state and room are independent reads. Resolving them together
		// also lets mute evaluation reuse this room instead of fetching it once to
		// discover the world and again before should-respond routing.
		const [agentUserState, room] = await Promise.all([
			timeInferenceSpan("message:ingress:participant-state", () =>
				runtime.getParticipantUserState(message.roomId, runtime.agentId),
			),
			timeInferenceSpan("message:ingress:room", () =>
				runtime.getRoom(message.roomId),
			),
		]);

		// Check if LLM is off by default
		const defLllmOff = parseBooleanFromText(
			String(runtime.getSetting("BASIC_CAPABILITIES_DEFLLMOFF") || ""),
		);

		if (defLllmOff && agentUserState === null) {
			runtime.logger.debug({ src: "service:message" }, "LLM is off by default");
			runTerminalOwner.request("off");
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
		const muteState = await timeInferenceSpan(
			"message:ingress:mute-state",
			() =>
				resolveEffectiveMuteState(runtime, {
					roomIds: [message.roomId],
					primaryRoom: room,
					primaryParticipantState: agentUserState,
					...(message.worldId || room?.worldId
						? { worldId: message.worldId ?? room?.worldId }
						: {}),
				}),
		);
		if (muteState.muted) {
			runtime.logger.debug(
				{
					src: "service:message",
					roomId: message.roomId,
					scope: muteState.scope,
				},
				"Ignoring muted room",
			);
			runTerminalOwner.request("muted");
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
				runTerminalOwner.request("personality_gate");
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
			runTerminalOwner.request("bot_noise_triage");
			return {
				didRespond: false,
				responseContent: null,
				responseMessages: [],
				state: { values: {}, data: {}, text: "" } as State,
				mode: "none",
			};
		}

		// Prefetch the shared per-turn recall-query embed now that every cheap
		// short-circuit gate (self, LLM-off, mute, personality reply-gate,
		// bot-noise triage) has passed — so a dropped turn never issues a wasted
		// embed and the "muted room = zero model calls" invariant holds. Placed
		// before the remaining serial pre-compose work (room fetch, attachment
		// processing, incoming hooks, composeState) so this embed round-trip
		// overlaps it instead of gating the Stage-1 model call: the
		// relevant-conversations provider, document recall, experience recall,
		// and the FACTS path all route the same text through `embedRecallQuery`
		// (keyed by this run), so they await this in-flight result rather than
		// starting a fresh round-trip. Delivery does not await it, but RUN_ENDED
		// does; the value is re-read from the per-run cache by normalized-text key.
		// Present the turn's `messageId` so this prefetch ADOPTS the pre-run cache
		// the API chat path's document augmentation already warmed under the same
		// id (#15253): on a no-match turn the query text is byte-identical, so the
		// adopted vector resolves here with ZERO new embed instead of a second
		// identical round-trip.
		// error-policy:J7 diagnostics-must-not-kill-the-loop — a warm failure only
		// forfeits the overlap; the compose-time caller re-embeds and fails open.
		const recallWarmText = message.content?.text;
		if (
			typeof recallWarmText === "string" &&
			recallWarmText.trim() !== "" &&
			!isCanonicalModelCapabilityDisabled(runtime, ModelType.TEXT_EMBEDDING)
		) {
			const recallWarmMessageId =
				typeof message.id === "string" ? message.id : undefined;
			const recallWarmTask = embedRecallQuery(runtime, recallWarmText, {
				messageId: recallWarmMessageId,
				...(opts.abortSignal ? { signal: opts.abortSignal } : {}),
			}).catch((error) => {
				if (opts.abortSignal?.aborted) {
					// error-policy:J5 the request boundary observes cancellation;
					// suppress only this detached speculative warm's rejection.
					return;
				}
				runtime.reportError("MessageService.recallEmbedPrefetch", error, {
					roomId: message.roomId,
					runId,
				});
			});
			runTerminalOwner.adopt("recall-embed-prefetch", recallWarmTask);
		}

		// Process attachments before state composition / incoming hooks
		if (message.content.attachments && message.content.attachments.length > 0) {
			const attachments = message.content.attachments;
			message.content.attachments = await timeInferenceSpan(
				"message:ingress:attachments",
				() => this.processAttachments(runtime, attachments),
			);
			if (message.id) {
				// API chat can pass a prompt-only clone whose text includes language
				// or document guidance while the canonical user memory already exists.
				// Attachment enrichment must update only the durable attachment view,
				// not overwrite the stored user's words with those internal prompt
				// instructions. Preserve the canonical persisted text when available.
				const canonicalMessage = await runtime.getMemoryById(message.id);
				const canonicalText = canonicalMessage?.content?.text;
				await runtime.updateMemory({
					id: message.id,
					content: {
						...message.content,
						...(typeof canonicalText === "string"
							? { text: canonicalText }
							: {}),
						attachments: sanitizeAttachmentsForStorage(
							message.content.attachments,
						),
					},
				});
			}
		}

		const preIncomingHookText =
			typeof message.content?.text === "string" ? message.content.text : "";

		await timeInferenceSpan("message:ingress:hooks", () =>
			runtime.applyPipelineHooks(
				"incoming_before_compose",
				incomingPipelineHookContext(message, {
					roomId: message.roomId,
					responseId,
					runId,
				}),
			),
		);

		const postIncomingHookText =
			typeof message.content?.text === "string" ? message.content.text : "";

		if (postIncomingHookText !== preIncomingHookText) {
			// An incoming hook rewrote the turn's text — the core security hook
			// replaces `content.text` with the external-content envelope for every
			// untrusted-source message (incoming-message-security.ts), and the
			// storage scrub can rewrite trusted text too. Compose-time recall
			// callers (relevant-conversations, document recall, experience recall)
			// present the REWRITTEN text, whose normalized cache key misses the
			// raw-text vector the prefetch above is already fetching — a guaranteed
			// second, serial TEXT_EMBEDDING round-trip on every rewritten turn.
			// Declare the rewritten text equivalent to the raw prompt for this
			// turn's recall so those callers join the prefetch round-trip instead;
			// the raw user text is also the semantically correct recall query (the
			// user's words, not the security armor around them).
			if (
				preIncomingHookText.trim() !== "" &&
				postIncomingHookText.trim() !== ""
			) {
				aliasRecallQuery(runtime, {
					...(typeof message.id === "string" ? { messageId: message.id } : {}),
					sourceText: preIncomingHookText,
					aliasText: postIncomingHookText,
				});
			}
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

		await timeInferenceSpan("message:ingress:pre-respond-hooks", () =>
			runtime.applyPipelineHooks(
				"pre_should_respond",
				preShouldRespondPipelineHookContext(message, {
					roomId: message.roomId,
					responseId,
					runId,
					state,
					isAutonomous,
				}),
			),
		);

		let shouldRespondToMessage = true;
		let terminalDecision: "IGNORE" | "STOP" | null = null;
		let routedDecision: ContextRoutingDecision | null = null;
		let strategyResult: StrategyResult | null = null;
		let _usedV5Runtime = false;
		let stage1DecidedRespond = false;
		let stage1RiskGateApplied = false;
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
			? async (event: ResponseHandlerEarlyReplyEvent): Promise<boolean> => {
					// Structural early-ack gate: a pre-planner ack is only warranted
					// when the routed work is an async handoff — a candidate action
					// whose execution continues after the turn returns (sub-agent
					// spawn class), where the real result arrives long after the turn.
					// Synchronous turns (retrieval, in-turn tool work) deliver one
					// reply — the final answer — so voice matches text channels
					// bubble-for-bubble. Returning false tells the Stage-1 producer
					// nothing was delivered.
					if (
						!candidateActionsIncludeAsyncHandoff(
							runtime.actions,
							event.messageHandler.plan.candidateActions ?? [],
						)
					) {
						return false;
					}
					const proposedText = event.text.trim();
					const earlyReplyEgressDecision = evaluatePlannedReplyEgress({
						reply: proposedText,
						actionResults: [],
						actions: runtime.actions,
					});
					if (earlyReplyEgressDecision.verdict !== "allow") {
						// An ungrounded completion claim cannot ship, and this delivery
						// floor must not manufacture a substitute ack — drop the early
						// reply; the planner's final delivery owns the turn.
						return false;
					}
					const text = proposedText;
					if (!text || !message.id) return false;
					const currentResponseId = getLatestResponseId(
						runtime.agentId,
						message.roomId,
					);
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
						return false;
					}
					if (getStreamingContext()?.abortSignal?.aborted) {
						return false;
					}
					const earlyResponseId = asUUID(v4());
					let earlyContent: Content = {
						thought: event.messageHandler.thought,
						actions: ["REPLY"],
						text,
						responseId: earlyResponseId,
						inReplyTo: createUniqueUuid(runtime, message.id),
						// #14873: the early reply IS the Stage-1 model's replyText —
						// genuine agent voice (egress-rejected text never reaches this
						// point) — so gated transports must not re-voice it.
						agentVoiced: true,
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
					earlyContent = enforceEffectGroundedVisibleContent(
						runtime,
						earlyContent,
					);
					earlyContent = await enforceTrustedDeliveryAudienceAtEgress(
						runtime,
						message,
						earlyContent,
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
					return true;
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

		// #8791: the explicit-protocol shortcut gate runs first so slash/`!`
		// commands cannot be pre-empted by another handler. Ordinary language is
		// never eligible here and always reaches the planner.
		if (!strategyResult) {
			// Reuse the role resolved once per turn in handleMessage (stamped on the
			// trajectory context) — resolving again here costs a room+world lookup.
			const shortcutSenderRole =
				getTrajectoryContext()?.userRole ??
				(await resolveStage1SenderRole(runtime, message));
			const shortcutOutcome = await runShortcutGate({
				runtime,
				message,
				state,
				responseId,
				senderRole: shortcutSenderRole,
				...(opts.onSettledActionResult
					? { onSettledActionResult: opts.onSettledActionResult }
					: {}),
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
					timeInferenceSpan("message:planner", () =>
						runV5MessageRuntimeStage1({
							runtime,
							message,
							state,
							responseId,
							...(callback ? { callback } : {}),
							deliveredVisibleTexts,
							...(opts.roomHandlerLease
								? { roomHandlerLease: opts.roomHandlerLease }
								: {}),
							runTerminalOwner,
							...(opts.onSettledActionResult
								? {
										onSettledActionResult: opts.onSettledActionResult,
									}
								: {}),
							onResponseHandlerEarlyReply: deliverResponseHandlerEarlyReply,
							onStage1RespondDecision: () => {
								stage1DecidedRespond = true;
							},
						}),
					),
					timeInferenceSpan("message:ingress:parallel-respond-hooks", () =>
						runtime.applyPipelineHooks(
							"parallel_with_should_respond",
							parallelHookCtx,
						),
					),
				]);
				stage1RiskGateApplied = outcome.kind !== "terminal";
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
				// error-policy:J1 This is the user-message boundary: translate
				// planner/model failures into the designed structured failure state.
				const callerSignal = getStreamingContext()?.abortSignal;
				if (callerSignal?.aborted) {
					const reason = callerSignal.reason;
					throw reason instanceof TurnAbortedError
						? reason
						: new TurnAbortedError(
								reason instanceof Error ? reason.message : String(reason),
							);
				}
				if (
					error instanceof TurnAbortedError ||
					(isRecord(error) && error.code === "TURN_ABORTED")
				) {
					throw error;
				}
				const errMsg = error instanceof Error ? error.message : String(error);
				const errStack = error instanceof Error ? error.stack : undefined;
				// Provider failures often surface with a masked statusText message
				// ("Bad Request") while the actionable cause lives on the AI SDK
				// error's responseBody — carry it so the failure is diagnosable
				// from logs and RECENT_ERRORS without a wire capture.
				const providerErrorDetail = modelProviderErrorDetail(error);
				runtime.logger.warn(
					{
						src: "service:message",
						agentId: runtime.agentId,
						error: errMsg,
						stack: errStack,
						...(providerErrorDetail ? { providerErrorDetail } : {}),
					},
					"v5 message runtime failed",
				);
				runtime.reportError("MessageService.v5Runtime", error, {
					entityId: message.entityId,
					roomId: message.roomId,
					...(providerErrorDetail
						? { providerError: providerErrorDetail as JsonValue }
						: {}),
				});
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
					// error-policy:J5 The same failure is already observed by the
					// runtime logger and reportError immediately above.
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
				const failureGate = this.isDeterministicallyAddressedTurn({
					runtime,
					message,
					room,
					mentionContext,
					isAutonomous,
					hasDeliveredEarlyReply: earlyReplyMessages.length > 0,
				});
				// Stage 1 already made the per-message RESPOND decision for this
				// turn before the runtime died — that is the model evaluation the
				// deterministic gate defers to, so the anti-spam suppression
				// (which exists for pre-decision throws) does not apply.
				if (failureGate.addressed || stage1DecidedRespond) {
					shouldRespondToMessage = true;
					terminalDecision = null;
					// Distinguish WHY the runtime died so the failure reply names
					// the real condition: a capability that was never invocable is
					// not a transient blip and must not read like one (#17027 AC6).
					const failureCause = classifyStructuredFailureCause(error);
					runtime.logger.info(
						{
							src: "service:message",
							agentId: runtime.agentId,
							roomId: message.roomId,
							failureCause,
						},
						"MessageService: structured failure reply cause classified",
					);
					strategyResult = await this.buildStructuredFailureReply(
						runtime,
						message,
						state,
						responseId,
						"running the native tool message runtime",
						failureCause,
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
		if (shouldRespondToMessage && !stage1RiskGateApplied) {
			const injectionGate = await timeInferenceSpan(
				"evaluators:injection-risk-gate",
				() =>
					runShouldRespondInjectionGate({
						runtime,
						message,
						// Per-turn role already resolved in handleMessage; fall back to a
						// fresh lookup only outside a trajectory scope.
						resolveSenderRole: () =>
							getTrajectoryContext()?.userRole ??
							resolveStage1SenderRole(runtime, message),
					}),
			);
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
		const persistedResponseMessageIds = new Set<UUID>(
			Array.from(persistedEarlyReplyIds, (id) => id as UUID),
		);
		let actionResults: ActionResult[] | undefined;
		let mode: StrategyMode = "none";

		if (shouldRespondToMessage) {
			let result: StrategyResult;
			if (strategyResult) {
				result = strategyResult;
			} else {
				_usedV5Runtime = true;
				// No thrown trajectory error reaches this fallback-only branch, so
				// there is no structural capability/exhaustion cause to preserve.
				// Keep the default generic transient classification.
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
			actionResults = result.actionResults;
			mode = result.mode;

			// Race check before we send anything.
			//
			// When a newer message arrives in the same room while we were
			// generating a response, the default behavior is to drop the older
			// response so the bot only replies to the freshest input.
			//
			// Keep only a deliverable response carrying the explicit REPLY/RESPOND
			// marker. Action results opt into the user channel through userFacingText,
			// and that path constructs the same explicit reply marker.
			const currentResponseId = getLatestResponseId(
				runtime.agentId,
				message.roomId,
			);
			if (currentResponseId !== responseId && !opts.keepExistingResponses) {
				const keepReason = resolveSupersededResponseKeepReason(responseContent);
				if (keepReason) {
					runtime.logger.info(
						{
							src: "service:message",
							agentId: runtime.agentId,
							roomId: message.roomId,
						},
						`Race detected but keeping response (${keepReason})`,
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
					// Mirror the ignore-path sibling below: a superseded turn ends
					// its run as "replaced" so the discard is an observable terminal
					// outcome instead of an unrecorded nothing.
					runTerminalOwner.request("replaced");
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
			if (responseContent) {
				responseContent = await enforceTrustedDeliveryAudienceAtEgress(
					runtime,
					message,
					responseContent,
				);
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
						responseContent = await enforceTrustedDeliveryAudienceAtEgress(
							runtime,
							message,
							responseContent,
						);
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
					await timeInferenceSpan("message:delivery:persistence", () =>
						runtime.createMemory(responseMemory, "messages"),
					);
					if (responseMemory.id) {
						persistedResponseMessageIds.add(responseMemory.id);
					}

					await timeInferenceSpan("message:delivery:event", () =>
						this.emitMessageSent(
							runtime,
							responseMemory,
							message.content.source ?? "messageHandler",
						),
					);
				}
			}

			if (responseContent) {
				let deliverableResponseContent = responseContent;
				if (mode === "simple") {
					// Keep content hooks before delivery so the wire response carries
					// their edits. The response-memory DB write starts alongside the
					// callback so its largest post-LLM cost (~250-440ms measured via
					// the message:delivery:persistence InferenceTiming span) does not
					// delay delivery. Both operations still settle before this turn
					// proceeds, so
					// everything downstream in THIS turn (MESSAGE_SENT, post-turn
					// evaluators, followUp) observes the stored reply — and a
					// CONCURRENT same-room turn started off this delivery waits on
					// the pendingReplyPersists barrier before composing, so its
					// RECENT_MESSAGES read observes it too. Do not put MESSAGE_SENT
					// handlers or post-turn evaluators before the callback; they are
					// side effects and must not stall user-visible streaming.
					await timeInferenceSpan("message:delivery:hooks", () =>
						runtime.applyPipelineHooks(
							"outgoing_before_deliver",
							outgoingPipelineHookContext(deliverableResponseContent, {
								source: "simple",
								roomId: message.roomId,
								message,
								responseId:
									deliverableResponseContent.responseId ??
									responseMessages[0]?.id,
							}),
						),
					);
					deliverableResponseContent = enforceEffectGroundedVisibleContent(
						runtime,
						deliverableResponseContent,
					);
					deliverableResponseContent =
						await enforceTrustedDeliveryAudienceAtEgress(
							runtime,
							message,
							deliverableResponseContent,
						);
					responseContent = deliverableResponseContent;
					// Registered BEFORE the callback fires so a follow-up prompted
					// by this delivery always finds the barrier pending; released
					// (never rejected) in the finally once the persist settles.
					const releaseReplyPersistBarrier = this.registerPendingReplyPersist(
						runtime,
						message.roomId,
					);
					try {
						// Settled-result handling instead of catch blocks: a delivery
						// failure must not skip the persist, and callers classify the
						// raw delivery error by identity (TURN_ABORTED / generation-
						// timeout checks at the conversation route), so both failures
						// are rethrown UNCHANGED after both operations settle.
						const deliveryTask = callback
							? timeInferenceSpan("message:delivery:callback", () =>
									callback(deliverableResponseContent),
								).then((value) => {
									markInference(INFERENCE_MARKS.replyDelivered);
									return value;
								})
							: Promise.resolve(undefined);
						// Memories owed a MESSAGE_SENT claim once — and only if — the
						// delivery boundary succeeds. Collected during the persist pass
						// (which runs concurrently with the callback), committed below
						// strictly after both operations settle.
						const deliveredClaimMemories: Memory[] = [];
						const persistTask = (async () => {
							for (const responseMemory of responseMessages) {
								if (
									responseMemory.id &&
									persistedEarlyReplyIds.has(responseMemory.id)
								) {
									continue;
								}
								responseMemory.content =
									await enforceTrustedDeliveryAudienceAtEgress(
										runtime,
										message,
										deliverableResponseContent,
									);
								if (shouldSkipResponseMemoryPersistence(responseMemory)) {
									runtime.logger.debug(
										{ src: "service:message", memoryId: responseMemory.id },
										"Skipping transient response memory persistence",
									);
								} else {
									runtime.logger.debug(
										{ src: "service:message", memoryId: responseMemory.id },
										"Saving response to memory",
									);
									await timeInferenceSpan("message:delivery:persistence", () =>
										runtime.createMemory(responseMemory, "messages"),
									);
									if (responseMemory.id) {
										persistedResponseMessageIds.add(responseMemory.id);
									}
								}
								deliveredClaimMemories.push(responseMemory);
							}
						})();
						const [deliveryOutcome, persistOutcome] = await Promise.allSettled([
							deliveryTask,
							persistTask,
						]);
						// MESSAGE_SENT signals delivery, not persistence — and delivery
						// is only a fact once the callback boundary has resolved.
						// Claiming from inside the persist pass raced the callback and
						// recorded a durable sent-claim for deliveries that then failed,
						// turning a dropped reply into recorded success. The claim
						// commits here, strictly after the boundary succeeded: a
						// rejected callback produces no claim, and the error rethrown
						// below reaches the caller with the turn still unclaimed, so a
						// later retry that delivers can claim exactly once. It still
						// fires for transient/doNotPersist replies (structured failure
						// replies skip the memory write above): their delivery is just
						// as real, and suppressing the event made those delivered turns
						// indistinguishable from drops in logs, activity streams, and
						// trajectory closure.
						if (deliveryOutcome.status === "fulfilled") {
							for (const responseMemory of deliveredClaimMemories) {
								runTerminalOwner.track("MESSAGE_SENT", () =>
									this.emitMessageSent(
										runtime,
										responseMemory,
										message.content.source ?? "messageHandler",
									),
								);
							}
						}
						if (persistOutcome.status === "rejected") {
							// The persist failure (data loss) outranks the delivery
							// failure for propagation; the held delivery failure is
							// reported so it is never silently superseded.
							if (deliveryOutcome.status === "rejected") {
								runtime.reportError(
									"MessageService.simpleDeliveryCallback",
									deliveryOutcome.reason,
									{
										agentId: runtime.agentId,
										roomId: message.roomId,
									},
								);
							}
							throw persistOutcome.reason;
						}
						if (deliveryOutcome.status === "rejected") {
							throw deliveryOutcome.reason;
						}
					} finally {
						releaseReplyPersistBarrier();
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
			const currentResponseId = getLatestResponseId(
				runtime.agentId,
				message.roomId,
			);

			if (currentResponseId !== responseId && !opts.keepExistingResponses) {
				runtime.logger.info(
					{
						src: "service:message",
						agentId: runtime.agentId,
						roomId: message.roomId,
					},
					"Ignore response discarded - newer message being processed",
				);
				runTerminalOwner.request("replaced");
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
				runTerminalOwner.request("noMessageId");
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
			let terminalContent: Content = {
				thought:
					terminalAction === "STOP"
						? "Agent decided to stop and end the run."
						: "Agent decided not to respond to this message.",
				actions: [terminalAction],
				inReplyTo: createUniqueUuid(runtime, message.id),
			};

			await timeInferenceSpan("message:delivery:hooks", () =>
				runtime.applyPipelineHooks(
					"outgoing_before_deliver",
					outgoingPipelineHookContext(terminalContent, {
						source: "excluded",
						roomId: message.roomId,
						message,
					}),
				),
			);
			terminalContent = await enforceTrustedDeliveryAudienceAtEgress(
				runtime,
				message,
				terminalContent,
			);

			const terminalMemory: Memory = {
				id: asUUID(v4()),
				entityId: runtime.agentId,
				agentId: runtime.agentId,
				content: terminalContent,
				roomId: message.roomId,
				createdAt: Date.now(),
			};
			await timeInferenceSpan("message:delivery:persistence", () =>
				runtime.createMemory(terminalMemory, "messages"),
			);
			await timeInferenceSpan("message:delivery:event", () =>
				this.emitMessageSent(
					runtime,
					terminalMemory,
					message.content.source ?? "messageHandler",
				),
			);
			runtime.logger.debug(
				{ src: "service:message", memoryId: terminalMemory.id },
				"Saved terminal response to memory",
			);

			if (
				callback &&
				!(terminalAction === "IGNORE" && isVoiceChannelMessage(message))
			) {
				await timeInferenceSpan("message:delivery:callback", () =>
					callback(terminalContent),
				);
			}
		}

		// Clean up the response ID
		clearLatestResponseId(runtime.agentId, message.roomId, responseId);
		({ responseContent, responseMessages } =
			await enforceTrustedDeliveryAudienceOnResult(
				runtime,
				message,
				responseContent,
				responseMessages,
			));

		// Post-turn evaluation runs first as one structured call over registered
		// evaluator items. ALWAYS_AFTER actions remain available for plugin hooks
		// that are not part of the unified evaluator service.
		const didRespondGate =
			shouldRespondToMessage && !isStopResponse(responseContent);
		const semanticSignal = hasPostTurnSemanticSignal(
			message,
			state,
			responseContent,
		);
		// Post-turn work is never part of connector completion. It owns one real
		// evaluator child step, and the run terminal follows in the same detached
		// barrier so the parent cannot close while that child's telemetry is still
		// being written. Child failure is reported at that barrier, which still
		// releases the trajectory exactly once after the child settles.
		runTerminalOwner.track("post_turn", async () => {
			await withEvaluatorStep(runtime, "post_turn", async () => {
				if (semanticSignal) {
					await runPostTurnEvaluators(runtime, message, state, {
						didRespond: didRespondGate,
						responses: responseMessages,
						semanticSignal,
					});
				}
				await runtime.runActionsByMode("ALWAYS_AFTER", message, state, {
					didRespond: didRespondGate,
					responses: responseMessages,
				});
			});
		});

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
			const roomDatas = await timeInferenceSpan(
				"message:lifecycle:log-context-room",
				() => runtime.getRoomsByIds([message.roomId]),
			);
			if (roomDatas?.length) {
				const roomData = roomDatas[0];
				if (roomData.name) {
					roomName = roomData.name;
				}
				if (roomData.worldId) {
					const worldId = roomData.worldId;
					const worldData = await timeInferenceSpan(
						"message:lifecycle:log-context-world",
						() => runtime.getWorld(worldId),
					);
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

		return {
			didRespond,
			responseContent,
			responseMessages,
			...(persistedResponseMessageIds.size > 0
				? {
						persistedResponseMessageIds: Array.from(
							persistedResponseMessageIds,
						),
					}
				: {}),
			...(actionResults ? { actionResults } : {}),
			state,
			mode,
		};
	}

	/**
	 * Deterministic "this turn addressed the agent" predicate shared by the
	 * Stage-1 failure catch (failure-reply gating) and the race-discard check.
	 * Both are silent-exit gates: when they misjudge an addressed turn the user
	 * sees terminal, unobservable silence — so they must agree on exactly which
	 * turns owe the user a delivery. Addressed means: a deterministic
	 * shouldRespond hit (DM/API/SELF channel, whitelisted source), a platform
	 * mention or reply, an autonomous turn, or a turn where an early ack
	 * already went out (the user watched the agent engage).
	 */
	private isDeterministicallyAddressedTurn(args: {
		runtime: IAgentRuntime;
		message: Memory;
		room: Room | null | undefined;
		mentionContext: MentionContext | undefined;
		isAutonomous: boolean;
		hasDeliveredEarlyReply: boolean;
	}): { addressed: boolean; reason: string | undefined } {
		const gate = this.shouldRespond(
			args.runtime,
			args.message,
			args.room ?? undefined,
			args.mentionContext,
		);
		return {
			addressed:
				gate.shouldRespond ||
				args.mentionContext?.isMention === true ||
				args.mentionContext?.isReply === true ||
				args.isAutonomous ||
				args.hasDeliveredEarlyReply,
			reason: gate.reason,
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

		// Sources that always trigger a response. A trigger-prompt message is
		// the agent's OWN scheduled intent firing (a reminder or prompt
		// automation it created earlier) — gating it behind "should I respond
		// to this ambient message?" is a category error and silently eats
		// reminders.
		const alwaysRespondSources = [
			MESSAGE_SOURCE_CLIENT_CHAT,
			MESSAGE_SOURCE_TRIGGER_PROMPT,
		];

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

		const processedAttachments: Media[] = [];
		const byteBudget: AttachmentByteBudget = {
			remaining: ATTACHMENT_TURN_MAX_BYTES,
		};
		// Enrichment is deliberately ordered. In particular, transcription models
		// are often backed by one local GPU/process; launching an attacker-sized
		// attachment array concurrently caused memory spikes and provider storms.
		for (const attachment of attachments) {
			const processed = await (async () => {
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
								byteBudget,
								attachment.size,
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
							byteBudget,
							attachment.size,
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
							Object.assign(
								processedAttachment,
								attachmentFailure(
									"extract",
									"unsupported_type",
									false,
									`Unsupported document type (${contentType}); stored but text not extracted`,
								),
							);
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
								byteBudget,
								attachment.size,
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
								Object.assign(
									processedAttachment,
									attachmentFailure(
										"transcribe",
										"empty_result",
										false,
										"Audio transcription returned no text (empty or no speech detected)",
									),
								);
							}
						} catch (err) {
							// error-policy:J4 The attachment remains available with an
							// explicit failure state. Fetch-layer failures (MediaFetchError:
							// size cap, remote or local HTTP/stream error) happen before any TRANSCRIPTION
							// provider runs, so they get a transient could-not-fetch marker —
							// the "transcription unavailable" marker is reserved for genuine
							// provider failures because the read action treats it as
							// STT-is-disabled evidence.
							Object.assign(
								processedAttachment,
								err instanceof Error && err.name === "MediaFetchError"
									? attachmentFailure(
											err.message.includes("turn byte budget")
												? "budget"
												: "fetch",
											err.message.includes("turn byte budget")
												? "byte_limit"
												: "unavailable",
											true,
											"Audio attachment could not be fetched for enrichment",
										)
									: attachmentFailure(
											"transcribe",
											"unavailable",
											true,
											"Audio transcription unavailable",
										),
							);
							runtime.logger.warn(
								{
									src: "service:message",
									errorName: err instanceof Error ? err.name : "UnknownError",
								},
								"Audio transcription failed, continuing without transcript",
							);
							runtime.reportError(
								"MessageService.audioTranscription",
								sanitizedAttachmentDiagnostic(
									"ATTACHMENT_AUDIO_TRANSCRIPTION_FAILED",
									"Audio attachment enrichment failed",
									attachment,
								),
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
								byteBudget,
								attachment.size,
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
								Object.assign(
									processedAttachment,
									attachmentFailure(
										"transcribe",
										"empty_result",
										false,
										"Video transcription returned no text (empty or no speech detected)",
									),
								);
							}
						} catch (err) {
							// error-policy:J4 The attachment remains available with an
							// explicit failure state. Fetch-layer failures (MediaFetchError:
							// size cap, remote or local HTTP/stream error) happen before any TRANSCRIPTION
							// provider runs, so they get a transient could-not-fetch marker —
							// the "transcription unavailable" marker is reserved for genuine
							// provider failures because the read action treats it as
							// STT-is-disabled evidence.
							Object.assign(
								processedAttachment,
								err instanceof Error && err.name === "MediaFetchError"
									? attachmentFailure(
											err.message.includes("turn byte budget")
												? "budget"
												: "fetch",
											err.message.includes("turn byte budget")
												? "byte_limit"
												: "unavailable",
											true,
											"Video attachment could not be fetched for enrichment",
										)
									: attachmentFailure(
											"transcribe",
											"unavailable",
											true,
											"Video transcription unavailable",
										),
							);
							runtime.logger.warn(
								{
									src: "service:message",
									errorName: err instanceof Error ? err.name : "UnknownError",
								},
								"Video transcription failed, continuing without transcript",
							);
							runtime.reportError(
								"MessageService.videoTranscription",
								sanitizedAttachmentDiagnostic(
									"ATTACHMENT_VIDEO_TRANSCRIPTION_FAILED",
									"Video attachment enrichment failed",
									attachment,
								),
							);
						}
					}

					return processedAttachment;
				} catch (err) {
					// error-policy:J4 Preserve the original attachment with an
					// explicit retry signal while reporting enrichment failure.
					// One bad attachment must never drop the others or the message text.
					// Degrade to the un-enriched attachment (marking remote ones
					// ephemeral so the UI can offer a retry) and keep processing.
					runtime.logger.warn(
						{
							src: "service:message",
							attachmentId: attachment.id,
							errorName: err instanceof Error ? err.name : "UnknownError",
						},
						"Attachment processing failed; keeping un-enriched attachment",
					);
					runtime.reportError(
						"MessageService.attachmentEnrichment",
						sanitizedAttachmentDiagnostic(
							"ATTACHMENT_ENRICHMENT_FAILED",
							"Attachment enrichment failed",
							attachment,
						),
					);
					return {
						...attachment,
						...attachmentFailure(
							"extract",
							"unavailable",
							true,
							"Attachment enrichment unavailable",
						),
						ephemeral: isRemote ? true : attachment.ephemeral,
					};
				}
			})();
			processedAttachments.push(processed);
		}

		return processedAttachments;
	}

	/**
	 * Fetch an attachment's bytes for enrichment with a hard size cap. Remote
	 * (attacker-influenceable) URLs go through the SSRF-guarded fetcher, which
	 * blocks private/loopback/link-local hosts; trusted local media-store URLs
	 * (built from a path-validated relative URL) use the runtime fetch. This is
	 * the ONLY place a raw fetch is used during attachment enrichment. Both
	 * branches fail only with typed MediaFetchError carrying static prose
	 * (numeric HTTP status, never statusText), so the transcription catch
	 * blocks can classify every byte-fetch failure as transient could-not-fetch
	 * — the transcription-unavailable marker must never be forged by a fetch
	 * that failed before any TRANSCRIPTION provider ran. Bodies are read
	 * through the shared streaming cap, cancelling at the limit instead of
	 * materializing an oversize payload first.
	 */
	private async fetchAttachmentBytes(
		runtime: IAgentRuntime,
		rawUrl: string,
		resolvedLocalUrl: string,
		isRemote: boolean,
		budget: AttachmentByteBudget,
		expectedBytes?: number,
	): Promise<{ buffer: Buffer; contentType: string }> {
		if (budget.remaining <= 0) {
			throw new MediaFetchError(
				"max_bytes",
				"Attachment turn byte budget exhausted",
			);
		}
		const maxBytes = Math.min(ATTACHMENT_FETCH_MAX_BYTES, budget.remaining);
		if (
			typeof expectedBytes === "number" &&
			Number.isFinite(expectedBytes) &&
			expectedBytes > maxBytes
		) {
			throw new MediaFetchError(
				"max_bytes",
				expectedBytes > budget.remaining
					? "Attachment exceeds turn byte budget"
					: `Attachment exceeds ${ATTACHMENT_FETCH_MAX_BYTES} bytes`,
			);
		}
		if (isRemote) {
			const { buffer, contentType } = await fetchRemoteMedia({
				url: rawUrl,
				maxBytes,
			});
			budget.remaining -= Math.max(buffer.byteLength, expectedBytes ?? 0);
			return {
				buffer,
				contentType: contentType ?? "application/octet-stream",
			};
		}
		const runtimeFetch = runtime.fetch ?? globalThis.fetch;
		try {
			const res = await runtimeFetch(resolvedLocalUrl);
			if (!res.ok) {
				// Only the numeric status: statusText is dynamic prose (a local
				// 503 could carry "TRANSCRIPTION not available") and must never
				// reach the catch blocks that key on unavailability wording.
				throw new MediaFetchError(
					"http_error",
					`Failed to fetch attachment locally (HTTP ${res.status})`,
				);
			}
			// Reject on the declared size before reading; the streamed read below
			// cancels at the cap when the header is absent or lying.
			const declaredLength = Number(res.headers.get("content-length"));
			if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
				throw new MediaFetchError(
					"max_bytes",
					declaredLength > budget.remaining
						? "Attachment exceeds turn byte budget"
						: `Attachment exceeds ${ATTACHMENT_FETCH_MAX_BYTES} bytes`,
				);
			}
			const contentType =
				res.headers.get("content-type") || "application/octet-stream";
			const buffer = await readResponseWithLimit(res, maxBytes);
			budget.remaining -= Math.max(buffer.byteLength, expectedBytes ?? 0);
			return { buffer, contentType };
		} catch (err) {
			// error-policy:J2 typed transient-class rethrow covering the whole
			// local read boundary (fetch, header reads, body read): every local
			// byte-fetch failure surfaces as MediaFetchError so the audio/video
			// catch blocks write the transient could-not-fetch marker, never the
			// transcription-unavailable one. Matched by name rather than
			// instanceof so the pass-through survives module duplication across
			// the multi-target build and test mocks.
			if (err instanceof Error && err.name === "MediaFetchError") throw err;
			throw new MediaFetchError(
				"fetch_failed",
				"Failed to fetch attachment locally",
				err,
			);
		}
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
				// Bound reasoning on reasoning models (#16394): the failure-reply
				// path is a plain-text fallback that must stay low-latency, so every
				// slot carries thinking="off" like Stage-1, the evaluator, and every
				// planner iteration. Without it a drained/failed turn can still spend
				// hundreds of hidden reasoning tokens before producing visible text.
				const response = await runtime.useModel(modelType, {
					prompt,
					providerOptions: { eliza: { thinking: "off" } },
				});
				if (typeof response !== "string") {
					continue;
				}

				const cleaned = stripReasoningBlocks(response);
				const visible = sanitizeUserVisibleModelOutput(cleaned);
				if (visible.kind === "text" && visible.format === "plain") {
					return { kind: "text", value: visible.text };
				}
				if (visible.kind === "empty") {
					continue;
				}

				// error-policy:J3 the fallback prompt requires plain text. A
				// typed invalid/control result advances to the next model slot
				// and is reported instead of masquerading as a valid reply.
				reportRejectedUserVisibleModelOutput({
					runtime,
					scope: "MessageService.generateFailureReplyText",
					code: "FAILURE_REPLY_INVALID_MODEL_OUTPUT",
					message:
						"Failure-reply model violated the plain-text output contract",
					stage,
					output: visible,
					context: { modelType },
				});
			} catch (error) {
				// error-policy:J1 this model-fallback boundary translates
				// provider failures into the typed outcome the caller renders.
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
		cause: StructuredFailureCause = "transient",
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
		const failurePrompt = buildFailureReplyPrompt(recentMessages, cause);

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
			} else if (cause === "missing_capability") {
				// Permanent gap: never fall through to transientFailureReply
				// ("try again in a moment") — that copy invites a retry that
				// cannot succeed until the capability is enabled (#17027 AC6).
				// Dedicated template when present; otherwise the built-in
				// capability-unavailable default.
				const tmpl = runtime.character.templates?.missingCapabilityFailureReply;
				replyText =
					(typeof tmpl === "function" ? tmpl({ state }) : tmpl) ||
					"I can't do that here right now - it needs a capability that isn't available in this setup.";
			} else if (cause === "planner_exhaustion") {
				// Retryable budget exhaustion. Dedicated template first; the
				// legacy transientFailureReply remains a voice-compatible
				// fallback only for this recoverable class.
				const tmpl = runtime.character.templates?.plannerExhaustionFailureReply;
				const fallbackTmpl = runtime.character.templates?.transientFailureReply;
				replyText =
					(typeof tmpl === "function" ? tmpl({ state }) : tmpl) ||
					(typeof fallbackTmpl === "function"
						? fallbackTmpl({ state })
						: fallbackTmpl) ||
					"I ran out of attempts before I could finish that. Nothing was completed - please try again.";
			} else {
				const tmpl = runtime.character.templates?.transientFailureReply;
				replyText =
					(typeof tmpl === "function" ? tmpl({ state }) : tmpl) ||
					"Something went wrong on my end. Please try again.";
			}
		}

		replyText = replyText.trim();

		// Preserve the terminal cause at the delivery boundary. Provider failures
		// encountered while generating the apology take precedence because the
		// canned reply describes that condition. Capability, action, persistence,
		// auth, and credit failures remain stable until their cause changes;
		// throttling, planner exhaustion, and generic infrastructure failures can
		// be retried without presenting a durable success record.
		const failureKind =
			attempt.kind === "creditsExhausted"
				? "insufficient_credits"
				: attempt.kind === "rateLimited"
					? "rate_limited"
					: attempt.kind === "authFailed"
						? "provider_issue"
						: cause === "transient"
							? "transient_failure"
							: cause;
		const responseContent: Content = {
			thought: `Handle a ${cause} reply failure during ${stage}.`,
			actions: ["REPLY"],
			failureKind,
			elizaSyntheticFailure: true,
			transient:
				failureKind === "transient_failure" || failureKind === "rate_limited",
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

	private async emitMessageSent(
		runtime: IAgentRuntime,
		message: Memory,
		source: string,
	): Promise<void> {
		await runtime.emitEvent(EventType.MESSAGE_SENT, {
			runtime,
			message,
			source,
			trajectoryTerminalOwner: "run",
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

		const messageIds: UUID[] = [];
		for (const memory of memories) {
			if (!memory.id) {
				throw new ElizaError(
					"Cannot clear a channel containing a message memory without an ID",
					{
						code: "CHANNEL_MESSAGE_ID_MISSING",
						context: { roomId, channelId },
					},
				);
			}
			messageIds.push(memory.id);
		}

		let deletedCount = 0;
		for (const messageId of messageIds) {
			await runtime.deleteMemory(messageId);
			deletedCount++;
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
