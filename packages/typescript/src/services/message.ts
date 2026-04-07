import { v4 } from "uuid";
import { parseActionParams } from "../actions";
import { createUniqueUuid } from "../entities";
import { logger } from "../logger";
import {
	imageDescriptionTemplate,
	messageHandlerTemplate,
	multiStepDecisionTemplate,
	multiStepSummaryTemplate,
	postActionDecisionTemplate,
	shouldRespondTemplate,
} from "../prompts";
import { runWithStreamingContext } from "../streaming-context";
import { runWithTrajectoryContext } from "../trajectory-context";
import type {
	Action,
	ActionResult,
	HandlerCallback,
} from "../types/components";
import type { Room } from "../types/environment";
import type { RunEventPayload } from "../types/events";
import { EventType } from "../types/events";
import type { Memory } from "../types/memory";
import type {
	IMessageService,
	MessageProcessingOptions,
	MessageProcessingResult,
	ResponseDecision,
} from "../types/message-service";
import type {
	GenerateTextAttachment,
	TextToSpeechParams,
} from "../types/model";
import { ModelType } from "../types/model";
import type { Content, Media, MentionContext, UUID } from "../types/primitives";
import { asUUID, ChannelType, ContentType } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";
import {
	composePromptFromState,
	getLocalServerUrl,
	parseBooleanFromText,
	parseKeyValueXml,
	truncateToCompleteSentence,
} from "../utils";
import {
	createStreamingContext,
	MarkableExtractor,
	ResponseStreamExtractor,
} from "../utils/streaming";
import {
	extractFirstSentence,
	hasFirstSentence,
} from "../utils/text-splitting";

/**
 * Reserved XML response keys that are NOT action names.
 * Used when scanning parsedXml for standalone action param blocks.
 */
export const RESERVED_XML_KEYS = new Set([
	"actions",
	"thought",
	"text",
	"simple",
	"providers",
]);

/**
 * Extract action params from standalone XML blocks in a parsedXml object.
 *
 * When the LLM outputs `<actions>REPLY,START_CODING_TASK</actions>` alongside
 * `<START_CODING_TASK><repo>...</repo></START_CODING_TASK>`, the XML parser
 * puts the action block as a top-level key on parsedXml. This function finds
 * those keys and assembles them into the legacy flat params format that
 * `parseActionParams` consumes.
 *
 * Returns the assembled params string, or empty string if none found.
 */
export function extractStandaloneActionParams(
	actionNames: string[],
	parsedXml: Record<string, unknown>,
): string {
	const fragments: string[] = [];
	for (const actionName of actionNames) {
		const upperName = actionName.toUpperCase();
		const matchingKey = Object.keys(parsedXml).find(
			(k) => k.toUpperCase() === upperName,
		);
		if (
			matchingKey &&
			!RESERVED_XML_KEYS.has(matchingKey.toLowerCase()) &&
			typeof parsedXml[matchingKey] === "string" &&
			(parsedXml[matchingKey] as string).includes("<")
		) {
			fragments.push(`<${upperName}>${parsedXml[matchingKey]}</${upperName}>`);
		}
	}
	return fragments.join("\n");
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
function escapeHandlebars(text: string): string {
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
		const { _data: _discardData, _mimeType: _discardMimeType, ...rest } =
			attachment as MediaWithInlineData;
		return rest;
	});
}

function resolvePromptAttachments(
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

import type { ShouldRespondModelType } from "../types/message-service";

/**
 * Resolved message options with defaults applied.
 * Required numeric options + optional streaming callback.
 */
type ResolvedMessageOptions = {
	maxRetries: number;
	timeoutDuration: number;
	useMultiStep: boolean;
	maxMultiStepIterations: number;
	continueAfterActions: boolean;
	onStreamChunk?: (chunk: string, messageId?: string) => Promise<void>;
	shouldRespondModel: ShouldRespondModelType;
};

/**
 * Multi-step workflow action result with action name tracking
 */
interface MultiStepActionResult extends ActionResult {
	data: { actionName: string };
}

/**
 * Multi-step workflow state - uses standard State since StateData.actionResults
 * already supports ActionResult[] properly
 */
type MultiStepState = State;

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
 * Tracks the latest response ID per agent+room to handle message superseding
 */
const latestResponseIds = new Map<string, Map<string, string>>();

export function isSimpleReplyResponse(
	responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
	return !!(
		responseContent?.actions &&
		responseContent.actions.length === 1 &&
		typeof responseContent.actions[0] === "string" &&
		responseContent.actions[0].toUpperCase() === "REPLY"
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

function shouldContinueAfterActions(
	responseContent: Content | null | undefined,
): boolean {
	// Actions that handle their own async work and should not trigger
	// post-action continuation loops (which generate noisy follow-up messages).
	const terminalActions = new Set([
		"REPLY", "IGNORE", "STOP", "CREATE_TASK", "START_CODING_TASK",
		"CODE_TASK", "SPAWN_AGENT", "SPAWN_CODING_AGENT",
	]);
	return !!responseContent?.actions?.some((action) => {
		if (typeof action !== "string") return false;
		return !terminalActions.has(action.trim().toUpperCase());
	});
}

function formatActionResultsForPrompt(actionResults: ActionResult[]): string {
	if (actionResults.length === 0) {
		return "No action results available.";
	}

	return [
		"# Action Results",
		...actionResults.map((result, index) => {
			const actionNameValue = result.data?.actionName;
			const actionName =
				typeof actionNameValue === "string"
					? actionNameValue
					: "Unknown Action";
			const lines = [
				`${index + 1}. ${actionName} - ${result.success === false ? "failed" : "succeeded"}`,
			];
			if (typeof result.text === "string" && result.text.trim()) {
				lines.push(`Output: ${result.text.trim().slice(0, 2000)}`);
			}
			if (result.error) {
				const errorText =
					result.error instanceof Error
						? result.error.message
						: String(result.error);
				lines.push(`Error: ${errorText.slice(0, 1000)}`);
			}
			return lines.join("\n");
		}),
	].join("\n\n");
}

function withActionResults(state: State, actionResults: ActionResult[]): State {
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

/**
 * Default implementation of the MessageService interface.
 * This service handles the complete message processing pipeline including:
 * - Message validation and memory creation
 * - Smart response decision (shouldRespond)
 * - Single-shot or multi-step processing strategies
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
		const trajectoryStepId =
			typeof message.metadata === "object" &&
			message.metadata !== null &&
			"trajectoryStepId" in message.metadata
				? (message.metadata as { trajectoryStepId?: string }).trajectoryStepId
				: undefined;

		return await runWithTrajectoryContext<MessageProcessingResult>(
			typeof trajectoryStepId === "string" && trajectoryStepId.trim() !== ""
				? { trajectoryStepId: trajectoryStepId.trim() }
				: undefined,
			async (): Promise<MessageProcessingResult> => {
				// Determine shouldRespondModel from options or runtime settings
				const shouldRespondModelSetting = runtime.getSetting(
					"SHOULD_RESPOND_MODEL",
				);
				const resolvedShouldRespondModel: ShouldRespondModelType =
					options?.shouldRespondModel ??
					(shouldRespondModelSetting === "large" ? "large" : "small");

				const opts: ResolvedMessageOptions = {
					maxRetries: options?.maxRetries ?? 3,
					timeoutDuration: options?.timeoutDuration ?? 60 * 60 * 1000, // 1 hour
					useMultiStep:
						options?.useMultiStep ??
						parseBooleanFromText(
							String(runtime.getSetting("USE_MULTI_STEP") ?? ""),
						),
					maxMultiStepIterations:
						options?.maxMultiStepIterations ??
						parseInt(
							String(runtime.getSetting("MAX_MULTISTEP_ITERATIONS") ?? "6"),
							10,
						),
					continueAfterActions:
						options?.continueAfterActions ??
						parseBooleanFromText(
							String(runtime.getSetting("CONTINUE_AFTER_ACTIONS") ?? "true"),
						),
					onStreamChunk: options?.onStreamChunk,
					shouldRespondModel: resolvedShouldRespondModel,
				};

				// Set up timeout monitoring
				let timeoutId: NodeJS.Timeout | undefined;
				// Single ID used for tracking, streaming, and the final message
				const responseId = asUUID(v4());

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

					// Wrap processing with streaming context for automatic streaming in useModel calls
					// Use ResponseStreamExtractor to filter XML and only stream <text> (if REPLY) or <message>
					let streamingContext:
						| {
								onStreamChunk: (
									chunk: string,
									messageId?: string,
								) => Promise<void>;
								messageId?: string;
						  }
						| undefined;
					// Voice handling state
					let firstSentenceSent = false;
					let firstSentenceText = "";

					if (opts.onStreamChunk) {
						const extractor = new ResponseStreamExtractor();
						const onStreamChunk = opts.onStreamChunk;

						let streamText = "";

						streamingContext = {
							onStreamChunk: async (chunk: string, msgId?: string) => {
								if (extractor.done) return;
								const textToStream = extractor.push(chunk);
								if (textToStream) {
									streamText += textToStream;

									// Check for first sentence to send to voice
									if (!firstSentenceSent && hasFirstSentence(streamText)) {
										const { first } = extractFirstSentence(streamText);
										firstSentenceText = first;
										if (first.length > 5) {
											// Minimal length check
											firstSentenceSent = true;

											// Process voice in background
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

									await onStreamChunk(textToStream, msgId);
								}
							},
							messageId: responseId,
						};
					}

					const processingPromise = runWithStreamingContext(
						streamingContext,
						() =>
							this.processMessage(
								runtime,
								message,
								callback,
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

									if (audioBuffer && callback) {
										const audioBase64 = audioBuffer.toString("base64");
										await callback({
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
					const agentMap = latestResponseIds.get(runtime.agentId);
					if (agentMap) {
						agentMap.delete(message.roomId);
						if (agentMap.size === 0) {
							latestResponseIds.delete(runtime.agentId);
						}
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
		if (
			agentUserState === "MUTED" &&
			message.content.text &&
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

		// Compose initial state
		let state = await runtime.composeState(
			message,
			["ANXIETY", "ENTITIES", "CHARACTER", "RECENT_MESSAGES", "ACTIONS"],
			true,
			false,
		);

		// Get room and mention context
		const mentionContext = message.content.mentionContext;
		const room = await runtime.getRoom(message.roomId);

		// Process attachments before deciding to respond
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

		const promptAttachments = resolvePromptAttachments(message.content.attachments);

		let shouldRespondToMessage = true;
		let terminalDecision: "IGNORE" | "STOP" | null = null;
		const metadata =
			typeof message.content.metadata === "object" &&
			message.content.metadata !== null
				? (message.content.metadata as Record<string, unknown>)
				: null;
		const isAutonomous = metadata?.isAutonomous === true;
		const autonomyMode =
			typeof metadata?.autonomyMode === "string" ? metadata.autonomyMode : null;

		if (isAutonomous) {
			runtime.logger.debug(
				{ src: "service:message", autonomyMode },
				"Autonomy message bypassing shouldRespond checks",
			);
			shouldRespondToMessage = true;
		} else {
			// Check if shouldRespond evaluation is enabled
			const checkShouldRespondEnabled = runtime.isCheckShouldRespondEnabled();

			// Determine if we should respond
			const responseDecision = this.shouldRespond(
				runtime,
				message,
				room ?? undefined,
				mentionContext,
			);

			runtime.logger.debug(
				{ src: "service:message", responseDecision, checkShouldRespondEnabled },
				"Response decision",
			);

			// If checkShouldRespond is disabled, always respond (ChatGPT mode)
			if (!checkShouldRespondEnabled) {
				runtime.logger.debug(
					{ src: "service:message" },
					"checkShouldRespond disabled, always responding (ChatGPT mode)",
				);
				shouldRespondToMessage = true;
			} else if (responseDecision.skipEvaluation) {
				// If we can skip the evaluation, use the decision directly
				runtime.logger.debug(
					{
						src: "service:message",
						agentName: runtime.character.name ?? "Agent",
						reason: responseDecision.reason,
					},
					"Skipping LLM evaluation",
				);
				shouldRespondToMessage = responseDecision.shouldRespond;
			} else {
				// Need LLM evaluation for ambiguous case
				const _shouldRespondPrompt = composePromptFromState({
					state,
					template:
						runtime.character.templates?.shouldRespondTemplate ||
						shouldRespondTemplate,
				});

				// Select model based on configuration - "large" enables better context analysis and planning
				const _shouldRespondModelType =
					opts.shouldRespondModel === "large"
						? ModelType.TEXT_LARGE
						: ModelType.TEXT_SMALL;

				runtime.logger.debug(
					{
						src: "service:message",
						agentName: runtime.character.name ?? "Agent",
						reason: responseDecision.reason,
						model: opts.shouldRespondModel,
					},
					"Using LLM evaluation",
				);

				// Use dynamicPromptExecFromState for structured output with validation
				const responseObject = await runtime.dynamicPromptExecFromState({
					state,
					params: {
						prompt:
							runtime.character.templates?.shouldRespondTemplate ||
							shouldRespondTemplate,
						...(promptAttachments ? { attachments: promptAttachments } : {}),
					},
					schema: [
						// Decision schema - no streaming, no per-field validation needed
						// WHY: This is internal decision-making, not user-facing output
						{
							field: "name",
							description: "The name of the agent responding",
							validateField: false,
							streamField: false,
						},
						{
							field: "reasoning",
							description: "Your reasoning for this decision",
							validateField: false,
							streamField: false,
						},
						{
							field: "action",
							description: "RESPOND | IGNORE | STOP",
							validateField: false,
							streamField: false,
						},
					],
					options: {
						contextCheckLevel: 0, // Set to 0 for now
						modelSize: opts.shouldRespondModel === "large" ? "large" : "small",
						preferredEncapsulation: "toon",
					},
				});

				runtime.logger.debug(
					{ src: "service:message", responseObject },
					"Parsed evaluation result",
				);

				// A classifier output can either continue the turn or terminate it.
				const nonResponseActions = ["IGNORE", "NONE", "STOP"];
				const actionValue = responseObject?.action;
				if (
					typeof actionValue === "string" &&
					(actionValue.toUpperCase() === "IGNORE" ||
						actionValue.toUpperCase() === "STOP")
				) {
					terminalDecision = actionValue.toUpperCase() as "IGNORE" | "STOP";
				}
				shouldRespondToMessage =
					typeof actionValue === "string" &&
					!nonResponseActions.includes(actionValue.toUpperCase());
			}
		}

		let responseContent: Content | null = null;
		let responseMessages: Memory[] = [];
		let mode: StrategyMode = "none";

		if (shouldRespondToMessage) {
			const result = opts.useMultiStep
				? await this.runMultiStepCore(
						runtime,
						message,
						state,
						callback,
						opts,
						responseId,
						promptAttachments,
					)
				: await this.runSingleShotCore(
						runtime,
						message,
						state,
						opts,
						responseId,
						promptAttachments,
					);

			responseContent = result.responseContent;
			responseMessages = result.responseMessages;
			state = result.state;
			mode = result.mode;

			// Race check before we send anything
			const currentResponseId = agentResponses.get(message.roomId);
			if (currentResponseId !== responseId) {
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

			if (responseContent && message.id) {
				responseContent.inReplyTo = createUniqueUuid(runtime, message.id);
			}

			if (responseContent?.providers && responseContent.providers.length > 0) {
				state = await runtime.composeState(
					message,
					responseContent.providers,
					false,
					false,
				);
			}

			// Save response memory to database
			if (responseMessages.length > 0) {
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

					// Emit MESSAGE_SENT event after saving to memory
					await runtime.emitEvent(EventType.MESSAGE_SENT, {
						runtime,
						message: responseMemory,
						source: message.content.source ?? "messageHandler",
					});
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
					if (callback) {
						// Redact any secrets from response content before sending
						if (responseContent.text) {
							responseContent.text = runtime.redactSecrets(
								responseContent.text,
							);
						}
						await callback(responseContent);
					}
				} else if (mode === "actions") {
					// Pass onStreamChunk to processActions so each action can manage its own streaming context
					await runtime.processActions(
						message,
						responseMessages,
						state,
						async (content) => {
							runtime.logger.debug(
								{ src: "service:message", content },
								"Action callback",
							);
							if (responseContent) {
								responseContent.actionCallbacks = content;
							}
							if (callback) {
								return callback(content);
							}
							return [];
						},
						{ onStreamChunk: opts.onStreamChunk },
					);

					if (
						opts.continueAfterActions &&
						message.id &&
						shouldContinueAfterActions(responseContent)
					) {
						const continuation = await this.runPostActionContinuation(
							runtime,
							message,
							state,
							callback,
							opts,
							runtime.getActionResults(message.id),
						);
						if (continuation.responseMessages.length > 0) {
							responseMessages = [
								...responseMessages,
								...continuation.responseMessages,
							];
						}
						if (continuation.responseContent) {
							responseContent = continuation.responseContent;
							mode = continuation.mode;
						}
						state = continuation.state;
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
			const keepResp = parseBooleanFromText(
				String(runtime.getSetting("BASIC_CAPABILITIES_KEEP_RESP") || ""),
			);

			if (currentResponseId !== responseId && !keepResp) {
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

			// Call the callback with the terminal content
			if (callback) {
				await callback(terminalContent);
			}

			// Save this terminal action/thought to memory
			const terminalMemory: Memory = {
				id: asUUID(v4()),
				entityId: runtime.agentId,
				agentId: runtime.agentId,
				content: terminalContent,
				roomId: message.roomId,
				createdAt: Date.now(),
			};
			await runtime.createMemory(terminalMemory, "messages");
			runtime.logger.debug(
				{ src: "service:message", memoryId: terminalMemory.id },
				"Saved terminal response to memory",
			);
		}

		// Clean up the response ID
		agentResponses.delete(message.roomId);
		if (agentResponses.size === 0) {
			latestResponseIds.delete(runtime.agentId);
		}

		const didRespond =
			shouldRespondToMessage && !isStopResponse(responseContent);

		// Run evaluators — fire-and-forget for streaming HTTP sources so the SSE
		// response can close even if evaluators stall (e.g. auth error on TEXT_LARGE).
		const runEvaluate = () =>
			runtime.evaluate(
				message,
				state,
				didRespond,
				async (content) => {
					runtime.logger.debug(
						{ src: "service:message", content },
						"Evaluate callback",
					);
					if (responseContent) {
						responseContent.evalCallbacks = content;
					}
					if (callback) {
						if (content.text) {
							content.text = runtime.redactSecrets(content.text);
						}
						return callback(content);
					}
					return [];
				},
				responseMessages,
			);

		const source = message.content?.source;
		if (source === "client_chat" || source === "client_direct") {
			void runEvaluate().catch((err) => {
				runtime.logger.warn(
					{ err, src: "service:message" },
					"Deferred evaluate failed",
				);
			});
		} else {
			await runEvaluate();
		}

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
	): ResponseDecision {
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
			runtime.getSetting("ALWAYS_RESPOND_CHANNELS") ||
				runtime.getSetting("SHOULD_RESPOND_BYPASS_TYPES"),
		);
		const customSources = normalizeEnvList(
			runtime.getSetting("ALWAYS_RESPOND_SOURCES") ||
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

		// 4. All other cases: let the LLM decide
		return {
			shouldRespond: false,
			skipEvaluation: false,
			reason: "needs LLM evaluation",
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

					const response = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
						prompt: imageDescriptionTemplate,
						imageUrl,
					});

					if (typeof response === "string") {
						const parsedXml = parseKeyValueXml(response);

						if (parsedXml && (parsedXml.description || parsedXml.text)) {
							processedAttachment.description =
								(typeof parsedXml.description === "string"
									? parsedXml.description
									: "") || "";
							processedAttachment.title =
								(typeof parsedXml.title === "string"
									? parsedXml.title
									: "Image") || "Image";
							processedAttachment.text =
								(typeof parsedXml.text === "string" ? parsedXml.text : "") ||
								(typeof parsedXml.description === "string"
									? parsedXml.description
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
							// Fallback: Try simple regex parsing
							const responseStr = response as string;
							const titleMatch = responseStr.match(/<title>([^<]+)<\/title>/);
							const descMatch = responseStr.match(
								/<description>([^<]+)<\/description>/,
							);
							const textMatch = responseStr.match(/<text>([^<]+)<\/text>/);

							if (titleMatch || descMatch || textMatch) {
								processedAttachment.title = titleMatch?.[1] || "Image";
								processedAttachment.description = descMatch?.[1] || "";
								processedAttachment.text =
									textMatch?.[1] || descMatch?.[1] || "";

								runtime.logger.debug(
									{
										src: "service:message",
										descriptionPreview:
											processedAttachment.description?.substring(0, 100),
									},
									"Used fallback XML parsing for description",
								);
							} else {
								runtime.logger.warn(
									{ src: "service:message" },
									"Failed to parse XML response for image description",
								);
							}
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

	private async runPostActionContinuation(
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		callback: HandlerCallback | undefined,
		opts: ResolvedMessageOptions,
		initialActionResults: ActionResult[],
	): Promise<StrategyResult> {
		if (!message.id || initialActionResults.length === 0) {
			return {
				responseContent: null,
				responseMessages: [],
				state,
				mode: "none",
			};
		}

		const traceActionResults: ActionResult[] = [...initialActionResults];
		const responseMessages: Memory[] = [];
		let accumulatedState = state;
		let responseContent: Content | null = null;

		for (
			let iterationCount = 0;
			iterationCount < opts.maxMultiStepIterations;
			iterationCount++
		) {
			accumulatedState = withActionResults(
				await runtime.composeState(message, ["ACTIONS"], false, false),
				traceActionResults,
			);

			const continuation = await this.runSingleShotCore(
				runtime,
				message,
				accumulatedState,
				opts,
				asUUID(v4()),
				resolvePromptAttachments(message.content.attachments),
				{
					prompt:
						runtime.character.templates?.postActionDecisionTemplate ||
						postActionDecisionTemplate,
					precomposedState: accumulatedState,
				},
			);

			if (!continuation.responseContent) {
				runtime.logger.debug(
					{ src: "service:message", iteration: iterationCount + 1 },
					"Post-action continuation produced no response",
				);
				break;
			}

			responseContent = continuation.responseContent;
			if (message.id) {
				responseContent.inReplyTo = createUniqueUuid(runtime, message.id);
			}

			if (responseContent.providers && responseContent.providers.length > 0) {
				accumulatedState = withActionResults(
					await runtime.composeState(
						message,
						responseContent.providers,
						false,
						false,
					),
					traceActionResults,
				);
			} else {
				accumulatedState = withActionResults(
					continuation.state,
					traceActionResults,
				);
			}

			if (continuation.responseMessages.length > 0) {
				for (const responseMemory of continuation.responseMessages) {
					responseMemory.content = responseContent;
					await runtime.createMemory(responseMemory, "messages");
					await runtime.emitEvent(EventType.MESSAGE_SENT, {
						runtime,
						message: responseMemory,
						source: message.content.source ?? "messageHandler",
					});
				}
				responseMessages.push(...continuation.responseMessages);
			}

			if (continuation.mode === "simple") {
				if (callback) {
					if (responseContent.text) {
						responseContent.text = runtime.redactSecrets(responseContent.text);
					}
					await callback(responseContent);
				}
				break;
			}

			if (continuation.mode !== "actions") {
				break;
			}

			await runtime.processActions(
				message,
				continuation.responseMessages,
				accumulatedState,
				async (content) => {
					runtime.logger.debug(
						{ src: "service:message", content },
						"Post-action callback",
					);
					if (responseContent) {
						responseContent.actionCallbacks = content;
					}
					if (callback) {
						return callback(content);
					}
					return [];
				},
				{ onStreamChunk: opts.onStreamChunk },
			);

			if (!shouldContinueAfterActions(responseContent)) {
				break;
			}

			const latestActionResults = runtime.getActionResults(message.id);
			if (latestActionResults.length === 0) {
				runtime.logger.warn(
					{ src: "service:message", iteration: iterationCount + 1 },
					"Post-action continuation produced no new action results",
				);
				break;
			}
			traceActionResults.push(...latestActionResults);
		}

		accumulatedState = withActionResults(accumulatedState, traceActionResults);

		return {
			responseContent,
			responseMessages,
			state: accumulatedState,
			mode: responseContent ? "simple" : "none",
		};
	}

	/**
	 * Single-shot strategy: one LLM call to generate response
	 * Uses dynamicPromptExecFromState for validation-aware structured output
	 */
	private async runSingleShotCore(
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		opts: ResolvedMessageOptions,
		responseId: UUID,
		promptAttachments?: GenerateTextAttachment[],
		overrides?: {
			prompt?: string;
			precomposedState?: State;
		},
	): Promise<StrategyResult> {
		state =
			overrides?.precomposedState ??
			(await runtime.composeState(message, ["ACTIONS"], false, false));

		if (!state.values || !state.values.actionNames) {
			runtime.logger.warn(
				{ src: "service:message" },
				"actionNames data missing from state",
			);
		}

		let responseContent: Content | null = null;

		// Create streaming context for retry state tracking
		const streamingExtractor = opts.onStreamChunk
			? new MarkableExtractor()
			: undefined;
		const streamingCtx =
			streamingExtractor && opts.onStreamChunk
				? createStreamingContext(
						streamingExtractor,
						opts.onStreamChunk,
						responseId,
					)
				: undefined;

		// Resolve the template prompt once so it's available for both the primary
		// call and any follow-up repair prompts (e.g. parameter repair).
		const prompt =
			overrides?.prompt ||
			runtime.character.templates?.messageHandlerTemplate ||
			messageHandlerTemplate;

		// Use dynamicPromptExecFromState for structured output with validation
		const parsedXml = await runtime.dynamicPromptExecFromState({
			state,
			params: {
				prompt,
				...(promptAttachments ? { attachments: promptAttachments } : {}),
			},
			schema: [
				// WHY validateField: false on non-streamed fields?
				// At validation level 1, each field gets validation codes by default.
				// If a non-streamed field's code is corrupted, we'd retry unnecessarily.
				// By opting out, we reduce token overhead AND avoid false failures.
				{
					field: "thought",
					description:
						"Your internal reasoning about the message and what to do",
					required: true,
					validateField: false,
					streamField: false,
				},
				{
					field: "actions",
					description: "List of actions to take (comma-separated)",
					required: true,
					validateField: false,
					streamField: false,
				},
				// WHY streamField: true? This is the user-facing output - stream it!
				// WHY validateField default? At level 1, we want to validate text integrity
				{
					field: "text",
					description: "The text response to send to the user",
					streamField: true,
				},
				{
					field: "params",
					description:
						"Optional TOON parameters for the selected action. Use a params object keyed by action name when the action needs input, e.g. params: { RUN_IN_TERMINAL: { command: \"ls -la\" } }",
					validateField: false,
					streamField: false,
				},
				{
					field: "simple",
					description: "Whether this is a simple response (true/false)",
					validateField: false,
					streamField: false,
				},
			],
			options: {
				modelSize: "large",
				preferredEncapsulation: opts.onStreamChunk ? "xml" : "toon",
				requiredFields: ["thought", "actions"],
				maxRetries: opts.maxRetries,
				// Stream through the filtered context callback for real-time output
				onStreamChunk: streamingCtx?.onStreamChunk,
			},
		});

		runtime.logger.debug(
			{ src: "service:message", parsedXml },
			"Parsed Response Content",
		);

		if (parsedXml) {
			// Mark streaming as complete now that we have a valid response
			streamingExtractor?.markComplete();

			const normalizedActions = (() => {
				// New nested format: actions is a string containing <action> XML children
				if (typeof parsedXml.actions === "string") {
					const actionsXml = parsedXml.actions;
					// Check if it contains <action> elements (new format)
					if (
						actionsXml.includes("<action>") ||
						actionsXml.includes("<action ")
					) {
						const actionEntries: Array<{
							name: string;
							paramsXml?: string;
						}> = [];
						// Use matchAll to avoid assignment-in-expression lint warning
						// We just need names here; params are extracted separately below
						for (const match of actionsXml.matchAll(
							/<action>([\s\S]*?)<\/action>/g,
						)) {
							const inner = match[1];
							const nameMatch = inner.match(/<name>([\s\S]*?)<\/name>/);
							const paramsMatch = inner.match(/<params>([\s\S]*?)<\/params>/);
							if (nameMatch) {
								const name = nameMatch[1].trim();
								const paramsXml = paramsMatch
									? paramsMatch[1].trim()
									: undefined;
								if (name) actionEntries.push({ name, paramsXml });
							}
						}

						if (actionEntries.length > 0) {
							// Merge inline params back into responseContent.params
							// Build a legacy flat params string so parseActionParams can consume it
							const inlineParamsXml = actionEntries
								.filter((e) => e.paramsXml)
								.map(
									(e) =>
										`<${e.name.toUpperCase()}>${e.paramsXml}</${e.name.toUpperCase()}>`,
								)
								.join("\n");
							if (
								inlineParamsXml &&
								(!parsedXml.params || parsedXml.params === "")
							) {
								parsedXml.params = inlineParamsXml;
							}

							return actionEntries.map((e) => e.name);
						}
					}
					// Legacy comma-separated format
					const commaSplitActions = actionsXml
						.split(",")
						.map((action) => String(action).trim())
						.filter((action) => action.length > 0);

					// Extract params from standalone action blocks in parsedXml
					// (e.g. <START_CODING_TASK><repo>...</repo></START_CODING_TASK>).
					if (!parsedXml.params || parsedXml.params === "") {
						const assembled = extractStandaloneActionParams(
							commaSplitActions,
							parsedXml as Record<string, unknown>,
						);
						if (assembled) {
							parsedXml.params = assembled;
						}
					}

					return commaSplitActions;
				}
				if (Array.isArray(parsedXml.actions)) {
					return parsedXml.actions as string[];
				}
				return [];
			})();

			// Limit to single action if action planning is disabled
			const finalActions =
				!runtime.isActionPlanningEnabled() && normalizedActions.length > 1
					? [normalizedActions[0]]
					: normalizedActions;

			responseContent = {
				...parsedXml,
				thought: String(parsedXml.thought || ""),
				actions: finalActions.length > 0 ? finalActions : ["IGNORE"],
				providers: [],
				text: String(parsedXml.text || ""),
				simple: parsedXml.simple === true || parsedXml.simple === "true",
			};
		} else {
			// dynamicPromptExecFromState returned null - use streamed text if available
			const streamedText = streamingCtx?.getStreamedText?.() || "";
			const isTextComplete = streamingCtx?.isComplete?.() ?? false;

			if (isTextComplete && streamedText) {
				runtime.logger.info(
					{
						src: "service:message",
						streamedTextLength: streamedText.length,
						streamedTextPreview: streamedText.substring(0, 100),
					},
					"Text extraction complete - using streamed text",
				);

				responseContent = {
					thought: "Response generated via streaming",
					actions: ["REPLY"],
					providers: [],
					text: streamedText,
					simple: true,
				};
			} else if (streamedText && !isTextComplete) {
				// Text was cut mid-stream - attempt continuation
				runtime.logger.debug(
					{
						src: "service:message",
						streamedTextLength: streamedText.length,
						streamedTextPreview: streamedText.substring(0, 100),
					},
					"Text cut mid-stream - attempting continuation",
				);

				// Reset extractor for fresh streaming of continuation
				streamingCtx?.reset?.();

				// Build continuation prompt with full context (reuses `prompt` from outer scope)
				const escapedStreamedText = escapeHandlebars(streamedText);
				const continuationPrompt = `${prompt}

[CONTINUATION REQUIRED]
Your previous response was cut off. The user already received this text:
"${escapedStreamedText}"

Continue EXACTLY from where you left off. Do NOT repeat what was already said.
Output ONLY the continuation, starting immediately after the last character above.`;

				const continuationParsed = await runtime.dynamicPromptExecFromState({
					state,
					params: {
						prompt: continuationPrompt,
						...(promptAttachments ? { attachments: promptAttachments } : {}),
					},
					schema: [
						{
							field: "text",
							description: "Continuation of response",
							required: true,
							streamField: true,
						},
					],
					options: {
						modelSize: "large",
						preferredEncapsulation: streamingCtx?.onStreamChunk
							? "xml"
							: "toon",
						contextCheckLevel: 0, // Fast mode for continuations - we trust the model
						onStreamChunk: streamingCtx?.onStreamChunk,
					},
				});

				const continuationText = String(continuationParsed?.text || "");
				const fullText = streamedText + continuationText;

				responseContent = {
					thought: "Response completed via continuation",
					actions: ["REPLY"],
					providers: [],
					text: fullText,
					simple: true,
				};
			} else {
				runtime.logger.warn(
					{ src: "service:message" },
					"dynamicPromptExecFromState returned null",
				);
			}
		}

		if (!responseContent) {
			return {
				responseContent: null,
				responseMessages: [],
				state,
				mode: "none",
			};
		}

		// Action parameter repair (Python parity):
		// If the model selected actions with required parameters but omitted <params>,
		// do a second pass asking for ONLY a <params> block.
		const requiredByAction = new Map<string, string[]>();
		const actionByName = new Map<string, Action>();
		for (const action of runtime.actions) {
			const normalizedName = action.name.trim().toUpperCase();
			if (normalizedName) {
				actionByName.set(normalizedName, action);
			}
		}
		for (const a of responseContent.actions ?? []) {
			const actionName = typeof a === "string" ? a.trim().toUpperCase() : "";
			if (!actionName) continue;
			const actionDef = actionByName.get(actionName);
			const required =
				actionDef?.parameters?.filter((p) => p.required).map((p) => p.name) ??
				[];
			if (required.length > 0) {
				requiredByAction.set(actionName, required);
			}
		}

		const existingParams = parseActionParams(responseContent.params);

		const missingRequiredParams = (): boolean => {
			for (const [actionName, required] of requiredByAction) {
				const params = existingParams.get(actionName);
				if (!params) return true;
				for (const key of required) {
					if (!(key in params)) return true;
				}
			}
			return false;
		};

		if (requiredByAction.size > 0 && missingRequiredParams()) {
			const requirementLines = Array.from(requiredByAction.entries())
				.map(([a, req]) => `- ${a}: ${req.join(", ")}`)
				.join("\n");
			const repairPrompt = [
				prompt,
				"",
				"# Parameter Repair",
				"You selected actions that require parameters but did not include a complete params object.",
				"Return ONLY a TOON document with a top-level params field keyed by action name.",
				'Example:',
				'params:',
				'  SEND_MESSAGE:',
				'    target: room-or-channel-id',
				'    text: message body',
				"",
				"Required parameters by action:",
				requirementLines,
				"",
				"Do not include thought, actions, providers, text, or any other fields.",
			].join("\n");

			const repairResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
				prompt: repairPrompt,
				});
				const repairParsed = parseKeyValueXml<Record<string, unknown>>(repairResponse);
				if (repairParsed?.params) {
					responseContent.params = repairParsed.params as Content["params"];
				}
			}

		// Benchmark mode (Python parity): force action-based loop when benchmark context is present.
		const benchmarkMode = state.values.benchmark_has_context === true;
		if (benchmarkMode) {
			if (!responseContent.actions || responseContent.actions.length === 0) {
				responseContent.actions = ["REPLY"];
			}
			if (
				!responseContent.providers ||
				responseContent.providers.length === 0
			) {
				responseContent.providers = ["CONTEXT_BENCH"];
			}
			// Suppress any direct planner answer; the REPLY action should generate final output.
			if (responseContent.actions.some((a) => a.toUpperCase() === "REPLY")) {
				responseContent.text = "";
			}
		}

		// LLM terminal-control ambiguity handling
		if (responseContent.actions && responseContent.actions.length > 1) {
			const isIgnore = (a: unknown) =>
				typeof a === "string" && a.toUpperCase() === "IGNORE";
			const isStop = (a: unknown) =>
				typeof a === "string" && a.toUpperCase() === "STOP";
			const hasIgnore = responseContent.actions.some(isIgnore);
			const hasStop = responseContent.actions.some(isStop);

			if (hasIgnore) {
				if (!responseContent.text || responseContent.text.trim() === "") {
					responseContent.actions = ["IGNORE"];
				} else {
					const filtered = responseContent.actions.filter((a) => !isIgnore(a));
					responseContent.actions = filtered.length ? filtered : ["REPLY"];
				}
			}

			if (hasStop) {
				const filtered = responseContent.actions.filter((a) => !isStop(a));
				responseContent.actions = filtered.length ? filtered : ["STOP"];
			}
		}

		// Automatically determine if response is simple
		const isSimple = isSimpleReplyResponse(responseContent);
		const isStop = isStopResponse(responseContent);

		responseContent.simple = isSimple;
		// Include message ID for streaming coordination (so broadcast uses same ID)
		responseContent.responseId = responseId;

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
			mode: isStop
				? "none"
				: isSimple && responseContent.text
					? "simple"
					: "actions",
		};
	}

	/**
	 * Multi-step strategy: iterative action execution with final summary
	 */
	private async runMultiStepCore(
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		callback: HandlerCallback | undefined,
		opts: ResolvedMessageOptions,
		responseId: UUID,
		promptAttachments?: GenerateTextAttachment[],
	): Promise<StrategyResult> {
		const traceActionResult: MultiStepActionResult[] = [];
		let accumulatedState: MultiStepState = state as MultiStepState;
		let iterationCount = 0;

		while (iterationCount < opts.maxMultiStepIterations) {
			iterationCount++;
			runtime.logger.debug(
				{
					src: "service:message",
					iteration: iterationCount,
					maxIterations: opts.maxMultiStepIterations,
				},
				"Starting multi-step iteration",
			);

			accumulatedState = (await runtime.composeState(
				message,
				["RECENT_MESSAGES", "ACTION_STATE", "PROVIDERS"],
				false,
				false,
			)) as MultiStepState;
			accumulatedState.data.actionResults = traceActionResult;

			// Use dynamicPromptExecFromState for structured decision output
			const parsedStep = await runtime.dynamicPromptExecFromState({
				state: accumulatedState,
				params: {
					prompt:
						runtime.character.templates?.multiStepDecisionTemplate ||
						multiStepDecisionTemplate,
					...(promptAttachments ? { attachments: promptAttachments } : {}),
				},
				schema: [
					// Multi-step decision loop - internal reasoning, no streaming needed
					// WHY: This is orchestration logic, not user-facing output
					{
						field: "thought",
						description:
							"Your reasoning for the selected providers and/or action, and how this step contributes to resolving the user's request",
						validateField: false,
						streamField: false,
					},
					{
						field: "providers",
						description:
							"Comma-separated list of providers to call to gather necessary data",
						validateField: false,
						streamField: false,
					},
					{
						field: "action",
						description:
							"Name of the action to execute after providers return (can be empty if no action is needed)",
						validateField: false,
						streamField: false,
					},
					// WHY parameters: Actions need input data. Without this field in the schema,
					// the LLM won't be instructed to output parameters, breaking action execution.
					{
						field: "params",
						description:
							"Optional TOON parameters for the selected action. Use a `params` object keyed by action name when the action needs input.",
						validateField: false,
						streamField: false,
					},
					{
						field: "isFinish",
						description:
							"true if the task is fully resolved and no further steps are needed, false otherwise",
						validateField: false,
						streamField: false,
					},
				],
				options: {
					modelSize: "large",
					preferredEncapsulation: "toon",
				},
			});

			if (!parsedStep) {
				runtime.logger.warn(
					{ src: "service:message", iteration: iterationCount },
					"Failed to parse multi-step result",
				);
				traceActionResult.push({
					data: { actionName: "parse_error" },
					success: false,
					error: "Failed to parse step result",
				});
				break;
			}

			const thought =
				typeof parsedStep.thought === "string" ? parsedStep.thought : undefined;
			// Handle providers as comma-separated string or array
			let providers: string[] = [];
			if (Array.isArray(parsedStep.providers)) {
				providers = parsedStep.providers;
			} else if (typeof parsedStep.providers === "string") {
				providers = parsedStep.providers
					.split(",")
					.map((p: string) => p.trim())
					.filter((p: string) => p.length > 0);
			}
			const action =
				typeof parsedStep.action === "string" ? parsedStep.action : undefined;
			const isFinish = parsedStep.isFinish;

			// Check for completion condition
			if (isFinish === "true" || isFinish === true) {
				runtime.logger.info(
					{
						src: "service:message",
						agentId: runtime.agentId,
						iteration: iterationCount,
					},
					"Multi-step task completed",
				);
				if (callback) {
					await callback({
						text: "",
						thought: typeof thought === "string" ? thought : "",
					});
				}
				break;
			}

			// Validate that we have something to do
			const providersArray = Array.isArray(providers) ? providers : [];
			if ((!providersArray || providersArray.length === 0) && !action) {
				runtime.logger.warn(
					{ src: "service:message", iteration: iterationCount },
					"No providers or action specified, forcing completion",
				);
				break;
			}

			// Total timeout for all providers running in parallel (configurable via PROVIDERS_TOTAL_TIMEOUT_MS env var)
			// Since providers run in parallel, this is the max wall-clock time allowed
			const PROVIDERS_TOTAL_TIMEOUT_MS = parseInt(
				String(runtime.getSetting("PROVIDERS_TOTAL_TIMEOUT_MS") || "1000"),
				10,
			);

			// Track which providers have completed (for timeout diagnostics)
			const completedProviders = new Set<string>();

			const providerByName = new Map(
				runtime.providers.map((provider) => [provider.name, provider]),
			);
			const providerPromises: Array<
				Promise<{
					providerName: string;
					success: boolean;
					text?: string;
					error?: string;
				}>
			> = [];
			for (const name of providersArray) {
				if (typeof name !== "string") continue;
				providerPromises.push(
					(async (providerName: string) => {
						const provider = providerByName.get(providerName);
						if (!provider) {
							runtime.logger.warn(
								{ src: "service:message", providerName },
								"Provider not found",
							);
							completedProviders.add(providerName);
							return {
								providerName,
								success: false,
								error: `Provider not found: ${providerName}`,
							};
						}

						try {
							const providerResult = await provider.get(
								runtime,
								message,
								state,
							);
							completedProviders.add(providerName);

							if (!providerResult) {
								runtime.logger.warn(
									{ src: "service:message", providerName },
									"Provider returned no result",
								);
								return {
									providerName,
									success: false,
									error: "Provider returned no result",
								};
							}

							const success = !!providerResult.text;
							return {
								providerName,
								success,
								text: success ? providerResult.text : undefined,
								error: success ? undefined : "Provider returned no result",
							};
						} catch (err) {
							completedProviders.add(providerName);
							const errorMsg = err instanceof Error ? err.message : String(err);
							runtime.logger.error(
								{ src: "service:message", providerName, error: errorMsg },
								"Provider execution failed",
							);
							return { providerName, success: false, error: errorMsg };
						}
					})(name),
				);
			}

			// Create timeout promise for provider execution (with cleanup)
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const timeoutPromise = new Promise<"timeout">((resolve) => {
				timeoutId = setTimeout(
					() => resolve("timeout"),
					PROVIDERS_TOTAL_TIMEOUT_MS,
				);
			});

			// Race between all providers completing and timeout
			const allProvidersPromise = Promise.allSettled(providerPromises);
			const raceResult = await Promise.race([
				allProvidersPromise,
				timeoutPromise,
			]);

			// Clear timeout if providers completed first
			if (timeoutId !== undefined) {
				clearTimeout(timeoutId);
			}

			// Check if providers took too long - abort pipeline and notify user
			if (raceResult === "timeout") {
				// Identify which providers were still pending when timeout hit
				const allProviderNames = providersArray.filter(
					(name): name is string => typeof name === "string",
				);
				const pendingProviders = allProviderNames.filter(
					(name) => !completedProviders.has(name),
				);

				runtime.logger.error(
					{
						src: "service:message",
						timeoutMs: PROVIDERS_TOTAL_TIMEOUT_MS,
						pendingProviders,
						completedProviders: Array.from(completedProviders),
					},
					`Providers took too long (>${PROVIDERS_TOTAL_TIMEOUT_MS}ms) - slow providers: ${pendingProviders.join(", ")}`,
				);

				if (callback) {
					await callback({
						text: "Providers took too long to respond. Please optimize your providers or use caching.",
						actions: [],
						thought: "Provider timeout - pipeline aborted",
					});
				}

				return {
					responseContent: null,
					responseMessages: [],
					state,
					mode: "none",
				};
			}

			// Providers completed in time
			const providerResults = raceResult;

			// Process results and notify via callback
			for (const result of providerResults) {
				if (result.status === "fulfilled") {
					const { providerName, success, text, error } = result.value;
					traceActionResult.push({
						data: { actionName: providerName },
						success,
						text,
						error,
					});

					if (callback) {
						await callback({
							text: `🔎 Provider executed: ${providerName}`,
							actions: [providerName],
							thought: typeof thought === "string" ? thought : "",
						});
					}
				} else {
					runtime.logger.error(
						{
							src: "service:message",
							error: result.reason || "Unknown provider failure",
						},
						"Unexpected provider promise rejection",
					);
				}
			}

			if (action) {
				const actionContent: Content = {
					text: `🔎 Executing action: ${action}`,
					actions: [action],
					thought: thought || "",
				};
				if (parsedStep && typeof parsedStep.params === "string") {
					actionContent.params = parsedStep.params;
				}

				await runtime.processActions(
					message,
					[
						{
							id: v4() as UUID,
							entityId: runtime.agentId,
							roomId: message.roomId,
							createdAt: Date.now(),
							content: actionContent,
						},
					],
					state,
					async () => {
						return [];
					},
				);

				// Get cached action results from runtime
				const cachedState = runtime.stateCache.get(
					`${message.id}_action_results`,
				);
				const cachedStateValues = cachedState?.values;
				const rawActionResults = cachedStateValues?.actionResults;
				const actionResults: ActionResult[] = Array.isArray(rawActionResults)
					? rawActionResults
					: [];
				const result: ActionResult | null =
					actionResults.length > 0 ? actionResults[0] : null;
				const success = result?.success ?? false;

				traceActionResult.push({
					data: { actionName: typeof action === "string" ? action : "unknown" },
					success,
					text:
						result && "text" in result && typeof result.text === "string"
							? result.text
							: undefined,
					values:
						result &&
						"values" in result &&
						typeof result.values === "object" &&
						result.values !== null
							? result.values
							: undefined,
					error: success
						? undefined
						: result && "text" in result && typeof result.text === "string"
							? result.text
							: undefined,
				});
			}
		}

		if (iterationCount >= opts.maxMultiStepIterations) {
			runtime.logger.warn(
				{ src: "service:message", maxIterations: opts.maxMultiStepIterations },
				"Reached maximum iterations, forcing completion",
			);
		}

		accumulatedState = (await runtime.composeState(
			message,
			["RECENT_MESSAGES", "ACTION_STATE"],
			false,
			false,
		)) as MultiStepState;

		// Use dynamicPromptExecFromState for final summary generation
		// Stream the final summary for better UX
		const summary = await runtime.dynamicPromptExecFromState({
			state: accumulatedState,
			params: {
				prompt:
					runtime.character.templates?.multiStepSummaryTemplate ||
					multiStepSummaryTemplate,
				...(promptAttachments ? { attachments: promptAttachments } : {}),
			},
			schema: [
				{
					field: "thought",
					description: "Your internal reasoning about the summary",
					validateField: false,
					streamField: false,
				},
				// WHY streamField: true? This is the final user-facing output
				{
					field: "text",
					description: "The final summary message to send to the user",
					required: true,
					streamField: true,
				},
			],
			options: {
				modelSize: "large",
				preferredEncapsulation: opts.onStreamChunk ? "xml" : "toon",
				requiredFields: ["text"],
				// Stream the final summary to the user
				onStreamChunk: opts.onStreamChunk,
			},
		});

		let responseContent: Content | null = null;
		const summaryText = summary?.text;
		if (typeof summaryText === "string" && summaryText) {
			responseContent = {
				actions: ["MULTI_STEP_SUMMARY"],
				text: summaryText,
				thought:
					(typeof summary?.thought === "string"
						? summary.thought
						: "Final user-facing message after task completion.") ||
					"Final user-facing message after task completion.",
				simple: true,
				responseId,
			};
		}

		const responseMessages: Memory[] = responseContent
			? [
					{
						id: responseId,
						entityId: runtime.agentId,
						agentId: runtime.agentId,
						content: responseContent,
						roomId: message.roomId,
						createdAt: Date.now(),
					},
				]
			: [];

		return {
			responseContent,
			responseMessages,
			state: accumulatedState,
			mode: responseContent ? "simple" : "none",
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
