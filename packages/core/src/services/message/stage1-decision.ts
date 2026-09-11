/** Builds the complete Stage 1 request, performs bounded empty-output retries, and validates the response decision. Registers diagnostic persistence with the outer turn before handing control to routing and planning. */

import {
	createHandleResponseTool,
	HANDLE_RESPONSE_TOOL_NAME,
} from "../../actions/to-tool";
import { recordInferenceSpan, timeInferenceSpan } from "../../inference-timing";
import { getCandidateActionBackstopRules } from "../../runtime/candidate-action-backstop";
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
import type { GenerateTextResult } from "../../types/model";
import { ModelType } from "../../types/model";
import { ChannelType } from "../../types/primitives";
import { CODING_SUB_AGENT_CONTEXTS } from "./action-surface.js";
import type {
	listAvailableContextsForRole,
	resolveStage1SenderRole,
} from "./addressing.js";
import { createV5MessageContextObject } from "./context-assembly.js";
import {
	projectDiscoverableContext,
	readContextRequests,
} from "./context-discovery.js";
import {
	getActionInferenceMessageText,
	isSubAgentCompletionArtifact,
	resolveContinuationInferenceMessageText,
} from "./dialogue-context.js";
import { composeResponseState } from "./provider-state.js";
import {
	getStage1FinishReason,
	stage1HitCompletionLimit,
	synthesizeStage1CompletionLimitReply,
} from "./stage1-completion.js";
import {
	getStage1RetryReason,
	isEmptyStage1Result,
	parseMessageHandlerModelOutput,
	readStage1EmptyRetryLimit,
	shouldRetryStage1Generation,
	shouldUseStage1PlannerFallback,
	synthesizePlannerFallbackFromStage1Failure,
} from "./stage1-generation.js";
import { renderMessageHandlerModelInput } from "./stage1-input.js";
import {
	extractMessageHandlerRawParsed,
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
	const responseHandlerFieldPrompt =
		await args.runtime.responseHandlerFieldRegistry.composePromptSlices(
			responseHandlerFieldContext,
		);
	const responseHandlerSchema =
		args.runtime.responseHandlerFieldRegistry.composeSchema();
	const loadedContext = new Set<string>();
	const discoveryEnabled =
		directMessageChannel && !voiceDirectMessageChannel && !args.codingMode;
	let discovery = discoveryEnabled
		? projectDiscoverableContext(context, args.state, loadedContext)
		: { context, available: new Set<string>() };
	let messageHandlerInput = renderMessageHandlerModelInput(
		args.runtime,
		discovery.context,
		availableContexts,
		{
			directMessage: directMessageChannel,
			voiceDirectMessage: voiceDirectMessageChannel,
			responseHandlerFields: responseHandlerFieldPrompt.rendered,
		},
	);
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
		...((stage1ProviderOptions as { eliza?: Record<string, unknown> }).eliza ??
			{}),
		thinking: "off",
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
	let rawMessageHandler: string | GenerateTextResult = args.codingMode
		? directCodingResponseHandlerResult()
		: ((await args.runtime.useModel(
				ModelType.RESPONSE_HANDLER,
				stage1ModelParams,
			)) as string | GenerateTextResult);
	let stage1RetryReason = getStage1RetryReason(rawMessageHandler);
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
		rawMessageHandler = (await args.runtime.useModel(
			ModelType.RESPONSE_HANDLER,
			stage1ModelParams,
		)) as string | GenerateTextResult;
		stage1RetryReason = getStage1RetryReason(rawMessageHandler);
	}
	// A context request is an incomplete decision. Recompose through the same
	// permission/disclosure gates before another model call, and never dispatch
	// its draft, extraction fields, or action candidates. Each provider can be
	// expanded once; there is no action-planner loop for reading provider text.
	while (discoveryEnabled) {
		const requested = readContextRequests(
			extractMessageHandlerRawParsed(rawMessageHandler),
			discovery.available,
		);
		if (requested.length === 0) break;
		stage1TurnSignal.throwIfAborted();
		for (const name of requested) loadedContext.add(name);
		const refreshed = await composeResponseState(
			args.runtime,
			args.message,
			true,
		);
		Object.assign(args.state, refreshed);
		const refreshedContext = await createV5MessageContextObject({
			...args,
			userRoles: [senderRole],
			availableContexts,
		});
		Object.assign(context, refreshedContext, { id: context.id });
		discovery = projectDiscoverableContext(context, args.state, loadedContext);
		messageHandlerInput = renderMessageHandlerModelInput(
			args.runtime,
			discovery.context,
			availableContexts,
			{
				directMessage: directMessageChannel,
				voiceDirectMessage: voiceDirectMessageChannel,
				responseHandlerFields: responseHandlerFieldPrompt.rendered,
			},
		);
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
			conversationId: args.message.roomId
				? String(args.message.roomId)
				: undefined,
		});
		stage1ModelParams = {
			...stage1ModelParams,
			messages: messageHandlerInput.messages,
			promptSegments: messageHandlerInput.promptSegments,
			providerOptions: withModelInputBudgetProviderOptions(
				{
					...stage1ProviderOptions,
					...expandedCacheOptions,
					eliza: {
						...(stage1ProviderOptions.eliza as object),
						...(expandedCacheOptions.eliza as object),
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
			{ providers: requested },
			"[message] Expanding requested context before final response decision",
		);
		stage1TurnSignal.throwIfAborted();
		rawMessageHandler = (await args.runtime.useModel(
			ModelType.RESPONSE_HANDLER,
			stage1ModelParams,
		)) as string | GenerateTextResult;
	}
	const messageHandlerEndedAt = Date.now();
	// Capture the provider that served the Stage-1 (RESPONSE_HANDLER) call
	// right after it completes, before any later model call could overwrite the
	// runtime-wide last-resolved-provider, so the recorded stage names the real
	// provider instead of the fabricated "default" literal (#13623).
	const messageHandlerProvider = args.codingMode
		? undefined
		: args.runtime.getLastResolvedModelProvider?.(ModelType.RESPONSE_HANDLER);
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

	return {
		messageHandler,
		providerDiscoveryEnabled: discoveryEnabled,
		loadedContextProviders: [...loadedContext],
		fieldRunResult,
		inferenceMessageText,
		parsedResponseHandlerReply,
		messageHandlerEndedAt,
	};
}
