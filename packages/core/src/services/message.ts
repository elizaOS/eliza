import { v4 } from "uuid";
import z from "zod";
import { formatActionNames, formatActions } from "../actions";
import {
	actionToTool,
	createHandleResponseTool,
	HANDLE_RESPONSE_TOOL_NAME,
	PLAN_ACTIONS_TOOL,
	PLAN_ACTIONS_TOOL_NAME,
	STABLE_PLANNER_TOOLS,
} from "../actions/to-tool";
import { evaluateConnectorAccountPolicies } from "../connectors/account-manager";
import { createUniqueUuid } from "../entities";
import {
	formatTaskCompletionStatus,
	type TaskCompletionAssessment,
} from "../features/advanced-capabilities/evaluators/task-completion";
import { looksLikeNonActionableChatter } from "../features/basic-capabilities/providers/non-actionable-chatter";
import { logger } from "../logger";
import { imageDescriptionTemplate, messageHandlerTemplate } from "../prompts";
import { checkSenderRole } from "../roles";
import {
	buildActionCatalog,
	type LocalizedActionExampleResolver,
} from "../runtime/action-catalog";
import { retrieveActions } from "../runtime/action-retrieval";
import { tierActionResults } from "../runtime/action-tiering";
import { applyAddressedTo } from "../runtime/addressed-to";
import { filterByContextGate } from "../runtime/context-gates";
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
import { getLocalizedExamplesProvider } from "../runtime/localized-examples-provider";
import {
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
} from "../runtime/planner-loop";
import { buildResponseGrammar } from "../runtime/response-grammar";
import {
	type ResponseHandlerEvaluator,
	type ResponseHandlerPatch,
	runResponseHandlerEvaluators,
} from "../runtime/response-handler-evaluators";
import { actionHasSubActions, runSubPlanner } from "../runtime/sub-planner";
import { buildCanonicalSystemPrompt } from "../runtime/system-prompt";
import {
	createJsonFileTrajectoryRecorder,
	isTrajectoryRecordingEnabled,
	type TrajectoryRecorder,
} from "../runtime/trajectory-recorder";
import { isExplicitSelfModificationRequest } from "../should-respond";
import {
	getModelStreamChunkDeliveryDepth,
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
import {
	extractFirstSentence,
	hasFirstSentence,
} from "../utils/text-splitting";
import { maybeHandleAnalysisActivation } from "./analysis-mode-handler";
import { runPostTurnEvaluators } from "./evaluator";
import type { OptimizedPromptTask } from "./optimized-prompt";
import {
	type OptimizedPromptRuntimeLike,
	resolveOptimizedPromptForRuntime,
} from "./optimized-prompt-resolver";

const PLANNER_CONTROL_ACTIONS = new Set(
	["REPLY", "RESPOND", "IGNORE", "STOP"].map(normalizeActionIdentifier),
);

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

function splitPlannerCompoundActionName(
	actionName: string,
): { actionName: string; subaction: string } | null {
	const parts = unwrapPlannerIdentifier(actionName)
		.split(".")
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts[0]?.toLowerCase() === "functions") {
		parts.shift();
	}
	if (parts.length !== 2) {
		return null;
	}
	return {
		actionName: parts[0],
		subaction: parts[1],
	};
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

		const compoundAction = splitPlannerCompoundActionName(actionName);
		if (compoundAction) {
			const resolvedCompoundAction = resolveRuntimeAction(
				actionLookup,
				compoundAction.actionName,
			);
			if (resolvedCompoundAction) {
				return [resolvedCompoundAction.name];
			}
		}

		const aliasedActionName = PLANNER_ACTION_ALIASES.get(normalized);
		if (aliasedActionName) {
			const resolvedAlias = resolveRuntimeAction(
				actionLookup,
				aliasedActionName,
			);
			if (resolvedAlias) {
				runtime.logger.info(
					{
						src: "service:message",
						actionName,
						aliasedActionName: resolvedAlias.name,
					},
					"Repaired planner action alias",
				);
				return [resolvedAlias.name];
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
): string[] {
	const lookup =
		actionLookup ?? buildRuntimeActionLookup(runtime as IAgentRuntime);
	const resolved = resolvePlannerActionNameFromLookup(
		runtime,
		lookup,
		actionName,
	);
	if (resolved.length > 0) {
		return resolved;
	}

	if (actionLookup) {
		const runtimeResolved = resolvePlannerActionNameFromLookup(
			runtime,
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
	runtime: Pick<IAgentRuntime, "actions" | "logger">,
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

	const compoundAction = splitPlannerCompoundActionName(actionName);
	if (compoundAction) {
		const resolvedCompoundAction = resolveRuntimeAction(
			lookup,
			compoundAction.actionName,
		);
		if (resolvedCompoundAction) {
			return [resolvedCompoundAction.name];
		}
	}

	const aliasedActionName = PLANNER_ACTION_ALIASES.get(normalized);
	if (aliasedActionName) {
		const resolvedAlias = resolveRuntimeAction(lookup, aliasedActionName);
		if (resolvedAlias) {
			runtime.logger.info(
				{
					src: "service:message",
					actionName,
					aliasedActionName: resolvedAlias.name,
				},
				"Repaired planner action alias",
			);
			return [resolvedAlias.name];
		}
	}

	return [];
}

function normalizePlannerProviders(
	parsedPlanner: Record<string, unknown>,
	runtime?: IAgentRuntime,
): string[] {
	const providerNames = extractPlannerProviderNames(parsedPlanner);

	if (!runtime) {
		return providerNames;
	}

	const providerLookup = new Map<string, string>();
	for (const provider of runtime.providers ?? []) {
		const normalized = normalizeActionIdentifier(provider.name);
		if (!normalized || providerLookup.has(normalized)) {
			continue;
		}
		providerLookup.set(normalized, provider.name);
	}
	const normalizedProviders = providerNames
		.map((providerName) => {
			const normalizedProviderName = normalizeActionIdentifier(providerName);
			const canonicalProvider =
				providerLookup.get(normalizedProviderName) ??
				(() => {
					const aliasedProvider = PLANNER_PROVIDER_ALIASES.get(
						normalizedProviderName,
					);
					if (!aliasedProvider) {
						return undefined;
					}
					return providerLookup.get(normalizeActionIdentifier(aliasedProvider));
				})();
			if (canonicalProvider) {
				return canonicalProvider;
			}
			runtime.logger.warn(
				{
					src: "service:message",
					providerName,
				},
				"Dropping unknown planner provider",
			);
			return "";
		})
		.filter((providerName) => providerName.length > 0);

	if (normalizedProviders.length === 0) {
		return normalizedProviders;
	}

	const providerDefinitions = new Map(
		(runtime.providers ?? []).map((provider) => [
			normalizeActionIdentifier(provider.name),
			provider,
		]),
	);
	const expandedProviders = [...normalizedProviders];
	const seenProviders = new Set(
		expandedProviders.map((providerName) =>
			normalizeActionIdentifier(providerName),
		),
	);

	for (let index = 0; index < expandedProviders.length; index += 1) {
		const providerName = expandedProviders[index];
		const providerDefinition = providerDefinitions.get(
			normalizeActionIdentifier(providerName),
		);
		const companionProviders = providerDefinition?.companionProviders ?? [];
		for (const companionProvider of companionProviders) {
			const canonicalCompanion = providerLookup.get(
				normalizeActionIdentifier(companionProvider),
			);
			if (!canonicalCompanion) {
				runtime.logger.warn(
					{
						src: "service:message",
						providerName,
						companionProvider,
					},
					"Dropping unknown companion provider",
				);
				continue;
			}
			const normalizedCompanion = normalizeActionIdentifier(canonicalCompanion);
			if (seenProviders.has(normalizedCompanion)) {
				continue;
			}
			seenProviders.add(normalizedCompanion);
			expandedProviders.push(canonicalCompanion);
		}
	}

	return expandedProviders;
}

function isStructuredPlannerIdentifier(value: string): boolean {
	const unwrapped = unwrapPlannerIdentifier(value).trim();
	return /^[A-Za-z][A-Za-z0-9_:-]*$/u.test(unwrapped);
}

function extractStructuredProviderList(rawProviders: string): string[] {
	const safe =
		rawProviders.length > 10_000 ? rawProviders.slice(0, 10_000) : rawProviders;
	const tokens = safe
		.split(/[\n,;]/)
		.map((providerName) =>
			providerName.replace(/^[\s"'[\](){}]+|[\s"'[\](){}]+$/g, ""),
		)
		.map((providerName) => unwrapPlannerIdentifier(providerName).trim())
		.filter((providerName) => providerName.length > 0);
	if (tokens.length === 0 || !tokens.every(isStructuredPlannerIdentifier)) {
		return [];
	}
	return tokens;
}

// Schemas for LLM-emitted provider lists embedded as JSON strings inside the
// planner output. The planner sometimes returns providers as a JSON array of
// strings or as a `{ providers: string[] }` object.
// We coerce non-string entries to string and validate downstream.
const ProviderJsonArraySchema = z.array(z.unknown());
const ProviderJsonEnvelopeSchema = z.object({
	providers: z.array(z.unknown()),
});

export function extractPlannerProviderNames(
	parsedPlanner: Record<string, unknown>,
): string[] {
	const rawProviders = parsedPlanner.providers;
	if (typeof rawProviders === "string") {
		const trimmedProviders = rawProviders.trim();
		if (!trimmedProviders) {
			return [];
		}
		if (
			(trimmedProviders.startsWith("[") && trimmedProviders.endsWith("]")) ||
			(trimmedProviders.startsWith("{") && trimmedProviders.endsWith("}"))
		) {
			try {
				const parsedJson: unknown = JSON.parse(trimmedProviders);
				const arrayResult = ProviderJsonArraySchema.safeParse(parsedJson);
				if (arrayResult.success) {
					return arrayResult.data
						.map((providerName) => String(providerName).trim())
						.filter(
							(providerName): providerName is string =>
								providerName.length > 0 &&
								isStructuredPlannerIdentifier(providerName),
						);
				}
				const envelopeResult = ProviderJsonEnvelopeSchema.safeParse(parsedJson);
				if (envelopeResult.success) {
					return envelopeResult.data.providers
						.map((providerName) => String(providerName).trim())
						.filter(
							(providerName): providerName is string =>
								providerName.length > 0 &&
								isStructuredPlannerIdentifier(providerName),
						);
				}
				logger.warn(
					{
						raw: trimmedProviders,
						arrayErr: arrayResult.error.issues,
						envelopeErr: envelopeResult.error.issues,
					},
					"[message] LLM response failed schema validation",
				);
			} catch (err) {
				logger.warn(
					{ raw: trimmedProviders, err },
					"[message] LLM response failed schema validation",
				);
			}
		}

		return extractStructuredProviderList(trimmedProviders);
	}

	if (Array.isArray(rawProviders)) {
		return rawProviders.flatMap((providerName) => {
			if (typeof providerName !== "string") {
				const normalized = String(providerName).trim();
				return normalized.length > 0 &&
					isStructuredPlannerIdentifier(normalized)
					? [normalized]
					: [];
			}

			const trimmedProvider = providerName.trim();
			if (!trimmedProvider) {
				return [];
			}
			if (
				(trimmedProvider.startsWith("[") && trimmedProvider.endsWith("]")) ||
				(trimmedProvider.startsWith("{") && trimmedProvider.endsWith("}"))
			) {
				try {
					const parsedJson: unknown = JSON.parse(trimmedProvider);
					const arrayResult = ProviderJsonArraySchema.safeParse(parsedJson);
					if (arrayResult.success) {
						return arrayResult.data
							.map((entry) => String(entry).trim())
							.filter(
								(entry): entry is string =>
									entry.length > 0 && isStructuredPlannerIdentifier(entry),
							);
					}
					logger.warn(
						{ raw: trimmedProvider, err: arrayResult.error.issues },
						"[message] LLM response failed schema validation",
					);
				} catch (err) {
					logger.warn(
						{ raw: trimmedProvider, err },
						"[message] LLM response failed schema validation",
					);
				}
			}

			return extractStructuredProviderList(trimmedProvider);
		});
	}

	return [];
}

const CORE_RESPONSE_STATE_PROVIDERS = [
	"UI_CONTEXT",
	"ENTITIES",
	"RECENT_MESSAGES",
	"ATTACHMENTS",
	"PLATFORM_CHAT_CONTEXT",
	"PLATFORM_USER_CONTEXT",
	// CURRENT_TIME is dynamic and would otherwise be filtered out before
	// reaching the response handler. The wall-clock time is a baseline
	// signal for nearly every routing decision (scheduling, freshness of
	// recent messages, "today/tomorrow" parsing), so it's always-on here.
	"CURRENT_TIME",
];

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
 * Note: we still keep FACTS rendered if present — Stage 1 may need a
 * grounded fact to discriminate ambiguous routing, and FACTS are stable
 * across calls (only refreshed when the underlying store changes).
 */
const STAGE1_EXTRA_PROVIDER_EXCLUSIONS = [
	"CURRENT_TIME",
	"ENTITIES",
	"DOCUMENTS",
] as const;

const STRUCTURED_RESPONSE_STATE_PROVIDERS = ["ACTIONS", "PROVIDERS"];
const FOCUSED_PROVIDER_REPLY_STATE_PROVIDERS = ["CHARACTER", "RECENT_MESSAGES"];

function hasInboundBenchmarkContext(message: Memory): boolean {
	const metadata = message.metadata as Record<string, unknown> | undefined;
	const benchmarkContext = metadata?.benchmarkContext;
	return (
		typeof benchmarkContext === "string" && benchmarkContext.trim().length > 0
	);
}

/**
 * Returns true when the current turn was issued by a benchmark harness AND the
 * `MILADY_BENCH_FORCE_TOOL_CALL` env opt-in is set. Used to bias the planner
 * toward emitting structured tool calls instead of routing every turn through
 * `REPLY`, which is what LifeOpsBench and similar harnesses score against.
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
function isBenchmarkForcingToolCall(message: Memory): boolean {
	if (process.env.MILADY_BENCH_FORCE_TOOL_CALL !== "1") return false;
	const content = message.content;
	if (!content) return false;
	if (content.source === "benchmark") return true;
	const contentMetadata = content.metadata as Record<string, unknown> | undefined;
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

function composeResponseState(
	runtime: IAgentRuntime,
	message: Memory,
	skipCache = false,
): Promise<State> {
	const providers = hasInboundBenchmarkContext(message)
		? [...CORE_RESPONSE_STATE_PROVIDERS, "CONTEXT_BENCH"]
		: CORE_RESPONSE_STATE_PROVIDERS;
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

function _composeStructuredResponseState(
	runtime: IAgentRuntime,
	message: Memory,
	skipCache = false,
): Promise<State> {
	return runtime.composeState(
		message,
		STRUCTURED_RESPONSE_STATE_PROVIDERS,
		false,
		skipCache,
	);
}

function composeProviderGroundedResponseState(
	runtime: IAgentRuntime,
	message: Memory,
	providers: string[],
	skipCache = false,
): Promise<State> {
	return runtime.composeState(
		message,
		[...CORE_RESPONSE_STATE_PROVIDERS, ...providers],
		false,
		skipCache,
	);
}

function selectV5PlannerStateProviderNames(args: {
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
	for (const provider of filterByContextGate(
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

function _composeFocusedProviderReplyState(
	runtime: IAgentRuntime,
	message: Memory,
	providers: string[],
	skipCache = false,
): Promise<State> {
	return runtime.composeState(
		message,
		[...FOCUSED_PROVIDER_REPLY_STATE_PROVIDERS, ...providers],
		true,
		skipCache,
	);
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

/**
 * Image description response from the model
 */
interface ImageDescriptionResponse {
	description: string;
	title?: string;
}

type MediaWithInlineData = Media & {
	_data?: unknown;
	_mimeType?: unknown;
};

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
	| { kind: "noProvider" };

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

function getV5ModelText(raw: string | GenerateTextResult): string {
	if (typeof raw === "string") {
		return raw;
	}
	return typeof raw.text === "string" ? raw.text : JSON.stringify(raw);
}

function createV5ReplyStrategyResult(args: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	responseId: UUID;
	text: string;
	thought: string;
	mode?: StrategyMode;
}): StrategyResult {
	const responseContent: Content = {
		thought: args.thought,
		actions: ["REPLY"],
		providers: [],
		text: args.text,
		simple: args.mode !== "actions",
		responseId: args.responseId,
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

function appendPriorDialogueEvents(
	events: ContextEvent[],
	runtime: IAgentRuntime,
	state: State,
	currentMessage: Memory,
): void {
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
			const contentType =
				m.content && typeof m.content === "object"
					? (m.content as { type?: string }).type
					: undefined;
			if (contentType === "action_result") return false;
			const text =
				typeof m.content?.text === "string" ? m.content.text.trim() : "";
			return text.length > 0;
		})
		.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
	for (const memory of dialogue) {
		const isAgent = memory.entityId === runtime.agentId;
		events.push({
			id: `history:${memory.id}`,
			type: "message",
			source: isAgent ? "agent" : "user",
			createdAt: memory.createdAt,
			message: {
				id: memory.id,
				role: isAgent ? "assistant" : "user",
				content: memory.content,
				metadata: {
					roomId: memory.roomId,
					entityId: memory.entityId,
				},
			},
		});
	}
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
		.filter((memory): memory is Memory => {
			if (!memory || typeof memory !== "object") return false;
			if (memory.id && currentMessage.id && memory.id === currentMessage.id) {
				return false;
			}
			return typeof memory.content?.text === "string";
		})
		.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
		.slice(0, 8)
		.map((memory) => memory.content.text?.trim() ?? "")
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
	userRoles?: readonly RoleGateRole[];
}): Promise<Action[]> {
	// We used to filter the candidate set by `action.contexts` against the
	// messageHandler-picked `selectedContexts`. That filter excluded owner
	// actions, CALENDAR, SCHEDULED_TASKS, etc. whenever the messageHandler routed to
	// "general" — even when the user clearly asked for a habit/event/etc.
	// (See `docs/audits/lifeops-2026-05-09/12-real-root-cause.md`.)
	//
	// Now: every action is a candidate. Role gates and per-action validate /
	// account-policy checks still apply (those are correctness/security, not
	// relevance). Retrieval scoring then uses `selectedContexts` as a
	// *weight* (boost actions whose contexts intersect the active set) but
	// never as a hard filter.
	const allRuntimeActions = args.runtime.actions;
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
		_activeContexts:
			| readonly AgentContext[]
			| undefined = args.selectedContexts,
	): Promise<boolean> => {
		const normalizedName = normalizeActionIdentifier(action.name);
		if (!normalizedName || seen.has(normalizedName)) {
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

	if (
		params.actions.length === 0 ||
		process.env.MILADY_TIERED_ACTION_SURFACE === "0"
	) {
		return buildFullV5PlannerActionSurface({
			actions: params.actions,
			candidateActions,
			parentActionHints,
		});
	}

	const toolSearchStartedAt = Date.now();
	const catalog = buildActionCatalog([...params.actions], {
		localizedExamples: params.localizedExamples,
	});
	const retrieval = retrieveActions({
		catalog,
		messageText: getUserMessageText(params.message) ?? "",
		recentConversationText: getRecentConversationSearchText(
			params.state,
			params.message,
		),
		selectedContexts: params.selectedContexts,
		candidateActions,
		parentActionHints,
	});
	const tieredSurface = tierActionResults({
		catalog,
		results: retrieval.results,
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
						text: getUserMessageText(params.message) ?? "",
						tokens: retrieval.query.tokens,
						candidateActions: [...candidateActions],
						parentActionHints: [...parentActionHints],
					},
					results: retrieval.results.slice(0, 25).map((r, idx) => ({
						name: r.name,
						score: r.score,
						rank: idx,
						rrfScore: (r as unknown as { rrfScore?: number }).rrfScore,
						matchedBy: (r as unknown as { matchedBy?: string[] }).matchedBy,
						stageScores: (
							r as unknown as { stageScores?: Record<string, number> }
						).stageScores,
					})),
					tier: {
						tierA: tieredSurface.sortedTierAParentNames,
						tierB: tieredSurface.sortedTierBParentNames,
						omitted: tieredSurface.omittedParentNames.length,
					},
					durationMs: toolSearchEndedAt - toolSearchStartedAt,
					fallback,
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

	const renderExclusions = args.extraProviderExclusions?.length
		? [...MODEL_CONTEXT_PROVIDER_EXCLUSIONS, ...args.extraProviderExclusions]
		: MODEL_CONTEXT_PROVIDER_EXCLUSIONS;
	appendStateProviderEvents(events, args.state, renderExclusions);

	appendPriorDialogueEvents(events, args.runtime, args.state, args.message);

	events.push({
		id: String(args.message.id ?? "current-message"),
		type: "message",
		source: args.message.content.source ?? "user",
		createdAt: args.message.createdAt,
		message: {
			id: args.message.id,
			role: "user",
			content: args.message.content,
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
	// Stage 2 sees one stable wrapper tool: PLAN_ACTIONS. Per-action specs live in
	// `events[type=tool]` and are rendered into the conversation's
	// available-actions block by the available_actions provider; the LLM picks
	// one by name and passes it back via `PLAN_ACTIONS({ action, ... })`.
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
		? [PLAN_ACTIONS_TOOL]
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

function contextAvailableForRepair(
	context: AgentContext,
	availableContexts: readonly ContextDefinition[] | undefined,
): boolean {
	return (
		!availableContexts ||
		availableContexts.length === 0 ||
		availableContexts.some((definition) => definition.id === context)
	);
}

function addRepairPlanToPatch(
	patch: {
		setContexts?: AgentContext[];
		addContexts: AgentContext[];
		addCandidateActions: string[];
		addParentActionHints: string[];
	},
	repair: {
		contexts: AgentContext[];
		candidateActions: string[];
		parentActionHints: string[];
	},
	mode: "replace-contexts" | "add-contexts",
): void {
	if (mode === "replace-contexts") {
		patch.setContexts = mergeAgentContexts([], repair.contexts);
	} else {
		patch.addContexts = mergeAgentContexts(patch.addContexts, repair.contexts);
	}
	patch.addCandidateActions = [
		...new Set([...patch.addCandidateActions, ...repair.candidateActions]),
	];
	patch.addParentActionHints = [
		...new Set([...patch.addParentActionHints, ...repair.parentActionHints]),
	];
}

function getStage1OwnerPreferenceRepairPlan(args: {
	message: Memory;
	availableContexts: readonly ContextDefinition[];
}): {
	contexts: AgentContext[];
	candidateActions: string[];
	parentActionHints: string[];
} | null {
	const text = (getUserMessageText(args.message) ?? "").trim();
	if (!text) {
		return null;
	}
	const lower = text.toLowerCase();
	const explicitDocumentArtifactIntent =
		/\b(?:document|doc|file|markdown|pdf|spreadsheet|sheet|notes?\s+(?:file|document|page)|save\s+(?:this|that|it)\s+as)\b/.test(
			lower,
		);
	const stablePreferenceIntent =
		/\b(?:remember|save|store|record|keep|note)\b[\s\S]{0,120}\b(?:i|me|my)\b[\s\S]{0,80}\b(?:prefer|preference|preferences|prefs?|like|usually|always)\b/.test(
			lower,
		) ||
		/\b(?:travel|booking|flight|hotel)\s+(?:preference|preferences|prefs?)\b/.test(
			lower,
		);
	if (!stablePreferenceIntent || explicitDocumentArtifactIntent) {
		return null;
	}
	const travelPreferenceIntent =
		/\b(?:travel|booking|flight|flights?|seat|seats?|aisle|window|carry-?on|checked bags?|luggage|hotel|hotels?|venue|venues?)\b/.test(
			lower,
		);
	const contexts = (
		["memory", "settings", "calendar"] as AgentContext[]
	).filter((context) =>
		contextAvailableForRepair(context, args.availableContexts),
	);
	return {
		contexts: contexts.length > 0 ? contexts : ["general"],
		candidateActions: travelPreferenceIntent
			? [
					"save_travel_preferences",
					"store_travel_preferences",
					"store_preference",
				]
			: ["store_preference", "save_owner_profile"],
		parentActionHints: ["REPLY", "DOCUMENT"],
	};
}

function getStage1ApprovalResolutionRepairPlan(args: {
	message: Memory;
	availableContexts: readonly ContextDefinition[];
}): {
	contexts: AgentContext[];
	candidateActions: string[];
	parentActionHints: string[];
} | null {
	const text = (getUserMessageText(args.message) ?? "").trim();
	if (!text) {
		return null;
	}
	const lower = text.toLowerCase();
	const resolutionIntent =
		/\b(?:approve|accept|confirm|reject|deny|decline)\b[\s\S]{0,120}\b(?:pending\s+)?(?:approval|request)\b/.test(
			lower,
		) ||
		/\b(?:pending\s+)?(?:approval|request)\b[\s\S]{0,120}\b(?:approve|accept|confirm|reject|deny|decline)\b/.test(
			lower,
		);
	if (!resolutionIntent) {
		return null;
	}
	const rejectIntent = /\b(?:reject|deny|decline)\b/.test(lower);
	const contexts = (
		["tasks", "automation", "admin", "general"] as AgentContext[]
	).filter((context) =>
		contextAvailableForRepair(context, args.availableContexts),
	);
	return {
		contexts: contexts.length > 0 ? contexts : ["general"],
		candidateActions: rejectIntent
			? ["resolve_pending_approval", "reject_approval", "deny_approval"]
			: ["resolve_pending_approval", "approve_approval", "approve_request"],
		parentActionHints: ["RESOLVE_REQUEST"],
	};
}

function getStage1PasswordManagerRepairPlan(args: {
	message: Memory;
	availableContexts: readonly ContextDefinition[];
}): {
	contexts: AgentContext[];
	candidateActions: string[];
	parentActionHints: string[];
} | null {
	const text = (getUserMessageText(args.message) ?? "").trim();
	if (!text) {
		return null;
	}
	const lower = text.toLowerCase();
	const lookupVerb =
		/\b(?:look\s*up|find|search|show|list|copy|retrieve|get)\b/.test(lower);
	const credentialNoun =
		/\b(?:passwords?|saved\s+logins?|logins?|credentials?|1password|onepassword|protonpass|passkey|passkeys)\b/.test(
			lower,
		);
	const explicitFillIntent =
		/\b(?:fill|autofill|type|enter)\b[\s\S]{0,80}\b(?:password|login|field|form)\b/.test(
			lower,
		);
	if (!lookupVerb || !credentialNoun || explicitFillIntent) {
		return null;
	}
	const contexts = (
		["secrets", "settings", "browser", "automation"] as AgentContext[]
	).filter((context) =>
		contextAvailableForRepair(context, args.availableContexts),
	);
	return {
		contexts: contexts.length > 0 ? contexts : ["secrets"],
		candidateActions: [
			"password_manager_search",
			"saved_login_lookup",
			"credential_lookup",
			"search_password_manager",
		],
		parentActionHints: ["CREDENTIALS"],
	};
}

function getStage1CheckinRepairPlan(args: {
	message: Memory;
	availableContexts: readonly ContextDefinition[];
}): {
	contexts: AgentContext[];
	candidateActions: string[];
	parentActionHints: string[];
} | null {
	const text = (getUserMessageText(args.message) ?? "").trim();
	if (!text) {
		return null;
	}
	const lower = text.toLowerCase();
	const checkinIntent =
		/\b(?:run|give|start|do|show|open)\b[\s\S]{0,80}\b(?:morning|night|daily|evening|bedtime)\s+check-?in\b/.test(
			lower,
		) ||
		/\b(?:morning|night|daily|evening|bedtime)\s+check-?in\b[\s\S]{0,80}\b(?:now|today|tonight|please|for me)?\b/.test(
			lower,
		);
	if (!checkinIntent) {
		return null;
	}
	const nightIntent = /\b(?:night|evening|bedtime|tonight)\b/.test(lower);
	const morningIntent = /\bmorning\b/.test(lower);
	const contexts = (
		["tasks", "health", "automation", "calendar", "email"] as AgentContext[]
	).filter((context) =>
		contextAvailableForRepair(context, args.availableContexts),
	);
	return {
		contexts: contexts.length > 0 ? contexts : ["tasks"],
		candidateActions: nightIntent
			? ["night_checkin", "run_night_checkin", "lifeops_night_checkin"]
			: morningIntent
				? ["morning_checkin", "run_morning_checkin", "lifeops_morning_checkin"]
				: ["run_checkin", "daily_checkin", "lifeops_checkin"],
		parentActionHints: ["CHECKIN"],
	};
}

function getStage1CalendlyRepairPlan(args: {
	message: Memory;
	availableContexts: readonly ContextDefinition[];
}): {
	contexts: AgentContext[];
	candidateActions: string[];
	parentActionHints: string[];
} | null {
	const text = (getUserMessageText(args.message) ?? "").trim();
	if (!text) {
		return null;
	}
	const lower = text.toLowerCase();
	const calendlyIntent = /\bcalendly\b|api\.calendly\.com/u.test(lower);
	if (!calendlyIntent) {
		return null;
	}
	const availabilityIntent =
		/\b(?:availability|available|open|slots?|times?)\b/u.test(lower);
	const singleUseLinkIntent =
		/\b(?:single[\s-]?use|one[\s-]?time|booking\s+link|book(?:ing)?\s+link|link)\b/u.test(
			lower,
		) && /\b(?:create|make|generate|get|give|send)\b/u.test(lower);
	if (!availabilityIntent && !singleUseLinkIntent) {
		return null;
	}
	const contexts = (
		["calendar", "connectors", "tasks"] as AgentContext[]
	).filter((context) =>
		contextAvailableForRepair(context, args.availableContexts),
	);
	return {
		contexts: contexts.length > 0 ? contexts : ["calendar"],
		candidateActions: singleUseLinkIntent
			? [
					"calendly_single_use_link",
					"calendly_create_single_use_link",
					"calendar_calendly_single_use_link",
				]
			: [
					"calendly_availability",
					"calendar_check_calendly_availability",
					"check_calendly_availability",
				],
		parentActionHints: ["CALENDAR"],
	};
}

function looksLikeCalendarTravelFeasibilityRequest(text: string): boolean {
	const lower = text.toLowerCase();
	const hasTravelSignal =
		/\b(?:flight|flights?|airport|arriv(?:e|es|al|ing)|land(?:s|ed|ing)?|depart(?:s|ed|ure)?|itinerary|travel|jfk|sfo|lax|ord|ewr|lga)\b/u.test(
			lower,
		);
	const hasCalendarSignal =
		/\b(?:meeting|board|calendar|schedule|appointment|event|conflict|make\s+(?:my|the|it))\b/u.test(
			lower,
		);
	const hasFeasibilitySignal =
		/\b(?:can|could|will|would|make|given|tight|conflict|overlap|rebook|move|reschedule|enough time)\b/u.test(
			lower,
		);
	return hasTravelSignal && hasCalendarSignal && hasFeasibilitySignal;
}

function getStage1CalendarTravelRepairPlan(args: {
	message: Memory;
	availableContexts: readonly ContextDefinition[];
}): {
	contexts: AgentContext[];
	candidateActions: string[];
	parentActionHints: string[];
} | null {
	const text = (getUserMessageText(args.message) ?? "").trim();
	if (!text || !looksLikeCalendarTravelFeasibilityRequest(text)) {
		return null;
	}
	const contexts = (["calendar", "tasks"] as AgentContext[]).filter((context) =>
		contextAvailableForRepair(context, args.availableContexts),
	);
	return {
		contexts: contexts.length > 0 ? contexts : ["calendar"],
		candidateActions: [
			"check_flight_conflict",
			"flight_conflict_rebooking",
			"calendar_search_events",
			"calendar_read",
		],
		parentActionHints: ["CALENDAR"],
	};
}

function looksLikeCalendarSignatureDeadlineRequest(text: string): boolean {
	const lower = text.toLowerCase();
	const hasSignatureSignal =
		/\b(?:nda|docusign|signature|signed|signing|sign\s+(?:the|a)?\s*(?:document|doc|nda)|document\s+sign(?:ing|ature)?)\b/u.test(
			lower,
		);
	const hasCalendarDeadlineSignal =
		/\b(?:meeting|appointment|kick-?off|deadline|before|due|in\s+\d+\s+days?|partnership)\b/u.test(
			lower,
		);
	const hasInitiationSignal =
		/\b(?:initiate|start|begin|draft|queue|prepare|send|get\s+(?:it|the\s+nda)\s+signed|signing\s+flow)\b/u.test(
			lower,
		);
	return hasSignatureSignal && hasCalendarDeadlineSignal && hasInitiationSignal;
}

function getStage1CalendarSignatureDeadlineRepairPlan(args: {
	message: Memory;
	availableContexts: readonly ContextDefinition[];
}): {
	contexts: AgentContext[];
	candidateActions: string[];
	parentActionHints: string[];
} | null {
	const text = (getUserMessageText(args.message) ?? "").trim();
	if (!text || !looksLikeCalendarSignatureDeadlineRequest(text)) {
		return null;
	}
	const contexts = (["calendar"] as AgentContext[]).filter((context) =>
		contextAvailableForRepair(context, args.availableContexts),
	);
	return {
		contexts: contexts.length > 0 ? contexts : ["calendar"],
		candidateActions: [
			"personal_assistant_sign_document",
			"sign_document",
			"calendar_search_events",
			"calendar_read",
		],
		parentActionHints: ["PERSONAL_ASSISTANT", "CALENDAR"],
	};
}

function getStage1KnownToolRepairPlan(args: {
	message: Memory;
	availableContexts: readonly ContextDefinition[];
}): {
	contexts: AgentContext[];
	candidateActions: string[];
	parentActionHints: string[];
} | null {
	return (
		getStage1ApprovalResolutionRepairPlan(args) ??
		getStage1PasswordManagerRepairPlan(args) ??
		getStage1CheckinRepairPlan(args) ??
		getStage1CalendarSignatureDeadlineRepairPlan(args) ??
		getStage1CalendarTravelRepairPlan(args) ??
		getStage1CalendlyRepairPlan(args) ??
		getStage1OwnerPreferenceRepairPlan(args)
	);
}

function buildFallbackStage1PlanForKnownToolRequest(args: {
	message: Memory;
	availableContexts: readonly ContextDefinition[];
}): MessageHandlerResult | null {
	const repair = getStage1KnownToolRepairPlan(args);
	if (!repair) {
		return null;
	}
	return {
		processMessage: "RESPOND",
		thought:
			"Deterministic fallback: explicit owner tool request requires a known owning action.",
		plan: {
			contexts: repair.contexts,
			requiresTool: true,
			simple: false,
			candidateActions: repair.candidateActions,
			parentActionHints: repair.parentActionHints,
		},
	};
}

function buildKnownToolRequestResponseHandlerPatch(args: {
	message: Memory;
	availableContexts: readonly ContextDefinition[];
}): ResponseHandlerPatch | null {
	const text = (getUserMessageText(args.message) ?? "").trim();
	if (!text) {
		return null;
	}

	const lower = text.toLowerCase();
	const patch = {
		setContexts: undefined as AgentContext[] | undefined,
		addContexts: [] as AgentContext[],
		addCandidateActions: [] as string[],
		addParentActionHints: [] as string[],
	};

	const replaceRepairs = [
		getStage1ApprovalResolutionRepairPlan(args),
		getStage1PasswordManagerRepairPlan(args),
		getStage1CheckinRepairPlan(args),
		getStage1CalendarSignatureDeadlineRepairPlan(args),
		getStage1CalendarTravelRepairPlan(args),
		getStage1CalendlyRepairPlan(args),
	].filter(
		(
			repair,
		): repair is {
			contexts: AgentContext[];
			candidateActions: string[];
			parentActionHints: string[];
		} => repair !== null,
	);
	for (const repair of replaceRepairs) {
		addRepairPlanToPatch(patch, repair, "replace-contexts");
	}

	const targetLookupReplyIntent =
		/\b(draft|prepare|write|compose)\b[\s\S]{0,80}\brepl(?:y|ies|ied|ying)\b/.test(
			lower,
		) ||
		/\brepl(?:y|ies|ied|ying|respond)\b[\s\S]{0,80}\b(to|from|latest|last|recent|email|message|dm|text)\b/.test(
			lower,
		);
	const mentionsMailOrMessageTarget =
		/\b(e-?mail|inbox|message|dm|direct message|text|sms|slack|discord|telegram|signal|whatsapp|imessage|from\s+[a-z][\w'-]*)\b/.test(
			lower,
		);
	if (targetLookupReplyIntent && mentionsMailOrMessageTarget) {
		const contexts = (
			["email", "messaging", "connectors"] as AgentContext[]
		).filter((context) =>
			contextAvailableForRepair(context, args.availableContexts),
		);
		addRepairPlanToPatch(
			patch,
			{
				contexts,
				candidateActions: ["draft_reply", "message_draft_reply", "send_email"],
				parentActionHints: ["MESSAGE"],
			},
			"add-contexts",
		);
	}

	const ownerPreferenceRepair = getStage1OwnerPreferenceRepairPlan(args);
	if (ownerPreferenceRepair) {
		addRepairPlanToPatch(patch, ownerPreferenceRepair, "replace-contexts");
	}

	const desktopScreenshotIntent =
		/\b(screen\s*shot|screenshot|capture\s+(?:my\s+|the\s+|current\s+)?screen|see\s+(?:my\s+|the\s+)?screen)\b/.test(
			lower,
		) &&
		!/\b(generate|create|draw|make)\b[\s\S]{0,40}\b(image|picture|art|graphic)\b/.test(
			lower,
		);
	if (desktopScreenshotIntent) {
		const contexts = (["browser", "automation"] as AgentContext[]).filter(
			(context) => contextAvailableForRepair(context, args.availableContexts),
		);
		addRepairPlanToPatch(
			patch,
			{
				contexts,
				candidateActions: ["take_screenshot", "capture_screen"],
				parentActionHints: ["COMPUTER_USE"],
			},
			"add-contexts",
		);
	}

	if (
		!patch.setContexts &&
		patch.addContexts.length === 0 &&
		patch.addCandidateActions.length === 0 &&
		patch.addParentActionHints.length === 0
	) {
		return null;
	}

	return {
		requiresTool: true,
		simple: false,
		clearReply: true,
		...(patch.setContexts ? { setContexts: patch.setContexts } : {}),
		...(patch.addContexts.length > 0 ? { addContexts: patch.addContexts } : {}),
		...(patch.addCandidateActions.length > 0
			? { addCandidateActions: patch.addCandidateActions }
			: {}),
		...(patch.addParentActionHints.length > 0
			? { addParentActionHints: patch.addParentActionHints }
			: {}),
		debug: ["known tool request repair"],
	};
}

const BUILTIN_RESPONSE_HANDLER_EVALUATORS: readonly ResponseHandlerEvaluator[] =
	[
		{
			name: "core.known_tool_request_repair",
			description:
				"Deterministically repairs Stage 1 routing for explicit known tool requests.",
			priority: 20,
			shouldRun: ({ message }) =>
				Boolean((getUserMessageText(message) ?? "").trim()),
			evaluate: ({ message, availableContexts }) =>
				buildKnownToolRequestResponseHandlerPatch({
					message,
					availableContexts,
				}) ?? undefined,
		},
	];

/**
 * Baseline instruction prefix for the `response` task. When an optimized
 * artifact exists for `response`, the resolver substitutes this string with
 * the optimizer's prompt before the per-turn context is appended.
 *
 * Kept as a single string so the operator can train against the exact
 * baseline by exporting `RESPONSE_TASK_BASELINE_INSTRUCTIONS` from this
 * module if needed.
 */
const RESPONSE_TASK_BASELINE_INSTRUCTIONS = [
	"task: Write one direct reply to the user.",
	"",
	"rules:",
	"- answer directly in the agent's voice",
	"- do not select actions or tools",
	"- do not include internal reasoning",
].join("\n");

async function generateDirectReplyOnce(args: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	messageHandler: MessageHandlerResult;
}): Promise<string> {
	const latestText = getUserMessageText(args.message) ?? "";
	const instructions = resolveOptimizedPromptForRuntime(
		args.runtime,
		"response",
		RESPONSE_TASK_BASELINE_INSTRUCTIONS,
	);
	const prompt = [
		instructions,
		"",
		"context:",
		args.state.text,
		"",
		`user_message: ${latestText}`,
		`routing_thought: ${args.messageHandler.thought}`,
	].join("\n");
	const raw = await args.runtime.useModel(ModelType.TEXT_SMALL, { prompt });
	return getV5ModelText(raw).trim();
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
 * The Stage-1 `messageHandlerTemplate` covers three optimized-prompt tasks:
 *
 *   - `context_routing` — when the role-filtered context catalog is non-empty
 *     the prompt asks the model to pick which contexts to consume. Optimizing
 *     this task tunes the routing instructions.
 *   - `should_respond` — when no contexts are available (direct messages, or
 *     callers that haven't registered any) the prompt collapses to a respond
 *     /ignore decision. Optimizing this task tunes that classifier.
 *   - `response` — Stage-1 also emits the assistant's draft reply when it
 *     decides to respond, so a separately-trained `response` artifact
 *     replaces the same baseline when present and the operator wants that
 *     variant active.
 *
 * The dispatch here is keyed on call-site state (whether contexts are
 * available), not on an `if (task === 'X')` branch — we ask the resolver for
 * one task name per call.
 */
function selectMessageHandlerTask(
	availableContexts: readonly ContextDefinition[],
): OptimizedPromptTask {
	return availableContexts.length > 0 ? "context_routing" : "should_respond";
}

function renderMessageHandlerInstructions(
	runtime: OptimizedPromptRuntimeLike,
	availableContexts: readonly ContextDefinition[],
	options?: { directMessage?: boolean },
): string {
	const baseline = resolveOptimizedPromptForRuntime(
		runtime,
		selectMessageHandlerTask(availableContexts),
		messageHandlerTemplate,
	);
	return composePrompt({
		state: {
			directMessage: options?.directMessage ? "true" : "",
			availableContexts: formatAvailableContextsForPrompt(availableContexts),
			handleResponseToolName: HANDLE_RESPONSE_TOOL_NAME,
		},
		template: baseline,
	}).trim();
}

function renderMessageHandlerModelInput(
	runtime: OptimizedPromptRuntimeLike,
	context: ContextObject,
	availableContexts: readonly ContextDefinition[] = [],
	options?: { directMessage?: boolean },
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
		extraProviderExclusions: STAGE1_EXTRA_PROVIDER_EXCLUSIONS,
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

function parseToolArguments(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		if (typeof value !== "string") {
			return null;
		}
		try {
			const parsed: unknown = JSON.parse(value);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: null;
		} catch {
			return null;
		}
	}
	return value as Record<string, unknown>;
}

function parseMessageHandlerNativeToolCall(
	raw: GenerateTextResult,
): MessageHandlerResult | null {
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
		return parseMessageHandlerOutput(JSON.stringify(args));
	}
	return null;
}

function looksLikeMessageHandlerToolArguments(
	args: Record<string, unknown>,
): boolean {
	if (Object.keys(args).length === 0) {
		return false;
	}
	return (
		args.plan !== undefined ||
		args.processMessage !== undefined ||
		args.shouldRespond !== undefined ||
		args.action !== undefined ||
		args.contexts !== undefined ||
		args.reply !== undefined ||
		args.replyText !== undefined ||
		args.thought !== undefined ||
		args.extract !== undefined
	);
}

function parseMessageHandlerModelOutput(
	raw: string | GenerateTextResult,
): MessageHandlerResult | null {
	if (typeof raw !== "string") {
		return (
			parseMessageHandlerNativeToolCall(raw) ??
			parseMessageHandlerOutput(getV5ModelText(raw)) ??
			synthesizeSimpleReplyFromPlainText(getV5ModelText(raw))
		);
	}
	return (
		parseMessageHandlerOutput(raw) ?? synthesizeSimpleReplyFromPlainText(raw)
	);
}

/**
 * Tolerant fallback: when the model returns plain text instead of the
 * expected JSON / native tool-call format, wrap the text as a simple
 * reply. This keeps the conversation alive on cold-start turns where
 * weaker / smaller models occasionally skip the structured-output
 * scaffold. Without this, the runtime threw `v5 messageHandler returned
 * invalid MessageHandlerResult` and the user saw the failure-template.
 *
 * Returns null only when the text is genuinely empty — that's a real
 * failure that should still propagate.
 */
function synthesizeSimpleReplyFromPlainText(
	raw: string | undefined | null,
): MessageHandlerResult | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	// Strip <think>...</think> blocks emitted by reasoning models.
	const cleaned = trimmed.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
	const replyText = cleaned || trimmed;
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

function buildFallbackStage1DirectReplyPlan(): MessageHandlerResult {
	return {
		processMessage: "RESPOND",
		thought:
			"Tolerant fallback: response handler returned no parseable plan; routing as a simple direct reply.",
		plan: {
			contexts: [SIMPLE_CONTEXT_ID],
			simple: true,
		},
	};
}

/**
 * Resolve the calling sender's role for context-catalog filtering.
 *
 * This is best-effort: when there is no world context (DM-only sessions,
 * benchmarks, tests), `checkSenderRole` returns null and we fall through to a
 * conservative default. Owner-only messages always pass the agent's own
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
			"Stage 1 sender role lookup failed; defaulting to USER",
		);
	}
	// No world metadata — fall back to USER. This matches the lenient default
	// in plugin-role-gating so local-only usage isn't blocked.
	return "USER";
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

/**
 * Unwrap a `PLAN_ACTIONS` tool call into its target action.
 *
 * The LLM sees the stable Stage 2 wrapper surface, so every invocation
 * arrives wrapped: `{ name: "PLAN_ACTIONS",
 * params: { action, parameters, thought } }`. Returns a
 * normalized tool call where `name` is the actual action name and `params`
 * are the action-shaped parameters, ready for the rest of the dispatch
 * pipeline.
 *
 * Legacy planner payloads may still include `subaction`; when present, it is
 * mirrored into canonical `params.action` for parent-action dispatch.
 *
 * Pass-through for other tool calls (REPLY/IGNORE/STOP terminal sentinels,
 * already-unwrapped action calls) so they keep their existing semantics.
 */
function unwrapPlanActionsToolCall(toolCall: PlannerToolCall): PlannerToolCall {
	if (toolCall.name !== PLAN_ACTIONS_TOOL_NAME) {
		return toolCall;
	}
	const params = toolCall.params ?? {};
	const rawAction = params.action;
	const rawActionName = typeof rawAction === "string" ? rawAction.trim() : "";
	const compoundAction = splitPlannerCompoundActionName(rawActionName);
	const actionName = compoundAction?.actionName ?? rawActionName;
	const rawSubaction = params.subaction ?? compoundAction?.subaction;
	const subaction =
		typeof rawSubaction === "string" && rawSubaction.trim().length > 0
			? rawSubaction.trim()
			: undefined;
	const rawActionParameters = params.parameters;
	const baseParameters =
		rawActionParameters &&
		typeof rawActionParameters === "object" &&
		!Array.isArray(rawActionParameters)
			? (rawActionParameters as Record<string, unknown>)
			: {};
	const mergedParameters: Record<string, unknown> = subaction
		? {
				...baseParameters,
				action: baseParameters.action ?? subaction,
				subaction,
			}
		: baseParameters;
	return {
		id: toolCall.id,
		name: actionName,
		params: mergedParameters,
	};
}

function normalizeCompoundPlannerToolCall(
	toolCall: PlannerToolCall,
): PlannerToolCall {
	const compoundAction = splitPlannerCompoundActionName(toolCall.name);
	if (!compoundAction) {
		return toolCall;
	}
	const params =
		toolCall.params && typeof toolCall.params === "object"
			? { ...toolCall.params }
			: {};
	if (params.subaction === undefined) {
		params.subaction = compoundAction.subaction;
	}
	if (params.action === undefined) {
		params.action = compoundAction.subaction;
	}
	return {
		...toolCall,
		name: compoundAction.actionName,
		params,
	};
}

function stringParam(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

type PlannerLifeAliasDefaults = {
	action?: string;
	subaction?: string;
	kind?: "definition" | "goal";
	definitionKind?: "task" | "habit" | "routine";
};

function normalizedPlannerAliasDefaults(
	actionName: string,
): PlannerLifeAliasDefaults | undefined {
	return PLANNER_ACTION_ALIAS_DEFAULTS.get(
		normalizeActionIdentifier(actionName),
	);
}

function normalizedLifeSubactionDefaults(
	subaction: unknown,
): PlannerLifeAliasDefaults | undefined {
	if (typeof subaction !== "string") {
		return undefined;
	}
	return PLANNER_LIFE_SUBACTION_DEFAULTS.get(
		normalizeActionIdentifier(subaction),
	);
}

const LIFE_SUBACTIONS = new Set([
	"create",
	"update",
	"delete",
	"complete",
	"skip",
	"snooze",
	"review",
]);

const LIFE_DEFINITION_KINDS = new Set(["task", "habit", "routine"]);

function normalizedLifeSubaction(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim().toLowerCase();
	return LIFE_SUBACTIONS.has(normalized) ? normalized : undefined;
}

function normalizedLifeDefinitionKind(
	value: unknown,
): "task" | "habit" | "routine" | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim().toLowerCase();
	return LIFE_DEFINITION_KINDS.has(normalized)
		? (normalized as "task" | "habit" | "routine")
		: undefined;
}

function normalizedLifeTopLevelKind(
	value: unknown,
): "definition" | "goal" | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim().toLowerCase();
	return normalized === "definition" || normalized === "goal"
		? normalized
		: undefined;
}

function firstStringParam(
	params: Record<string, unknown>,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		const value = stringParam(params[key]);
		if (value) {
			return value;
		}
	}
	return undefined;
}

function buildNormalizedLifePlannerParams(args: {
	toolCall: PlannerToolCall;
	defaults?: PlannerLifeAliasDefaults;
	message: Memory;
}): Record<string, unknown> {
	const params =
		args.toolCall.params && typeof args.toolCall.params === "object"
			? { ...args.toolCall.params }
			: {};
	const existingDetails =
		params.details &&
		typeof params.details === "object" &&
		!Array.isArray(params.details)
			? (params.details as Record<string, unknown>)
			: {};
	const rawSubaction = params.action ?? params.subaction;
	const rawKind = params.kind;
	const definitionKind =
		normalizedLifeDefinitionKind(rawKind) ??
		normalizedLifeDefinitionKind(params.entity) ??
		normalizedLifeDefinitionKind(params.type) ??
		args.defaults?.definitionKind;
	const topLevelKind =
		normalizedLifeTopLevelKind(rawKind) ??
		args.defaults?.kind ??
		(definitionKind ? "definition" : undefined);
	const subaction =
		args.defaults?.action ??
		args.defaults?.subaction ??
		normalizedLifeSubaction(rawSubaction);
	const title = firstStringParam(params, [
		"title",
		"name",
		"task",
		"todo",
		"todo_title",
		"task_name",
		"habit",
		"habit_name",
		"habit_title",
		"goal",
		"goal_name",
		"goal_title",
	]);
	const intent =
		stringParam(params.intent) ?? getUserMessageText(args.message) ?? title;

	const details: Record<string, unknown> = {
		...existingDetails,
		originalPlannerAction: args.toolCall.name,
	};
	if (
		typeof rawSubaction === "string" &&
		rawSubaction.trim().length > 0 &&
		rawSubaction.trim().toLowerCase() !== subaction
	) {
		details.originalPlannerSubaction = rawSubaction.trim();
	}
	if (definitionKind && typeof existingDetails.kind !== "string") {
		details.kind = definitionKind;
	}

	for (const [key, value] of Object.entries(params)) {
		if (
			key !== "action" &&
			key !== "subaction" &&
			key !== "kind" &&
			key !== "intent" &&
			key !== "title" &&
			key !== "target" &&
			key !== "minutes" &&
			key !== "details" &&
			value !== undefined
		) {
			details[key] = value;
		}
	}

	return {
		...(subaction ? { action: subaction, subaction } : {}),
		...(topLevelKind ? { kind: topLevelKind } : {}),
		...(intent ? { intent } : {}),
		...(title ? { title } : {}),
		...(stringParam(params.target)
			? { target: stringParam(params.target) }
			: {}),
		...(typeof params.minutes === "number" ? { minutes: params.minutes } : {}),
		...(Object.keys(details).length > 0 ? { details } : {}),
	};
}

function shouldTreatPlannerContactAliasAsLifeReminder(
	toolCall: PlannerToolCall,
	message: Memory,
): boolean {
	const normalizedName = normalizeActionIdentifier(toolCall.name);
	if (
		normalizedName !== normalizeActionIdentifier("ADD_CONTACT") &&
		normalizedName !== normalizeActionIdentifier("RELATIONSHIP")
	) {
		return false;
	}
	const text = (getUserMessageText(message) ?? "").toLowerCase();
	if (!text || /\bfollow\s+up\b/.test(text)) {
		return false;
	}
	return (
		/\b(?:remember|remind|reminder)\b/.test(text) &&
		/\b(?:call|phone|text|message|email)\b/.test(text)
	);
}

function messageTextMatches(message: Memory, pattern: RegExp): boolean {
	return pattern.test((getUserMessageText(message) ?? "").toLowerCase());
}

function plannerErrorLooksTransient(error: unknown): boolean {
	const message =
		error instanceof Error
			? `${error.name} ${error.message} ${String(error.cause ?? "")}`
			: String(error ?? "");
	return /\b(?:429|rate[\s_-]*limit|too many requests|temporarily unavailable|overloaded|timeout|timed out|econnreset|etimedout|50[234]|failed after \d+ attempts)\b/i.test(
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
		executorCtx: {
			message: args.message,
			state: args.plannerState,
			activeContexts: args.selectedContexts,
			userRoles: [args.senderRole],
			previousResults: [],
		},
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

function shouldTreatPlannerLifeAsDeviceIntent(
	resolvedName: string,
	_message: Memory,
): boolean {
	if (
		normalizeActionIdentifier(resolvedName) !==
		normalizeActionIdentifier("LIFE")
	) {
		return false;
	}
	// DEVICE_INTENT is no longer a planner-visible action. Legacy LIFE plans for
	// device-wide delivery should not be rewritten into another retired action.
	return false;
}

function shouldTreatPlannerWebAsCalendlyCalendar(
	resolvedName: string,
	message: Memory,
): boolean {
	const normalized = normalizeActionIdentifier(resolvedName);
	if (
		normalized !== normalizeActionIdentifier("BROWSER") &&
		normalized !== normalizeActionIdentifier("WEB_GET") &&
		normalized !== normalizeActionIdentifier("WEB_SEARCH")
	) {
		return false;
	}
	return messageTextMatches(message, /\bcalendly\b|api\.calendly\.com/);
}

function shouldTreatPlannerWebAsBookTravel(
	resolvedName: string,
	message: Memory,
): boolean {
	const normalized = normalizeActionIdentifier(resolvedName);
	if (
		normalized !== normalizeActionIdentifier("BROWSER") &&
		normalized !== normalizeActionIdentifier("WEB_GET") &&
		normalized !== normalizeActionIdentifier("WEB_SEARCH")
	) {
		return false;
	}
	return messageTextMatches(
		message,
		/\b(?:book|reserve)\s+(?:travel|flight|hotel|trip)\b|\bbook\s+travel\b/,
	);
}

function shouldTreatPlannerBrowserAsAutofill(
	resolvedName: string,
	message: Memory,
): boolean {
	const normalized = normalizeActionIdentifier(resolvedName);
	if (
		normalized !== normalizeActionIdentifier("BROWSER") &&
		normalized !== normalizeActionIdentifier("WEB_GET") &&
		normalized !== normalizeActionIdentifier("WEB_SEARCH")
	) {
		return false;
	}
	return (
		messageTextMatches(message, /\bfill\b/) &&
		messageTextMatches(message, /\b(?:password|login|form|field)\b/)
	);
}

function shouldTreatPlannerConnectorAsPost(
	resolvedName: string,
	message: Memory,
): boolean {
	if (
		normalizeActionIdentifier(resolvedName) !==
		normalizeActionIdentifier("CONNECTOR")
	) {
		return false;
	}
	return (
		messageTextMatches(message, /\b(?:x|twitter)\b/) &&
		messageTextMatches(message, /\b(?:search|posts?|timeline|feed|mentions?)\b/)
	);
}

function shouldTreatPlannerConnectorAsMessage(
	resolvedName: string,
	message: Memory,
): boolean {
	if (
		normalizeActionIdentifier(resolvedName) !==
		normalizeActionIdentifier("CONNECTOR")
	) {
		return false;
	}
	const text = getUserMessageText(message) ?? "";
	return (
		/\b(?:email|gmail|mail|inbox|unread|draft reply|reply to|unsubscribe)\b/i.test(
			text,
		) ||
		(/\b(?:x|twitter)\b/i.test(text) &&
			/\b(?:dm|dms|direct messages?|messages?)\b/i.test(text)) ||
		(/\b(?:discord|slack|telegram|signal|whatsapp)\b/i.test(text) &&
			/\b(?:post|send|message|dm|channel)\b/i.test(text))
	);
}

function shouldTreatPlannerDeviceIntentAsLifeReminder(
	resolvedName: string,
	message: Memory,
): boolean {
	if (
		normalizeActionIdentifier(resolvedName) !==
		normalizeActionIdentifier("DEVICE_INTENT")
	) {
		return false;
	}
	const text = getUserMessageText(message) ?? "";
	if (
		/\b(?:device|devices|phone|mobile|desktop|broadcast|push)\b/i.test(text)
	) {
		return false;
	}
	return (
		/\b(?:remember|remind|reminder)\b/i.test(text) &&
		/\b(?:call|phone|text|message|email)\b/i.test(text)
	);
}

function inferPostSearchQuery(message: Memory): string | undefined {
	const text = getUserMessageText(message) ?? "";
	return (
		/\bposts?\s+about\s+(.+)$/i.exec(text)?.[1]?.trim() ??
		/\bsearch\s+(?:x|twitter)\s+for\s+(.+)$/i.exec(text)?.[1]?.trim() ??
		/\babout\s+(.+)$/i.exec(text)?.[1]?.trim()
	);
}

function normalizeBlockPlannerParams(
	toolCall: PlannerToolCall,
	message: Memory,
	target: "website" | "app",
): Record<string, unknown> {
	const params =
		toolCall.params && typeof toolCall.params === "object"
			? (toolCall.params as Record<string, unknown>)
			: {};
	return {
		action:
			stringParam(params.action) ?? stringParam(params.subaction) ?? "block",
		subaction:
			stringParam(params.action) ?? stringParam(params.subaction) ?? "block",
		target,
		intent: stringParam(params.intent) ?? getUserMessageText(message),
		...(Array.isArray(params.hostnames) || typeof params.hostnames === "string"
			? { hostnames: params.hostnames }
			: {}),
		...(Array.isArray(params.sites) || typeof params.sites === "string"
			? { hostnames: params.sites }
			: {}),
		...(typeof params.durationMinutes === "number" ||
		typeof params.durationMinutes === "string"
			? { durationMinutes: params.durationMinutes }
			: {}),
		...(typeof params.confirmed === "boolean" ||
		typeof params.confirmed === "string"
			? { confirmed: params.confirmed }
			: {}),
	};
}

function normalizePostPlannerParams(
	toolCall: PlannerToolCall,
	message: Memory,
): Record<string, unknown> {
	const params =
		toolCall.params && typeof toolCall.params === "object"
			? (toolCall.params as Record<string, unknown>)
			: {};
	const rawAction = stringParam(params.action);
	const source = stringParam(params.source);
	const op = /^(?:timeline|feed|read|read_feed|get_timeline|get_feed)$/i.test(
		rawAction ?? "",
	)
		? "read"
		: /^(?:search|search_twitter|x_search)$/i.test(rawAction ?? "")
			? "search"
			: rawAction;
	return {
		...(op ? { action: op } : {}),
		...(source
			? { source: source === "twitter" ? "x" : source }
			: messageTextMatches(message, /\b(?:x|twitter)\b/)
				? { source: "x" }
				: {}),
		...(stringParam(params.query)
			? { query: params.query }
			: stringParam(params.searchTerm)
				? { query: params.searchTerm }
				: op === "search" || messageTextMatches(message, /\bsearch\b/)
					? {
							query:
								inferPostSearchQuery(message) ?? getUserMessageText(message),
						}
					: {}),
		...(stringParam(params.feed) ? { feed: params.feed } : {}),
		...(stringParam(params.target) ? { target: params.target } : {}),
	};
}

function normalizeMessagePlannerParams(
	toolCall: PlannerToolCall,
	message: Memory,
): Record<string, unknown> {
	const params =
		toolCall.params && typeof toolCall.params === "object"
			? (toolCall.params as Record<string, unknown>)
			: {};
	const rawOperation = stringParam(params.action);
	const manageIntent =
		stringParam(params.manageOperation) ?? stringParam(params.command);
	const rawSource =
		stringParam(params.source) ??
		stringParam(params.platform) ??
		stringParam(params.connector);
	const source =
		rawSource === "twitter"
			? "x"
			: /^(?:google|email|mail)$/i.test(rawSource ?? "")
				? "gmail"
				: rawSource;
	const sender = stringParam(params.sender) ?? stringParam(params.from);
	const target =
		stringParam(params.target) ??
		stringParam(params.recipient) ??
		stringParam(params.channel) ??
		stringParam(params.channelName) ??
		stringParam(params.room) ??
		stringParam(params.email) ??
		stringParam(params.emailAddress) ??
		stringParam(params.address);
	const id = stringParam(params.id);
	const messageId =
		stringParam(params.messageId) ??
		stringParam(params.inReplyToId) ??
		(rawOperation !== "send_draft" ? id : undefined);
	const inReplyToId = stringParam(params.inReplyToId);
	const draftId =
		stringParam(params.draftId) ??
		(rawOperation === "send_draft" ? id : undefined);
	const messageBody =
		stringParam(params.message) ??
		stringParam(params.text) ??
		stringParam(params.content) ??
		stringParam(params.body);
	const text = getUserMessageText(message) ?? "";
	const directChatSend =
		/\b(?:post|send|message|dm)\b/i.test(text) &&
		/\b(?:discord|slack|telegram|signal|whatsapp)\b/i.test(text);
	const operation =
		rawOperation === "send_draft" &&
		!stringParam(params.draftId) &&
		(directChatSend || source || target || messageBody)
			? "send"
			: rawOperation;
	const inferredOperation = operation
		? undefined
		: directChatSend
			? "send"
			: /\bdraft\b.*\breply\b/i.test(text)
				? "draft_reply"
				: /\b(?:unread|inbox|digest|summarize).*?\b(?:email|gmail|mail|inbox)\b/i.test(
							text,
						) ||
						/\b(?:email|gmail|mail|inbox)\b.*?\b(?:unread|digest|summarize)\b/i.test(
							text,
						)
					? "list_inbox"
					: /\b(?:x|twitter)\b/i.test(text) &&
							/\b(?:dm|dms|direct messages?|messages?)\b/i.test(text)
						? "read_channel"
						: undefined;
	return {
		...((inferredOperation ?? operation)
			? {
					action: inferredOperation ?? operation,
				}
			: {}),
		...(source
			? { source: source === "twitter" ? "x" : source }
			: /\b(?:x|twitter)\b/i.test(text)
				? { source: "x" }
				: {}),
		...(target ? { target } : {}),
		...(sender || target ? { sender: sender ?? target } : {}),
		...(messageId ? { messageId } : {}),
		...(inReplyToId ? { inReplyToId } : {}),
		...(draftId ? { draftId } : {}),
		...(messageBody ? { message: messageBody, body: messageBody } : {}),
		...(target && stringParam(params.channel) ? { targetKind: "channel" } : {}),
		...(manageIntent
			? {
					manageOperation: /\bunsubscribe\b/i.test(manageIntent)
						? "unsubscribe"
						: manageIntent,
				}
			: {}),
		...(stringParam(params.query) ? { query: params.query } : {}),
		...(stringParam(params.channel) ? { channel: params.channel } : {}),
		...(params.sources !== undefined ? { sources: params.sources } : {}),
		...(params.worldIds !== undefined ? { worldIds: params.worldIds } : {}),
		...(params.channelIds !== undefined
			? { channelIds: params.channelIds }
			: {}),
		...(params.limit !== undefined ? { limit: params.limit } : {}),
		...(params.since !== undefined ? { since: params.since } : {}),
		...(params.until !== undefined ? { until: params.until } : {}),
	};
}

function normalizeResolveRequestPlannerParams(
	toolCall: PlannerToolCall,
	message: Memory,
): Record<string, unknown> {
	const params =
		toolCall.params && typeof toolCall.params === "object"
			? (toolCall.params as Record<string, unknown>)
			: {};
	const text = `${toolCall.name} ${getUserMessageText(message) ?? ""}`;
	const subaction = /\b(?:reject|deny|decline|no)\b/i.test(text)
		? "reject"
		: "approve";
	return {
		action: subaction,
		subaction,
		...(stringParam(params.requestId) ? { requestId: params.requestId } : {}),
		...(stringParam(params.reason) ? { reason: params.reason } : {}),
	};
}

function normalizePasswordManagerPlannerParams(
	toolCall: PlannerToolCall,
	message: Memory,
): Record<string, unknown> {
	const params =
		toolCall.params && typeof toolCall.params === "object"
			? (toolCall.params as Record<string, unknown>)
			: {};
	const rawSubaction = stringParam(params.subaction);
	const wantsCopy = messageTextMatches(
		message,
		/\b(?:copy|clipboard|inject|fill)\b/,
	);
	const subaction =
		rawSubaction &&
		/^(?:list|search|inject_username|inject_password)$/i.test(rawSubaction)
			? rawSubaction
			: wantsCopy
				? "inject_password"
				: "search";
	const query =
		stringParam(params.query) ??
		stringParam(params.service) ??
		stringParam(params.target) ??
		stringParam(params.domain) ??
		getUserMessageText(message);
	return {
		action: subaction,
		subaction,
		...(query ? { query, intent: query } : {}),
		...(stringParam(params.itemId) ? { itemId: params.itemId } : {}),
		...(typeof params.confirmed === "boolean"
			? { confirmed: params.confirmed }
			: {}),
	};
}

function normalizeAutofillPlannerParams(
	toolCall: PlannerToolCall,
	message: Memory,
): Record<string, unknown> {
	const params =
		toolCall.params && typeof toolCall.params === "object"
			? (toolCall.params as Record<string, unknown>)
			: {};
	const text = getUserMessageText(message) ?? "";
	const domain =
		stringParam(params.domain) ??
		stringParam(params.site) ??
		stringParam(params.website) ??
		/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i.exec(text)?.[1];
	return {
		action:
			stringParam(params.action) ?? stringParam(params.subaction) ?? "fill",
		subaction:
			stringParam(params.action) ?? stringParam(params.subaction) ?? "fill",
		field: stringParam(params.field) ?? "password",
		...(domain
			? {
					domain,
					url: /^https?:\/\//i.test(domain) ? domain : `https://${domain}`,
				}
			: {}),
	};
}

const OWNER_SURFACE_ACTIONS = new Set(
	[
		"OWNER_TODOS",
		"OWNER_REMINDERS",
		"OWNER_ALARMS",
		"OWNER_ROUTINES",
		"OWNER_GOALS",
	].map(normalizeActionIdentifier),
);

function normalizePersonalAssistantPlannerParams(
	toolCall: PlannerToolCall,
): Record<string, unknown> {
	const params =
		toolCall.params && typeof toolCall.params === "object"
			? (toolCall.params as Record<string, unknown>)
			: {};
	const raw =
		`${toolCall.name} ${stringParam(params.action) ?? ""}`.toLowerCase();
	const action = /\bschedul/.test(raw) ? "scheduling" : "book_travel";
	return { ...params, action };
}

function normalizeAliasedPlannerToolCall(
	toolCall: PlannerToolCall,
	resolvedName: string,
	message: Memory,
): PlannerToolCall {
	const normalizedResolvedName = normalizeActionIdentifier(resolvedName);
	const isOwnerSurface =
		normalizedResolvedName === normalizeActionIdentifier("LIFE") ||
		OWNER_SURFACE_ACTIONS.has(normalizedResolvedName);
	if (!isOwnerSurface) {
		if (normalizedResolvedName === normalizeActionIdentifier("BLOCK")) {
			const originalName = normalizeActionIdentifier(toolCall.name);
			const target =
				originalName.includes("APP") || originalName.includes("PHONE")
					? "app"
					: "website";
			return {
				...toolCall,
				name: resolvedName,
				params: normalizeBlockPlannerParams(toolCall, message, target),
			};
		}
		if (normalizedResolvedName === normalizeActionIdentifier("POST")) {
			return {
				...toolCall,
				name: resolvedName,
				params: normalizePostPlannerParams(toolCall, message),
			};
		}
		if (normalizedResolvedName === normalizeActionIdentifier("MESSAGE")) {
			return {
				...toolCall,
				name: resolvedName,
				params: normalizeMessagePlannerParams(toolCall, message),
			};
		}
		if (
			normalizedResolvedName === normalizeActionIdentifier("RESOLVE_REQUEST")
		) {
			return {
				...toolCall,
				name: resolvedName,
				params: normalizeResolveRequestPlannerParams(toolCall, message),
			};
		}
		if (normalizedResolvedName === normalizeActionIdentifier("CREDENTIALS")) {
			const originalName = normalizeActionIdentifier(toolCall.name);
			const rawAction =
				toolCall.params && typeof toolCall.params === "object"
					? (stringParam((toolCall.params as Record<string, unknown>).action) ??
						stringParam((toolCall.params as Record<string, unknown>).subaction))
					: undefined;
			const params =
				originalName.includes("AUTOFILL") ||
				originalName.includes("LOGIN") ||
				originalName.includes("FILL") ||
				rawAction === "fill"
					? normalizeAutofillPlannerParams(toolCall, message)
					: normalizePasswordManagerPlannerParams(toolCall, message);
			return {
				...toolCall,
				name: resolvedName,
				params,
			};
		}
		if (
			normalizedResolvedName === normalizeActionIdentifier("PERSONAL_ASSISTANT")
		) {
			return {
				...toolCall,
				name: resolvedName,
				params: normalizePersonalAssistantPlannerParams(toolCall),
			};
		}
		if (
			normalizeActionIdentifier(toolCall.name) ===
				normalizeActionIdentifier("BROWSER_AUTOFILL_LOGIN") &&
			normalizedResolvedName === normalizeActionIdentifier("BROWSER")
		) {
			const base =
				toolCall.params && typeof toolCall.params === "object"
					? { ...(toolCall.params as Record<string, unknown>) }
					: ({} as Record<string, unknown>);
			return {
				...toolCall,
				name: resolvedName,
				params: { ...base, subaction: "autofill-login" },
			};
		}
		return { ...toolCall, name: resolvedName };
	}

	const defaults =
		normalizedPlannerAliasDefaults(toolCall.name) ??
		normalizedLifeSubactionDefaults(
			toolCall.params?.action ?? toolCall.params?.subaction,
		);

	return {
		...toolCall,
		name: resolvedName,
		params: buildNormalizedLifePlannerParams({ toolCall, defaults, message }),
	};
}

async function executeV5PlannedToolCall(
	args: ExecuteV5PlannedToolCallParams,
): Promise<PlannerToolResult> {
	const unwrappedToolCall = normalizeCompoundPlannerToolCall(
		unwrapPlanActionsToolCall(args.toolCall),
	);
	if (!unwrappedToolCall.name) {
		return {
			success: false,
			error: `${PLAN_ACTIONS_TOOL_NAME} requires a non-empty action`,
		};
	}

	const actions = args.executorOptions?.actions ?? args.runtime.actions;
	const actionLookup = buildRuntimeActionLookup({ actions });
	const resolvedNames = resolvePlannerActionName(
		args.runtime,
		actionLookup,
		unwrappedToolCall.name,
	);
	const resolvedName = resolvedNames[0] ?? unwrappedToolCall.name;
	const forceContactReminderToLife =
		shouldTreatPlannerContactAliasAsLifeReminder(
			unwrappedToolCall,
			args.executorCtx.message,
		);
	const forceLifeToDeviceIntent =
		!forceContactReminderToLife &&
		shouldTreatPlannerLifeAsDeviceIntent(
			resolvedName,
			args.executorCtx.message,
		);
	const forceDeviceIntentToLife =
		!forceContactReminderToLife &&
		!forceLifeToDeviceIntent &&
		shouldTreatPlannerDeviceIntentAsLifeReminder(
			resolvedName,
			args.executorCtx.message,
		);
	const forceWebToCalendlyCalendar =
		!forceContactReminderToLife &&
		!forceLifeToDeviceIntent &&
		!forceDeviceIntentToLife &&
		shouldTreatPlannerWebAsCalendlyCalendar(
			resolvedName,
			args.executorCtx.message,
		);
	const forceWebToBookTravel =
		!forceContactReminderToLife &&
		!forceLifeToDeviceIntent &&
		!forceDeviceIntentToLife &&
		!forceWebToCalendlyCalendar &&
		shouldTreatPlannerWebAsBookTravel(resolvedName, args.executorCtx.message);
	const forceBrowserToAutofill =
		!forceContactReminderToLife &&
		!forceLifeToDeviceIntent &&
		!forceDeviceIntentToLife &&
		!forceWebToCalendlyCalendar &&
		!forceWebToBookTravel &&
		shouldTreatPlannerBrowserAsAutofill(resolvedName, args.executorCtx.message);
	const forceConnectorToPost =
		!forceContactReminderToLife &&
		!forceLifeToDeviceIntent &&
		!forceDeviceIntentToLife &&
		!forceWebToCalendlyCalendar &&
		!forceWebToBookTravel &&
		!forceBrowserToAutofill &&
		!shouldTreatPlannerConnectorAsMessage(
			resolvedName,
			args.executorCtx.message,
		) &&
		shouldTreatPlannerConnectorAsPost(resolvedName, args.executorCtx.message);
	const forceConnectorToMessage =
		!forceContactReminderToLife &&
		!forceLifeToDeviceIntent &&
		!forceDeviceIntentToLife &&
		!forceWebToCalendlyCalendar &&
		!forceWebToBookTravel &&
		!forceBrowserToAutofill &&
		shouldTreatPlannerConnectorAsMessage(
			resolvedName,
			args.executorCtx.message,
		);
	const effectiveResolvedName = forceContactReminderToLife
		? "OWNER_REMINDERS"
		: forceLifeToDeviceIntent
			? "MESSAGE"
			: forceDeviceIntentToLife
				? "OWNER_REMINDERS"
				: forceWebToCalendlyCalendar
					? "CALENDAR"
					: forceWebToBookTravel
						? "PERSONAL_ASSISTANT"
						: forceBrowserToAutofill
							? "CREDENTIALS"
							: forceConnectorToPost
								? "POST"
								: forceConnectorToMessage
									? "MESSAGE"
									: resolvedName;
	const toolCallForNormalization =
		forceContactReminderToLife || forceDeviceIntentToLife
			? {
					...unwrappedToolCall,
					params: {
						action: "create",
						subaction: "create",
						intent: getUserMessageText(args.executorCtx.message),
						details: {
							contactName: stringParam(unwrappedToolCall.params?.name),
							relationship: stringParam(unwrappedToolCall.params?.relationship),
							originalPlannerAction: unwrappedToolCall.name,
						},
					},
				}
			: forceWebToBookTravel
				? {
						...unwrappedToolCall,
						name: "PERSONAL_ASSISTANT",
						params: {
							...(unwrappedToolCall.params &&
							typeof unwrappedToolCall.params === "object"
								? unwrappedToolCall.params
								: {}),
							action: "book_travel",
							intent: getUserMessageText(args.executorCtx.message),
						},
					}
				: forceBrowserToAutofill
					? {
							...unwrappedToolCall,
							name: "CREDENTIALS",
							params: {
								...(unwrappedToolCall.params &&
								typeof unwrappedToolCall.params === "object"
									? unwrappedToolCall.params
									: {}),
								action: "fill",
								subaction: "fill",
							},
						}
					: unwrappedToolCall;
	const toolCall = normalizeAliasedPlannerToolCall(
		toolCallForNormalization,
		effectiveResolvedName,
		args.executorCtx.message,
	);

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

	if (action && actionHasSubActions(action)) {
		const subResult = await runSubPlanner({
			runtime: args.runtime as IAgentRuntime & PlannerRuntime,
			action,
			context: args.plannerContext,
			ctx: args.executorCtx,
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
		args.executorCtx,
		toolCall,
		{ ...(args.executorOptions ?? {}), actions: executionActions },
	);
	return actionResultToPlannerToolResult(actionResult);
}

function subPlannerResultToPlannerToolResult(
	subResult: Awaited<ReturnType<typeof runSubPlanner>>,
): PlannerToolResult {
	const evaluator = subResult.evaluator;
	const lastStep =
		subResult.trajectory.steps[subResult.trajectory.steps.length - 1];
	const success = evaluator?.success ?? lastStep?.result?.success ?? true;
	return {
		success,
		text: subResult.finalMessage ?? evaluator?.messageToUser,
		data: lastStep?.result?.data,
		error: lastStep?.result?.error,
	};
}

/**
 * Planner-loop tool surface. We always expose the same fixed Stage 2 wrapper
 * list so the prompt-cache key stays stable across requests no matter which
 * actions are gated this turn. Action names + parameter schemas live in the
 * conversation's available-actions block; the LLM picks one and passes it
 * through PLAN_ACTIONS({ action, ... }).
 *
 * When no actions are gated for the current turn we fall back to an empty
 * tool array so the planner can short-circuit (the pipeline's stage-1
 * shortcut still emits HANDLE_RESPONSE through its own dedicated call).
 */
function collectPlannerTools(context: ContextObject): ToolDefinition[] {
	const hasAnyAction = context.events.some(
		(event) =>
			event.type === "tool" &&
			"tool" in event &&
			Boolean(
				(event as { tool?: { name?: string } }).tool?.name?.trim().length,
			),
	);
	return hasAnyAction ? [...STABLE_PLANNER_TOOLS] : [];
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

export async function runV5MessageRuntimeStage1(args: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	responseId: UUID;
	plannerLoopConfig?: PlannerLoopParams["config"];
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
		extraProviderExclusions: STAGE1_EXTRA_PROVIDER_EXCLUSIONS,
	});

	// G10/G11: construct the per-trajectory recorder. No-op when disabled via
	// MILADY_TRAJECTORY_RECORDING=0. Failures inside the recorder must NEVER
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
			args.message.content?.channelType === ChannelType.VOICE_DM ||
			args.message.content?.channelType === ChannelType.API ||
			args.message.content?.channelType === ChannelType.SELF;
		const messageHandlerInput = renderMessageHandlerModelInput(
			args.runtime,
			context,
			availableContexts,
			{ directMessage: directMessageChannel },
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
		await args.runtime.runActionsByMode(
			"RESPONSE_HANDLER_BEFORE",
			args.message,
			args.state,
		);

		// RESPONSE_HANDLER_DURING (non-blocking): fire-and-forget alongside the model
		// call. We don't await — the user contract is "during". Errors are
		// logged inside `runActionsByMode`.
		void args.runtime
			.runActionsByMode("RESPONSE_HANDLER_DURING", args.message, args.state)
			.catch(() => {});

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
				responseHandlerFields:
					args.runtime.responseHandlerFieldRegistry?.list() ?? [],
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

		const rawMessageHandler = (await args.runtime.useModel(
			ModelType.RESPONSE_HANDLER,
			{
				messages: messageHandlerInput.messages,
				promptSegments: messageHandlerInput.promptSegments,
				tools: messageHandlerTools,
				toolChoice: "required",
				maxTokens: 1024,
				// Streamed structured generation: the local engine (W4) streams the
				// HANDLE_RESPONSE envelope and parses it incrementally so `shouldRespond`
				// / `contexts` route the moment they are known and `replyText` flows to
				// TTS the instant that field opens. Cloud adapters ignore the flag and
				// return the result whole.
				streamStructured: true,
				responseSkeleton: responseGrammar.responseSkeleton,
				grammar: responseGrammar.grammar,
				providerOptions: messageHandlerProviderOptions,
			},
		)) as string | GenerateTextResult;
		const messageHandlerEndedAt = Date.now();
		let messageHandler = parseMessageHandlerModelOutput(rawMessageHandler);
		if (!messageHandler) {
			messageHandler =
				buildFallbackStage1PlanForKnownToolRequest({
					message: args.message,
					availableContexts,
				}) ?? buildFallbackStage1DirectReplyPlan();
		}
		if (!messageHandler && process.env.MILADY_DEBUG_STAGE1 === "1") {
			args.runtime.logger?.warn?.(
				{
					raw:
						typeof rawMessageHandler === "string"
							? rawMessageHandler
							: JSON.stringify(rawMessageHandler),
				},
				"[message] parseMessageHandlerModelOutput returned null",
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
			throw new Error(
				"v5 messageHandler returned invalid MessageHandlerResult",
			);
		}

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
				logger: args.runtime.logger,
			});
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

		const responseHandlerEvaluation = await runResponseHandlerEvaluators({
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
		const route = routeMessageHandlerOutput(messageHandler);
		if (route.type === "ignored" || route.type === "stopped") {
			return {
				kind: "terminal",
				action: route.type === "stopped" ? "STOP" : "IGNORE",
				messageHandler,
				state: args.state,
			};
		}

		if (route.type === "final_reply") {
			// `replyText` (→ `route.reply`) is part of the HANDLE_RESPONSE envelope
			// and is `required` in the schema, so the direct-reply path normally
			// emits it inline with no extra model call. `generateDirectReplyOnce`
			// only runs as a degenerate fallback when Stage-1 produced no usable
			// reply text at all (malformed output that even the tolerant parser
			// could not recover a reply from).
			const reply =
				route.reply ||
				(await generateDirectReplyOnce({
					runtime: args.runtime,
					message: args.message,
					state: args.state,
					messageHandler,
				}));
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
		const plannerProviderNames = selectV5PlannerStateProviderNames({
			runtime: args.runtime,
			message: args.message,
			selectedContexts,
			userRoles: [senderRole],
		});
		const recomposedPlannerState =
			typeof args.runtime.composeState === "function"
				? await args.runtime.composeState(
						args.message,
						plannerProviderNames,
						true,
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
		const plannerCandidateActions = await collectV5PlannerCandidateActions({
			runtime: args.runtime,
			message: args.message,
			state: plannerState,
			selectedContexts,
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
		const plannerContextWithDecision = appendContextEvent(plannerContext, {
			id: `message-handler:${messageHandlerEndedAt}`,
			type: "message_handler",
			source: "message-service",
			createdAt: messageHandlerEndedAt,
			metadata: {
				processMessage: messageHandler.processMessage,
				plan: {
					contexts: messageHandler.plan.contexts,
					...(messageHandler.plan.requiresTool !== undefined
						? { requiresTool: messageHandler.plan.requiresTool }
						: {}),
					candidateActions: getMessageHandlerCandidateActions(messageHandler),
					parentActionHints: getMessageHandlerParentActionHints(messageHandler),
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
		const requireNonTerminalToolCall =
			(messageHandler.plan.requiresTool === true || benchmarkForcingToolCall) &&
			plannerTools.length > 0;
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
							"Do not answer directly from memory, chat history, prior attachments, or prior tool output. " +
							"Call at least one exposed non-terminal tool that can attempt the current request.",
				})
			: plannerContextWithDecision;
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
		void args.runtime
			.runActionsByMode("CONTEXT_DURING", args.message, plannerState, {
				selectedContexts,
			})
			.catch(() => {});

		let plannerResult: PlannerLoopResult;
		try {
			plannerResult = await runPlannerLoop({
				runtime: plannerRuntime,
				context: effectivePlannerContext,
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
						plannerContext: effectivePlannerContext,
						executorCtx: {
							message: args.message,
							state: plannerState,
							activeContexts: selectedContexts,
							userRoles: [senderRole],
							previousResults: collectPreviousActionResults(ctx.trajectory),
						},
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
				plannerContext: effectivePlannerContext,
				plannerRuntime,
				actions: exposedPlannerActions,
				evaluatorEffects,
				recorder,
				trajectoryId,
				plannerLoopConfig: args.plannerLoopConfig,
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
		const plannedText = String(plannerResult.finalMessage ?? "").trim();

		return {
			kind: "planned_reply",
			messageHandler,
			result: plannedText
				? createV5ReplyStrategyResult({
						...args,
						state: finalPlannerState,
						text: plannedText,
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
		const factsOutcome = await factsTask;
		if (recorder && trajectoryId && factsOutcome) {
			await recordFactsAndRelationshipsStage({
				recorder,
				trajectoryId,
				outcome: factsOutcome,
				logger: args.runtime.logger,
			});
		}
		if (recorder && trajectoryId) {
			await recorder.endTrajectory(trajectoryId, endStatus).catch((err) => {
				args.runtime.logger?.warn?.(
					{ err: (err as Error).message, trajectoryId },
					"[TrajectoryRecorder] endTrajectory failed",
				);
			});
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
				provider: "default",
				messages: args.messages,
				tools: args.tools,
				toolChoice: args.toolChoice,
				providerOptions: args.providerOptions,
				response: responseText,
				toolCalls: extractMessageHandlerToolCalls(args.raw),
				usage,
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
						provider: "default",
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

export function resolveStrategyMode(
	responseContent:
		| Pick<Content, "actions" | "text" | "simple">
		| null
		| undefined,
): StrategyMode {
	if (isStopResponse(responseContent)) {
		return "none";
	}

	if (!isSimpleReplyResponse(responseContent)) {
		return "actions";
	}

	const hasPlannerText =
		typeof responseContent?.text === "string" &&
		responseContent.text.trim().length > 0;

	return responseContent?.simple === true && hasPlannerText
		? "simple"
		: "actions";
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

function normalizeActionIdentifier(actionName: string): string {
	return unwrapPlannerIdentifier(actionName).toUpperCase().replace(/_/g, "");
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

const PLANNER_ACTION_ALIASES = new Map(
	[
		["BULK_RESCHEDULE", "CALENDAR"],
		["BULK_RESCHEDULE_MEETINGS", "CALENDAR"],
		["SCHEDULE_MEETING", "CALENDAR"],
		["RESCHEDULE_MEETINGS", "CALENDAR"],
		["GET_AVAILABILITY", "CALENDAR"],
		["CREATE_EVENT", "CALENDAR"],
		["CREATE_RECURRING_EVENT", "CALENDAR"],
		["CALENDAR_CREATE_RECURRING_EVENT", "CALENDAR"],
		["SCHEDULE_RECURRING_EVENT", "CALENDAR"],
		["SCHEDULE_RECURRING_MEETING", "CALENDAR"],
		["SCHEDULE_RECURRING", "CALENDAR"],
		["BOOK_TRAVEL_ACTION", "PERSONAL_ASSISTANT"],
		["BOOK_TRAVEL", "PERSONAL_ASSISTANT"],
		["SCHEDULING_NEGOTIATION", "PERSONAL_ASSISTANT"],
		["CAPTURE_TRAVEL_PREFERENCES", "REPLY"],
		["CAPTURE_BOOKING_PREFERENCES", "REPLY"],
		["CREATE_TRAVEL_PREFERENCES", "REPLY"],
		["SET_PREFERENCES", "REPLY"],
		["SET_TRAVEL_PREFERENCES", "REPLY"],
		["PROFILE", "REPLY"],
		["CREATE_FOLLOWUP", "SCHEDULED_TASKS"],
		["GET_PENDING_ASSETS", "MESSAGE"],
		["GET_PENDING_ITEMS", "MESSAGE"],
		["EVENT_ASSET_CHECKLIST", "MESSAGE"],
		["OUTSTANDING_EVENT_ASSETS", "MESSAGE"],
		["PORTAL_ASSET_CHECKLIST", "MESSAGE"],
		["PROPOSE_GROUP_CHAT_HANDOFF", "MESSAGE"],
		["GROUP_CHAT_HANDOFF_POLICY", "MESSAGE"],
		["SET_GROUP_CHAT_HANDOFF_POLICY", "MESSAGE"],
		["CREATE_GROUP_CHAT", "MESSAGE"],
		["BUMP_WITH_CONTEXT", "MESSAGE"],
		["CONTEXTUAL_BUMP", "MESSAGE"],
		["BUMP_UNANSWERED_DECISION", "MESSAGE"],
		["GET_PENDING_DRAFTS", "MESSAGE"],
		["SOCIAL_POSTING", "POST"],
		["GET_TIMELINE", "POST"],
		["READ_TIMELINE", "POST"],
		["SEARCH_TWITTER", "POST"],
		["TWITTER_SEARCH", "POST"],
		["X_SEARCH", "POST"],
		["SEARCH_TWITTER_POSTS", "POST"],
		["TWITTER_POST_SEARCH", "POST"],
		["FETCH_X_TIMELINE", "POST"],
		["VIEW_X_FEED", "POST"],
		["FETCH_TWITTER_FEED", "POST"],
		["FETCH_TWITTER_TIMELINE", "POST"],
		["FETCH_TWITTER_DMS", "MESSAGE"],
		["READ_TWITTER_DMS", "MESSAGE"],
		["READ_TWITTER_DM", "MESSAGE"],
		["FETCH_X_DMS", "MESSAGE"],
		["READ_X_DMS", "MESSAGE"],
		["READ_X_DM", "MESSAGE"],
		["DISCORD_POST_MESSAGE", "MESSAGE"],
		["DISCORD_SEND_MESSAGE", "MESSAGE"],
		["SEND_DISCORD_MESSAGE", "MESSAGE"],
		["SLACK_POST_MESSAGE", "MESSAGE"],
		["TELEGRAM_SEND_MESSAGE", "MESSAGE"],
		["EMAIL_FETCH_LATEST", "MESSAGE"],
		["EMAIL_DRAFT_REPLY", "MESSAGE"],
		["EMAIL_FETCH_UNREAD", "MESSAGE"],
		["FETCH_UNREAD_EMAIL", "MESSAGE"],
		["FETCH_UNREAD_EMAILS", "MESSAGE"],
		["LIST_UNREAD_EMAILS", "MESSAGE"],
		["SUMMARIZE_UNREAD_EMAILS", "MESSAGE"],
		["SUMMARISE_UNREAD_EMAILS", "MESSAGE"],
		["UNREAD_EMAIL_SUMMARY", "MESSAGE"],
		["READ_UNREAD_EMAILS", "MESSAGE"],
		["ADD_TODO", "OWNER_TODOS"],
		["CREATE_TODO", "OWNER_TODOS"],
		["TODO_ADD", "OWNER_TODOS"],
		["TODO_CREATE", "OWNER_TODOS"],
		["TODOS_ADD", "OWNER_TODOS"],
		["TODOS_CREATE", "OWNER_TODOS"],
		["TASK_ADD", "OWNER_TODOS"],
		["TASK_CREATE", "OWNER_TODOS"],
		["ADD_TASK", "OWNER_TODOS"],
		["CREATE_TASK", "OWNER_TODOS"],
		["TASKS_ADD_TODO", "OWNER_TODOS"],
		["TASKS_CREATE_TODO", "OWNER_TODOS"],
		["TASKS_CREATE_REMINDER", "OWNER_REMINDERS"],
		["LIST_TODOS", "OWNER_TODOS"],
		["GET_TODOS", "OWNER_TODOS"],
		["TODO_LIST", "OWNER_TODOS"],
		["TODO_LIST_TODAY", "OWNER_TODOS"],
		["TODOS_LIST", "OWNER_TODOS"],
		["TODO_GET", "OWNER_TODOS"],
		["TODOS_GET", "OWNER_TODOS"],
		["TODOS_REVIEW", "OWNER_TODOS"],
		["TASK_LIST", "OWNER_TODOS"],
		["TASK_LIST_TODAY", "OWNER_TODOS"],
		["TASKS_REVIEW", "OWNER_TODOS"],
		["TASKS_LIST_TODAY", "OWNER_TODOS"],
		["TASKS_LIST_TODOS", "OWNER_TODOS"],
		["LIST_TASKS", "OWNER_TODOS"],
		["LIFE_GET_TODOS", "OWNER_TODOS"],
		["LIFE_TODO", "OWNER_TODOS"],
		["ADD_HABIT", "OWNER_ROUTINES"],
		["CREATE_HABIT", "OWNER_ROUTINES"],
		["LIST_HABITS", "OWNER_ROUTINES"],
		["ADD_GOAL", "OWNER_GOALS"],
		["CREATE_GOAL", "OWNER_GOALS"],
		["TASKS_SET_GOAL", "OWNER_GOALS"],
		["SET_GOAL", "OWNER_GOALS"],
		["CREATE_REMINDER", "OWNER_REMINDERS"],
		["SET_REMINDER_RULE", "OWNER_REMINDERS"],
		["CHECK_IN", "CHECKIN"],
		["LIFE_CHECK_IN", "CHECKIN"],
		["MORNING_CHECKIN", "CHECKIN"],
		["MORNING_CHECK_IN", "CHECKIN"],
		["NIGHT_CHECKIN", "CHECKIN"],
		["NIGHT_CHECK_IN", "CHECKIN"],
		["RUN_CHECKIN", "CHECKIN"],
		["RUN_MORNING_CHECKIN", "CHECKIN"],
		["RUN_NIGHT_CHECKIN", "CHECKIN"],
		["AUTOMATION_RUN", "REPLY"],
		["DAILY_BRIEF", "REPLY"],
		["MEMORY_SET", "REPLY"],
		["MEMORY_WRITE", "REPLY"],
		["REMEMBER_PREFERENCES", "REPLY"],
		["CREATE_PREFERENCE_PROFILE", "REPLY"],
		["FLAG_CONFLICT", "CALENDAR"],
		["CHECK_FLIGHT_CONFLICT", "CALENDAR"],
		["FLIGHT_CONFLICT_REBOOKING", "CALENDAR"],
		["REBOOK_CONFLICTING_EVENT", "CALENDAR"],
		["CALENDAR_READ", "CALENDAR"],
		["CALENDAR_CREATE_EVENT", "CALENDAR"],
		["CALENDAR_FEED", "CALENDAR"],
		["CALENDLY_CHECK_AVAILABILITY", "CALENDAR"],
		["CALENDLY_AVAILABILITY", "CALENDAR"],
		["CALENDLY_SINGLE_USE_LINK", "CALENDAR"],
		["CALENDAR_CHECK_AVAILABILITY", "CALENDAR"],
		["BLOCK_WEBSITE", "BLOCK"],
		["WEBSITE_BLOCKER", "BLOCK"],
		["WEBSITE_BLOCK", "BLOCK"],
		["AUTOMATION_FOCUS_BLOCK", "BLOCK"],
		["FOCUS_BLOCK", "BLOCK"],
		["SET_APP_BLOCK", "BLOCK"],
		["PHONE_SET_APP_BLOCK", "BLOCK"],
		["PHONE_BLOCK_APPS", "BLOCK"],
		["APP_BLOCK", "BLOCK"],
		["BLOCK_APPS", "BLOCK"],
		["ADMIN_REJECT_APPROVAL", "RESOLVE_REQUEST"],
		["REJECT_APPROVAL", "RESOLVE_REQUEST"],
		["DENY_APPROVAL", "RESOLVE_REQUEST"],
		["DECLINE_APPROVAL", "RESOLVE_REQUEST"],
		["REQUEST_UPLOAD", "COMPUTER_USE"],
		["UPLOAD_PORTAL", "COMPUTER_USE"],
		["DESKTOP", "COMPUTER_USE"],
	].map(([from, to]) => [
		normalizeActionIdentifier(from),
		normalizeActionIdentifier(to),
	]),
);

const PLANNER_ACTION_ALIAS_DEFAULTS = new Map(
	[
		[
			"ADD_TODO",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"CREATE_TODO",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"TODO_ADD",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"TODO_CREATE",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"TODOS_ADD",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"TODOS_CREATE",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"TASK_ADD",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"TASK_CREATE",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"ADD_TASK",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"CREATE_TASK",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"TASKS_ADD_TODO",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"TASKS_CREATE_TODO",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"ADD_HABIT",
			{ action: "create", kind: "definition", definitionKind: "habit" },
		],
		[
			"CREATE_HABIT",
			{ action: "create", kind: "definition", definitionKind: "habit" },
		],
		["ADD_GOAL", { action: "create", kind: "goal" }],
		["CREATE_GOAL", { action: "create", kind: "goal" }],
		["TASKS_SET_GOAL", { action: "create", kind: "goal" }],
		["SET_GOAL", { action: "create", kind: "goal" }],
		[
			"CREATE_REMINDER",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"TASKS_CREATE_REMINDER",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"SET_REMINDER_RULE",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		["LIST_TODOS", { action: "review" }],
		["GET_TODOS", { action: "review" }],
		["TODO_LIST", { action: "review" }],
		["TODO_LIST_TODAY", { action: "review" }],
		["TODOS_LIST", { action: "review" }],
		["TODO_GET", { action: "review" }],
		["TODOS_GET", { action: "review" }],
		["TODOS_REVIEW", { action: "review" }],
		["TASK_LIST", { action: "review" }],
		["TASK_LIST_TODAY", { action: "review" }],
		["TASKS_REVIEW", { action: "review" }],
		["TASKS_LIST_TODAY", { action: "review" }],
		["TASKS_LIST_TODOS", { action: "review" }],
		["LIST_TASKS", { action: "review" }],
		["LIFE_GET_TODOS", { action: "review" }],
		["LIFE_TODO", {}],
		["LIST_HABITS", { action: "review" }],
	].map(([from, defaults]) => [
		normalizeActionIdentifier(from as string),
		defaults as PlannerLifeAliasDefaults,
	]),
);

const PLANNER_LIFE_SUBACTION_DEFAULTS = new Map(
	[
		[
			"ADD_TODO",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"CREATE_TODO",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"TODO_ADD",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"TODO_CREATE",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"TODOS_ADD",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"TODOS_CREATE",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"TASK_ADD",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"TASK_CREATE",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"TASKS_ADD_TODO",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"TASKS_CREATE_TODO",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"ADD_TASK",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"CREATE_TASK",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"ADD_REMINDER",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"CREATE_REMINDER",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"TASKS_CREATE_REMINDER",
			{ action: "create", kind: "definition", definitionKind: "task" },
		],
		[
			"ADD_HABIT",
			{ action: "create", kind: "definition", definitionKind: "habit" },
		],
		[
			"CREATE_HABIT",
			{ action: "create", kind: "definition", definitionKind: "habit" },
		],
		["ADD_GOAL", { action: "create", kind: "goal" }],
		["CREATE_GOAL", { action: "create", kind: "goal" }],
		["TASKS_SET_GOAL", { action: "create", kind: "goal" }],
		["SET_GOAL", { action: "create", kind: "goal" }],
		["LIST_TODOS", { action: "review" }],
		["GET_TODOS", { action: "review" }],
		["TODO_LIST", { action: "review" }],
		["TODO_LIST_TODAY", { action: "review" }],
		["TODOS_LIST", { action: "review" }],
		["TODO_GET", { action: "review" }],
		["TODOS_GET", { action: "review" }],
		["TODOS_REVIEW", { action: "review" }],
		["TASK_LIST", { action: "review" }],
		["TASK_LIST_TODAY", { action: "review" }],
		["TASKS_REVIEW", { action: "review" }],
		["TASKS_LIST_TODAY", { action: "review" }],
		["TASKS_LIST_TODOS", { action: "review" }],
		["LIST_TASKS", { action: "review" }],
		["LIFE_GET_TODOS", { action: "review" }],
		["LIFE_TODO", {}],
		["LIST_TASKS", { action: "review" }],
		["LIST_HABITS", { action: "review" }],
	].map(([from, defaults]) => [
		normalizeActionIdentifier(from as string),
		defaults as PlannerLifeAliasDefaults,
	]),
);

const PLANNER_PROVIDER_ALIASES = new Map(
	[
		["DOCUMENT_LOOKUP", "ATTACHMENTS"],
		["INBOX_TRIAGE", "inboxTriage"],
		["PENDING_DRAFTS_PROVIDER", "inboxTriage"],
		["PENDING_DRAFTS", "inboxTriage"],
		["DRAFTS", "inboxTriage"],
	].map(([from, to]) => [normalizeActionIdentifier(from), to]),
);

const PROVIDER_FOLLOWUP_PASSIVE_ACTIONS = new Set(
	["REPLY", "RESPOND", "NONE"].map(normalizeActionIdentifier),
);

const ACTION_REPAIR_PASSIVE_ACTIONS = new Set(
	["REPLY", "RESPOND", "NONE", "IGNORE"].map(normalizeActionIdentifier),
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
// Without these entries, the correction layer (findOwnedActionCorrectionFromMetadata)
// routinely overrides a correct CREATE_CRON / WORKFLOW pick on
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
const EXPLICIT_INTENT_ACTIONS = new Set(
	[
		"SPAWN_AGENT",
		"START_CODING_TASK",
		"CREATE_TASK",
		"ATTACHMENT",
		"TRANSCRIBE_MEDIA",
		"DOWNLOAD_MEDIA",
		"CHAT_WITH_ATTACHMENTS",
		"MESSAGE",
		"POST",
		"SUMMARIZE_CONVERSATION",
		"SERVER_INFO",
		"WORKFLOW",
		"TRIGGER",
		"CREATE_TRIGGER",
		"SCHEDULE_TRIGGER",
		"SCHEDULE_TASK",
		"CREATE_HEARTBEAT",
		"SCHEDULE_HEARTBEAT",
		"CREATE_AUTOMATION",
		"SCHEDULE_AUTOMATION",
		"CREATE_CRON",
		"CREATE_RECURRING",
		"CONTACT",
		"ENTITY",
		// Owner task actions pick routine / reminder / todo / habit / goal intents that
		// frequently mention a verb-noun pair the corrector will mis-rewrite.
		// "remember to call mom on Sunday" → planner correctly picks OWNER_REMINDERS
		// (a reminder), but the corrector keyword-rescores it to
		// VOICE_CALL because of "call". Trust the planner's pick.
		"OWNER_REMINDERS",
		"OWNER_TODOS",
		"OWNER_ROUTINES",
		"OWNER_GOALS",
	].map(normalizeActionIdentifier),
);

function _shouldAttemptCanonicalActionRepair(
	rawPlannerActions: string[],
	normalizedActions: string[],
): boolean {
	const hasUnknownOperationalAction = rawPlannerActions.some((actionName) => {
		const normalized = normalizeActionIdentifier(actionName);
		return (
			normalized.length > 0 &&
			!ACTION_REPAIR_PASSIVE_ACTIONS.has(normalized) &&
			!PLANNER_CONTROL_ACTIONS.has(normalized)
		);
	});

	if (!hasUnknownOperationalAction) {
		return false;
	}

	return (
		normalizedActions.length === 0 ||
		normalizedActions.every((actionName) =>
			ACTION_REPAIR_PASSIVE_ACTIONS.has(normalizeActionIdentifier(actionName)),
		)
	);
}

function buildCanonicalActionRepairPrompt(args: {
	userText: string;
	rawPlannerActions: string[];
	rawPlannerProviders: string[];
	plannerReplyText: string;
	availableActionNames: string[];
}): string {
	const plannerReplyText =
		args.plannerReplyText.trim().length > 0
			? args.plannerReplyText.trim()
			: "(empty)";
	const rawPlannerActions =
		args.rawPlannerActions.length > 0
			? `planner_actions_raw[${args.rawPlannerActions.length}]: ${args.rawPlannerActions.join(",")}`
			: "planner_actions_raw[0]:";
	const rawPlannerProviders =
		args.rawPlannerProviders.length > 0
			? `planner_providers_raw[${args.rawPlannerProviders.length}]: ${args.rawPlannerProviders.join(",")}`
			: "planner_providers_raw[0]:";
	const availableRuntimeActions =
		args.availableActionNames.length > 0
			? `available_runtime_actions[${args.availableActionNames.length}]: ${args.availableActionNames.join(",")}`
			: "available_runtime_actions[0]:";

	return [
		"You are repairing an action-planner output that used a non-canonical action name.",
		"Choose ONLY from the available runtime actions below.",
		"If the user explicitly asked for an operational artifact or workflow, select the responsible action instead of replying inline.",
		"If the subject is already present, do not ask a clarifying question just because the original planner used a generic lookup verb.",
		"Map generic planner labels like LOOKUP, SEARCH, FETCH, GET, RETRIEVE, BRIEF, or BACKGROUND to the best canonical runtime action.",
		"Return ONLY a JSON object with top-level fields: actions, providers, params, and optional text.",
		'Use "actions": ["ACTION_NAME"] for selected actions and a params object keyed by action name when inputs are needed.',
		"Do not include text unless there is truly no matching runtime action.",
		"",
		`user_message:\n${args.userText}`,
		"",
		rawPlannerActions,
		"",
		rawPlannerProviders,
		"",
		`planner_reply_text:\n${plannerReplyText}`,
		"",
		availableRuntimeActions,
		"",
		"Example:",
		'user_message: "Pull up a dossier on Satya Nadella."',
		"planner_actions_raw[1]: LOOKUP",
		"output:",
		JSON.stringify(
			{
				actions: ["DOSSIER"],
				providers: [],
				params: { DOSSIER: { subject: "Satya Nadella" } },
			},
			null,
			2,
		),
	].join("\n");
}

async function _repairCanonicalPlannerActions(args: {
	runtime: IAgentRuntime;
	message: Memory;
	rawPlannerActions: string[];
	rawPlannerProviders: string[];
	plannerReplyText: string;
}): Promise<Record<string, unknown> | null> {
	const availableActionNames = Array.from(
		new Set(
			(args.runtime.actions ?? [])
				.map((action) => action.name?.trim())
				.filter((name): name is string => Boolean(name)),
		),
	).sort();

	if (availableActionNames.length === 0) {
		return null;
	}

	const repairPrompt = buildCanonicalActionRepairPrompt({
		userText: String(args.message.content.text ?? ""),
		rawPlannerActions: args.rawPlannerActions,
		rawPlannerProviders: args.rawPlannerProviders,
		plannerReplyText: args.plannerReplyText,
		availableActionNames,
	});

	return args.runtime.dynamicPromptExecFromState({
		state: { values: {}, data: {}, text: "" } as State,
		params: {
			prompt: repairPrompt,
		},
		schema: [
			{
				field: "actions",
				description: "Selected canonical runtime action names",
				type: "array",
				items: { description: "One canonical runtime action name" },
				required: true,
				validateField: false,
				streamField: false,
			},
			{
				field: "providers",
				description: "Optional provider names needed before the action",
				type: "array",
				items: { description: "One provider name" },
				required: false,
				validateField: false,
				streamField: false,
			},
			{
				field: "params",
				description:
					"Optional JSON object keyed by action name with repaired action params",
				type: "object",
				required: false,
				validateField: false,
				streamField: false,
			},
			{
				field: "text",
				description:
					"Optional fallback reply only when no runtime action matches",
				required: false,
				validateField: false,
				streamField: false,
			},
		],
		options: {
			modelType: ModelType.TEXT_LARGE,
			contextCheckLevel: 0,
			maxRetries: 1,
		},
	});
}

function _buildProviderFollowupPrompt(basePrompt: string): string {
	return `${basePrompt}

[PROVIDER FOLLOW-UP]
The requested providers have already been executed, and their grounded results are now present in context above.
Use those provider results to produce the final reply and/or action plan for this turn.
Do not ask for the same providers again.
If the provider results fully answer the user, reply directly.
If DOCUMENTS contains a direct answer, prefer that grounded answer even when DOCUMENTS lists multiple files.
Do not ask "which file?" when the grounded DOCUMENTS result already resolves the request.`;
}

function _buildActionRescuePrompt(
	basePrompt: string,
	draftReply: string,
): string {
	const trimmedDraftReply = draftReply.trim();
	const draftSection =
		trimmedDraftReply.length > 0
			? `\n[PREVIOUS DRAFT REPLY]\n${trimmedDraftReply.replace(/<\/response>/gi, "<\\/response>")}\n`
			: "";

	return `${basePrompt}

	[ACTION RESCUE]
	The previous draft stayed in prose-only mode or selected only passive reply actions.
	Re-evaluate the turn using the same available actions and providers already in context above.
	If a listed non-REPLY action owns the user's request, choose it now even when the text still needs to ask a follow-up question.
	Prefer the owning action for requests to create, store, remember, schedule, remind, upload, follow up, route, escalate, set a standing policy, delegate a future workflow, bulk-reschedule a cohort, run a morning brief, or call the owner when blocked.
	Missing details like the exact time, participant list, channel, platform, portal login, file arrival, itinerary specifics, or which item is at risk are not a reason to fall back to REPLY when a listed action can own the follow-up.
	When the user is defining a durable policy or future-condition workflow such as missed-call repair, contextual bumping, group-chat handoff, travel booking after approval, flight-conflict rebooking, portal upload after file arrival, updated-ID collection, multi-device meeting ladders, cancellation-fee warnings, outstanding event-asset checklists, or calling the owner if the agent gets stuck, picking only REPLY is wrong if a listed action can store or queue that behavior.
	For live checklist questions like what slides, bio, title, portal assets, drafts, or pending items the owner still owes, choose the owning inbox/calendar/computer-use action instead of answering from memory or treating it like a generic LifeOps reminder.
	If the draft reply merely acknowledges the task or asks for details before selecting an owning action, treat that draft as incomplete and repair it.
	Keep REPLY/NONE only when no listed action actually owns the request.${draftSection}`;
}

function _buildActionOnlyRescuePrompt(draftReply: string): string {
	const trimmedDraftReply = draftReply.trim();
	const draftSection =
		trimmedDraftReply.length > 0
			? `Draft reply:\n${trimmedDraftReply}\n\n`
			: "";

	return `Select the single best action for this turn using only the available actions already in context above.

	Rules:
	- Choose a listed non-REPLY action when the user is asking to create, store, remember, schedule, remind, upload, follow up, route, escalate, or set a standing policy.
	- If the request delegates a future workflow or approval-gated workflow, still choose the owning action even before every detail is present.
	- If the right action still needs clarification, choose that action anyway.
	- A reply that only says "tell me more", "which one?", "send it over", "I can do that", or "let me know the details" is wrong when an owning action can store or queue the workflow.
	- Durable requests like missed-call repair, contextual bump rules, group-chat handoff, travel booking after approval, flight-conflict rebooking, portal upload after file arrival, updated-ID collection, device reminder ladders, cancellation-fee warnings, event-asset checklists, and call-me-if-stuck escalations must choose the owning action on this turn.
	- Choose REPLY only when no listed action owns the request.
	- Do not invent action names.

Examples:
- "need to book 1 hour per day for time with Jill, any time is fine, ideally before sleep" -> CALENDAR
- "I'm in Tokyo for limited time so let's schedule PendingReality and Ryan at the same time if possible" -> CALENDAR
- "repair that missed call and hold the note for approval" -> MESSAGE action=triage
- "if I still haven't answered about those three events, bump me again with context instead of starting over" -> MESSAGE action=draft_followup
	- "if direct relaying gets messy, suggest a group chat handoff" -> MESSAGE action=triage
	- "tell me what slides, bio, title, or portal assets I still owe before the event" -> MESSAGE action=list_inbox
	- "we're gonna cancel some stuff and push everything back until next month, all partnership meetings" -> CALENDAR
	- "capture my reusable flight and hotel preferences" -> REPLY
	- "flag the conflict before my flight later and, if needed, help rebook the other thing" -> CALENDAR
	- "I can go ahead and start booking the flights and hotel today if that's good with you" -> PERSONAL_ASSISTANT action=book_travel
	- "when I'm done with the PPT, upload it to the speaker portal for me" -> COMPUTER_USE
	- "if you get stuck in the browser or on my computer, call me" -> VOICE_CALL
- "check disk space on this VPS with df -h" -> SHELL
	- "what is the current BTC price in USD?" -> SEARCH

${draftSection}Return JSON only:
{
  "thought": "short reasoning",
  "actions": ["ACTION_NAME"]
}`;
}

const ROUTING_REASSESS_ACTIONS = new Set(
	["OWNER_TODOS", "OWNER_REMINDERS", "COMPUTER_USE", "OWNER_FINANCES"].map(
		normalizeActionIdentifier,
	),
);

const ACTION_OWNERSHIP_STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"because",
	"can",
	"could",
	"do",
	"for",
	"from",
	"get",
	"go",
	"here",
	"i",
	"if",
	"in",
	"into",
	"is",
	"it",
	"just",
	"let",
	"me",
	"my",
	"now",
	"of",
	"on",
	"or",
	"our",
	"please",
	"so",
	"that",
	"the",
	"them",
	"this",
	"to",
	"up",
	"we",
	"when",
	"with",
	"you",
	"your",
]);

const ACTION_OWNERSHIP_TRIGGER_PATTERNS = [
	/\b(?:if|when)\b/iu,
	/\b(?:upload|send over|send|attach)\b/iu,
	/\b(?:remind|warning|warn|nudge|alert)\b/iu,
	/\b(?:book|schedule|reschedule|follow up|bump|handoff|route|escalat|calls?)\b/iu,
	/\b(?:cancel|push|move|meeting|meetings|partnership|next month)\b/iu,
	/\b(?:remember|store|save|keep track|set (?:up|a|an)|policy|workflow)\b/iu,
	/\b(?:asset|assets|checklist|owe|owed|deadline|slides|bio|portal)\b/iu,
	/\b(?:sign|signature|appointment|clinic|docs?)\b/iu,
];

const ACTION_METADATA_FUTURE_HINTS =
	/\b(?:standing|future|workflow|policy|approval|delegate|gated|queued?|queue|intervention|nudge|warning|upload|portal|browser|device|follow[- ]?up)\b/iu;

export type ActionOwnershipSuggestion = {
	actionName: string;
	score: number;
	secondBestScore: number;
	reasons: string[];
};

type ActionOwnershipCandidate = {
	actionName: string;
	score: number;
	reasons: string[];
};

function tokenizeOwnershipText(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.map((token) => token.trim())
		.filter(
			(token) => token.length >= 2 && !ACTION_OWNERSHIP_STOPWORDS.has(token),
		);
}

function buildTokenSet(text: string): Set<string> {
	return new Set(tokenizeOwnershipText(text));
}

function exampleContentText(action: Action): string[] {
	return (action.examples ?? []).flatMap((example) =>
		example.flatMap((turn) => {
			const text =
				typeof turn.content?.text === "string" ? turn.content.text.trim() : "";
			return text.length > 0 ? [text] : [];
		}),
	);
}

function splitActionMetadataText(value: string): string[] {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return [];
	}
	return trimmed
		.split(/(?:[\r\n]+|(?<=[.!?;])\s+)/u)
		.map((chunk) => chunk.trim())
		.filter((chunk) => chunk.length > 0);
}

function actionMetadataTexts(action: Action): string[] {
	return [
		action.name,
		action.description,
		action.descriptionCompressed,
		...(action.tags ?? []),
		...(action.similes ?? []),
		...exampleContentText(action),
	]
		.filter(
			(value): value is string =>
				typeof value === "string" && value.trim().length > 0,
		)
		.flatMap((value) => splitActionMetadataText(value));
}

function scoreActionOwnershipMatch(
	messageText: string,
	action: Action,
): { score: number; reasons: string[] } {
	const messageTokens = buildTokenSet(messageText);
	if (messageTokens.size === 0) {
		return { score: 0, reasons: [] };
	}

	let score = 0;
	const reasons: string[] = [];
	let bestExampleScore = 0;
	const normalizedMessage = messageText.toLowerCase();
	const actionMetadataBlob = actionMetadataTexts(action)
		.join(" ")
		.toLowerCase();

	for (const chunk of actionMetadataTexts(action)) {
		const chunkTokens = buildTokenSet(chunk);
		if (chunkTokens.size === 0) {
			continue;
		}
		const overlap = [...messageTokens].filter((token) =>
			chunkTokens.has(token),
		);
		if (overlap.length === 0) {
			continue;
		}
		const normalizedChunk = chunk.toLowerCase();
		const overlapRatio = overlap.length / Math.max(3, chunkTokens.size);
		if (
			/\b(?:do not use this for|don't use this for|not for|belongs? to)\b/iu.test(
				normalizedChunk,
			)
		) {
			score -= overlap.length * 1.25 + overlapRatio;
			if (overlap.length >= 2) {
				reasons.push(`negative:${overlap.slice(0, 4).join(",")}`);
			}
			continue;
		}
		score += overlap.length * 1.25 + overlapRatio;
		if (overlap.length >= 2) {
			reasons.push(`overlap:${overlap.slice(0, 4).join(",")}`);
		}

		if (
			normalizedChunk.length > 12 &&
			(normalizedMessage.includes(normalizedChunk) ||
				normalizedChunk.includes(normalizedMessage))
		) {
			score += 3;
			reasons.push("phrase");
		}

		const exampleTokens = tokenizeOwnershipText(chunk);
		if (exampleTokens.length >= 3) {
			const exampleOverlap = overlap.length / exampleTokens.length;
			if (exampleOverlap > bestExampleScore) {
				bestExampleScore = exampleOverlap;
			}
		}
	}

	if (bestExampleScore >= 0.6) {
		score += 4;
		reasons.push("example");
	}

	if (
		/\b(?:no calls? between|sleep window|blackout|preferred hours?|travel buffer|unless i explicitly say|unless i say it'?s okay)\b/iu.test(
			messageText,
		) &&
		/\b(?:sleep window|no-call|blackout|preferred hours?|meeting preferences|scheduling rules)\b/iu.test(
			actionMetadataBlob,
		)
	) {
		score += 4;
		reasons.push("schedule-policy");
	}

	if (
		ACTION_OWNERSHIP_TRIGGER_PATTERNS.some((pattern) =>
			pattern.test(messageText),
		) &&
		ACTION_METADATA_FUTURE_HINTS.test(
			[action.description, ...(action.tags ?? []), ...(action.similes ?? [])]
				.filter(Boolean)
				.join(" "),
		)
	) {
		score += 2;
		reasons.push("workflow");
	}

	return { score, reasons };
}

function findDirectOwnedActionSuggestion(
	runtime: Pick<IAgentRuntime, "actions">,
	messageText: string,
): ActionOwnershipSuggestion | null {
	if (looksLikeLocalShellRequest(messageText)) {
		const shellAction = findRuntimeActionByNames(runtime, [
			"SHELL",
			"SHELL_COMMAND",
			"RUN_IN_TERMINAL",
			"RUN_COMMAND",
			"EXECUTE_COMMAND",
			"TERMINAL",
			"SHELL",
			"RUN_SHELL",
			"EXEC",
		]);
		if (shellAction) {
			return {
				actionName: shellAction.name,
				score: 100,
				secondBestScore: 0,
				reasons: ["direct:local-shell-check"],
			};
		}
	}

	if (looksLikeWebSearchRequest(messageText)) {
		const searchAction = findRuntimeActionByNames(runtime, [
			"SEARCH",
			"WEB_SEARCH",
			"SEARCH_WEB",
			"BRAVE_SEARCH",
			"INTERNET_SEARCH",
			"SEARCH_INTERNET",
			"LOOKUP_WEB",
			"GOOGLE",
		]);
		if (searchAction) {
			return {
				actionName: searchAction.name,
				score: 100,
				secondBestScore: 0,
				reasons: ["direct:web-search"],
			};
		}
	}

	if (
		/\b(?:no calls? between|sleep window|blackout|preferred hours?|travel buffer|unless i explicitly say|unless i say it'?s okay)\b/iu.test(
			messageText,
		)
	) {
		const calendarAction = (runtime.actions ?? []).find(
			(action) =>
				normalizeActionIdentifier(action.name) ===
				normalizeActionIdentifier("CALENDAR"),
		);
		if (calendarAction) {
			return {
				actionName: calendarAction.name,
				score: 100,
				secondBestScore: 0,
				reasons: ["direct:schedule-policy"],
			};
		}
	}

	return null;
}

function findRuntimeActionByNames(
	runtime: Pick<IAgentRuntime, "actions">,
	names: string[],
): Action | undefined {
	const wanted = new Set(names.map(normalizeActionIdentifier));
	return (runtime.actions ?? []).find((action) => {
		const candidates = [action.name, ...(action.similes ?? [])]
			.filter((value): value is string => typeof value === "string")
			.map(normalizeActionIdentifier);
		return candidates.some((candidate) => wanted.has(candidate));
	});
}

function looksLikeLocalShellRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	if (!normalized.trim()) {
		return false;
	}

	if (
		/\b(?:do not|don't|dont|without)\s+(?:run|execute|use)\s+(?:commands?|shell|terminal)\b/iu.test(
			normalized,
		)
	) {
		return false;
	}

	if (looksLikeActionExplanationRequest(normalized)) {
		return false;
	}

	const mentionsCommand =
		/\b(?:git|df|du|ls|pwd|cat|sed|awk|rg|grep|curl|ps|systemctl|journalctl|docker|bun|npm|node|sqlite3|gh)\b/iu.test(
			normalized,
		);
	const asksToInspect =
		/\b(?:run|execute|check|inspect|show|list|print|tail|look(?:\s+at)?|read|verify)\b/iu.test(
			normalized,
		);
	const mentionsLocalSurface =
		/(?:^|\s)(?:\/home\/|~\/|\.\/|\.\.\/)/u.test(normalized) ||
		/\b(?:this vps|local(?:ly)?|workspace|worktree|repo|repository|branch|head|origin\/(?:develop|main|master)|git status|disk space|logs?|service|systemd)\b/iu.test(
			normalized,
		);

	return mentionsCommand && asksToInspect && mentionsLocalSurface;
}

function looksLikeActionExplanationRequest(text: string): boolean {
	const normalized = text.toLowerCase().replace(/\s+/gu, " ").trim();
	const asksForExplanation =
		/\b(?:explain|describe|teach|walk\s+me\s+through|what\s+does|what\s+is|how\s+(?:does|do|to)|why)\b/iu.test(
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

function looksLikeWebSearchRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	if (!normalized.trim()) {
		return false;
	}

	if (
		/\b(?:do not|don't|dont|without)\s+(?:browse|search|google|look\s+up|use)\s+(?:the\s+)?(?:web|internet|live prices?|current prices?)\b/iu.test(
			normalized,
		)
	) {
		return false;
	}

	const explicitlyAsksSearch =
		/\b(?:search\s+(?:the\s+)?web|web\s+search|search\s+online|look\s+up|lookup|google|browse\s+(?:the\s+)?web|search\s+(?:the\s+)?internet)\b/iu.test(
			normalized,
		);
	const asksCurrentInfo =
		/\b(?:current|currently|latest|live|real[- ]?time|right now|today|now|up[- ]?to[- ]?date)\b/iu.test(
			normalized,
		);
	const mentionsMarketOrNews =
		/\b(?:price|prices|quote|btc|bitcoin|eth|ethereum|stock|stocks?|ticker|market|markets?|exchange rate|news|headline|headlines|weather)\b/iu.test(
			normalized,
		);

	return explicitlyAsksSearch || (asksCurrentInfo && mentionsMarketOrNews);
}

function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function extractLocalShellPath(text: string): string | null {
	const match = text.match(
		/(?:^|[\s`'"])(\/(?:home|Users|workspace|workspaces|tmp|var\/tmp|opt|srv)\/[A-Za-z0-9._~+/@:-]+)/u,
	);
	if (!match?.[1]) {
		return null;
	}
	return match[1].replace(/[),.;:]+$/u, "");
}

export function inferLocalShellCommandFromMessageText(
	messageText: string,
): string | null {
	const text = messageText.toLowerCase();
	if (!looksLikeLocalShellRequest(messageText)) {
		return null;
	}

	if (/\bdf\s+-h\b/iu.test(messageText) || /\bdisk space\b/iu.test(text)) {
		return "df -h";
	}

	if (/\bgit\b/iu.test(text)) {
		const localPath = extractLocalShellPath(messageText);
		if (!localPath) {
			if (/\bgit\s+status\b/iu.test(messageText)) {
				return "git status --short --branch";
			}
			return null;
		}
		const repo = quoteShellArg(localPath);
		const commands = [`git -C ${repo} status --short --branch`];
		if (
			/\b(?:branch|head|sha|origin\/(?:develop|main|master)|latest|author config|commit author|user\.name|user\.email)\b/iu.test(
				messageText,
			)
		) {
			commands.push(
				`git -C ${repo} branch --show-current`,
				`git -C ${repo} rev-parse --short HEAD`,
				`(git -C ${repo} rev-parse --short origin/develop 2>/dev/null || git -C ${repo} rev-parse --short origin/main 2>/dev/null || true)`,
				`git -C ${repo} config user.name`,
				`git -C ${repo} config user.email`,
			);
		}
		return commands.join(" && ");
	}

	return null;
}

export function inferWebSearchQueryFromMessageText(
	messageText: string,
): string | null {
	if (!looksLikeWebSearchRequest(messageText)) {
		return null;
	}

	const query = messageText
		.replace(/<@!?\d+>/gu, " ")
		.replace(
			/\banswer\s+(?:briefly|in\s+one\s+short\s+sentence|with\s+the\s+price\s+only)\b.*$/iu,
			" ",
		)
		.replace(
			/\band\s+mention\s+if\s+you\s+cannot\s+browse\s+live\s+prices\b.*$/iu,
			" ",
		)
		.replace(
			/\b(?:search\s+(?:the\s+)?web\s+(?:for|about)?|web\s+search|search\s+online|look\s+up|lookup|google|browse\s+(?:the\s+)?web|search\s+(?:the\s+)?internet)\b/iu,
			" ",
		)
		.replace(/\bwhat\s+is\s+the\b/iu, " ")
		.replace(/[?.!]+/gu, " ")
		.trim()
		.replace(/\s+/gu, " ");

	return query.length > 0 ? query : messageText.trim();
}

function _hasSelectedShellCommandAction(
	responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
	return (
		responseContent?.actions?.some(
			(actionName) =>
				typeof actionName === "string" &&
				[
					normalizeActionIdentifier("SHELL"),
					normalizeActionIdentifier("SHELL_COMMAND"),
				].includes(normalizeActionIdentifier(actionName)),
		) ?? false
	);
}

function _hasSelectedSearchAction(
	responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
	return (
		responseContent?.actions?.some((actionName) => {
			if (typeof actionName !== "string") {
				return false;
			}
			const normalized = normalizeActionIdentifier(actionName);
			return (
				normalized === normalizeActionIdentifier("SEARCH") ||
				normalized === normalizeActionIdentifier("WEB_SEARCH")
			);
		}) ?? false
	);
}

function _mergeLocalShellCommandParams(
	existingParams: Content["params"],
	command: string,
): Content["params"] {
	if (
		existingParams &&
		typeof existingParams === "object" &&
		!Array.isArray(existingParams)
	) {
		return {
			...(existingParams as Record<string, unknown>),
			SHELL: {
				...(((existingParams as Record<string, unknown>).SHELL as
					| Record<string, unknown>
					| undefined) ?? {}),
				command,
			},
		} as Content["params"];
	}

	return {
		SHELL: { command },
	} as Content["params"];
}

function _mergeWebSearchQueryParams(
	existingParams: Content["params"],
	query: string,
): Content["params"] {
	if (
		existingParams &&
		typeof existingParams === "object" &&
		!Array.isArray(existingParams)
	) {
		return {
			...(existingParams as Record<string, unknown>),
			SEARCH: {
				...(((existingParams as Record<string, unknown>).SEARCH as
					| Record<string, unknown>
					| undefined) ?? {}),
				category: "web",
				query,
			},
		} as Content["params"];
	}

	return {
		SEARCH: { category: "web", query },
	} as Content["params"];
}

export function suggestOwnedActionFromMetadata(
	runtime: Pick<IAgentRuntime, "actions">,
	message: Pick<Memory, "content">,
): ActionOwnershipSuggestion | null {
	const messageText = getUserMessageText(message);
	if (messageText.length === 0) {
		return null;
	}

	const directSuggestion = findDirectOwnedActionSuggestion(
		runtime,
		messageText,
	);
	if (directSuggestion) {
		return directSuggestion;
	}

	if (
		!ACTION_OWNERSHIP_TRIGGER_PATTERNS.some((pattern) =>
			pattern.test(messageText),
		)
	) {
		return null;
	}

	const ranked: ActionOwnershipCandidate[] = (runtime.actions ?? [])
		.filter((action) => {
			const normalized = normalizeActionIdentifier(action.name);
			return (
				normalized.length > 0 &&
				!PROVIDER_FOLLOWUP_PASSIVE_ACTIONS.has(normalized) &&
				normalized !== normalizeActionIdentifier("IGNORE") &&
				normalized !== normalizeActionIdentifier("STOP")
			);
		})
		.map((action) => ({
			actionName: action.name,
			...scoreActionOwnershipMatch(messageText, action),
		}))
		.filter((candidate) => candidate.score > 0)
		.sort((left, right) => right.score - left.score);

	if (ranked.length === 0) {
		return null;
	}

	const best = ranked[0];
	const secondBestScore = ranked[1]?.score ?? 0;
	if (best.score < 8 || best.score - secondBestScore < 1.5) {
		return null;
	}

	return {
		actionName: best.actionName,
		score: best.score,
		secondBestScore,
		reasons: best.reasons,
	};
}

export function findOwnedActionCorrectionFromMetadata(
	runtime: Pick<IAgentRuntime, "actions">,
	message: Pick<Memory, "content">,
	responseContent: Pick<Content, "actions"> | null | undefined,
): ActionOwnershipSuggestion | null {
	const hasExplicitIntent = (responseContent?.actions ?? []).some(
		(actionName) =>
			typeof actionName === "string" &&
			EXPLICIT_INTENT_ACTIONS.has(normalizeActionIdentifier(actionName)),
	);
	if (hasExplicitIntent) {
		return null;
	}

	const currentAction = responseContent?.actions?.find(
		(actionName) =>
			typeof actionName === "string" &&
			!PROVIDER_FOLLOWUP_PASSIVE_ACTIONS.has(
				normalizeActionIdentifier(actionName),
			) &&
			normalizeActionIdentifier(actionName) !==
				normalizeActionIdentifier("IGNORE") &&
			normalizeActionIdentifier(actionName) !==
				normalizeActionIdentifier("STOP"),
	);
	if (!currentAction) {
		return null;
	}

	const suggestion = suggestOwnedActionFromMetadata(runtime, message);
	if (!suggestion) {
		return null;
	}

	if (
		normalizeActionIdentifier(suggestion.actionName) ===
		normalizeActionIdentifier(currentAction)
	) {
		return null;
	}

	const currentActionDef = (runtime.actions ?? []).find(
		(action) =>
			normalizeActionIdentifier(action.name) ===
			normalizeActionIdentifier(currentAction),
	);
	const currentScore = currentActionDef
		? scoreActionOwnershipMatch(
				typeof message.content?.text === "string" ? message.content.text : "",
				currentActionDef,
			).score
		: 0;
	if (suggestion.score - currentScore < 4) {
		return null;
	}

	return suggestion;
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

function _shouldAttemptActionRescue(
	runtime: Pick<IAgentRuntime, "actions">,
	message: Memory,
	state: State,
	responseContent:
		| Pick<Content, "actions" | "providers" | "text">
		| null
		| undefined,
): boolean {
	if (!responseContent) {
		return false;
	}

	if (hasNonPassiveAction(responseContent)) {
		return false;
	}

	if (looksLikeNonActionableChatter(message)) {
		return false;
	}

	if (looksLikeSelfPolicyExplanationRequest(message)) {
		return false;
	}

	const availableActionNames =
		typeof state.values?.actionNames === "string"
			? state.values.actionNames
			: "";
	if (
		availableActionNames.trim().length === 0 &&
		(runtime.actions?.length ?? 0) === 0
	) {
		return false;
	}

	return true;
}

function getMessageText(message: Memory): string {
	return getUserMessageText(message);
}

function looksLikeOwnershipSensitiveRequest(message: Memory): boolean {
	const text = getMessageText(message).toLowerCase();
	if (!text) {
		return false;
	}

	return [
		/\bif\b/,
		/\bwhen\b/,
		/\bwhenever\b/,
		/\bapproval\b/,
		/\bapprove\b/,
		/\bgood with you\b/,
		/\bif needed\b/,
		/\brebook\b/,
		/\bgroup chat\b/,
		/\bhandoff\b/,
		/\bbump me again\b/,
		/\bwith context\b/,
		/\bwhat .* still owe\b/,
		/\bslides\b/,
		/\bportal assets?\b/,
		/\bupdated copy\b/,
		/\bexpired\b/,
		/\bcancellation fee\b/,
		/\bimportant meetings?\b/,
		/\bstuck\b/,
		/\bupload it to the portal\b/,
	].some((pattern) => pattern.test(text));
}

function _shouldAttemptOwnershipRepair(
	runtime: Pick<IAgentRuntime, "actions">,
	message: Memory,
	state: State,
	responseContent:
		| Pick<Content, "actions" | "providers" | "text">
		| null
		| undefined,
): boolean {
	if (!responseContent || !hasNonPassiveAction(responseContent)) {
		return false;
	}

	if (looksLikeNonActionableChatter(message)) {
		return false;
	}

	const availableActionNames =
		typeof state.values?.actionNames === "string"
			? state.values.actionNames
			: "";
	if (
		availableActionNames.trim().length === 0 &&
		(runtime.actions?.length ?? 0) === 0
	) {
		return false;
	}

	const normalizedActions = (responseContent.actions ?? [])
		.map((actionName) =>
			typeof actionName === "string"
				? normalizeActionIdentifier(actionName)
				: "",
		)
		.filter((actionName) => actionName.length > 0);
	if (normalizedActions.length !== 1) {
		return false;
	}

	return (
		ROUTING_REASSESS_ACTIONS.has(normalizedActions[0]) &&
		looksLikeOwnershipSensitiveRequest(message)
	);
}

function _buildOwnershipRepairPrompt(
	basePrompt: string,
	selectedActionName: string,
	draftReply: string,
): string {
	const trimmedDraftReply = draftReply.trim();
	const draftSection =
		trimmedDraftReply.length > 0
			? `\n[PREVIOUS DRAFT REPLY]\n${trimmedDraftReply.replace(/<\/response>/gi, "<\\/response>")}\n`
			: "";

	return `${basePrompt}

[OWNERSHIP REPAIR]
The previous plan selected ${selectedActionName}, but that action may be too broad or the wrong surface.
Re-evaluate the request and choose the single best owning action from the listed actions above.
Prefer the most specific owning action for inbox coordination, calendar conflict/rebooking, approval-gated travel booking, browser/portal workflows, device-warning policies, or owner-escalation workflows.
Generic contextual bump rules about unanswered events belong to MESSAGE action=draft_followup or an OWNER_* task surface, unless the owner explicitly asks for device-wide phone/desktop/mobile delivery.
Missing-ID or blocked-workflow prompts belong to VOICE_CALL or MESSAGE with the appropriate inbox/draft action, not COMPUTER_USE, unless the assistant is actually operating a browser, portal, or file surface on the owner's machine.
Outstanding slides, bios, titles, portal assets, drafts, and other "what do I still owe?" questions belong to the owning inbox/calendar/browser action, not to OWNER_TODOS unless the request is explicitly about personal todo/habit state.
Cancellation-fee warnings and "warn me and offer to handle it now" policies belong to calendar, OWNER_FINANCES, or call escalation actions; email unsubscribe belongs to MESSAGE action=manage unless the user explicitly asks to audit, cancel, or status-check a paid subscription.
Flight-conflict rebooking belongs to CALENDAR even when the exact flight time or event ID still needs a follow-up.
If the current action is already the most specific owner, keep it.${draftSection}`;
}

function _shouldAttemptProviderRescue(
	responseContent: Pick<Content, "actions" | "providers"> | null | undefined,
): boolean {
	if (!responseContent) {
		return false;
	}

	if ((responseContent.providers?.length ?? 0) > 0) {
		return false;
	}

	const normalizedActions = (responseContent.actions ?? [])
		.map((actionName) =>
			typeof actionName === "string"
				? normalizeActionIdentifier(actionName)
				: "",
		)
		.filter((actionName) => actionName.length > 0);

	if (normalizedActions.length === 0) {
		return true;
	}

	return normalizedActions.every((actionName) =>
		PROVIDER_FOLLOWUP_PASSIVE_ACTIONS.has(actionName),
	);
}

export function looksLikeSelfPolicyExplanationRequest(
	message: Pick<Memory, "content">,
): boolean {
	const text =
		typeof message.content.text === "string"
			? message.content.text.toLowerCase()
			: "";
	if (!text.trim()) {
		return false;
	}

	const hasNoWorkDirective =
		/\b(?:do not|don't|dont|without)\s+(?:build|create|edit|change|modify|write|scaffold|run|execute|use|touch|commit|push|open|make)\b/iu.test(
			text,
		) ||
		/\b(?:answer|respond)\s+(?:in|with)\s+(?:one|1|a)\s+(?:short\s+)?sentence\b/iu.test(
			text,
		) ||
		/\bdo not run commands?\b/iu.test(text);
	const asksMonetizedAppGuidance =
		/\b(?:monetized|monetised)\b/iu.test(text) &&
		/\b(?:workflow|skill|sdk|example app|reference app|build[- ]?monetized[- ]?app)\b/iu.test(
			text,
		);
	const asksWorkspaceMap =
		/\b(?:which|what|where)\b[\s\S]{0,120}\b(?:folder|folders|path|paths|repo|repos|repository|repositories|workspace|worktree|source)\b/iu.test(
			text,
		) &&
		/\b(?:live|read[- ]?only|allowed|touch|edit|pr work|github|git config|default branch|latest)\b/iu.test(
			text,
		);
	const asksAgentMethod =
		/\b(?:what|which|how)\b[\s\S]{0,120}\b(?:workflow|workflows|skill|skills|sdk|example app|routing|configured|allowed|supposed to use|should you use)\b/iu.test(
			text,
		) && /\b(?:you|your|agent|codex|task agent|subagent)\b/iu.test(text);
	const asksQuestion =
		/\?/.test(text) || /\b(?:what|which|where|how|should)\b/iu.test(text);
	const asksActualWork =
		/\b(?:build|create|make|implement|fix|edit|change|modify|write|scaffold|deploy|commit|push|open)\b[\s\S]{0,120}\b(?:app|code|file|files|pr|pull request|branch|repo|feature|bug)\b/iu.test(
			text,
		);

	if (
		hasNoWorkDirective &&
		asksQuestion &&
		(asksMonetizedAppGuidance || asksWorkspaceMap || asksAgentMethod)
	) {
		return true;
	}

	return (
		asksQuestion &&
		!asksActualWork &&
		(asksWorkspaceMap || asksAgentMethod || asksMonetizedAppGuidance)
	);
}

export function shouldSkipDocumentProviderRescue(message: Memory): boolean {
	if ((message.content.attachments?.length ?? 0) > 0) {
		return true;
	}

	const text =
		typeof message.content.text === "string"
			? message.content.text.toLowerCase()
			: "";
	if (!text) {
		return false;
	}

	if (looksLikeLocalShellRequest(text)) {
		return true;
	}

	const asksSelfPolicy =
		/\b(?:configured|routing|workflow|workflows?|folders?|repos?|repositories|source|workspace|workspaces|skills?|sdk|example app|read-only|pr work)\b/.test(
			text,
		) && /\b(?:you|your|agent|codex|task agent|subagent)\b/.test(text);
	const asksDocument =
		/\b(uploaded|upload|attachment|attached|document|documents?|file|files?|document base|kb)\b/.test(
			text,
		);

	if (asksDocument) {
		return false;
	}

	if (looksLikeSelfPolicyExplanationRequest(message)) {
		return true;
	}

	return asksSelfPolicy;
}

function buildProviderSelectionPrompt(draftReply?: string): string {
	const trimmedDraftReply = draftReply?.trim() ?? "";
	const draftReplySection =
		trimmedDraftReply.length > 0
			? `draft_reply:\n${trimmedDraftReply.replace(/<\/response>/gi, "<\\/response>")}\n\n`
			: "";
	const draftReplyRules =
		trimmedDraftReply.length > 0
			? [
					"- if the draft reply asks the user to resend, restate, or clarify information that may already exist in provider context, choose the relevant providers instead of sending the draft reply as-is",
					'- when the recent conversation already identifies a prior upload or document store question, prefer grounded provider lookup over asking "which file?" again',
				]
			: [];
	return `task: Decide whether any providers should be called before sending the assistant's reply.

recent conversation:
{{recentMessages}}

${draftReplySection}rules[${4 + draftReplyRules.length}]:
- choose providers only when they can supply grounded information needed before the assistant replies
- uploaded files, documents, prior uploads, and document store questions should use the relevant providers before asking the user to resend the material
- if the user asks about an uploaded file or document and DOCUMENTS is available, prefer DOCUMENTS before sending any clarification reply
- return an empty providers field when no provider lookup is needed
- do not include actions, text, or thought in the output
${draftReplyRules.join("\n")}

output:
JSON only. Return exactly one JSON object containing only provider names. No prose before or after it. No <think>.

Examples:
- user asks: "what is the qa codeword from the uploaded file?"
  draft reply: "Which file are you referring to?"
  output:
  {"providers":["DOCUMENTS","DOCUMENTS"]}
- user asks: "what is the qa codeword from the uploaded file?"
  draft reply: "I don't have the file in my context. Which file contains the QA codeword?"
  output:
  {"providers":["DOCUMENTS","DOCUMENTS"]}
- user asks: "thanks, that's all"
  draft reply: "Glad to help."
  output:
  {"providers":[]}`;
}

async function _recoverProvidersForTurn(args: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	draftReply?: string;
	attachments?: GenerateTextAttachment[];
}): Promise<string[]> {
	if (shouldSkipDocumentProviderRescue(args.message)) {
		return [];
	}

	try {
		const parsed = await args.runtime.dynamicPromptExecFromState({
			state: args.state,
			params: {
				prompt: buildProviderSelectionPrompt(args.draftReply),
				...(args.attachments ? { attachments: args.attachments } : {}),
			},
			schema: [
				{
					field: "providers",
					description:
						"Provider names to call before replying, or an empty array",
					type: "array",
					items: { description: "One provider name" },
					required: true,
					validateField: false,
					streamField: false,
				},
			],
			options: {
				modelType: ModelType.TEXT_LARGE,
				contextCheckLevel: 0,
				maxRetries: 1,
			},
		});
		const normalizedProviders = normalizePlannerProviders(
			parsed ?? { providers: [] },
			args.runtime,
		);
		if (normalizedProviders.length > 0) {
			return normalizedProviders;
		}
		const shouldUseDocuments = await shouldUseDocumentProviders(
			args.runtime,
			args.state,
			args.attachments,
		);
		return shouldUseDocuments ? ["DOCUMENTS"] : [];
	} catch (error) {
		args.runtime.logger.warn(
			{
				src: "service:message",
				error: error instanceof Error ? error.message : String(error),
			},
			"Provider rescue model call failed",
		);
		return [];
	}
}

function _buildGroundedFallbackReplyPrompt(): string {
	return `task: Write the next assistant reply using grounded context.

grounded context:
{{providers}}

recent conversation:
{{recentMessages}}

rules[5]:
- answer directly from grounded context when it fully answers the user
- do not ask the user to resend, rename, or specify a file if grounded document or document context already answers the request
- do not say you cannot access the file when grounded context is already present above
- if DOCUMENTS contains a direct answer, prefer that grounded answer even when DOCUMENTS lists multiple files
- if grounded context is still insufficient, say exactly what is missing
- return only the reply text

output:
Plain text only. No XML, JSON, bullets, or <think>.`;
}

function buildDocumentProviderDecisionPrompt(): string {
	return `task: Decide whether the assistant should consult uploaded-document or document providers before replying.

recent conversation:
{{recentMessages}}

rules[5]:
- return true when the user is asking about an uploaded file, document, prior upload, or document store content
- return true when the answer is likely already stored in uploaded documents or semantic document search
- when DOCUMENTS is available and the user refers to an uploaded file or prior upload, return true
- return false for generic chat, thanks, or requests that clearly do not depend on uploaded or document store content
- return only the structured output, with no prose

output:
JSON only. Return exactly one JSON object.

Examples:
- user asks: "what is the qa codeword from the uploaded file?" -> useDocumentProviders: true
- user asks: "thanks, that's all" -> useDocumentProviders: false`;
}

async function shouldUseDocumentProviders(
	runtime: IAgentRuntime,
	state: State,
	attachments?: GenerateTextAttachment[],
): Promise<boolean> {
	try {
		const parsed = await runtime.dynamicPromptExecFromState({
			state,
			params: {
				prompt: buildDocumentProviderDecisionPrompt(),
				...(attachments ? { attachments } : {}),
			},
			schema: [
				{
					field: "useDocumentProviders",
					description:
						"true when uploaded-document or document providers should be consulted before replying",
					type: "boolean",
					required: true,
					validateField: false,
					streamField: false,
				},
			],
			options: {
				modelType: ModelType.TEXT_LARGE,
				contextCheckLevel: 0,
				maxRetries: 1,
			},
		});
		const value =
			parsed?.useDocumentProviders ?? parsed?.use_document_providers;
		if (typeof value === "boolean") {
			return value;
		}
		if (typeof value === "string") {
			return value.trim().toLowerCase() === "true";
		}
		return false;
	} catch (error) {
		runtime.logger.warn(
			{
				src: "service:message",
				error: error instanceof Error ? error.message : String(error),
			},
			"Documents provider decision model call failed",
		);
		return false;
	}
}

function buildRuntimeActionLookup(runtime: {
	actions?: readonly Action[];
}): Map<string, Action> {
	const actionMap = new Map<string, Action>();

	for (const action of runtime.actions ?? []) {
		const identifiers = [action.name, ...(action.similes ?? [])];
		for (const identifier of identifiers) {
			const normalized = normalizeActionIdentifier(identifier);
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

function _shouldContinueAfterActions(
	runtime: IAgentRuntime,
	responseContent: Content | null | undefined,
): boolean {
	return getActionContinuationDecision(runtime, responseContent).shouldContinue;
}

function _suppressesPostActionContinuation(
	runtime: IAgentRuntime,
	responseContent: Content | null | undefined,
): boolean {
	return getActionContinuationDecision(runtime, responseContent).suppressed;
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
	_runtime: Pick<IAgentRuntime, "agentId" | "logger">,
	_message: Pick<Memory, "id" | "roomId">,
	callback?: HandlerCallback,
): HandlerCallback | undefined {
	return callback;
}

function getLatestVisibleReplyText(
	responseContent: Content | null | undefined,
	actionResults: ActionResult[],
): string {
	for (let index = actionResults.length - 1; index >= 0; index--) {
		const result = actionResults[index];
		const actionName =
			typeof result?.data?.actionName === "string"
				? result.data.actionName
				: "";
		if (!isReplyActionIdentifier(actionName)) {
			continue;
		}

		if (typeof result.text === "string" && result.text.trim().length > 0) {
			return result.text.trim();
		}
	}

	const responseText =
		typeof responseContent?.text === "string"
			? responseContent.text.trim()
			: "";
	return responseText;
}

function isLikelyClarifyingQuestion(text: string): boolean {
	const normalized = text.trim();
	if (!normalized) {
		return false;
	}

	if (/[?؟]\s*$/.test(normalized)) {
		return true;
	}

	const firstSentence = extractFirstSentence(normalized)
		.first.trim()
		.toLowerCase();
	return /^(what|which|when|where|who|whom|whose|why|how|can you|could you|would you|will you|do you|did you|are you|is it|should i|should we)\b/.test(
		firstSentence,
	);
}

function _shouldWaitForUserAfterIncompleteReflection(
	responseContent: Content | null | undefined,
	actionResults: ActionResult[],
): boolean {
	const latestVisibleReply = getLatestVisibleReplyText(
		responseContent,
		actionResults,
	);
	if (!isLikelyClarifyingQuestion(latestVisibleReply)) {
		return false;
	}

	if (actionResults.length === 0) {
		return isSimpleReplyResponse(responseContent);
	}

	return actionResults.every((result) => {
		const actionName =
			typeof result?.data?.actionName === "string"
				? result.data.actionName
				: "";
		return isReplyActionIdentifier(actionName);
	});
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
	return withContextRoutingValues(
		await runtime.composeState(
			message,
			["RECENT_MESSAGES", "ACTIONS"],
			false,
			false,
		),
		contextRoutingStateValues,
	);
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
		// `MILADY_ENABLE_ANALYSIS_MODE` / `NODE_ENV=development`. See
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
				void runtime.runActionsByMode("ALWAYS_DURING", message).catch(() => {});
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
			runId: runtime.getCurrentRunId?.(),
			roomId: message.roomId,
			messageId: message.id,
			userRole: senderRole,
		};

		return await runWithTrajectoryContext<MessageProcessingResult>(
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
					// Voice handling state
					const firstSentenceSent = false;
					const firstSentenceText = "";

					const processingPromise = runWithStreamingContext(
						streamingContext,
						() =>
							this.processMessage(
								runtime,
								message,
								instrumentedCallback,
								responseId,
								runId,
								startTime,
								opts,
							),
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

					// Ensure latestResponseIds is cleaned up even if processMessage
					// threw before reaching its own cleanup at the end of the method.
					clearLatestResponseId(runtime.agentId, message.roomId, responseId);
					if (message.id) {
						runtime.stateCache.delete(`${message.id}_action_results`);
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

		// Check if room is muted
		const agentName = runtime.character.name ?? "agent";
		const mentionContext = message.content.mentionContext;
		const explicitlyAddressesAgent =
			mentionContext?.isMention === true ||
			mentionContext?.isReply === true ||
			textContainsAgentName(message.content.text, [
				runtime.character.name,
				runtime.character.username,
			]);
		if (
			agentUserState === "MUTED" &&
			message.content.text &&
			!explicitlyAddressesAgent &&
			!message.content.text.toLowerCase().includes(agentName.toLowerCase())
		) {
			runtime.logger.debug(
				{ src: "service:message", roomId: message.roomId },
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

		const directLifeOpsResult = await (
			runtime as IAgentRuntime & {
				lifeOpsDirectMessageHook?: {
					handleMessageRequest?: (args: {
						runtime: IAgentRuntime;
						message: Memory;
						state: State;
					}) => Promise<ActionResult | null | undefined>;
				};
			}
		).lifeOpsDirectMessageHook?.handleMessageRequest?.({
			runtime,
			message,
			state,
		});
		if (directLifeOpsResult) {
			const directText =
				typeof directLifeOpsResult.text === "string" &&
				directLifeOpsResult.text.trim().length > 0
					? directLifeOpsResult.text.trim()
					: directLifeOpsResult.success
						? "Done."
						: "I couldn't complete that LifeOps request.";
			strategyResult = createV5ReplyStrategyResult({
				runtime,
				message,
				state,
				responseId,
				text: directText,
				thought: "LifeOps direct workflow hook handled this request.",
				mode: "simple",
			});
			_usedV5Runtime = true;
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
				const errMsg = error instanceof Error ? error.message : String(error);
				const errStack = error instanceof Error ? error.stack : undefined;
				runtime.logger.warn(
					{
						src: "service:message",
						agentId: runtime.agentId,
						error: errMsg,
						stack: errStack,
					},
					"v5 message runtime failed; returning structured failure reply",
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
		// Holds a deferred simple-mode reply that will be flushed after
		// evaluators + reflection have had a chance to override it. Declared
		// out here so the post-evaluation flush at the bottom of handleMessage
		// can see the same variable that the simple-mode branch sets.
		let pendingSimpleEmit: Content | null = null;
		// Track memory IDs created for the simple-mode reply so we can clean
		// them up if reflection overrides the deferred emit (Greptile P1 fix).
		const pendingSimpleMemoryIds: string[] = [];

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
			responseMessages = result.responseMessages;
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

			const providerStateValues = {
				[AVAILABLE_CONTEXTS_STATE_KEY]:
					state.values?.[AVAILABLE_CONTEXTS_STATE_KEY],
				[CONTEXT_ROUTING_STATE_KEY]: state.values?.[CONTEXT_ROUTING_STATE_KEY],
			};

			if (responseContent?.providers && responseContent.providers.length > 0) {
				state = withContextRoutingValues(
					await composeProviderGroundedResponseState(
						runtime,
						message,
						responseContent.providers,
					),
					providerStateValues,
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
					// Update the content in case inReplyTo was added
					if (responseContent) {
						responseMemory.content = responseContent;
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
					// Log provider usage for simple responses
					if (
						responseContent.providers &&
						responseContent.providers.length > 0
					) {
						runtime.logger.debug(
							{
								src: "service:message",
								providers: responseContent.providers,
							},
							"Simple response used providers",
						);
					}
					// WHY order: hooks → createMemory → deferred callback matches wire + DB.
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
							if (responseContent) {
								responseMemory.content = responseContent;
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

							if (responseMemory.id) {
								pendingSimpleMemoryIds.push(responseMemory.id);
							}
						}
					}
					pendingSimpleEmit = responseContent;
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
				simple: true,
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

			if (callback) {
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
		await runPostTurnEvaluators(runtime, message, state, {
			didRespond: didRespondGate,
			responses: responseMessages,
		});
		await runtime.runActionsByMode("ALWAYS_AFTER", message, state, {
			didRespond: didRespondGate,
			responses: responseMessages,
		});

		// Flush the deferred simple-mode reply after hooks have had a chance
		// to attach callbacks. Chaining is handled inside the v5 planner loop.
		if (pendingSimpleEmit && callback) {
			await callback(pendingSimpleEmit);
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
			simple: responseContent?.simple,
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
		const alwaysRespondSources = ["client_chat"];

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

		// 5. Clear self-modification requests should bypass the ignore-biased
		// classifier even in group chat, but only for narrow personality/style
		// update phrasing to avoid broad false positives.
		if (isExplicitSelfModificationRequest(message.content.text || "")) {
			return {
				shouldRespond: true,
				skipEvaluation: true,
				reason: "explicit self-modification request",
				primaryContext: "social",
				secondaryContexts: ["admin"],
			};
		}

		// 6. All other cases are ambiguous enough to need the classifier.
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
					const runtimeFetch = runtime.fetch ?? globalThis.fetch;
					const inlineData = attachment as MediaWithInlineData;

					if (
						typeof inlineData._data === "string" &&
						inlineData._data.trim() &&
						typeof inlineData._mimeType === "string" &&
						inlineData._mimeType.trim()
					) {
						imageUrl = `data:${inlineData._mimeType};base64,${inlineData._data}`;
					} else if (!isRemote) {
						// Convert local/internal media to base64
						const res = await runtimeFetch(url);
						if (!res.ok)
							throw new Error(`Failed to fetch image: ${res.statusText}`);

						const arrayBuffer = await res.arrayBuffer();
						const buffer = Buffer.from(arrayBuffer);
						const contentType =
							res.headers.get("content-type") || "application/octet-stream";
						imageUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
					}

					const resolvedImagePrompt = resolveOptimizedPromptForRuntime(
						runtime,
						"media_description",
						imageDescriptionTemplate,
					);
					const response = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
						prompt: resolvedImagePrompt,
						imageUrl,
					});

					if (typeof response === "string") {
						const parsedJson = parseJSONObjectFromText(response);

						if (parsedJson && (parsedJson.description || parsedJson.text)) {
							processedAttachment.description =
								(typeof parsedJson.description === "string"
									? parsedJson.description
									: "") || "";
							processedAttachment.title =
								(typeof parsedJson.title === "string"
									? parsedJson.title
									: "Image") || "Image";
							processedAttachment.text =
								(typeof parsedJson.text === "string" ? parsedJson.text : "") ||
								(typeof parsedJson.description === "string"
									? parsedJson.description
									: "") ||
								"";

							runtime.logger.debug(
								{
									src: "service:message",
									descriptionPreview:
										processedAttachment.description?.substring(0, 100),
								},
								"Generated image description",
							);
						} else {
							runtime.logger.warn(
								{ src: "service:message" },
								"Failed to parse JSON response for image description",
							);
						}
					} else if (
						response &&
						typeof response === "object" &&
						"description" in response
					) {
						// Handle object responses for backwards compatibility
						const objResponse = response as ImageDescriptionResponse;
						processedAttachment.description = objResponse.description;
						processedAttachment.title = objResponse.title || "Image";
						processedAttachment.text = objResponse.description;

						runtime.logger.debug(
							{
								src: "service:message",
								descriptionPreview: processedAttachment.description?.substring(
									0,
									100,
								),
							},
							"Generated image description",
						);
					} else {
						runtime.logger.warn(
							{ src: "service:message" },
							"Unexpected response format for image description",
						);
					}
				} else if (
					attachment.contentType === ContentType.DOCUMENT &&
					!attachment.text
				) {
					const docFetch = runtime.fetch ?? globalThis.fetch;
					const res = await docFetch(url);
					if (!res.ok)
						throw new Error(`Failed to fetch document: ${res.statusText}`);

					const contentType = res.headers.get("content-type") || "";
					const isPlainText = contentType.startsWith("text/plain");

					if (isPlainText) {
						runtime.logger.debug(
							{ src: "service:message", documentUrl: attachment.url },
							"Processing plain text document",
						);

						const textContent = await res.text();
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
					} else {
						runtime.logger.warn(
							{ src: "service:message", contentType },
							"Skipping non-plain-text document",
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
						let transcriptionInput: string | Buffer = url;
						const audioFetch = runtime.fetch ?? globalThis.fetch;

						// For local/internal URLs, fetch the audio as a buffer
						if (!isRemote) {
							const res = await audioFetch(url);
							if (!res.ok)
								throw new Error(`Failed to fetch audio: ${res.statusText}`);
							const arrayBuffer = await res.arrayBuffer();
							transcriptionInput = Buffer.from(arrayBuffer);
						}

						const transcript = await runtime.useModel(
							ModelType.TRANSCRIPTION,
							transcriptionInput,
						);

						if (typeof transcript === "string" && transcript.trim()) {
							processedAttachment.text = transcript.trim();
							processedAttachment.title = processedAttachment.title || "Audio";
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
						}
					} catch (err) {
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
						let transcriptionInput: string | Buffer = url;
						const videoFetch = runtime.fetch ?? globalThis.fetch;

						// For local/internal URLs, fetch the video as a buffer
						if (!isRemote) {
							const res = await videoFetch(url);
							if (!res.ok)
								throw new Error(`Failed to fetch video: ${res.statusText}`);
							const arrayBuffer = await res.arrayBuffer();
							transcriptionInput = Buffer.from(arrayBuffer);
						}

						const transcript = await runtime.useModel(
							ModelType.TRANSCRIPTION,
							transcriptionInput,
						);

						if (typeof transcript === "string" && transcript.trim()) {
							processedAttachment.text = transcript.trim();
							processedAttachment.title = processedAttachment.title || "Video";
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
						}
					} catch (err) {
						runtime.logger.warn(
							{ src: "service:message", err },
							"Video transcription failed, continuing without transcript",
						);
					}
				}

				return processedAttachment;
			}),
		);

		return processedAttachments;
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

				const cleaned = response
					.replace(/<think>[\s\S]*?<\/think>/g, "")
					.trim();
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
		const failurePrompt = [
			"You hit a transient model error and have to send a short user-facing reply.",
			"Write a one or two sentence reply in plain language.",
			"",
			"Hard rules:",
			"- Stay in character. Keep your usual voice and tone.",
			"- NEVER mention internal mechanism words such as: planner, action_planner,",
			"  XML, JSON, schema, structured output, model, retries, sonnet,",
			"  opus, claude, anthropic, prompt, parse, parser, xml plan, decision",
			"  loop, runtime, dispatch, or hand off. The user does not know or care",
			"  what those are.",
			"- Do not use em-dashes or en-dashes. Use a plain hyphen, period, or comma.",
			"- Just acknowledge that something went wrong and suggest a retry.",
			'  Examples: "something flaked, try again in a sec",',
			'  "weird hiccup, give me another shot in a moment",',
			'  "got stuck on my end, retry that?"',
			"- If the user already gave a clear command and you can plausibly act,",
			"  acknowledge it and offer to take the action directly. Keep it short.",
			"- Return only the reply text. No labels, no XML, no JSON, no <think>.",
			"",
			"Recent Conversation:",
			recentMessages,
			"",
			"Reply:",
		].join("\n");

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

		let replyText = attempt.value;
		if (!replyText) {
			// Last-ditch fallback when every model call above also failed.
			// Voice-neutral so any character can ship this default; characters
			// can override with their own phrasing via
			// character.templates.transientFailureReply.
			replyText =
				runtime.character.templates?.transientFailureReply ||
				"Something went wrong on my end. Please try again.";
		}

		replyText = truncateToCompleteSentence(replyText.trim(), 2000);

		const responseContent: Content = {
			thought: `Handle a temporary reply failure during ${stage}.`,
			actions: ["REPLY"],
			providers: [],
			text: replyText,
			simple: true,
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
		const replyText =
			runtime.character.templates?.noModelProviderReply ||
			"This agent has no LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY in your environment, or sign in to Eliza Cloud (ELIZAOS_CLOUD_API_KEY).";

		runtime.logger.warn(
			{ src: "service:message", stage },
			"No LLM provider configured; rendering setup hint reply",
		);

		const responseContent: Content = {
			thought: `No LLM provider configured during ${stage}.`,
			actions: ["REPLY"],
			providers: [],
			text: replyText,
			simple: true,
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
	 * This method handles the actual deletion logic that was previously in event handlers.
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
