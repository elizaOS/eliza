import {
	providerReviewSources,
	withProviderReviewSchema,
} from "../../runtime/provider-context";
import type { JsonValue } from "../../types/primitives";
/** Builds the complete Stage 1 request, performs bounded empty-output retries, and validates the response decision. Registers diagnostic persistence with the outer turn before handing control to routing and planning. */

import {
	createHandleResponseTool,
	HANDLE_RESPONSE_TOOL_NAME,
} from "../../actions/to-tool";
import { ElizaError } from "../../errors";
import { recordInferenceSpan, timeInferenceSpan } from "../../inference-timing";
import {
	completionContextFieldEvaluator,
	contextRequestsFieldEvaluator,
	replyTextFieldEvaluator,
	withDirectTextBuiltinSchemaDescriptions,
} from "../../runtime/builtin-field-evaluators";
import { getCandidateActionBackstopRules } from "../../runtime/candidate-action-backstop";
import { withRequiredCompletionSourceIdentity } from "../../runtime/completion-context";
import { computePrefixHashes, hashString } from "../../runtime/context-hash";
import { getMessageHandlerReply } from "../../runtime/message-handler";
import {
	buildModelInputBudget,
	withModelInputBudgetProviderOptions,
} from "../../runtime/model-input-budget";
import { cacheProviderOptions } from "../../runtime/planner-loop";
import {
	buildResponseGrammar,
	buildSpanSamplerPlan,
	withGuidedDecodeProviderOptions,
} from "../../runtime/response-grammar";
import type {
	ResponseHandlerFieldContext,
	ResponseHandlerFieldRunResult,
	ResponseHandlerSenderRole,
} from "../../runtime/response-handler-field-evaluator";
import type { TrajectoryRecorder } from "../../runtime/trajectory-recorder";
import { sanitizeUserVisibleModelOutput } from "../../runtime/user-visible-model-output";
import { getStreamingContext } from "../../streaming-context";
import type { MessageHandlerResult } from "../../types/components";
import type { Memory } from "../../types/memory";
import type { GenerateTextResult } from "../../types/model";
import { ModelType } from "../../types/model";
import { ChannelType } from "../../types/primitives";
import { getUserMessageText } from "../../utils/message-text";
import { getEvaluatorProgressState } from "../evaluator-progress.ts";
import { HISTORY_RETENTION_EVALUATOR } from "../history-retention.ts";
import { CODING_SUB_AGENT_CONTEXTS } from "./action-surface.js";
import {
	listAvailableContextsForRole,
	resolveStage1SenderRole,
} from "./addressing.js";
import { createV5MessageContextObject } from "./context-assembly.js";
import {
	createContextReadTool,
	extractContextRead,
	projectDiscoverableContext,
	READ_CONTEXT_TOOL_NAME,
	withAvailableContextRequests,
} from "./context-discovery.js";
import {
	getActionInferenceMessageText,
	isSubAgentCompletionArtifact,
	resolveContinuationInferenceMessageText,
} from "./dialogue-context.js";
import { evaluatePlannedReplyEgress } from "./egress-policy.js";
import {
	canRepairHistoryIdentity,
	canRepairIncompleteHistorySelection,
	HISTORY_REFERENCE_PREFIX,
	type HistoryDiscovery,
	historyReferences,
	loadHistoryReferences,
	projectReviewedHistory,
	readHistoryContextRequests,
	repairableHistorySourceIds,
	requestedHistory,
	withReviewedHistorySelection,
} from "./history-discovery.js";
import { withInactiveArrayFields } from "./inactive-field-schema.js";
import { composeResponseState } from "./provider-state.js";
import { restorePiiInUserReplyText } from "./reply-policy.js";
import {
	createSourceReplySnapshot,
	resolveSourceReply,
	SOURCE_REPLY_INSTRUCTIONS,
	SOURCE_REPLY_SCHEMA,
	type SourceReplySnapshot,
} from "./source-reply";
import type { SourceReplyReferences } from "./source-reply-references";
import { createSourceSelectionBinding } from "./source-selection-binding";
import {
	getStage1FinishReason,
	stage1HitCompletionLimit,
	synthesizeStage1CompletionLimitReply,
} from "./stage1-completion.js";
import {
	getStage1RetryReason,
	getStage1RoutingRepair,
	getStage1UnusableDecisionRepair,
	isEmptyStage1Result,
	parseMessageHandlerModelOutput,
	readStage1EmptyRetryLimit,
	readStage1TerminalReaskSetting,
	shouldRetryStage1Generation,
	shouldUseStage1PlannerFallback,
	synthesizePlannerFallbackFromStage1Failure,
} from "./stage1-generation.js";
import {
	CONTEXT_CATALOG_REFERENCE,
	createContextCatalogReference,
	renderMessageHandlerModelInput,
} from "./stage1-input.js";
import {
	extractMessageHandlerRawParsed,
	hasHandleResponseToolCall,
	messageHandlerFromFieldResult,
	normalizeRawParsedForFieldRegistry,
	reportRejectedUserVisibleModelOutput,
} from "./stage1-output.js";
import { recordMessageHandlerStage } from "./trajectory-stages.js";
import type { V5MessageRuntimeInput } from "./turn-input.js";

/**
 * Trusted host routing for a dedicated coding turn. This deliberately looks
 * like the canonical Stage 1 tool result so the existing parsing and safety
 * pipeline stays shared, but it is never recorded or accounted as a model
 * response. Authorization remains owned by the normal context/action gates.
 */
export function directCodingResponseHandlerResult(): GenerateTextResult {
	return {
		text: "",
		toolCalls: [
			{
				id: "direct-coding-route",
				name: HANDLE_RESPONSE_TOOL_NAME,
				arguments: {
					shouldRespond: "RESPOND",
					contexts: [...CODING_SUB_AGENT_CONTEXTS],
					intents: [],
					replyText: "",
					replyEffectStatus: "none",
					candidateActionNames: [],
					facts: [],
					relationships: [],
					topics: [],
					addressedTo: [],
					emotion: "none",
				},
			},
		],
		finishReason: "tool_calls",
	};
}

export async function generateStage1Decision(
	args: V5MessageRuntimeInput,
	{
		senderRole,
		context,
		availableContexts,
		directMessageChannel,
		stage1PreprocessStartedAt,
		recorder,
		trajectoryId,
	}: {
		senderRole: Awaited<ReturnType<typeof resolveStage1SenderRole>>;
		context: Awaited<ReturnType<typeof createV5MessageContextObject>>;
		availableContexts: ReturnType<typeof listAvailableContextsForRole>;
		directMessageChannel: boolean;
		stage1PreprocessStartedAt: number;
		recorder: TrajectoryRecorder | undefined;
		trajectoryId: ReturnType<TrajectoryRecorder["startTrajectory"]> | undefined;
	},
	registerStageTask: (task: Promise<void>) => void,
) {
	const voiceDirectMessageChannel =
		args.message.content?.channelType === ChannelType.VOICE_DM;
	// Reads precede the routing/addressing decision. Only direct text may
	// publish progress here; ambient and voice turns retain their later gates.
	const contextReadProgressEnabled = Boolean(
		directMessageChannel &&
			!voiceDirectMessageChannel &&
			!args.codingMode &&
			!args.stage1DecisionOnly &&
			args.onPlanningAcknowledgment,
	);
	let contextReadAcknowledgmentSent = false;
	const messageHandlerStartedAt = Date.now();
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
	let responseHandlerFieldPrompt =
		await args.runtime.responseHandlerFieldRegistry.composePromptSlices(
			responseHandlerFieldContext,
		);
	const canonicalResponseHandlerSchema =
		args.runtime.responseHandlerFieldRegistry.composeSchema();
	const loadedContext = new Set<string>();
	const discoveryEnabled = directMessageChannel && !args.codingMode;
	const responseHandlerSchema = discoveryEnabled
		? withDirectTextBuiltinSchemaDescriptions(
				canonicalResponseHandlerSchema,
				selectedResponseHandlerFields,
			)
		: canonicalResponseHandlerSchema;
	let history: HistoryDiscovery | undefined;
	let historyReadEvidence: HistoryDiscovery | undefined;
	if (
		discoveryEnabled &&
		args.runtime.evaluators?.some(
			(evaluator) => evaluator.name === HISTORY_RETENTION_EVALUATOR,
		) &&
		!args.runtime.providers?.some((provider) =>
			provider.name.startsWith(HISTORY_REFERENCE_PREFIX),
		)
	) {
		const started = performance.now();
		try {
			const checkpoint = await getEvaluatorProgressState(
				args.runtime,
				args.message,
				HISTORY_RETENTION_EVALUATOR,
			);
			history = projectReviewedHistory(
				context,
				{
					agentId: args.runtime.agentId,
					roomId: args.message.roomId,
					entityId: args.message.entityId,
					roles: [senderRole],
				},
				checkpoint,
			);
		} catch (error) {
			// error-policy:J4 Report the optional index failure and render complete
			// original history instead; no unavailable source is treated as absent.
			args.runtime.reportError("MessageService.historyRetention", error, {
				roomId: args.message.roomId,
			});
		}
		recordInferenceSpan(
			"message:history-checkpoint",
			performance.now() - started,
			{
				applied: !!history,
				retainedSourceCount: history?.visibleEventIds.size ?? 0,
			},
		);
	}
	// A plugin that owns this name retains its ordinary provider-reference
	// contract; framework catalog discovery must not shadow its requests.
	let contextCatalogRead = false;
	let contextCatalog =
		discoveryEnabled &&
		Array.isArray(args.runtime.providers) &&
		!args.runtime.providers.some(
			(provider) => provider.name === CONTEXT_CATALOG_REFERENCE,
		)
			? createContextCatalogReference(args.runtime, availableContexts)
			: undefined;
	let discovery = discoveryEnabled
		? projectDiscoverableContext(context, args.state, loadedContext)
		: { context, available: new Set<string>() };
	if (contextCatalog) discovery.available.add(CONTEXT_CATALOG_REFERENCE);
	for (const reference of historyReferences(context, history))
		discovery.available.add(reference);
	let messageHandlerInput = renderMessageHandlerModelInput(
		args.runtime,
		discovery.context,
		availableContexts,
		{
			directMessage: directMessageChannel,
			voiceDirectMessage: voiceDirectMessageChannel,
			responseHandlerFields: responseHandlerFieldPrompt.rendered,
			contextCatalog,
			history,
		},
	);
	let compactInactiveFields = discoveryEnabled;
	let repairHistoryIdentity = false;
	let repairHistorySourceIds: string[] | undefined;
	let nativeHistoryRead = false;
	let sourceReplySnapshot: SourceReplySnapshot | undefined;
	let sourceSelectionBinding: ReturnType<typeof createSourceSelectionBinding>;
	let providerReviewSourceSetId: string | undefined;
	const createMessageHandlerTools = () => {
		context.metadata = {
			...context.metadata,
			loadedContextProviders: [...loadedContext],
		};
		// Bind to the exact sources offered by this inference, not a model-echoed nonce.
		providerReviewSourceSetId =
			discoveryEnabled && !voiceDirectMessageChannel
				? providerReviewSources(context)?.sourceSetId
				: undefined;
		const fieldSchema = compactInactiveFields
			? withInactiveArrayFields(
					responseHandlerSchema,
					responseHandlerFieldPrompt.skippedFieldNames,
				)
			: responseHandlerSchema;
		const referenceSchema =
			discoveryEnabled && !history
				? withAvailableContextRequests(fieldSchema, discovery.available)
				: fieldSchema;
		const readTool =
			discoveryEnabled && discovery.available.size > 0
				? createContextReadTool(referenceSchema, contextReadProgressEnabled)
				: undefined;
		// A ready native decision and a missing-context read are separate
		// operations. Preserve custom schemas and all legacy runtime fallbacks.
		nativeHistoryRead = Boolean(
			history &&
				readTool &&
				selectedResponseHandlerFields.includes(
					completionContextFieldEvaluator,
				) &&
				selectedResponseHandlerFields.includes(contextRequestsFieldEvaluator) &&
				canonicalResponseHandlerSchema.properties?.completionContext ===
					completionContextFieldEvaluator.schema &&
				canonicalResponseHandlerSchema.properties?.contextRequests ===
					contextRequestsFieldEvaluator.schema,
		);
		sourceReplySnapshot = undefined;
		if (
			nativeHistoryRead &&
			!voiceDirectMessageChannel &&
			history &&
			(history.loadedSourceIds.size > 0 || providerReviewSourceSetId) &&
			selectedResponseHandlerFields.includes(replyTextFieldEvaluator) &&
			canonicalResponseHandlerSchema.properties?.replyText ===
				replyTextFieldEvaluator.schema
		) {
			const providers = args.state.data?.providers as
				| Record<string, { data?: { recentMessages?: Memory[] } }>
				| undefined;
			const memories = providers?.RECENT_MESSAGES?.data?.recentMessages;
			if (Array.isArray(memories)) {
				const snapshot = createSourceReplySnapshot(context, history, memories);
				if (
					snapshot &&
					snapshot.originals.size === snapshot.suppliedIds.size &&
					(history.loadedSourceIds.size > 0 || snapshot.providerSourceSetId)
				)
					sourceReplySnapshot = snapshot;
			}
		}
		const sourceSchema = sourceReplySnapshot
			? {
					...referenceSchema,
					properties: {
						...referenceSchema.properties,
						replyText: SOURCE_REPLY_SCHEMA,
					},
				}
			: referenceSchema;
		const replySchema =
			discoveryEnabled && !voiceDirectMessageChannel
				? withProviderReviewSchema(sourceSchema, context)
				: sourceSchema;
		const parameters = withRequiredCompletionSourceIdentity(
			history
				? withReviewedHistorySelection(
						replySchema,
						nativeHistoryRead,
						repairHistorySourceIds,
					)
				: replySchema,
			discovery.context,
			repairHistoryIdentity,
		);
		// Only the registered native text history contract supports request references.
		sourceSelectionBinding =
			nativeHistoryRead && !voiceDirectMessageChannel && !repairHistoryIdentity
				? createSourceSelectionBinding(parameters, discovery.context)
				: undefined;
		return [
			createHandleResponseTool({
				directMessage: directMessageChannel,
				parameters: sourceSelectionBinding?.parameters ?? parameters,
				description: nativeHistoryRead
					? "Return a ready Stage 1 routing/reply decision after reviewing the supplied evidence. For missing or unresolved context, choose READ_CONTEXT instead. No execution permission is granted by either decision."
					: "Stage 1: populate registered response-handler fields once before action tools. Empty values for non-applicable fields.",
			}),
			...(readTool ? [readTool] : []),
		];
	};
	const appendSourceReplyInstructions = () => {
		if (
			sourceReplySnapshot &&
			!messageHandlerInput.promptSegments.some(
				(segment) => segment.content === SOURCE_REPLY_INSTRUCTIONS,
			)
		) {
			const first = messageHandlerInput.messages[0];
			if (first?.role === "system" && typeof first.content === "string") {
				messageHandlerInput = {
					...messageHandlerInput,
					messages: [
						{
							...first,
							content: `${first.content}\n${SOURCE_REPLY_INSTRUCTIONS}`,
						},
						...messageHandlerInput.messages.slice(1),
					],
					promptSegments: [
						...messageHandlerInput.promptSegments,
						{ content: SOURCE_REPLY_INSTRUCTIONS, stable: false },
					],
				};
			}
		}
	};
	let messageHandlerTools = createMessageHandlerTools();
	appendSourceReplyInstructions();
	let stage1PrefixHashes = computePrefixHashes(
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
	let stage1PrefixHash =
		stableStage1PrefixHashes[stableStage1PrefixHashes.length - 1]?.hash ??
		hashString(`stage1:${stage1SystemContent}`);

	// Discovery continues the same scoped workflow, even as its input expands.
	const stage1ConversationId = args.message.roomId
		? JSON.stringify([args.runtime.agentId, args.message.roomId, "stage1"])
		: undefined;
	const messageHandlerProviderOptions = withModelInputBudgetProviderOptions(
		cacheProviderOptions({
			prefixHash: stage1PrefixHash,
			segmentHashes: stage1PrefixHashes.map((entry) => entry.segmentHash),
			promptSegments: messageHandlerInput.promptSegments,
			// Keep shared-room agents and pipeline stages on separate cache slots.
			conversationId: stage1ConversationId,
		}),
		buildModelInputBudget({
			messages: messageHandlerInput.messages,
			promptSegments: messageHandlerInput.promptSegments,
			tools: messageHandlerTools,
		}),
	);

	if (!args.codingMode) {
		// RESPONSE_HANDLER_BEFORE (blocking): hooks fire right before the Stage 1
		// model call. A direct coding turn has no such model boundary.
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

		// RESPONSE_HANDLER_DURING runs only alongside a real handler model call.
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
	const createResponseGrammar = () =>
		buildResponseGrammar(
			{
				actions: args.runtime.actions ?? [],
				responseHandlerFields: sourceReplySnapshot
					? selectedResponseHandlerFields.map((field) =>
							field === replyTextFieldEvaluator
								? { ...field, schema: SOURCE_REPLY_SCHEMA }
								: field,
						)
					: selectedResponseHandlerFields,
				responseHandlerFieldSignature: sourceReplySnapshot
					? undefined
					: args.runtime.responseHandlerFieldRegistry?.composeSchemaSignature(),
			},
			{
				contexts: availableContexts.map((definition) => String(definition.id)),
				channelType:
					typeof args.message.content?.channelType === "string"
						? args.message.content.channelType
						: undefined,
			},
		);
	const responseGrammar = createResponseGrammar();

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
	// Selecting supplied originals is already a reasoning task. Waiting until
	// a history read enables reasoning can make the first call request sources
	// it already has. Keep the existing fast path when there is no projection.
	const initialHistoryReasoning = Boolean(history?.visibleEventIds.size);
	stage1ProviderOptions.eliza = {
		...((stage1ProviderOptions as { eliza?: Record<string, unknown> }).eliza ??
			{}),
		thinking: initialHistoryReasoning ? "on" : "off",
	};
	// A handler turn returns one decision or one batched context read. Parallel
	// decisions conflict rather than advance independent work; keep planner
	// tool-call concurrency separate. Providers ignoring this hint are still
	// validated by the native-response parser.
	stage1ProviderOptions.openai = {
		...((stage1ProviderOptions as { openai?: Record<string, unknown> })
			.openai ?? {}),
		parallelToolCalls: false,
	};
	let stage1ModelParams = {
		messages: messageHandlerInput.messages,
		promptSegments: messageHandlerInput.promptSegments,
		tools: messageHandlerTools,
		toolChoice: "required" as const,
		// Stage 1 packs the complete structured response and user-visible answer
		// into one generation on every channel. Let the adapter use the selected
		// provider/model maximum; an application-level ceiling can only turn a
		// valid long answer into an incomplete envelope.
		maxTokens: undefined,
		omitMaxTokens: true,
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
	if (!args.codingMode) {
		recordInferenceSpan(
			"message:stage1:preprocess",
			performance.now() - stage1PreprocessStartedAt,
		);
	} else {
		args.runtime.logger.debug?.(
			{ src: "service:message", codingMode: true },
			"Skipping Stage 1 model call for direct coding loop",
		);
	}
	const generateStage1 = async (parameters: typeof stage1ModelParams) => {
		// Capture the binding associated with these tools before asynchronous dispatch.
		const binding = sourceSelectionBinding;
		const raw = (await args.runtime.useModel(
			ModelType.RESPONSE_HANDLER,
			parameters,
		)) as string | GenerateTextResult;
		return binding ? binding.resolve(raw) : raw;
	};
	let rawMessageHandler: string | GenerateTextResult = args.codingMode
		? directCodingResponseHandlerResult()
		: await generateStage1(stage1ModelParams);
	const contextReadEnabled = () =>
		messageHandlerTools.some((tool) => tool.name === READ_CONTEXT_TOOL_NAME);
	let stage1RetryReason = extractContextRead(
		rawMessageHandler,
		contextReadEnabled(),
	)
		? null
		: getStage1RetryReason(rawMessageHandler);
	while (
		!args.codingMode &&
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
		rawMessageHandler = await generateStage1(stage1ModelParams);
		stage1RetryReason = extractContextRead(
			rawMessageHandler,
			contextReadEnabled(),
		)
			? null
			: getStage1RetryReason(rawMessageHandler);
	}
	// An explicit RESPOND without an answer or pending work gets one repaired
	// re-ask. STOP and IGNORE remain terminal in every language. The retry
	// still passes through ordinary terminal routing and reply validation.
	// Voice keeps its complete path: its spoken answer need not sit in replyText.
	if (!args.codingMode && !voiceDirectMessageChannel) {
		let usabilityDecision = extractMessageHandlerRawParsed(rawMessageHandler);
		// Source-part replies must be rendered before a string-based empty-answer
		// check. Invalid bindings still reach the ordinary history recovery path.
		if (
			sourceReplySnapshot &&
			typeof rawMessageHandler !== "string" &&
			hasHandleResponseToolCall(rawMessageHandler) &&
			usabilityDecision
		) {
			usabilityDecision =
				resolveSourceReply(context, sourceReplySnapshot, usabilityDecision) ??
				usabilityDecision;
		}
		const unusableRepair = getStage1UnusableDecisionRepair(usabilityDecision, {
			reaskTerminal: readStage1TerminalReaskSetting(args.runtime),
		});
		if (
			unusableRepair &&
			shouldUseStage1PlannerFallback(args.runtime, args.message)
		) {
			args.runtime.logger?.warn?.(
				{ src: "service:message", roomId: args.message.roomId },
				"[message] Stage 1 ended an addressed turn without an answer — one repaired re-ask",
			);
			const repairedInput = {
				...messageHandlerInput,
				messages: [
					...messageHandlerInput.messages,
					{ role: "user" as const, content: unusableRepair },
				],
				promptSegments: [
					...messageHandlerInput.promptSegments,
					{ content: unusableRepair, stable: false },
				],
			};
			const repairedHashes = computePrefixHashes(repairedInput.promptSegments);
			const repairedCacheOptions = cacheProviderOptions({
				prefixHash: stage1PrefixHash,
				segmentHashes: repairedHashes.map((entry) => entry.segmentHash),
				promptSegments: repairedInput.promptSegments,
				conversationId: stage1ConversationId,
			});
			stage1TurnSignal.throwIfAborted();
			const repaired = (await generateStage1({
				...stage1ModelParams,
				messages: repairedInput.messages,
				promptSegments: repairedInput.promptSegments,
				providerOptions: withModelInputBudgetProviderOptions(
					{
						...stage1ProviderOptions,
						...repairedCacheOptions,
						eliza: {
							...(stage1ProviderOptions.eliza as object),
							...(repairedCacheOptions.eliza as object),
						},
					},
					buildModelInputBudget({
						messages: repairedInput.messages,
						promptSegments: repairedInput.promptSegments,
						tools: messageHandlerTools,
					}),
				),
			})) as string | GenerateTextResult;
			if (extractMessageHandlerRawParsed(repaired)) {
				rawMessageHandler = repaired;
			}
		}
	}
	// A context request is an incomplete decision. Recompose through the same
	// permission/disclosure gates before another model call, and never dispatch
	// its draft, extraction fields, or action candidates. Each provider can be
	// expanded once; there is no action-planner loop for reading provider text.
	let routingRepairAttempted = false;
	let historySelectionRepairAttempted = false;
	let historyReadForDecision = false;
	while (discoveryEnabled) {
		const nativeRead = extractContextRead(
			rawMessageHandler,
			contextReadEnabled(),
		);
		let parsedDecision =
			nativeRead ?? extractMessageHandlerRawParsed(rawMessageHandler);

		const explicit = readHistoryContextRequests(
			context,
			history,
			parsedDecision,
			discovery.available,
		);
		const historyRequested = requestedHistory(
			context,
			history,
			parsedDecision,
			explicit,
			Boolean(nativeRead),
		);
		const requested = [...new Set([...explicit, ...historyRequested])];
		if (
			!nativeRead &&
			requested.length === 0 &&
			sourceReplySnapshot &&
			typeof rawMessageHandler !== "string" &&
			hasHandleResponseToolCall(rawMessageHandler) &&
			parsedDecision
		) {
			parsedDecision =
				resolveSourceReply(context, sourceReplySnapshot, parsedDecision) ??
				parsedDecision;
		}
		const routingRepair =
			!routingRepairAttempted &&
			explicit.length === 0 &&
			(requested.length === 0 ||
				canRepairIncompleteHistorySelection(context, history, parsedDecision))
				? getStage1RoutingRepair(parsedDecision)
				: undefined;
		repairHistoryIdentity =
			!routingRepair &&
			!historySelectionRepairAttempted &&
			explicit.length === 0 &&
			canRepairHistoryIdentity(context, history, parsedDecision);
		repairHistorySourceIds =
			nativeHistoryRead &&
			!routingRepair &&
			!repairHistoryIdentity &&
			!historySelectionRepairAttempted &&
			explicit.length === 0
				? repairableHistorySourceIds(context, history, parsedDecision)
				: undefined;
		const decisionRepair =
			routingRepair ??
			(repairHistorySourceIds
				? "source_label_repair: A previous completionContext entry was not a history label. Nothing from that response was processed or executed. Regenerate the decision from the supplied originals using only the history labels allowed by HANDLE_RESPONSE. Record IDs belong to tool work, not source arrays. If dialogue evidence is missing, choose READ_CONTEXT first. Do not assume the previous draft or selection was correct."
				: undefined) ??
			(repairHistoryIdentity
				? "source_identity_repair: Your previous response used a sourceSetId that does not match this request. Nothing from it was processed or executed. Regenerate HANDLE_RESPONSE for the original request using the source identity required by its schema. Review the supplied originals again; request missing history through contextRequests. Do not assume the previous selection or draft was correct."
				: undefined);
		if (requested.length === 0 && !decisionRepair) break;
		stage1TurnSignal.throwIfAborted();
		if (decisionRepair) {
			// One correction before field processors/effects. If it remains
			// contradictory, normal pending-intent guards still own routing.
			if (routingRepair) routingRepairAttempted = true;
			if (repairHistoryIdentity || repairHistorySourceIds)
				historySelectionRepairAttempted = true;
			messageHandlerInput = {
				...messageHandlerInput,
				messages: [
					...messageHandlerInput.messages,
					{ role: "user", content: decisionRepair },
				],
				promptSegments: [
					...messageHandlerInput.promptSegments,
					{
						content: decisionRepair,
						stable: false,
					},
				],
			};
		} else {
			const contextReadStartedAt = performance.now();
			for (const name of requested) {
				if (history && name.startsWith(HISTORY_REFERENCE_PREFIX)) continue;
				if (name === CONTEXT_CATALOG_REFERENCE && contextCatalog) {
					contextCatalogRead = true;
					contextCatalog.loaded = true;
				} else loadedContext.add(name);
			}
			if (contextCatalog?.loaded) {
				// Re-read role-filtered definitions for this read. Never restore an
				// old catalog after the requester's role or registrations changed.
				const role = await resolveStage1SenderRole(args.runtime, args.message);
				const current = listAvailableContextsForRole(
					args.runtime.contexts,
					role,
				);
				const refreshedCatalog = createContextCatalogReference(
					args.runtime,
					current,
				);
				if (refreshedCatalog) {
					contextCatalog = { ...refreshedCatalog, loaded: true };
				} else {
					// A small/currently empty catalog or an optimized prompt needs no
					// deferred representation. Render its complete current definitions.
					contextCatalog = undefined;
				}
				availableContexts = current;
			}
			const refreshed = await composeResponseState(
				args.runtime,
				args.message,
				true,
			);
			Object.assign(args.state, refreshed);
			const historyScope = history ?? historyReadEvidence;
			if (historyScope) {
				const currentRole = await resolveStage1SenderRole(
					args.runtime,
					args.message,
				);
				if (currentRole !== senderRole) {
					senderRole = currentRole;
					availableContexts = listAvailableContextsForRole(
						args.runtime.contexts,
						currentRole,
					);
					if (contextCatalog) {
						const freshCatalog = createContextCatalogReference(
							args.runtime,
							availableContexts,
						);
						contextCatalog = freshCatalog
							? { ...freshCatalog, loaded: contextCatalog.loaded }
							: undefined;
					}
				}
				if (
					historyScope.scope.roles.length !== 1 ||
					historyScope.scope.roles[0] !== currentRole ||
					args.runtime.providers?.some((provider) =>
						provider.name.startsWith(HISTORY_REFERENCE_PREFIX),
					)
				) {
					history = undefined;
					historyReadEvidence = undefined;
				}
			}
			const refreshedRole = await resolveStage1SenderRole(
				args.runtime,
				args.message,
			);
			const refreshedContext = await createV5MessageContextObject({
				...args,
				includeActionDiscovery: discoveryEnabled ? "reference" : true,
				userRoles: [refreshedRole],
				availableContexts,
			});
			Object.assign(context, refreshedContext, { id: context.id });
			if (history) {
				const read = loadHistoryReferences(context, history, historyRequested);
				history = read.projection;
				historyReadEvidence = read.evidence;
			}

			// Publish only a validated native read's dedicated progress field,
			// after fresh authority/state restoration and before the next inference.
			// This never dispatches extraction, actions, or a durable response.
			if (
				contextReadProgressEnabled &&
				!contextReadAcknowledgmentSent &&
				nativeRead?.acknowledgment
			) {
				const progress = sanitizeUserVisibleModelOutput(
					nativeRead.acknowledgment,
				);
				if (
					progress.kind === "text" &&
					evaluatePlannedReplyEgress({
						providers: args.state.data.providers,
						request: getUserMessageText(args.message),
						reply: progress.text,
						actionResults: [],
						actions: args.runtime.actions,
					}).verdict !== "reject"
				) {
					stage1TurnSignal.throwIfAborted();
					args.onPlanningAcknowledgment?.(
						restorePiiInUserReplyText(progress.text),
					);
					contextReadAcknowledgmentSent = true;
				}
			}
			if (historyRequested.length) historyReadForDecision = true;
			discovery = projectDiscoverableContext(
				context,
				args.state,
				loadedContext,
			);
			const restoredProviders: string[] = [];
			if (
				historyRequested.length &&
				nativeHistoryRead &&
				!voiceDirectMessageChannel
			) {
				// A missing-dialogue read can refer to recalled originals from another
				// room. Restore only freshly authorized, provider-indexed originals;
				// leave the current-room search scope and its match receipt unchanged.
				for (const event of context.events) {
					if (
						event.type === "provider" &&
						"reviewableSources" in event &&
						event.reviewableSources &&
						"name" in event &&
						typeof event.name === "string" &&
						discovery.available.has(event.name)
					) {
						loadedContext.add(event.name);
						restoredProviders.push(event.name);
					}
				}
				if (restoredProviders.length) {
					discovery = projectDiscoverableContext(
						context,
						args.state,
						loadedContext,
					);
					discovery.context = {
						...discovery.context,
						events: [
							...discovery.context.events,
							{
								id: "history-read-provider-restoration",
								type: "segment",
								source: "message-service",
								segment: {
									id: "history-read-provider-restoration",
									stable: false,
									content: `Additional authorized provider originals restored during this history read: ${JSON.stringify(restoredProviders)}. These are separate provider evidence, not matches in the current-conversation literal search.`,
								},
							},
						],
					};
				}
			}
			if (contextCatalog && !contextCatalog.loaded)
				discovery.available.add(CONTEXT_CATALOG_REFERENCE);
			for (const reference of historyReferences(context, history))
				discovery.available.add(reference);
			if (historyRequested.length)
				recordInferenceSpan(
					"message:history-reference-read",
					performance.now() - contextReadStartedAt,
					{
						requestedCount: historyRequested.length,
						fullRestoration: !history,
						restoredProviders: restoredProviders.join(","),
					},
				);
			// The read refreshed state and authority. Recheck field activity so
			// both guidance and schema reflect this new snapshot.
			responseHandlerFieldPrompt =
				await args.runtime.responseHandlerFieldRegistry.composePromptSlices({
					...responseHandlerFieldContext,
					senderRole: refreshedRole as ResponseHandlerSenderRole,
				});
			messageHandlerInput = renderMessageHandlerModelInput(
				args.runtime,
				discovery.context,
				availableContexts,
				{
					directMessage: directMessageChannel,
					voiceDirectMessage: voiceDirectMessageChannel,
					responseHandlerFields: responseHandlerFieldPrompt.rendered,
					contextCatalog,
					history,
					historyReadEvidence,
				},
			);
		}
		// Field activity was refreshed for reads; repairs reuse the earlier prompt.
		compactInactiveFields = !decisionRepair;
		messageHandlerTools = createMessageHandlerTools();
		appendSourceReplyInstructions();
		stage1PrefixHashes = computePrefixHashes(
			messageHandlerInput.promptSegments,
		);
		const stableHashes = computePrefixHashes(
			messageHandlerInput.promptSegments.filter((segment) => segment.stable),
		);
		stage1PrefixHash =
			stableHashes.at(-1)?.hash ?? hashString("context-discovery");
		const expandedCacheOptions = cacheProviderOptions({
			prefixHash: stage1PrefixHash,
			segmentHashes: stage1PrefixHashes.map((entry) => entry.segmentHash),
			promptSegments: messageHandlerInput.promptSegments,
			conversationId: stage1ConversationId,
		});
		// Full restoration returns to the ordinary selection contract. Keep the
		// actual tool schema aligned with the newly rendered history policy.
		// Keep the local decode grammar aligned with the native reply field.
		const readGrammar = createResponseGrammar();
		stage1ModelParams = {
			...stage1ModelParams,
			tools: messageHandlerTools,
			responseSkeleton: readGrammar.responseSkeleton,
			grammar: readGrammar.grammar,
			spanSamplerPlan: buildSpanSamplerPlan(readGrammar.responseSkeleton),
			messages: messageHandlerInput.messages,
			promptSegments: messageHandlerInput.promptSegments,
			providerOptions: withModelInputBudgetProviderOptions(
				{
					...stage1ProviderOptions,
					...expandedCacheOptions,
					openai: {
						...((stage1ProviderOptions as { openai?: Record<string, unknown> })
							.openai ?? {}),
						...((expandedCacheOptions as { openai?: Record<string, unknown> })
							.openai ?? {}),
					},
					eliza: {
						...(stage1ProviderOptions.eliza as object),
						...(expandedCacheOptions.eliza as object),
						// Keep source-selection reasoning through reads and repairs;
						// newly read originals also need reconciliation with recaps.
						thinking:
							initialHistoryReasoning || historyReadForDecision ? "on" : "off",
					},
				},
				buildModelInputBudget({
					messages: messageHandlerInput.messages,
					promptSegments: messageHandlerInput.promptSegments,
					tools: messageHandlerTools,
				}),
			),
		};
		args.runtime.logger.debug(
			{
				providers: requested,
				routingRepair: Boolean(routingRepair),
				historyIdentityRepair: repairHistoryIdentity,
				historySourceLabelRepair: Boolean(repairHistorySourceIds),
			},
			"[message] Resolving context or routing before final response decision",
		);
		stage1TurnSignal.throwIfAborted();
		rawMessageHandler = await generateStage1(stage1ModelParams);
	}
	const messageHandlerEndedAt = Date.now();
	// Capture the provider that served the Stage-1 (RESPONSE_HANDLER) call
	// right after it completes, before any later model call could overwrite the
	// runtime-wide last-resolved-provider, so the recorded stage names the real
	// provider instead of the fabricated "default" literal (#13623).
	const messageHandlerProvider = args.codingMode
		? undefined
		: args.runtime.getLastResolvedModelProvider?.(ModelType.RESPONSE_HANDLER);
	let rawFieldParsed = extractMessageHandlerRawParsed(rawMessageHandler);
	let sourceReplyReferences: SourceReplyReferences | undefined;
	if (
		sourceReplySnapshot &&
		typeof rawMessageHandler !== "string" &&
		hasHandleResponseToolCall(rawMessageHandler) &&
		rawFieldParsed
	) {
		const resolved = resolveSourceReply(
			context,
			sourceReplySnapshot,
			rawFieldParsed,
			(references) => {
				sourceReplyReferences = references;
			},
		);
		if (!resolved)
			throw new ElizaError(
				"Unresolved source-backed reply after history recovery",
				{ code: "STAGE1_INVALID_SOURCE_REPLY", severity: "ephemeral" },
			);
		rawFieldParsed = resolved;
	}
	if (
		routingRepairAttempted &&
		rawFieldParsed?.replyEffectStatus === "non_applied" &&
		getStage1RoutingRepair(rawFieldParsed)
	) {
		// A repeated preview/pending-work conflict cannot authorize effects or a
		// terminal reply. Keep the recorded model attempts and reject before fields.
		throw new ElizaError(
			"Stage-1 preview still declares pending work after repair; retry with a consistent routing decision",
			{
				code: "STAGE1_ROUTING_CONFLICT",
				context: { messageId: args.message.id },
			},
		);
	}
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
		continuationResolvedMessageText ??
		getActionInferenceMessageText(args.message);
	if (continuationResolvedMessageText) {
		args.runtime.logger?.debug?.(
			{ src: "service:message" },
			"[message] continuation turn resolved to prior user request for candidate inference",
		);
	}
	let fieldRunResult: ResponseHandlerFieldRunResult | null = null;
	let messageHandler: MessageHandlerResult | null = null;
	if (rawFieldParsed) {
		const normalizedRawParsed =
			normalizeRawParsedForFieldRegistry(rawFieldParsed);
		fieldRunResult = await timeInferenceSpan(
			"evaluators:response-handler-fields",
			() =>
				args.runtime.responseHandlerFieldRegistry.dispatch({
					rawParsed: normalizedRawParsed,
					runtime: args.runtime,
					message: args.message,
					state: args.state,
					senderRole: senderRole as ResponseHandlerSenderRole,
					turnSignal: stage1TurnSignal,
				}),
		);
		messageHandler = messageHandlerFromFieldResult(
			{
				...fieldRunResult.parsed,
				// Registry defaults are not an explicit model no-effect decision.
				// Keep missing/malformed statuses conservative without discarding
				// pending or applied statuses produced by field evaluators.
				replyEffectStatus:
					fieldRunResult.parsed.replyEffectStatus === "none" &&
					!(
						typeof normalizedRawParsed.replyEffectStatus === "string" &&
						normalizedRawParsed.replyEffectStatus.trim().toLowerCase() ===
							"none"
					)
						? undefined
						: fieldRunResult.parsed.replyEffectStatus,
			},
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
	if (!args.codingMode) {
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
	}

	if (!messageHandler) {
		if (isEmptyStage1Result(rawMessageHandler)) {
			throw new Error(
				`v5 messageHandler returned empty Stage 1 result after ${stage1RetryLimit + 1} attempts`,
			);
		}
		throw new Error("v5 messageHandler returned invalid MessageHandlerResult");
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
	args.onStage1Decision?.({
		...(trajectoryId ? { trajectoryId } : {}),
		provider: messageHandlerProvider,
		prefixHash: stage1PrefixHash,
		decision: messageHandler.processMessage,
		// Evaluators may patch the live handler later. Preserve the exact model
		// boundary value observed here instead of exposing a mutable alias.
		parsed: structuredClone(messageHandler),
	});

	if (!args.codingMode && recorder && trajectoryId) {
		registerStageTask(
			recordMessageHandlerStage({
				recorder,
				trajectoryId,
				messages: messageHandlerInput.messages,
				tools: messageHandlerTools,
				toolChoice: "required",
				providerOptions: stage1ModelParams.providerOptions,
				raw: rawMessageHandler,
				parsed: messageHandler,
				startedAt: messageHandlerStartedAt,
				endedAt: messageHandlerEndedAt,
				segmentHashes: stage1PrefixHashes.map((entry) => entry.segmentHash),
				prefixHash: stage1PrefixHash,
				provider: messageHandlerProvider,
				state: args.state,
				runtime: args.runtime,
			}),
		);
	}

	const rawProviderReview = rawFieldParsed?.providerReview;
	return {
		messageHandler,
		providerReview:
			providerReviewSourceSetId &&
			typeof rawMessageHandler !== "string" &&
			hasHandleResponseToolCall(rawMessageHandler) &&
			rawProviderReview &&
			typeof rawProviderReview === "object" &&
			!Array.isArray(rawProviderReview) &&
			Object.keys(rawProviderReview).every(
				(key) => key === "complete" || key === "keep",
			)
				? ({
						...rawProviderReview,
						sourceSetId: providerReviewSourceSetId,
					} as JsonValue)
				: undefined,
		contextReadAcknowledgmentSent,
		providerDiscoveryEnabled: discoveryEnabled,
		loadedContextProviders: [...loadedContext],
		historyReadEvidence,
		contextCatalogRead,
		fieldRunResult,
		inferenceMessageText,
		parsedResponseHandlerReply,
		sourceReplyReferences,
		messageHandlerEndedAt,
	};
}
