/**
 * AgentEventService bridge
 *
 * The runtime emits coarse lifecycle telemetry on the {@link EventType} bus
 * (`RUN_STARTED`, `ACTION_STARTED`, `EVALUATOR_STARTED`, …). Separately,
 * {@link AgentEventService} exposes a fully-typed per-run stream taxonomy
 * (`lifecycle | action | evaluator | tool | provider | …`) that the agent HTTP
 * server broadcasts to WS clients as `agent_event` messages.
 *
 * Historically the `AgentEventService` `action` / `evaluator` / `lifecycle`
 * streams were dead — the `emit*` helpers existed but had no call sites, so the
 * WS channel never carried per-turn phase data. This module is the single
 * bridge that maps the {@link EventType} bus → `AgentEventService` streams
 * (option (b) from issue #8813): one place to wire, every existing event lights
 * up for free, and the streams become reusable beyond the chat indicator.
 *
 * The bridge is intentionally defensive: it resolves `AgentEventService`
 * lazily, no-ops when the service is not hosted (core-only tests, headless
 * tools), and never throws back into the hot message loop.
 */

import { logger } from "../logger.ts";
import type { MessageEventData } from "../types/agentEvent.ts";
import type {
	ActionEventPayload,
	EvaluatorEventPayload,
	MessagePayload,
	RunEventPayload,
} from "../types/events.ts";
import type { IAgentRuntime } from "../types/index.ts";
import { MESSAGE_SOURCE_CLIENT_CHAT } from "../types/message-source.ts";
import type { NotificationInput } from "../types/notification.ts";
import type { JsonValue } from "../types/primitives.ts";
import { ServiceType } from "../types/service.ts";
import type { AgentEventService } from "./agentEvent.ts";

interface NotificationServiceLike {
	notify: (input: NotificationInput) => Promise<unknown> | unknown;
}

interface RuntimeServiceHost {
	agentId: IAgentRuntime["agentId"];
	getService: IAgentRuntime["getService"];
	getCurrentRunId?: IAgentRuntime["getCurrentRunId"];
}

export const CONNECTOR_MESSAGE_RECEIVED_EVENT_TYPES = [
	"line:message_received",
	"GOOGLE_CHAT_MESSAGE_RECEIVED",
	"TWITCH_MESSAGE_RECEIVED",
	"NOSTR_MESSAGE_RECEIVED",
] as const;

const CONNECTOR_EVENT_SOURCES: Readonly<Record<string, string>> = {
	"line:message_received": "line",
	GOOGLE_CHAT_MESSAGE_RECEIVED: "google-chat",
	TWITCH_MESSAGE_RECEIVED: "twitch",
	NOSTR_MESSAGE_RECEIVED: "nostr",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function readRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function isRuntimeServiceHost(value: unknown): value is RuntimeServiceHost {
	return (
		isRecord(value) &&
		typeof value.agentId === "string" &&
		typeof value.getService === "function"
	);
}

function readRuntime(value: unknown): RuntimeServiceHost | null {
	return isRuntimeServiceHost(value) ? value : null;
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		const string = readString(value);
		if (string) return string;
	}
	return undefined;
}

function readAttachments(value: unknown): boolean {
	const record = readRecord(value);
	return (
		(Array.isArray(record.attachments) && record.attachments.length > 0) ||
		(Array.isArray(record.attachment) && record.attachment.length > 0) ||
		(Array.isArray(record.files) && record.files.length > 0)
	);
}

/**
 * Resolve the {@link AgentEventService} if it is registered on the runtime.
 *
 * Duck-typed (rather than `instanceof`) so it works across bundle targets and
 * test doubles. Returns `null` when the service is absent so callers no-op.
 */
function resolveAgentEventService(
	runtime: RuntimeServiceHost,
): AgentEventService | null {
	try {
		const service = runtime.getService(ServiceType.AGENT_EVENT);
		if (
			service &&
			typeof (service as AgentEventService).emitActionStart === "function"
		) {
			return service as AgentEventService;
		}
	} catch {
		// getService may throw on partially-initialized runtimes; treat as absent.
	}
	return null;
}

function resolveNotificationService(
	runtime: RuntimeServiceHost,
): NotificationServiceLike | null {
	try {
		const service = runtime.getService(ServiceType.NOTIFICATION);
		const candidate = service as Partial<NotificationServiceLike>;
		if (candidate && typeof candidate.notify === "function") {
			return candidate as NotificationServiceLike;
		}
	} catch {
		// getService may throw on partially-initialized runtimes; treat as absent.
	}
	return null;
}

/**
 * Resolve the run id to correlate a stream event with. Action/evaluator events
 * do not carry their own run id, so we fall back to the runtime's current run.
 */
function resolveRunId(
	runtime: RuntimeServiceHost,
	payloadRunId?: string,
): string | null {
	if (payloadRunId) {
		return payloadRunId;
	}
	try {
		return runtime.getCurrentRunId?.() ?? null;
	} catch {
		return null;
	}
}

function resolveActionName(payload: ActionEventPayload): string {
	const actions = payload.content?.actions;
	if (Array.isArray(actions) && typeof actions[0] === "string") {
		return actions[0];
	}
	return "unknown";
}

function readContentRunId(payload: ActionEventPayload): string | undefined {
	const runId = (payload.content as Record<string, unknown> | undefined)?.runId;
	return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}

function messageMetadata(payload: MessagePayload): Record<string, unknown> {
	return isRecord(payload.message.metadata) ? payload.message.metadata : {};
}

function messageMetadataBase(
	metadata: Record<string, unknown>,
): Record<string, unknown> {
	return isRecord(metadata.base) ? metadata.base : {};
}

function resolveMessageSource(payload: MessagePayload): string {
	const metadata = messageMetadata(payload);
	const base = messageMetadataBase(metadata);
	return (
		readString(payload.source) ??
		readString(payload.message.content.source) ??
		readString(metadata.source) ??
		readString(base.source) ??
		readString(metadata.provider) ??
		"message"
	);
}

function resolveMessageChannel(
	payload: MessagePayload,
	source: string,
): string {
	const metadata = messageMetadata(payload);
	const origin = isRecord(metadata.origin) ? metadata.origin : {};
	const session = isRecord(metadata.session) ? metadata.session : {};
	const delivery = isRecord(metadata.delivery) ? metadata.delivery : {};
	return (
		readString(payload.message.content.channelType) ??
		readString(metadata.chatType) ??
		readString(metadata.channel) ??
		readString(session.channel) ??
		readString(origin.channel) ??
		readString(origin.provider) ??
		readString(delivery.channel) ??
		source
	);
}

function resolveMessageSessionKey(payload: MessagePayload): string | undefined {
	const metadata = messageMetadata(payload);
	const session = isRecord(metadata.session) ? metadata.session : {};
	return (
		readString(payload.message.sessionKey) ??
		readString(metadata.sessionKey) ??
		readString(session.sessionKey)
	);
}

function resolveMessageSenderName(payload: MessagePayload): string | undefined {
	const metadata = messageMetadata(payload);
	const sender = isRecord(metadata.sender) ? metadata.sender : {};
	return (
		readString(sender.name) ??
		readString(sender.username) ??
		readString(metadata.entityName) ??
		readString(metadata.entityUserName)
	);
}

function isBackfillMessage(metadata: Record<string, unknown>): boolean {
	return (
		readBoolean(metadata.historical) === true ||
		readBoolean(metadata.backfill) === true ||
		readBoolean(metadata.isBackfill) === true ||
		readBoolean(metadata.replay) === true ||
		readBoolean(metadata.imported) === true
	);
}

function isBotMessage(metadata: Record<string, unknown>): boolean {
	const discord = isRecord(metadata.discord) ? metadata.discord : {};
	const discordAuthor = isRecord(discord.discordAuthor)
		? discord.discordAuthor
		: {};
	return (
		readBoolean(metadata.fromBot) === true ||
		readBoolean(discordAuthor.bot) === true
	);
}

function shouldNotifyForInboundMessage(
	payload: MessagePayload,
	source: string,
): boolean {
	const metadata = messageMetadata(payload);
	const normalizedSource = source.toLowerCase();
	if (
		normalizedSource === MESSAGE_SOURCE_CLIENT_CHAT ||
		normalizedSource === "api" ||
		normalizedSource === "web" ||
		normalizedSource === "message" ||
		normalizedSource === "messageservice"
	) {
		return false;
	}
	if (payload.message.entityId === payload.runtime.agentId) {
		return false;
	}
	if (isBotMessage(metadata) || isBackfillMessage(metadata)) {
		return false;
	}
	return true;
}

function hasAttachments(payload: MessagePayload): boolean {
	const attachments = payload.message.content.attachments;
	return Array.isArray(attachments) && attachments.length > 0;
}

function resolveMessageRunId(
	payload: MessagePayload,
	source: string,
): string | null {
	const metadata = messageMetadata(payload);
	const explicitRunId = readString(metadata.trajectoryId);
	if (explicitRunId) {
		return resolveRunId(payload.runtime, explicitRunId);
	}
	if (shouldNotifyForInboundMessage(payload, source)) {
		return (
			readString(payload.message.id) ??
			resolveRunId(payload.runtime) ??
			readString(payload.message.roomId) ??
			null
		);
	}
	return (
		resolveRunId(payload.runtime) ??
		readString(payload.message.id) ??
		readString(payload.message.roomId) ??
		null
	);
}

function notificationData(
	payload: MessagePayload,
	source: string,
): Record<string, JsonValue> {
	return {
		source,
		messageId: payload.message.id ?? null,
		roomId: payload.message.roomId,
		entityId: payload.message.entityId,
	};
}

interface RawConnectorMessageSummary {
	runtime: RuntimeServiceHost;
	source: string;
	channel: string;
	messageId?: string;
	roomId?: string;
	senderId?: string;
	senderName?: string;
	content?: string;
	hasAttachments: boolean;
	deliveredAt?: number;
	accountId?: string;
}

function normalizeRawConnectorMessage(
	eventType: string,
	payload: unknown,
): RawConnectorMessageSummary | null {
	const root = readRecord(payload);
	const runtime = readRuntime(root.runtime);
	if (!runtime) return null;

	const message = readRecord(root.message);
	const event = readRecord(root.event);
	const eventMessage = readRecord(event.message);
	const lineSource = readRecord(root.lineSource);
	const space = readRecord(root.space ?? message.space ?? event.space);
	const user = readRecord(root.user ?? message.user ?? message.sender);
	const twitchUser = readRecord(message.user);

	const source =
		firstString(root.source, CONNECTOR_EVENT_SOURCES[eventType]) ?? "connector";
	const channel = firstString(
		message.channel,
		lineSource.type,
		space.type,
		space.displayName,
		source,
	);
	const content = firstString(
		message.content,
		message.text,
		message.argumentText,
		message.altText,
		eventMessage.text,
		eventMessage.argumentText,
		root.text,
	);
	const messageId = firstString(
		message.id,
		message.messageId,
		message.name,
		eventMessage.name,
		root.eventId,
		root.messageId,
	);
	const roomId = firstString(
		message.roomId,
		message.groupId,
		message.channel,
		lineSource.groupId,
		lineSource.roomId,
		lineSource.userId,
		space.name,
	);
	const senderId = firstString(
		message.entityId,
		message.senderId,
		message.userId,
		lineSource.userId,
		user.name,
		twitchUser.userId,
		root.from,
	);
	const senderName = firstString(
		message.name,
		message.displayName,
		user.displayName,
		twitchUser.displayName,
		twitchUser.username,
		root.from,
	);
	const deliveredAt =
		readNumber(message.timestamp) ??
		readNumber(root.createdAt) ??
		(typeof message.timestamp === "object" && message.timestamp instanceof Date
			? message.timestamp.getTime()
			: undefined);

	return {
		runtime,
		source,
		channel: channel ?? source,
		...(messageId ? { messageId } : {}),
		...(roomId ? { roomId } : {}),
		...(senderId ? { senderId } : {}),
		...(senderName ? { senderName } : {}),
		...(content ? { content } : {}),
		hasAttachments:
			readAttachments(message) ||
			readAttachments(eventMessage) ||
			readAttachments(root),
		...(deliveredAt !== undefined ? { deliveredAt } : {}),
		...(readString(root.accountId)
			? { accountId: readString(root.accountId) }
			: {}),
	};
}

function rawConnectorNotificationData(
	message: RawConnectorMessageSummary,
): Record<string, JsonValue> {
	return {
		source: message.source,
		messageId: message.messageId ?? null,
		roomId: message.roomId ?? null,
		entityId: message.senderId ?? null,
		accountId: message.accountId ?? null,
	};
}

function messageEventData(
	message: RawConnectorMessageSummary,
): MessageEventData {
	return {
		type: "received",
		...(message.messageId
			? { messageId: message.messageId as MessageEventData["messageId"] }
			: {}),
		channel: message.channel,
		...(message.senderId
			? { userId: message.senderId as MessageEventData["userId"] }
			: {}),
		...(message.roomId
			? { roomId: message.roomId as MessageEventData["roomId"] }
			: {}),
		...(message.content ? { content: message.content } : {}),
		hasAttachments: message.hasAttachments,
		...(message.deliveredAt !== undefined
			? { deliveredAt: message.deliveredAt }
			: {}),
	};
}

/**
 * Bridge connector-specific inbound message events that do not yet emit the
 * canonical `EventType.MESSAGE_RECEIVED` payload. This is intentionally
 * activity/notification-only: it never runs the message loop or sends replies.
 */
export async function bridgeConnectorMessageReceivedToStreams(
	eventType: string,
	payload: unknown,
): Promise<void> {
	const message = normalizeRawConnectorMessage(eventType, payload);
	if (!message) return;

	const runId =
		message.messageId ??
		message.roomId ??
		`${message.source}:${message.senderId ?? message.channel}`;
	const sessionKey = message.roomId
		? `${message.source}:${message.roomId}`
		: undefined;

	const agentEvents = resolveAgentEventService(message.runtime);
	if (agentEvents) {
		try {
			agentEvents.emitMessage(runId, messageEventData(message), sessionKey);
		} catch (err) {
			logger.debug(
				{
					src: "agent-event-bridge",
					eventType,
					err: err instanceof Error ? err.message : String(err),
				},
				"Failed to bridge connector message event to AgentEventService",
			);
		}
	}

	const notifications = resolveNotificationService(message.runtime);
	if (!notifications) return;

	try {
		await notifications.notify({
			title: message.senderName
				? `New ${message.channel} message from ${message.senderName}`
				: `New ${message.channel} message`,
			body:
				message.content ||
				(message.hasAttachments ? "Message includes attachments" : undefined),
			category: "message",
			priority: "normal",
			source: message.source,
			groupKey: `message:${message.source}:${
				message.roomId ?? message.senderId ?? message.channel
			}`,
			data: rawConnectorNotificationData(message),
			agentId: message.runtime.agentId,
		});
	} catch (err) {
		logger.debug(
			{
				src: "agent-event-bridge",
				eventType,
				err: err instanceof Error ? err.message : String(err),
			},
			"Failed to create connector-message notification",
		);
	}
}

function isSuccessfulActionStatus(payload: ActionEventPayload): boolean {
	// `actionStatus` is set to "completed" | "failed" by the action executors.
	const status = (payload.content as Record<string, unknown> | undefined)
		?.actionStatus;
	return status !== "failed";
}

/**
 * Bridge `MESSAGE_RECEIVED` → AgentEventService `message` stream and, for real
 * external connector traffic, a canonical user-facing notification.
 */
export async function bridgeMessageReceivedToStreams(
	payload: MessagePayload,
): Promise<void> {
	const source = resolveMessageSource(payload);
	const channel = resolveMessageChannel(payload, source);
	const sessionKey = resolveMessageSessionKey(payload);
	const runId = resolveMessageRunId(payload, source);
	const content = readString(payload.message.content.text);
	const attachments = hasAttachments(payload);

	if (runId) {
		const service = resolveAgentEventService(payload.runtime);
		if (service) {
			try {
				service.emitMessageReceived(
					runId,
					{
						messageId: payload.message.id,
						channel,
						userId: payload.message.entityId,
						roomId: payload.message.roomId,
						content,
						hasAttachments: attachments,
					},
					sessionKey,
				);
			} catch (err) {
				logger.debug(
					{
						src: "agent-event-bridge",
						err: err instanceof Error ? err.message : String(err),
					},
					"Failed to bridge MESSAGE_RECEIVED to AgentEventService",
				);
			}
		}
	}

	if (!shouldNotifyForInboundMessage(payload, source)) {
		return;
	}

	const notifications = resolveNotificationService(payload.runtime);
	if (!notifications) {
		return;
	}

	const senderName = resolveMessageSenderName(payload);
	const title = senderName
		? `New ${channel} message from ${senderName}`
		: `New ${channel} message`;
	const wasMentioned =
		readBoolean(messageMetadata(payload).wasMentioned) === true ||
		(isRecord(payload.message.content.mentionContext) &&
			readBoolean(payload.message.content.mentionContext.isMention) === true);

	try {
		await notifications.notify({
			title,
			body:
				content || (attachments ? "Message includes attachments" : undefined),
			category: "message",
			priority: wasMentioned ? "high" : "normal",
			source,
			deepLink: payload.message.content.url,
			groupKey: `message:${source}:${payload.message.roomId}`,
			data: notificationData(payload, source),
			agentId: payload.runtime.agentId,
		});
	} catch (err) {
		logger.debug(
			{
				src: "agent-event-bridge",
				err: err instanceof Error ? err.message : String(err),
			},
			"Failed to create inbound-message notification",
		);
	}
}

/**
 * Bridge `ACTION_STARTED` → AgentEventService `action` + `lifecycle` streams.
 */
export function bridgeActionStartedToStreams(
	payload: ActionEventPayload,
): void {
	const runtime = payload.runtime;
	const service = resolveAgentEventService(runtime);
	if (!service) {
		return;
	}
	const runId = resolveRunId(runtime, readContentRunId(payload));
	if (!runId) {
		return;
	}
	const actionName = resolveActionName(payload);
	try {
		service.emitActionStart(runId, { actionName });
		service.emitLifecycle(runId, { type: "action_start", actionName });
	} catch (err) {
		logger.debug(
			{
				src: "agent-event-bridge",
				err: err instanceof Error ? err.message : String(err),
			},
			"Failed to bridge ACTION_STARTED to AgentEventService",
		);
	}
}

/**
 * Bridge `ACTION_COMPLETED` → AgentEventService `action` + `lifecycle` streams.
 */
export function bridgeActionCompletedToStreams(
	payload: ActionEventPayload,
): void {
	const runtime = payload.runtime;
	const service = resolveAgentEventService(runtime);
	if (!service) {
		return;
	}
	const runId = resolveRunId(runtime, readContentRunId(payload));
	if (!runId) {
		return;
	}
	const actionName = resolveActionName(payload);
	const success = isSuccessfulActionStatus(payload);
	try {
		service.emitActionComplete(runId, { actionName, success });
		service.emitLifecycle(runId, {
			type: "action_end",
			actionName,
			success,
		});
	} catch (err) {
		logger.debug(
			{
				src: "agent-event-bridge",
				err: err instanceof Error ? err.message : String(err),
			},
			"Failed to bridge ACTION_COMPLETED to AgentEventService",
		);
	}
}

/**
 * Bridge `RUN_STARTED` → AgentEventService `lifecycle` stream.
 */
export function bridgeRunStartedToStreams(payload: RunEventPayload): void {
	const runtime = payload.runtime;
	const service = resolveAgentEventService(runtime);
	if (!service) {
		return;
	}
	const runId = resolveRunId(runtime, payload.runId);
	if (!runId) {
		return;
	}
	try {
		service.emitLifecycle(runId, { type: "run_start" });
	} catch (err) {
		logger.debug(
			{
				src: "agent-event-bridge",
				err: err instanceof Error ? err.message : String(err),
			},
			"Failed to bridge RUN_STARTED to AgentEventService",
		);
	}
}

/**
 * Bridge `RUN_ENDED` → AgentEventService `lifecycle` stream.
 */
export function bridgeRunEndedToStreams(payload: RunEventPayload): void {
	const runtime = payload.runtime;
	const service = resolveAgentEventService(runtime);
	if (!service) {
		return;
	}
	const runId = resolveRunId(runtime, payload.runId);
	if (!runId) {
		return;
	}
	const duration =
		typeof payload.duration === "number" ? payload.duration : undefined;
	try {
		service.emitLifecycle(runId, {
			type: "run_end",
			success: payload.status === "completed",
			...(duration !== undefined ? { duration } : {}),
		});
		// Run is over: drop its per-run sequence/context so the bridge does not
		// leak one map entry per turn over the life of the agent. Emitting first
		// keeps the final `run_end` seq monotonic.
		service.clearRunContext(runId);
	} catch (err) {
		logger.debug(
			{
				src: "agent-event-bridge",
				err: err instanceof Error ? err.message : String(err),
			},
			"Failed to bridge RUN_ENDED to AgentEventService",
		);
	}
}

/**
 * Bridge `EVALUATOR_STARTED` → AgentEventService `evaluator` stream.
 */
export function bridgeEvaluatorStartedToStreams(
	payload: EvaluatorEventPayload,
): void {
	const runtime = payload.runtime;
	const service = resolveAgentEventService(runtime);
	if (!service) {
		return;
	}
	const runId = resolveRunId(runtime);
	if (!runId) {
		return;
	}
	try {
		service.emitEvaluatorStart(runId, {
			evaluatorName: payload.evaluatorName,
		});
	} catch (err) {
		logger.debug(
			{
				src: "agent-event-bridge",
				err: err instanceof Error ? err.message : String(err),
			},
			"Failed to bridge EVALUATOR_STARTED to AgentEventService",
		);
	}
}

/**
 * Bridge `EVALUATOR_COMPLETED` → AgentEventService `evaluator` stream.
 */
export function bridgeEvaluatorCompletedToStreams(
	payload: EvaluatorEventPayload,
): void {
	const runtime = payload.runtime;
	const service = resolveAgentEventService(runtime);
	if (!service) {
		return;
	}
	const runId = resolveRunId(runtime);
	if (!runId) {
		return;
	}
	try {
		service.emitEvaluatorComplete(runId, {
			evaluatorName: payload.evaluatorName,
			validated: payload.completed === true,
		});
	} catch (err) {
		logger.debug(
			{
				src: "agent-event-bridge",
				err: err instanceof Error ? err.message : String(err),
			},
			"Failed to bridge EVALUATOR_COMPLETED to AgentEventService",
		);
	}
}
