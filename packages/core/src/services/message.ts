/** Exposes the built-in message service and stable helper exports. Per-service owners coordinate turn admission and persistence, response processing, attachment enrichment, and failure delivery while preserving the runtime’s IMessageService contract. */

import { MessageProcessor } from "./message/processor.js";
import { MessageTurnLifetime } from "./message/turn-lifetime.js";

export { shouldSkipResponseMemoryPersistence } from "./message/processor-policy.js";

import { MessageAttachments } from "./message/attachments.js";
import { MessageFailures } from "./message/failures.js";

export {
	type ActionContinuationDecision,
	type ActionOwnershipSuggestion,
	actionResultsSuppressPostActionContinuation,
	getActionContinuationDecision,
	resolveSupersededResponseKeepReason,
	shouldEmitPlannerPreamble,
	shouldPromoteExplicitReplyToOwnedAction,
	shouldRunMetadataActionRescue,
	stripReplyWhenActionOwnsTurn,
} from "./message/action-ownership.js";
export {
	getCachedActionCatalog,
	privacyDenialReplyForReasons,
} from "./message/action-surface.js";
export type {
	Stage1DecisionObservation,
	V5MessageRuntimeStage1Result,
} from "./message/contracts.js";
export {
	deliverFirstSentenceVoice,
	wrapSingleTurnVisibleCallback,
} from "./message/delivery.js";
export { cleanPriorDialogueSpeakerName } from "./message/dialogue-context.js";
export {
	enforceTrustedDeliveryAudienceAtEgress,
	enforceTrustedDeliveryAudienceOnResult,
	evaluatePlannedReplyEgress,
	type PlannedReplyClaimKind,
	type PlannedReplyEgressDecision,
	plannedReplyHasClaimGroundingReceipt,
} from "./message/egress-policy.js";
export { persistInferenceTimingSummary } from "./message/inference-timing.js";
export { runV5MessageRuntimeStage1 } from "./message/pipeline.js";
export {
	__buildV5ExecutorContextForTests,
	__invalidateEvidenceSensitiveProviderCacheForTests,
	subPlannerResultToPlannerToolResult,
} from "./message/planned-tool.js";
export {
	hasPostTurnSemanticSignal,
	isSimpleReplyResponse,
} from "./message/post-turn-policy.js";
export {
	selectV5PlannerStateProviderNames,
	stage1ResponseStateProviderNames,
} from "./message/provider-state.js";
export {
	answerlessToolTurnReport,
	candidateActionsIncludeAsyncHandoff,
	NO_REPORTABLE_TOOL_OUTCOME_MESSAGE,
	normalizeVisibleTextForDuplicateCheck,
	preservedSettledToolResult,
	resolveActionResultTranscriptVisibility,
	resolveZeroDeliveryRecovery,
	restorePiiInUserReplyText,
	structuredEffectConfirmation,
	type ZeroDeliveryRecoverySource,
} from "./message/reply-policy.js";
export { withActionResultsForPrompt } from "./message/response-state.js";
export { runShortcutGate } from "./message/shortcut-turn.js";
export {
	BUILTIN_RESPONSE_HANDLER_EVALUATORS,
	type EligibleDirectActionRoute,
	resolveEligibleDirectActionRoutes,
} from "./message/stage1-evaluators.js";
export {
	getStage1RetryReason,
	shouldRetryStage1Generation,
} from "./message/stage1-generation.js";
export {
	formatAvailableContextsForPrompt,
	renderMessageHandlerStablePrefix,
} from "./message/stage1-input.js";
export {
	applyDirectCurrentCandidateBackstopToMessageHandler,
	messageHandlerFromFieldResult,
} from "./message/stage1-output.js";
export {
	inferDirectCurrentRequestCandidateActions,
	shouldPreferDirectCurrentCandidateActions,
} from "./message/stage1-reply-policy.js";
export { subAgentCompletionRelayBody } from "./message/task-completion-relay.js";
export { hasTextGenerationHandler } from "./message/trajectory-stages.js";

import {
	BUILTIN_ALWAYS_RESPOND_CHANNELS,
	BUILTIN_ALWAYS_RESPOND_SOURCES,
	normalizeResponseBypassList,
	textContainsAgentName,
	textContainsUserTag,
} from "./message/addressing.js";

export {
	extractPlannerActionNames,
	resolvePlannerActionName,
} from "./message/action-identifiers.js";
export {
	classifyMessageAddress,
	type MessageAddressSignals,
	messageChallengesPriorAgentReply,
	messageContinuesAfterRecentAgentCorrection,
	textContainsAgentName,
} from "./message/addressing.js";
export { sanitizeReplyTextAfterMediaDelivery } from "./message/media-delivery.js";
export {
	getVoiceSpeakerEntityId,
	getVoiceTurnSignalMetadata,
	transcriptionModeActive,
	voiceTurnSignalConfirmsAgent,
	voiceTurnSignalSuppressesAgent,
} from "./message/voice-signals.js";

import { formatActionNames, formatActions } from "../actions";
import type { Action } from "../types/components";
import type { Room } from "../types/environment";
import type { Memory } from "../types/memory";
import type {
	ContextRoutedResponseDecision,
	IMessageService,
} from "../types/message-service";
import type { MentionContext, UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";
import {
	findWebLookupActionName,
	findWebLookupActionNames,
	inferLocalShellCommandFromMessageText,
	inferWebSearchQueryFromMessageText,
} from "./message/direct-action-heuristics";

export {
	findWebLookupActionName,
	findWebLookupActionNames,
	inferLocalShellCommandFromMessageText,
	inferWebSearchQueryFromMessageText,
};

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

export {
	buildFailureReplyPrompt,
	classifyStructuredFailureCause,
	ELIZA_CLOUD_GATEWAY_WARMING_EXHAUSTED,
	INSUFFICIENT_CREDITS_REPLY,
	isAuthError,
	isElizaCloudGatewayWarmingExhaustedError,
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

// Shared with the planner-path REPLY guard and the planned-reply egress
// guard; the detectors live in a leaf module so the action can import them
// without pulling in this service.
import {
	replyClaimsCompletedSideEffect,
	replyClaimsEmptyTrackedWorkState,
	replyClaimsInProgressWork,
} from "./message/side-effect-claims.ts";

export {
	replyClaimsCompletedSideEffect,
	replyClaimsEmptyTrackedWorkState,
	replyClaimsInProgressWork,
};

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
	readonly #turnLifetime = new MessageTurnLifetime({
		processMessage: (...args) => this.processMessage(...args),
	});
	readonly #processor = new MessageProcessor({
		awaitDeliveredReplyPersistence: (...args) =>
			this.awaitDeliveredReplyPersistence(...args),
		processAttachments: (...args) => this.processAttachments(...args),
		buildStructuredFailureReply: (...args) =>
			this.buildStructuredFailureReply(...args),
		shouldRespond: (...args) => this.shouldRespond(...args),
		buildNoModelProviderReply: (...args) =>
			this.buildNoModelProviderReply(...args),
		registerPendingReplyPersist: (...args) =>
			this.registerPendingReplyPersist(...args),
	});
	private readonly failures = new MessageFailures();
	private readonly attachments = new MessageAttachments();
	private pendingReplyPersistKey(
		...args: Parameters<MessageTurnLifetime["pendingReplyPersistKey"]>
	): ReturnType<MessageTurnLifetime["pendingReplyPersistKey"]> {
		return this.#turnLifetime.pendingReplyPersistKey(...args);
	}
	private registerPendingReplyPersist(
		...args: Parameters<MessageTurnLifetime["registerPendingReplyPersist"]>
	): ReturnType<MessageTurnLifetime["registerPendingReplyPersist"]> {
		return this.#turnLifetime.registerPendingReplyPersist(...args);
	}
	private awaitDeliveredReplyPersistence(
		...args: Parameters<MessageTurnLifetime["awaitDeliveredReplyPersistence"]>
	): ReturnType<MessageTurnLifetime["awaitDeliveredReplyPersistence"]> {
		return this.#turnLifetime.awaitDeliveredReplyPersistence(...args);
	}
	handleMessage(
		...args: Parameters<MessageTurnLifetime["handleMessage"]>
	): ReturnType<MessageTurnLifetime["handleMessage"]> {
		return this.#turnLifetime.handleMessage(...args);
	}
	private processMessage(
		...args: Parameters<MessageProcessor["processMessage"]>
	): ReturnType<MessageProcessor["processMessage"]> {
		return this.#processor.processMessage(...args);
	}
	private isDeterministicallyAddressedTurn(
		...args: Parameters<MessageProcessor["isDeterministicallyAddressedTurn"]>
	): ReturnType<MessageProcessor["isDeterministicallyAddressedTurn"]> {
		return this.#processor.isDeterministicallyAddressedTurn(...args);
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

		// Channel types that always trigger a response (private channels)
		const alwaysRespondChannels = BUILTIN_ALWAYS_RESPOND_CHANNELS;

		// Sources that always trigger a response. A trigger-prompt message is
		// the agent's OWN scheduled intent firing (a reminder or prompt
		// automation it created earlier) — gating it behind "should I respond
		// to this ambient message?" is a category error and silently eats
		// reminders.
		const alwaysRespondSources = BUILTIN_ALWAYS_RESPOND_SOURCES;

		// Support runtime-configurable overrides via env settings
		const customChannels = normalizeResponseBypassList(
			runtime.getSetting("ALWAYS_RESPOND_CHANNELS") ??
				runtime.getSetting("SHOULD_RESPOND_BYPASS_TYPES"),
		);
		const customSources = normalizeResponseBypassList(
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
	processAttachments(
		...args: Parameters<MessageAttachments["processAttachments"]>
	): ReturnType<MessageAttachments["processAttachments"]> {
		return this.attachments.processAttachments(...args);
	}
	private fetchAttachmentBytes(
		...args: Parameters<MessageAttachments["fetchAttachmentBytes"]>
	): ReturnType<MessageAttachments["fetchAttachmentBytes"]> {
		return this.attachments.fetchAttachmentBytes(...args);
	}
	private resolveRecentMessagesForFailureReply(
		...args: Parameters<MessageFailures["resolveRecentMessagesForFailureReply"]>
	): ReturnType<MessageFailures["resolveRecentMessagesForFailureReply"]> {
		return this.failures.resolveRecentMessagesForFailureReply(...args);
	}
	private generateFailureReplyText(
		...args: Parameters<MessageFailures["generateFailureReplyText"]>
	): ReturnType<MessageFailures["generateFailureReplyText"]> {
		return this.failures.generateFailureReplyText(...args);
	}
	private buildStructuredFailureReply(
		...args: Parameters<MessageFailures["buildStructuredFailureReply"]>
	): ReturnType<MessageFailures["buildStructuredFailureReply"]> {
		return this.failures.buildStructuredFailureReply(...args);
	}
	private buildNoModelProviderReply(
		...args: Parameters<MessageFailures["buildNoModelProviderReply"]>
	): ReturnType<MessageFailures["buildNoModelProviderReply"]> {
		return this.failures.buildNoModelProviderReply(...args);
	}
	private emitMessageSent(
		...args: Parameters<MessageProcessor["emitMessageSent"]>
	): ReturnType<MessageProcessor["emitMessageSent"]> {
		return this.#processor.emitMessageSent(...args);
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

		// Bulk room delete — do not snapshot via getMemoriesByRoomIds. The
		// in-memory adapter defaults that read to 20 rows, so a successful
		// per-id loop left the rest of the channel intact. deleteAllMemories
		// is the adapter contract for "this room, this table, all rows".
		const totalCount = await runtime.countMemories({
			roomIds: [roomId],
			tableName: "messages",
			unique: false,
		});
		await runtime.deleteAllMemories([roomId], "messages");

		runtime.logger.info(
			{
				src: "service:message",
				agentId: runtime.agentId,
				channelId,
				deletedCount: totalCount,
				totalCount,
			},
			"Cleared message memories from channel",
		);
	}
}

export { decideUmbrellaPlannerBudget } from "./message/planned-tool.js";
