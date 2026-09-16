/** Owns message-turn admission, preemption, terminal events, and the per-room delivered-reply persistence barrier. Response processing is a typed collaborator and each service instance owns its own pending writes. */

import { v4 } from "uuid";
import { ElizaError } from "../../errors";
import {
	emitInferenceTiming,
	getInferenceTimer,
	InferenceTurnTimer,
	nextInferenceTurnId,
	runWithInferenceTiming,
	timeInferenceSpan,
} from "../../inference-timing";
import { logger } from "../../logger";
import { parseCodingActionProfile } from "../../runtime/coding-action-profile";
import { resolveTraceCorrelationFromEnv } from "../../runtime/trace-correlation";
import { createOutboundEnvelopeStreamLatch } from "../../security/outbound-envelope-guard";
import {
	attestDeliveryAudienceFromCanonicalRoom,
	ownerExclusiveDisclosureWasUsed,
	trustedDeliveryAudienceIsBoundToRuntime,
} from "../../security/trusted-delivery-audience";
import {
	getModelStreamChunkDeliveryDepth,
	runWithStreamingContext,
	type StreamingContext,
} from "../../streaming-context";
import {
	getTrajectoryContext,
	runWithTrajectoryContext,
} from "../../trajectory-context";
import type {
	HandlerCallback,
	StreamChunkCallback,
} from "../../types/components";
import type { RunEventPayload } from "../../types/events";
import { EventType } from "../../types/events";
import type { Memory } from "../../types/memory";
import type {
	MessageProcessingOptions,
	MessageProcessingResult,
} from "../../types/message-service";
import { ModelType } from "../../types/model";
import { modelStreamChunkPipelineHookContext } from "../../types/pipeline-hooks";
import type { UUID } from "../../types/primitives";
import { asUUID, ContentType } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import type {
	StreamingContextEventPayload,
	StreamingEvaluationPayload,
	StreamingToolCallPayload,
	StreamingToolResultPayload,
} from "../../types/streaming";
import { parseBooleanFromText } from "../../utils";
import {
	createFirstSentenceStreamTracker,
	extractFirstSentence,
} from "../../utils/text-splitting";
import { maybeHandleAnalysisActivation } from "../analysis-mode-handler";
import { resolveStage1SenderRole } from "./addressing.js";
import type { ResolvedMessageOptions } from "./contracts.js";
import {
	buildTextToSpeechParams,
	deliverFirstSentenceVoice,
	wrapSingleTurnVisibleCallback,
} from "./delivery.js";
import { persistInferenceTimingSummary } from "./inference-timing.js";
import type { MessageProcessor } from "./processor.js";
import { normalizeVisibleTextForDuplicateCheck } from "./reply-policy.js";
import {
	mergeAbortSignals,
	normalizeShouldRespondModelType,
} from "./turn-admission.js";
import {
	clearLatestResponseId,
	detachPostDeliverySideEffect,
	latestResponseIds,
	MessageRunTerminalOwner,
} from "./turn-session.js";

export interface MessageTurnLifetimeHost {
	processMessage(
		...args: Parameters<MessageProcessor["processMessage"]>
	): ReturnType<MessageProcessor["processMessage"]>;
}

export class MessageTurnLifetime {
	constructor(private readonly host: MessageTurnLifetimeHost) {}

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

	pendingReplyPersistKey(runtime: IAgentRuntime, roomId: UUID): string {
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
	registerPendingReplyPersist(
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
	async awaitDeliveredReplyPersistence(
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
		// Validate trusted host policy before touching the message, runtime events,
		// action hooks, or callbacks. A profile is meaningful only on the explicit
		// direct coding path; accepting it elsewhere would make telemetry claim a
		// restriction that ordinary routing never applied.
		const codingActionProfile = parseCodingActionProfile(
			options?.codingActionProfile,
		);
		if (codingActionProfile && options?.codingMode !== true) {
			throw new ElizaError(
				"Coding action profile requires codingMode to be enabled",
				{
					code: "CODING_ACTION_PROFILE_REQUIRES_CODING_MODE",
					context: { kind: codingActionProfile.kind },
				},
			);
		}
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
					codingMode: options?.codingMode === true,
					...(codingActionProfile ? { codingActionProfile } : {}),
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
									this.host.processMessage(
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
}
