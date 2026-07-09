/**
 * Outbound message creation and send logic used by `DiscordService` — builds
 * and dispatches replies to Discord (content, attachments, chunking, pairing
 * gate) and maps interaction URLs into the outgoing payload.
 */
import { createHash } from "node:crypto";
import {
	ChannelType,
	type Content,
	ContentType,
	checkPairingAllowed,
	createUniqueUuid,
	type EventPayload,
	EventType,
	type FetchedDocumentUrl as FetchedKnowledgeUrl,
	fetchDocumentFromUrl,
	getConnectorAdminWhitelist,
	type HandlerCallback,
	type IAgentRuntime,
	isInAllowlist,
	lifeOpsPassiveConnectorsEnabled,
	type Media,
	type Memory,
	MemoryType,
	type Service,
	ServiceType,
	stringToUuid,
	type UUID,
} from "@elizaos/core";
import {
	type ActionRowBuilder,
	type AttachmentBuilder,
	type Channel,
	type Client,
	ChannelType as DiscordChannelType,
	type Message as DiscordMessage,
	type MessageActionRowComponentBuilder,
	type TextChannel,
} from "discord.js";
import { isDiscordUserAddressed } from "./addressing";
import { AttachmentManager } from "./attachments";
// See service.ts for detailed documentation on Discord ID handling.
// Key point: Discord snowflake IDs (e.g., "1253563208833433701") are NOT valid UUIDs.
// Use stringToUuid() to convert them, not asUUID() which would throw an error.
import type { ICompatRuntime } from "./compat";
import { createDraftStreamController } from "./draft-stream";
import { getDiscordSettings } from "./environment";
import { buildDiscordWorldMetadata } from "./identity";
import { formatInboundEnvelope } from "./inbound-envelope";
import { buildDiscordReplyPayload } from "./interactions";
import {
	appendCoalescedDiscordMetadata,
	type DiscordMessageWithCoalescedMetadata,
} from "./message-coalesce";
import { stripReasoningTags } from "./reasoning-tags";
import {
	applyDiscordStalenessGuard,
	type DiscordStalenessConfig,
	getDiscordChannelMessageSequence,
	getDiscordStalenessConfig,
} from "./staleness";
import {
	createStatusReactionController,
	type StatusReactionScope,
	shouldShowStatusReaction,
} from "./status-reactions";
import {
	DiscordEventTypes,
	type DiscordSettings,
	type IDiscordService,
	type JsonObject,
	type JsonValue,
} from "./types";
import { createTypingController } from "./typing";
import {
	buildDiscordComponents,
	buildOutboundDiscordAttachment,
	canSendMessage,
	extractUrls,
	getMessageService,
	getMessagingAPI,
	normalizeDiscordMessageText,
	sendMessageInChunks,
} from "./utils";

const INTERACTION_ONLY_FALLBACK_TEXT = "Choose an option:";

export function resolveGenerationTimeoutMs(
	timeoutSetting: unknown,
	fallbackSetting: unknown,
	mediaGenerationTimeoutSetting?: unknown,
): number | null {
	const hasExplicitDiscordTimeout =
		timeoutSetting !== undefined &&
		timeoutSetting !== null &&
		String(timeoutSetting).trim() !== "";

	const parsed = Number.parseInt(
		String(timeoutSetting ?? fallbackSetting ?? "120000"),
		10,
	);
	let base: number | null;
	if (!Number.isFinite(parsed)) {
		base = 120_000;
	} else {
		base = parsed > 0 ? Math.max(30_000, parsed) : null;
	}

	if (hasExplicitDiscordTimeout || base === null) {
		return base;
	}

	const mediaParsed = Number.parseInt(
		String(mediaGenerationTimeoutSetting ?? ""),
		10,
	);
	if (!Number.isFinite(mediaParsed) || mediaParsed <= 0) {
		return base;
	}
	return Math.max(base, Math.max(30_000, mediaParsed));
}

function isJsonValue(value: unknown): value is JsonValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return true;
	}
	if (Array.isArray(value)) {
		return value.every(isJsonValue);
	}
	if (typeof value === "object" && value !== null) {
		return Object.values(value).every(isJsonValue);
	}
	return false;
}

function compactJsonObject(record: Record<string, unknown>): JsonObject {
	const json: JsonObject = {};
	for (const [key, value] of Object.entries(record)) {
		if (value === undefined) continue;
		if (isJsonValue(value)) {
			json[key] = value;
		}
	}
	return json;
}

function normalizeReplyToMode(
	replyToMode: DiscordSettings["replyToMode"],
): "off" | "first" | "all" {
	if (replyToMode === "off" || replyToMode === "all") {
		return replyToMode;
	}

	return "first";
}

function getAddressingContent(message: DiscordMessage): string {
	return (
		(message as DiscordMessageWithCoalescedMetadata)
			.__discordAddressingContent ?? message.content
	);
}

function fetchedUrlToAttachment(
	url: string,
	fetched: FetchedKnowledgeUrl,
): Media {
	const hasReadableText = fetched.contentType !== "binary";
	return {
		id: webpageAttachmentId(url),
		url,
		title: fetched.filename || "Web Page",
		source: fetched.contentType === "transcript" ? "YouTube" : "Web",
		text: hasReadableText ? fetched.content : "",
		contentType: ContentType.LINK,
	};
}

function webpageAttachmentId(url: string): string {
	return `webpage-${createHash("sha256").update(url).digest("hex").slice(0, 24)}`;
}

const ACTIVE_TASK_AGENT_STATUSES = new Set([
	"active",
	"blocked",
	"tool_running",
]);
const DISCORD_OUTBOUND_DEDUPE_WINDOW_MS = 2000;
const DISCORD_OUTBOUND_DEDUPE_MAX_KEYS = 512;

const recentOutboundDiscordDeliveries = new Map<string, number>();

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringField(
	record: Record<string, unknown> | null,
	field: string,
): string | undefined {
	const value = record?.[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function hasActiveTaskAgentWorkForMessage(
	runtime: Pick<IAgentRuntime, "getService">,
	messageId: string,
): boolean {
	try {
		const coordinator = asRecord(runtime.getService("SWARM_COORDINATOR"));
		const tasks = coordinator?.tasks;
		if (!(tasks instanceof Map)) {
			return false;
		}

		for (const taskValue of tasks.values()) {
			const task = asRecord(taskValue);
			const status = stringField(task, "status");
			if (!status || !ACTIVE_TASK_AGENT_STATUSES.has(status)) {
				continue;
			}

			const metadata = asRecord(task?.originMetadata);
			const originMessageId = stringField(metadata, "messageId");
			if (originMessageId === messageId) {
				return true;
			}
		}
	} catch {
		return false;
	}

	return false;
}

export function shouldSuppressTimeoutForInFlightDispatchForTests({
	generationTimedOut,
	responseDispatchInFlight,
}: {
	generationTimedOut: boolean;
	responseDispatchInFlight: boolean;
}): boolean {
	return generationTimedOut && responseDispatchInFlight;
}

export interface DiscordOutboundDeliveryReservation {
	commit(): void;
	release(): void;
}

export type BeginDiscordOutboundDeliveryResult =
	| { kind: "duplicate" }
	| { kind: "deliver"; reservation: DiscordOutboundDeliveryReservation };

export interface DiscordOutboundDeliveryParams {
	accountId?: string;
	channelId: string;
	replyToMessageId?: string;
	text?: string;
	attachmentUrls?: readonly string[];
	now?: number;
	windowMs?: number;
	state?: Map<string, number>;
}

function normalizeOutboundText(text: string | undefined): string {
	return typeof text === "string"
		? text.replace(/\s+/g, " ").trim().toLowerCase()
		: "";
}

function outboundAttachmentIdentity(
	attachmentUrls: readonly string[] | undefined,
): string {
	return attachmentUrls?.filter(Boolean).sort().join(",") ?? "";
}

function pruneOutboundDedupeState(
	state: Map<string, number>,
	now: number,
	windowMs: number,
): void {
	for (const [key, timestamp] of state) {
		if (now - Math.abs(timestamp) > windowMs) {
			state.delete(key);
		}
	}
	if (state.size <= DISCORD_OUTBOUND_DEDUPE_MAX_KEYS) return;
	const overflow = state.size - DISCORD_OUTBOUND_DEDUPE_MAX_KEYS;
	let removed = 0;
	for (const key of state.keys()) {
		if (removed >= overflow) break;
		state.delete(key);
		removed += 1;
	}
}

/**
 * Reserve one outbound Discord delivery. Discord can receive the same logical
 * tool-backed answer through the inbound response callback and the generic
 * message-connector send path in the same event-loop burst; this guard shares a
 * short process-local window across both paths so the first REST send wins.
 */
export function beginDiscordOutboundDelivery(
	params: DiscordOutboundDeliveryParams,
): BeginDiscordOutboundDeliveryResult {
	const text = normalizeOutboundText(params.text);
	const attachments = outboundAttachmentIdentity(params.attachmentUrls);
	if (!text && !attachments) {
		return {
			kind: "deliver",
			reservation: { commit() {}, release() {} },
		};
	}

	const now = params.now ?? Date.now();
	const windowMs = params.windowMs ?? DISCORD_OUTBOUND_DEDUPE_WINDOW_MS;
	const state = params.state ?? recentOutboundDiscordDeliveries;
	const key = [
		params.accountId ?? "default",
		params.channelId,
		params.replyToMessageId ?? "",
		attachments,
		text,
	].join("\u0000");

	pruneOutboundDedupeState(state, now, windowMs);
	const previous = state.get(key);
	if (
		previous !== undefined &&
		Math.abs(now - Math.abs(previous)) <= windowMs
	) {
		return { kind: "duplicate" };
	}

	state.set(key, -now);
	let settled = false;
	return {
		kind: "deliver",
		reservation: {
			commit() {
				if (settled) return;
				settled = true;
				state.set(key, now);
			},
			release() {
				if (settled) return;
				settled = true;
				if (state.get(key) === -now) {
					state.delete(key);
				}
			},
		},
	};
}

/**
 * Outcome of {@link runGenerationWithAbortableTimeout}.
 *
 * - `timedOut`   — the timeout won the race; the abort signal was fired.
 * - `settled`    — the generation promise fulfilled or rejected before the
 *                  timeout. When `timedOut` is true, `settled` reflects
 *                  whether the orphaned generation had ALREADY completed at
 *                  the moment the timeout fired (almost always `false`).
 * - `error`      — the rejection value when generation rejected on its own
 *                  (not a timeout). `undefined` on success or timeout.
 */
export interface AbortableTimeoutResult {
	timedOut: boolean;
	settled: boolean;
	error?: unknown;
}

/**
 * Runs a single generation attempt against a wall-clock timeout, wiring an
 * {@link AbortController} so that a timeout ACTUALLY CANCELS the underlying
 * work instead of leaving it running as an orphan.
 *
 * Why this exists (the bug):
 * The previous Discord dispatch did `Promise.race([generationPromise,
 * timeoutPromise])` where `generationPromise` called
 * `messageService.handleMessage(runtime, message, callback)` with NO abort
 * signal. When the timeout won the race we set a `generationTimedOut` flag
 * and sent the "I timed out" reply — but the model call kept running,
 * burning tokens and (worse) racing to emit a late response into the same
 * room. The alternating "timeout / then instant" pattern is the classic
 * signature of an orphaned run that resolves late and poisons the next slot.
 *
 * The core message service ALREADY threads
 * `MessageProcessingOptions.abortSignal` → `StreamingContext.abortSignal` →
 * `runtime.useModel` (`params.signal ??= abortSignal`) → provider fetch
 * (see packages/core/src/services/message.ts and
 * message-handler-abort.test.ts). The only missing link was the connector
 * never CREATING a controller and never PASSING the signal down. This helper
 * closes that gap.
 *
 * Contract:
 * - `generate(signal)` MUST forward `signal` into the generation call so the
 *   abort actually propagates. The helper cannot enforce this — the call
 *   site is responsible for plumbing `{ abortSignal: signal }` through.
 * - On timeout: `controller.abort()` fires, `timedOut` is `true`, and the
 *   orphaned promise's eventual rejection is swallowed so it never surfaces
 *   as an unhandled rejection.
 * - `timeoutMs === null` disables the timeout entirely (media / long jobs);
 *   the generation is awaited to completion and no controller races it.
 *
 * @param generate  Callback receiving the abort signal; returns the
 *                  generation promise. Must forward the signal downstream.
 * @param timeoutMs Wall-clock budget in ms, or `null` to disable the timeout.
 * @returns         {@link AbortableTimeoutResult} describing how the race
 *                  resolved.
 */
export async function runGenerationWithAbortableTimeout(
	generate: (signal: AbortSignal) => Promise<unknown>,
	timeoutMs: number | null,
): Promise<AbortableTimeoutResult> {
	const controller = new AbortController();
	let settled = false;

	const generationPromise = Promise.resolve()
		.then(() => generate(controller.signal))
		.then(
			() => {
				settled = true;
				return { kind: "ok" as const };
			},
			(error: unknown) => {
				settled = true;
				return { kind: "error" as const, error };
			},
		);

	// Never let the orphaned generation surface as an unhandled rejection.
	// The `.then(onRejected)` above already converts rejection into a value,
	// but attach a defensive catch in case `generate` throws synchronously
	// off the microtask edge.
	void generationPromise.catch(() => {});

	if (timeoutMs === null) {
		const outcome = await generationPromise;
		return {
			timedOut: false,
			settled: true,
			...(outcome.kind === "error" ? { error: outcome.error } : {}),
		};
	}

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<"timeout">((resolve) => {
		timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
	});

	try {
		const winner = await Promise.race([generationPromise, timeoutPromise]);
		if (winner === "timeout") {
			// Timeout won: abort the underlying work so the orphaned run stops
			// burning tokens and cannot race a late response into the room.
			controller.abort();
			return { timedOut: true, settled };
		}
		return {
			timedOut: false,
			settled: true,
			...(winner.kind === "error" ? { error: winner.error } : {}),
		};
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
	}
}

export async function createDiscordMessageMemoryOnce(
	runtime: Pick<
		IAgentRuntime,
		"agentId" | "createMemory" | "getMemoryById" | "logger"
	>,
	memory: Memory,
	context: {
		operation: string;
		platformMessageId?: string;
	} = { operation: "discord-message-persist" },
): Promise<Memory | null> {
	if (!memory.id) {
		const id = await runtime.createMemory(memory, "messages");
		return { ...memory, id };
	}

	const existing = await runtime.getMemoryById(memory.id);
	if (existing) {
		runtime.logger.debug(
			{
				src: "plugin:discord",
				agentId: runtime.agentId,
				memoryId: memory.id,
				messageId: context.platformMessageId,
				operation: context.operation,
			},
			"Skipping duplicate Discord message memory",
		);
		return existing;
	}

	await runtime.createMemory(memory, "messages");
	return memory;
}

/** Options handed to `User.send` when delivering a Discord DM reply. */
export interface DmSendOptions {
	content: string;
	files?: AttachmentBuilder[];
	components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

/**
 * Build the option bag for a DM reply using the same widget rows as guild
 * sends. Discord supports action rows of buttons and string selects in DMs, so
 * the connector does not need a DM-specific fallback for the component types it
 * emits.
 *
 * `components`/`files` keys are omitted entirely when empty so we never send an
 * empty `components: []` (which Discord rejects) or an empty `files: []`.
 *
 * @param textContent - Prose to send (already normalized, may be the
 *   "Choose an option:" fallback when the reply is components-only).
 * @param files - Outbound attachments, if any.
 * @param components - Already-built discord.js action rows (from
 *   `buildDiscordComponents`), if any.
 */
export function buildDmSendOptions(
	textContent: string,
	files: AttachmentBuilder[],
	components: ActionRowBuilder<MessageActionRowComponentBuilder>[] | undefined,
): DmSendOptions {
	return {
		content: textContent,
		...(files.length > 0 ? { files } : {}),
		...(components && components.length > 0 ? { components } : {}),
	};
}

/**
 * Class representing a Message Manager for handling Discord messages.
 */

export class MessageManager {
	private client: Client;
	private runtime: ICompatRuntime;
	private attachmentManager: AttachmentManager;
	private getChannelType: (channel: Channel) => Promise<ChannelType>;
	private discordSettings: DiscordSettings;
	private discordService: IDiscordService;
	private accountId: string;
	private statusReactionScope: StatusReactionScope;
	private envelopeEnabled: boolean;
	private draftStreamingEnabled: boolean;
	private stalenessConfig: DiscordStalenessConfig;
	private recentlyProcessedMessageIds = new Map<string, number>();
	private static readonly PROCESSED_MESSAGE_TTL_MS = 2 * 60 * 1000;
	/**
	 * Constructor for a new instance of MessageManager.
	 * @param {IDiscordService} discordService - The Discord service instance.
	 * @param {ICompatRuntime} runtime - The agent runtime instance (with cross-core compat).
	 * @throws {Error} If the Discord client is not initialized
	 */
	constructor(discordService: IDiscordService, runtime: ICompatRuntime) {
		// Guard against null client - fail fast with a clear error
		if (!discordService.client) {
			const errorMsg =
				"Discord client not initialized - cannot create MessageManager";
			runtime.logger.error(
				{ src: "plugin:discord", agentId: runtime.agentId },
				errorMsg,
			);
			throw new Error(errorMsg);
		}

		this.client = discordService.client;
		this.runtime = runtime;
		this.attachmentManager = new AttachmentManager(this.runtime);
		this.getChannelType = discordService.getChannelType;
		this.discordService = discordService;
		this.accountId = discordService.accountId ?? "default";
		// Load Discord settings with proper priority (env vars > character settings > defaults)
		this.discordSettings =
			discordService.discordSettings ?? getDiscordSettings(this.runtime);
		const reactionScopeSetting = this.runtime.getSetting(
			"DISCORD_STATUS_REACTIONS",
		) as string | undefined;
		this.statusReactionScope = (
			["all", "group-mentions", "none"].includes(reactionScopeSetting ?? "")
				? reactionScopeSetting
				: "group-mentions"
		) as StatusReactionScope;

		const envelopeSetting = this.runtime.getSetting(
			"DISCORD_ENVELOPE_ENABLED",
		) as string | undefined;
		this.envelopeEnabled =
			envelopeSetting !== "false" && envelopeSetting !== "0";

		const draftStreamSetting = this.runtime.getSetting(
			"DISCORD_DRAFT_STREAMING",
		) as string | undefined;
		this.draftStreamingEnabled =
			draftStreamSetting === "true" || draftStreamSetting === "1";
		this.stalenessConfig = getDiscordStalenessConfig((key) =>
			this.runtime.getSetting(key),
		);
	}

	/**
	 * Check DM access based on the configured dmPolicy.
	 *
	 * @param message - The Discord DM message
	 * @returns Access check result with allowed status and optional reply message
	 */
	private async checkDmAccess(message: DiscordMessage): Promise<{
		allowed: boolean;
		replyMessage?: string;
	}> {
		const policy = this.discordSettings.dmPolicy ?? "pairing";
		const userId = message.author.id;

		// Disabled policy - block all DMs
		if (policy === "disabled") {
			this.runtime.logger.debug(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					userId,
				},
				"DM blocked: policy is disabled",
			);
			return { allowed: false };
		}

		// Open policy - allow all DMs
		if (policy === "open") {
			return { allowed: true };
		}

		// Allowlist policy - check static allowFrom list and dynamic pairing allowlist
		if (policy === "allowlist") {
			// Check static allowlist first
			if (this.discordSettings.allowFrom?.includes(userId)) {
				return { allowed: true };
			}

			// Check dynamic pairing allowlist
			const inDynamicAllowlist = await isInAllowlist(
				this.runtime,
				"discord",
				userId,
			);
			if (inDynamicAllowlist) {
				return { allowed: true };
			}

			this.runtime.logger.debug(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					userId,
				},
				"DM blocked: user not in allowlist",
			);
			return { allowed: false };
		}

		// Pairing policy - use PairingService
		if (policy === "pairing") {
			// Check static allowlist first (if configured, allow bypass of pairing)
			if (this.discordSettings.allowFrom?.includes(userId)) {
				return { allowed: true };
			}

			// The resolved bot owner and explicitly whitelisted connector admins
			// (seeded by refreshOwnerDiscordUserIds from the application owner /
			// team / ELIZA_DISCORD_OWNER_USER_IDS_JSON) are the pairing APPROVERS —
			// they must never be locked behind their own pairing gate (#14710).
			const discordAdminIds =
				getConnectorAdminWhitelist(this.runtime).discord ?? [];
			if (discordAdminIds.includes(userId)) {
				return { allowed: true };
			}

			// Use the PairingService for pairing workflow
			const result = await checkPairingAllowed(this.runtime, {
				channel: "discord",
				senderId: userId,
				metadata: {
					username: message.author.username,
					displayName: message.author.displayName ?? message.author.username,
					discriminator: message.author.discriminator ?? "",
				},
			});

			if (result.allowed) {
				return { allowed: true };
			}

			// Not allowed - return pairing reply message only for new requests
			this.runtime.logger.debug(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					userId,
					pairingCode: result.pairingCode,
					newRequest: result.newRequest,
				},
				"DM blocked: pairing required",
			);

			return {
				allowed: false,
				// Only send reply for new pairing requests (avoid spamming on every message)
				replyMessage: result.newRequest ? result.replyMessage : undefined,
			};
		}

		// Default: allow
		return { allowed: true };
	}

	private async persistInboundMemory(memory: Memory): Promise<void> {
		if (!memory.id) {
			return;
		}

		await createDiscordMessageMemoryOnce(this.runtime, memory, {
			operation: "discord-inbound",
		});
	}

	private markMessageAsProcessing(messageId: string): boolean {
		const now = Date.now();
		for (const [candidateId, processedAt] of this.recentlyProcessedMessageIds) {
			if (now - processedAt > MessageManager.PROCESSED_MESSAGE_TTL_MS) {
				this.recentlyProcessedMessageIds.delete(candidateId);
			}
		}

		if (this.recentlyProcessedMessageIds.has(messageId)) {
			return false;
		}

		this.recentlyProcessedMessageIds.set(messageId, now);
		return true;
	}

	/**
	 * Handles incoming Discord messages and processes them accordingly.
	 *
	 * @param {DiscordMessage} message - The Discord message to be handled
	 */
	async handleMessage(message: DiscordMessage) {
		// this filtering is already done in setupEventListeners
		/*
    if (
      (this.discordSettings.allowedChannelIds && this.discordSettings.allowedChannelIds.length) &&
      !this.discordSettings.allowedChannelIds.some((id: string) => id === message.channel.id)
    ) {
      return;
    }
    */

		const clientUser = this.client.user;
		if (
			message.interaction ||
			(clientUser && message.author.id === clientUser.id)
		) {
			return;
		}

		if (this.discordSettings.shouldIgnoreBotMessages && message.author?.bot) {
			return;
		}

		if (message.id && !this.markMessageAsProcessing(message.id)) {
			this.runtime.logger.debug(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					messageId: message.id,
				},
				"Skipping duplicate Discord message",
			);
			return;
		}

		// DM policy check - applies access control policies for direct messages
		if (message.channel.type === DiscordChannelType.DM) {
			const userId = message.author.id;
			if (this.discordSettings.shouldIgnoreDirectMessages) {
				const staticallyAllowed =
					this.discordSettings.allowFrom?.includes(userId) === true;
				const dynamicallyAllowed = await isInAllowlist(
					this.runtime,
					"discord",
					userId,
				);
				if (!staticallyAllowed && !dynamicallyAllowed) {
					return;
				}
			}

			const accessCheck = await this.checkDmAccess(message);
			if (!accessCheck.allowed) {
				// If a reply message was generated (new pairing request), send it
				if (accessCheck.replyMessage) {
					try {
						await message.author.send(accessCheck.replyMessage);
					} catch (err) {
						this.runtime.logger.warn(
							{
								src: "plugin:discord",
								agentId: this.runtime.agentId,
								userId: message.author.id,
								error: err instanceof Error ? err.message : String(err),
							},
							"Failed to send pairing reply",
						);
					}
				}
				return;
			}
		}

		const isBotPlatformMentioned = !!(
			clientUser?.id && message.mentions.users?.has(clientUser.id)
		);
		const isReplyToBot =
			!!message.reference?.messageId &&
			message.mentions.repliedUser?.id === clientUser?.id;
		const isBotAddressed = isDiscordUserAddressed({
			text: getAddressingContent(message),
			userId: clientUser?.id,
			hasMessageReference: Boolean(message.reference?.messageId),
			repliedUserId: message.mentions.repliedUser?.id,
		});
		const mentionedOtherUsers = message.mentions.users
			? Array.from(message.mentions.users.values()).some(
					(user) => user.id !== clientUser?.id && user.id !== message.author.id,
				)
			: false;
		const isReplyToOtherUser =
			!!message.reference?.messageId &&
			!!message.mentions.repliedUser?.id &&
			message.mentions.repliedUser.id !== clientUser?.id &&
			message.mentions.repliedUser.id !== message.author.id;
		const isInThread = message.channel.isThread();
		const isDM = message.channel.type === DiscordChannelType.DM;
		const strictModeEnabled =
			this.discordSettings.shouldRespondOnlyToMentions === true;
		const replyToMode = normalizeReplyToMode(this.discordSettings.replyToMode);
		const outboundReplyToMessageId =
			!isDM && replyToMode !== "off" && isBotAddressed ? message.id : undefined;
		const strictModeShouldProcess = isDM || isBotAddressed;

		const userName = message.author.bot
			? `${message.author.username}#${message.author.discriminator}`
			: message.author.username;
		const name =
			message.member?.displayName ??
			message.author.globalName ??
			message.author.displayName ??
			message.author.username;
		const channelId = message.channel.id;
		const roomId = createUniqueUuid(this.runtime, channelId);
		const roomName =
			message.guild &&
			"name" in message.channel &&
			typeof message.channel.name === "string"
				? message.channel.name
				: name || userName;

		// Determine channel type and server ID for ensureConnection
		// messageServerId is a Discord snowflake string, converted to UUID when needed
		let type: ChannelType;
		let messageServerId: string | undefined;

		if (message.guild) {
			// Use the gateway-cached guild directly; do NOT call
			// `await message.guild.fetch()`. That issues a REST GET /guilds/{id} on
			// EVERY message; in a large, busy guild (thousands of members) the
			// per-message fetch storm saturates discord.js's REST queue and starves
			// message handling — the bot goes silent in big servers while staying
			// fine in small ones (rate-limits are queued, not thrown, so nothing
			// shows in the logs). `guild.id` (all that's used below) is already on
			// the cached object.
			const guild = message.guild;
			type = await this.getChannelType(message.channel as Channel);
			if (type === null) {
				// usually a forum type post
				this.runtime.logger.warn(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						channelId: message.channel.id,
					},
					"Null channel type",
				);
			}
			messageServerId = guild.id;
		} else {
			type = ChannelType.DM;
			messageServerId = message.channel.id;
		}

		try {
			let { processedContent, attachments } =
				await this.processMessage(message);
			const currentMessageText = processedContent;
			// Audio attachments already processed in processMessage via attachmentManager

			if (this.envelopeEnabled && processedContent) {
				try {
					const envelope = await formatInboundEnvelope(
						message,
						processedContent,
					);
					processedContent = envelope.formattedContent;
				} catch {
					// Envelope formatting is best-effort only.
				}
			}

			if (!processedContent && !attachments?.length) {
				// Only process messages that are not empty
				return;
			}

			// Users often mention a teammate and then ask the bot by name in the
			// same message. Only short-circuit these messages when the bot is not
			// also clearly addressed.
			const ignoresOtherTarget =
				!isDM && !isBotAddressed && (mentionedOtherUsers || isReplyToOtherUser);

			// Use the service's buildMemoryFromMessage method with pre-processed content
			const newMessage = await this.discordService.buildMemoryFromMessage(
				message,
				{
					processedContent,
					processedAttachments: attachments,
					extraContent: {
						currentMessageText,
						mentionContext: {
							isMention: isBotPlatformMentioned && isBotAddressed,
							isReply: isReplyToBot,
							isThread: isInThread,
							mentionType:
								isBotPlatformMentioned && isBotAddressed
									? "platform_mention"
									: isReplyToBot
										? "reply"
										: isInThread
											? "thread"
											: "none",
						},
					},
					extraMetadata: compactJsonObject(
						appendCoalescedDiscordMetadata(message, {
							// Reply attribution for cross-agent filtering
							// WHY: When user replies to another bot's message, we need to know
							// so other agents can ignore it (only the replied-to agent should respond)
							...(message.mentions.repliedUser
								? {
										replyToAuthor: {
											id: message.mentions.repliedUser.id,
											displayName:
												message.mentions.repliedUser.globalName ??
												message.mentions.repliedUser.username,
											username: message.mentions.repliedUser.username,
											isBot: message.mentions.repliedUser.bot,
										},
										replyToSenderId: message.mentions.repliedUser.id,
										replyToSenderName:
											message.mentions.repliedUser.globalName ??
											message.mentions.repliedUser.username,
										replyToSenderUserName:
											message.mentions.repliedUser.username,
									}
								: {}),
							...(message.reference?.messageId
								? {
										replyToMessageId: createUniqueUuid(
											this.runtime,
											message.reference.messageId,
										),
										replyToExternalMessageId: message.reference.messageId,
									}
								: {}),
						}),
					),
				},
			);

			if (!newMessage) {
				this.runtime.logger.warn(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						messageId: message.id,
					},
					"Failed to build memory from message",
				);
				return;
			}

			await this.runtime.ensureConnection({
				entityId: newMessage.entityId,
				roomId,
				roomName,
				userName,
				name,
				source: "discord",
				channelId: message.channel.id,
				// Convert Discord snowflake to UUID (see service.ts header for why stringToUuid not asUUID)
				messageServerId: messageServerId
					? stringToUuid(messageServerId)
					: undefined,
				type,
				worldId: createUniqueUuid(this.runtime, messageServerId ?? roomId),
				worldName: message.guild?.name,
				// Preserve the raw Discord user id in source metadata for role and allowlist checks.
				userId: message.author.id as UUID,
				metadata: {
					...buildDiscordWorldMetadata(
						this.runtime,
						message.guild?.ownerId ?? undefined,
					),
					accountId: this.accountId,
				},
			});

			if (
				!this.discordSettings.autoReply ||
				lifeOpsPassiveConnectorsEnabled(this.runtime)
			) {
				await this.persistInboundMemory(newMessage);
				this.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						channelId: message.channel.id,
					},
					"Auto-reply disabled; message ingested without response",
				);
				return;
			}

			if (ignoresOtherTarget) {
				await this.persistInboundMemory(newMessage);
				this.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						channelId: message.channel.id,
					},
					"Ignoring message that targets another mentioned user",
				);
				return;
			}

			if (strictModeEnabled && !strictModeShouldProcess) {
				await this.persistInboundMemory(newMessage);
				this.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						channelId: message.channel.id,
					},
					"Strict mode: ignoring message (no mention or reply)",
				);
				return;
			}

			if (strictModeEnabled) {
				this.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						channelId: message.channel.id,
					},
					"Strict mode: processing message",
				);
			}

			const canSendResult = canSendMessage(message.channel);
			if (!canSendResult.canSend) {
				await this.persistInboundMemory(newMessage);
				return this.runtime.logger.warn(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						channelId: message.channel.id,
						reason: canSendResult.reason,
					},
					"Cannot send message to channel",
				);
			}

			const messageId = newMessage.id;
			const stalenessStartSequence = getDiscordChannelMessageSequence(
				this,
				message.channel.id,
			);
			const channel = message.channel as TextChannel;
			const typingController = createTypingController(channel);
			const clientUserId = this.client.user?.id;
			const useReactions = shouldShowStatusReaction(
				this.statusReactionScope,
				message,
				clientUserId,
			);
			const statusReactions = useReactions
				? createStatusReactionController(message)
				: null;
			const draftStream = this.draftStreamingEnabled
				? createDraftStreamController({
						log: (entry) =>
							this.runtime.logger.debug(
								{ src: "plugin:discord", agentId: this.runtime.agentId },
								entry,
							),
						warn: (entry) =>
							this.runtime.logger.warn(
								{ src: "plugin:discord", agentId: this.runtime.agentId },
								entry,
							),
					})
				: null;
			let typingStarted = false;
			let responseEmitted = false;
			let responseDispatchInFlight = false;
			let generationTimedOut = false;
			const generationTimeoutMs = resolveGenerationTimeoutMs(
				this.runtime.getSetting("DISCORD_GENERATION_TIMEOUT_MS") ??
					process.env.DISCORD_GENERATION_TIMEOUT_MS,
				this.runtime.getSetting("MESSAGE_TIMEOUT_MS") ??
					process.env.MESSAGE_TIMEOUT_MS,
				this.runtime.getSetting("ZEROLLAMA_VIDEO_TIMEOUT_MS") ??
					process.env.ZEROLLAMA_VIDEO_TIMEOUT_MS,
			);

			const finalizePendingDraft = async () => {
				if (draftStream?.isStarted() && !draftStream.isDone()) {
					await draftStream.finalize("");
				}
			};

			const abortPendingDraft = async () => {
				if (draftStream?.isStarted() && !draftStream.isDone()) {
					await draftStream.abort(
						"An error occurred while generating the response.",
					);
				}
			};

			const sendFailureReply = async (text: string) => {
				try {
					await channel.send({
						content: text,
						...(outboundReplyToMessageId && replyToMode !== "off"
							? {
									reply: {
										messageReference: outboundReplyToMessageId,
									},
								}
							: {}),
					});
					responseEmitted = true;
				} catch (sendError) {
					this.runtime.logger.warn(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							error:
								sendError instanceof Error
									? sendError.message
									: String(sendError),
						},
						"Failed to send Discord failure reply",
					);
				}
			};

			const runResponseDispatch = async <T>(
				dispatch: () => Promise<T>,
			): Promise<T> => {
				responseDispatchInFlight = true;
				try {
					return await dispatch();
				} finally {
					responseDispatchInFlight = false;
				}
			};

			if (draftStream) {
				await draftStream.start(channel, outboundReplyToMessageId, replyToMode);
			}
			// Typing indicator is deferred until the runtime actually invokes the
			// handler callback (see the `typingStarted` guard further down). This
			// avoids showing "Eliza is typing…" for messages the agent decides to
			// IGNORE/NONE, and lines up with the message-service preamble that
			// fires the callback the moment we commit to responding.

			statusReactions?.setQueued();
			statusReactions?.setThinking();

			const callback: HandlerCallback = async (content: Content) => {
				let outboundReservation: DiscordOutboundDeliveryReservation | undefined;
				try {
					const pendingAttachmentCount = Array.isArray(content.attachments)
						? content.attachments.filter((media) => Boolean(media?.url)).length
						: 0;
					// Long-running media (e.g. Wan video ~10 min) can outlive the Discord
					// generation timeout. Still deliver attachments when the job finishes.
					if (generationTimedOut && pendingAttachmentCount === 0) {
						return [];
					}
					// target is set but not addressed to us handling
					if (
						content.target &&
						typeof content.target === "string" &&
						content.target.toLowerCase() !== "discord"
					) {
						return [];
					}

					const stalenessDecision = applyDiscordStalenessGuard({
						config: this.stalenessConfig,
						owner: this,
						message,
						startSequence: stalenessStartSequence,
						content,
					});
					if (stalenessDecision.stale) {
						this.runtime.logger.warn(
							{
								src: "plugin:discord",
								agentId: this.runtime.agentId,
								channelId: message.channel.id,
								messageId: message.id,
								messagesSinceTurnStart:
									stalenessDecision.messagesSinceTurnStart,
								threshold: this.stalenessConfig.threshold,
								behavior: stalenessDecision.behavior,
							},
							"Discord response completed after newer channel messages arrived",
						);
					}
					if (!stalenessDecision.shouldSend) {
						typingController.stop();
						statusReactions?.setDone();
						await finalizePendingDraft();
						return [];
					}

					if (message.id && !content.inReplyTo) {
						content.inReplyTo = createUniqueUuid(this.runtime, message.id);
					}

					if (typeof content.text === "string" && content.text.length > 0) {
						content.text = stripReasoningTags(content.text);
					}

					// Project embedded interaction blocks (choices, task cards, …) onto
					// native Discord components, and strip their markers from the prose.
					const rendered = buildDiscordReplyPayload(this.runtime, content);
					const hasComponents = rendered.components.length > 0;
					let textContent = normalizeDiscordMessageText(rendered.text);
					if (textContent.trim().length === 0 && hasComponents) {
						textContent = INTERACTION_ONLY_FALLBACK_TEXT;
					}
					const hasText = textContent.trim().length > 0;
					let attachmentCount = Array.isArray(content.attachments)
						? content.attachments.filter((media) => Boolean(media?.url)).length
						: 0;

					// Skip attachment URLs already delivered by an action callback this turn.
					if (attachmentCount > 0 && content.inReplyTo) {
						const callbackDedup = message as DiscordMessage & {
							_elizaSentReplyKeys?: Set<string>;
							_elizaSentAttachmentUrls?: Set<string>;
						};
						callbackDedup._elizaSentAttachmentUrls ??= new Set();
						const sentAttachmentUrls = callbackDedup._elizaSentAttachmentUrls;
						const pendingAttachments = (content.attachments ?? []).filter(
							(media) =>
								Boolean(media?.url) && !sentAttachmentUrls.has(media.url),
						);
						if (pendingAttachments.length === 0) {
							content = { ...content, attachments: undefined };
							attachmentCount = 0;
						} else if (
							pendingAttachments.length !== (content.attachments ?? []).length
						) {
							content = { ...content, attachments: pendingAttachments };
							attachmentCount = pendingAttachments.length;
						}
					}

					if (!hasText && attachmentCount === 0) {
						return [];
					}

					if (!typingStarted) {
						typingStarted = true;
						typingController.start();
					}

					// Dedup: error when the runtime emits identical text
					// twice in response to the same inbound message (e.g.
					// planner follow-up repeating action output).
					if (hasText && content.inReplyTo) {
						const dedupKey = `${content.inReplyTo}::${textContent.replace(/\s+/g, " ").trim()}`;
						const callbackDedup = message as DiscordMessage & {
							_elizaSentReplyKeys?: Set<string>;
						};
						callbackDedup._elizaSentReplyKeys ??= new Set();
						if (callbackDedup._elizaSentReplyKeys.has(dedupKey)) {
							this.runtime.logger.debug(
								{
									src: "plugin:discord",
									agentId: this.runtime.agentId,
									messageId: message.id,
									textPreview: textContent
										.replace(/\s+/g, " ")
										.trim()
										.slice(0, 200),
								},
								"Suppressing duplicate callback reply with identical text",
							);
							return [];
						}
						callbackDedup._elizaSentReplyKeys.add(dedupKey);
					}

					const outboundDedupe = beginDiscordOutboundDelivery({
						accountId: this.accountId,
						channelId: channel.id,
						replyToMessageId:
							outboundReplyToMessageId ??
							(typeof content.inReplyTo === "string"
								? content.inReplyTo
								: undefined),
						text: textContent,
						attachmentUrls: content.attachments
							?.map((media) => media.url)
							.filter((url): url is string => typeof url === "string"),
					});
					if (outboundDedupe.kind === "duplicate") {
						this.runtime.logger.debug(
							{
								src: "plugin:discord",
								agentId: this.runtime.agentId,
								channelId: channel.id,
								messageId: message.id,
								textPreview: textContent
									.replace(/\s+/g, " ")
									.trim()
									.slice(0, 200),
							},
							"Suppressing duplicate Discord outbound delivery",
						);
						return [];
					}
					outboundReservation = outboundDedupe.reservation;

					const files: AttachmentBuilder[] = [];
					if (content.attachments && content.attachments.length > 0) {
						for (const media of content.attachments) {
							if (media.url) {
								files.push(
									await buildOutboundDiscordAttachment(media, this.runtime),
								);
							}
						}
						if (files.length > 0) {
							this.runtime.logger.info(
								{
									src: "plugin:discord",
									agentId: this.runtime.agentId,
									messageId: message.id,
									attachmentCount: files.length,
								},
								"Sending Discord message attachments",
							);
						}
					}

					let messages: DiscordMessage[] = [];
					if (draftStream?.isStarted() && !draftStream.isDone()) {
						if (hasText || files.length === 0) {
							const draftComponents = hasComponents
								? buildDiscordComponents(rendered.components)
								: undefined;
							messages = await runResponseDispatch(() =>
								draftStream.finalize(textContent, draftComponents),
							);
						} else {
							await finalizePendingDraft();
						}

						if (files.length > 0) {
							try {
								const attachmentMessage = await runResponseDispatch(() =>
									channel.send({
										files,
										...(outboundReplyToMessageId &&
										(replyToMode === "all" || !hasText)
											? {
													reply: {
														messageReference: outboundReplyToMessageId,
													},
												}
											: {}),
									}),
								);
								messages.push(attachmentMessage);
							} catch (error) {
								this.runtime.logger.warn(
									{
										src: "plugin:discord",
										agentId: this.runtime.agentId,
										error:
											error instanceof Error ? error.message : String(error),
									},
									"Failed to send Discord attachments after draft finalize",
								);
							}
						}
					} else if (content && content.channelType === "DM") {
						const user = await this.client.users.fetch(message.author.id);
						if (!user) {
							this.runtime.logger.warn(
								{
									src: "plugin:discord",
									agentId: this.runtime.agentId,
									entityId: message.author.id,
								},
								"User not found for DM",
							);
							return [];
						}

						const dmComponents = hasComponents
							? buildDiscordComponents(rendered.components)
							: undefined;
						const dmMessage = await runResponseDispatch(() =>
							user.send(buildDmSendOptions(textContent, files, dmComponents)),
						);
						messages = [dmMessage];
					} else {
						if (!message.id) {
							this.runtime.logger.warn(
								{ src: "plugin:discord", agentId: this.runtime.agentId },
								"Cannot send message: message.id is missing",
							);
							return [];
						}
						messages = await runResponseDispatch(() =>
							sendMessageInChunks(
								channel,
								textContent,
								outboundReplyToMessageId ?? "",
								files,
								hasComponents ? rendered.components : undefined,
								this.runtime,
								replyToMode,
							),
						);
					}

					const attemptedSend = hasText || attachmentCount > 0;
					if (attemptedSend && messages.length === 0) {
						throw new Error(
							"Discord response callback completed without sending any messages",
						);
					}
					if (messages.length > 0) {
						outboundReservation.commit();
						outboundReservation = undefined;
					}

					const memories: Memory[] = [];
					for (const m of messages) {
						const actions = content.actions;
						// Only attach files to the memory for the message that actually carries them
						const hasAttachments = m.attachments?.size > 0;

						const memory: Memory = {
							id: createUniqueUuid(this.runtime, m.id),
							entityId: this.runtime.agentId,
							agentId: this.runtime.agentId,
							content: {
								...content,
								source: "discord",
								text: m.content || textContent || " ",
								actions,
								inReplyTo: messageId,
								url: m.url,
								channelType: type,
								// Only include attachments for the message chunk that actually has them
								attachments:
									hasAttachments && content.attachments
										? content.attachments
										: undefined,
							},
							roomId,
							metadata: {
								type: MemoryType.MESSAGE,
								accountId: this.accountId,
								platformMessageId: m.id,
							},
							createdAt: m.createdTimestamp,
						};
						memories.push(memory);
					}

					for (const m of memories) {
						await createDiscordMessageMemoryOnce(this.runtime, m, {
							operation: "discord-response-callback",
							platformMessageId:
								typeof m.metadata?.platformMessageId === "string"
									? m.metadata.platformMessageId
									: undefined,
						});
					}

					if (memories.length > 0) {
						responseEmitted = true;
					}
					if (
						messages.length > 0 &&
						content.attachments?.length &&
						content.inReplyTo
					) {
						const callbackDedup = message as DiscordMessage & {
							_elizaSentAttachmentUrls?: Set<string>;
						};
						callbackDedup._elizaSentAttachmentUrls ??= new Set();
						for (const media of content.attachments) {
							if (media.url) {
								callbackDedup._elizaSentAttachmentUrls.add(media.url);
							}
						}
					}
					typingController.stop();
					statusReactions?.setDone();

					return memories;
				} catch (error) {
					outboundReservation?.release();
					this.runtime.logger.error(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							error: error instanceof Error ? error.message : String(error),
						},
						"Error handling message callback",
					);
					typingController.stop();
					statusReactions?.setError();
					await abortPendingDraft();
					throw error;
				}
			};

			const messagingAPI = getMessagingAPI(this.runtime);
			const messageService = getMessageService(this.runtime);
			// AbortController for the whole generation attempt. On timeout we fire
			// this so the underlying model call ACTUALLY cancels instead of running
			// on as an orphan (the root cause of the alternating timeout / instant
			// pattern). The signal threads into `messageService.handleMessage`
			// options → StreamingContext → runtime.useModel → provider fetch. See
			// runGenerationWithAbortableTimeout above and __tests__/generation-abort.
			const generationAbortController = new AbortController();
			const generationSignal = generationAbortController.signal;
			let generationTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
			try {
				const generationPromise = (async () => {
					if (messageService) {
						this.runtime.logger.debug(
							{ src: "plugin:discord", agentId: this.runtime.agentId },
							"Using messageService API",
						);
						await messageService.handleMessage(
							this.runtime,
							newMessage,
							callback,
							{ abortSignal: generationSignal },
						);
					} else if (messagingAPI?.handleMessage) {
						this.runtime.logger.debug(
							{ src: "plugin:discord", agentId: this.runtime.agentId },
							"Using messaging API handleMessage",
						);
						await messagingAPI.handleMessage(this.runtime.agentId, newMessage, {
							onResponse: callback,
						});
					} else if (messagingAPI?.sendMessage) {
						this.runtime.logger.debug(
							{ src: "plugin:discord", agentId: this.runtime.agentId },
							"Using messaging API sendMessage",
						);
						await messagingAPI.sendMessage(this.runtime.agentId, newMessage, {
							onResponse: callback,
						});
					} else {
						this.runtime.logger.debug(
							{ src: "plugin:discord", agentId: this.runtime.agentId },
							"Using event-based message handling",
						);
						const payload: EventPayload & {
							message: Memory;
							callback: HandlerCallback;
							accountId: string;
						} = {
							runtime: this.runtime,
							message: newMessage,
							callback,
							source: "discord",
							accountId: this.accountId,
						};
						await this.runtime.emitEvent(
							[
								DiscordEventTypes.MESSAGE_RECEIVED,
								EventType.MESSAGE_RECEIVED,
							] as string[],
							payload,
						);
					}
				})();

				// Never let the orphaned generation surface as an unhandled
				// rejection once we stop awaiting it on timeout.
				generationPromise.catch(() => {});
				if (generationTimeoutMs === null) {
					await generationPromise;
				} else {
					const timeoutPromise = new Promise<never>((_, reject) => {
						generationTimeoutHandle = setTimeout(() => {
							generationTimedOut = true;
							// Abort the underlying generation BEFORE rejecting so the
							// orphaned model call stops burning tokens and cannot race a
							// late response into this room. Without this the run stayed
							// live and poisoned the next message slot.
							generationAbortController.abort();
							reject(
								new Error(
									`Discord generation timeout after ${generationTimeoutMs}ms`,
								),
							);
						}, generationTimeoutMs);
					});

					await Promise.race([generationPromise, timeoutPromise]);
				}
			} catch (generationError) {
				const activeTaskAgentWork =
					generationTimedOut &&
					!!messageId &&
					hasActiveTaskAgentWorkForMessage(this.runtime, messageId);
				this.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						messageId: message.id,
						timeoutMs: generationTimeoutMs,
						activeTaskAgentWork,
						error:
							generationError instanceof Error
								? generationError.message
								: String(generationError),
					},
					"Discord generation failed or timed out",
				);
				typingController.stop();
				if (activeTaskAgentWork) {
					statusReactions?.setDone();
					await abortPendingDraft();
					this.runtime.logger.warn(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							messageId: message.id,
							memoryId: messageId,
							roomId,
							timeoutMs: generationTimeoutMs,
						},
						"Suppressing Discord timeout reply while task-agent work is still active",
					);
					return;
				}

				if (
					shouldSuppressTimeoutForInFlightDispatchForTests({
						generationTimedOut,
						responseDispatchInFlight,
					})
				) {
					this.runtime.logger.warn(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							messageId: message.id,
							memoryId: messageId,
							roomId,
							timeoutMs: generationTimeoutMs,
						},
						"Suppressing Discord timeout handling while response dispatch is in flight",
					);
					return;
				}

				statusReactions?.setError();
				await abortPendingDraft();

				if (!responseEmitted) {
					await sendFailureReply(
						generationTimedOut
							? "I timed out while generating that reply. Please retry."
							: "I hit a provider issue while generating the reply. Please retry.",
					);
				}
				return;
			} finally {
				if (generationTimeoutHandle) {
					clearTimeout(generationTimeoutHandle);
				}
			}

			if (!responseEmitted) {
				typingController.stop();
				statusReactions?.setDone();
				await finalizePendingDraft();
			}
		} catch (error) {
			this.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error handling message",
			);
		}
	}

	/**
	 * Processes the message content, mentions, code blocks, attachments, and URLs to generate
	 * processed content and media attachments.
	 *
	 * @param {DiscordMessage} message The message to process
	 * @returns {Promise<{ processedContent: string; attachments: Media[] }>} Processed content and media attachments
	 */
	async processMessage(
		message: DiscordMessage,
	): Promise<{ processedContent: string; attachments: Media[] }> {
		let processedContent = message.content;
		const attachments: Media[] = [];

		if (message.embeds?.length) {
			for (const i in message.embeds) {
				const embed = message.embeds[i];
				// type: rich
				processedContent += `\nEmbed #${parseInt(i, 10) + 1}:\n`;
				processedContent += `  Title:${embed.title ?? "(none)"}\n`;
				processedContent += `  Description:${embed.description ?? "(none)"}\n`;
			}
		}
		const mentionRegex = /<@!?(\d+)>/g;
		processedContent = processedContent.replace(
			mentionRegex,
			(match, entityId) => {
				const user = message.mentions.users.get(entityId);
				if (user) {
					return `${user.username} (@${entityId})`;
				}
				return match;
			},
		);

		const codeBlockRegex = /```([\s\S]*?)```/g;
		let match: RegExpExecArray | null = codeBlockRegex.exec(processedContent);
		while (match !== null) {
			const fullMatch = match[0];
			const codeBlock = match[1];
			const lines = codeBlock.split("\n");
			const title = lines[0];
			const description = lines.slice(0, 3).join("\n");
			const attachmentId =
				`code-${Date.now()}-${Math.floor(Math.random() * 1000)}`.slice(-5);
			attachments.push({
				id: attachmentId,
				url: "",
				title: title || "Code Block",
				source: "Code",
				description,
				text: codeBlock,
			});
			processedContent = processedContent.replace(
				fullMatch,
				`Code Block (${attachmentId})`,
			);
			match = codeBlockRegex.exec(processedContent);
		}

		if (message.attachments.size > 0) {
			attachments.push(
				...(await this.attachmentManager.processAttachments(
					message.attachments,
				)),
			);
		}

		// Extract and clean URLs from the message content
		const urls = extractUrls(processedContent, this.runtime);

		for (const url of urls) {
			// Use string literal type for getService, assume methods exist at runtime
			const videoService = this.runtime.getService(ServiceType.VIDEO) as
				| ({
						isVideoUrl?: (url: string) => boolean;
						processVideo?: (
							url: string,
							runtime: IAgentRuntime,
						) => Promise<{
							title: string;
							description: string;
							text: string;
						}>;
				  } & Service)
				| null;
			if (
				typeof videoService?.isVideoUrl === "function" &&
				typeof videoService.processVideo === "function" &&
				videoService.isVideoUrl(url)
			) {
				try {
					const videoInfo = await videoService.processVideo(url, this.runtime);

					attachments.push({
						id: `youtube-${Date.now()}`,
						url,
						title: videoInfo.title,
						source: "YouTube",
						description: videoInfo.description,
						text: videoInfo.text,
					});
				} catch (error) {
					// Handle video processing errors gracefully - the URL is still preserved in the message
					const errorMsg =
						error instanceof Error ? error.message : String(error);
					this.runtime.logger.warn(
						`Failed to process video ${url}: ${errorMsg}`,
					);
				}
			} else {
				try {
					const fetched = await fetchDocumentFromUrl(url);
					attachments.push(fetchedUrlToAttachment(url, fetched));
					continue;
				} catch (error) {
					const errorMsg =
						error instanceof Error ? error.message : String(error);
					this.runtime.logger.debug(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							url,
							error: errorMsg,
						},
						"Direct URL enrichment failed; trying browser service fallback",
					);
				}

				const browserService = this.runtime.getService(ServiceType.BROWSER) as
					| ({
							getPageContent?: (
								url: string,
								runtime: IAgentRuntime,
							) => Promise<{ title?: string; description?: string }>;
					  } & Service)
					| null;
				if (!browserService) {
					this.runtime.logger.debug(
						{ src: "plugin:discord", agentId: this.runtime.agentId },
						"Skipping URL enrichment because browser service is unavailable",
					);
					continue;
				}

				try {
					this.runtime.logger.debug(
						`Fetching page content for cleaned URL: "${url}"`,
					);
					if (typeof browserService.getPageContent !== "function") {
						continue;
					}
					const { title, description: summary } =
						await browserService.getPageContent(url, this.runtime);

					attachments.push({
						id: webpageAttachmentId(url),
						url,
						title: title || "Web Page",
						source: "Web",
						description: summary,
						text: summary,
						contentType: ContentType.LINK,
					});
				} catch (error) {
					// Silently handle browser errors (certificate issues, timeouts, dead sites, etc.)
					// The URL is still preserved in the message content, just without scraped metadata
					const errorMsg =
						error instanceof Error ? error.message : String(error);
					const errorString = String(error);

					// Check for common expected failures that don't need logging
					const isExpectedFailure =
						errorMsg.includes("ERR_CERT") ||
						errorString.includes("ERR_CERT") ||
						errorMsg.includes("Timeout") ||
						errorString.includes("Timeout") ||
						errorMsg.includes("ERR_NAME_NOT_RESOLVED") ||
						errorString.includes("ERR_NAME_NOT_RESOLVED") ||
						errorMsg.includes("ERR_HTTP_RESPONSE_CODE_FAILURE") ||
						errorString.includes("ERR_HTTP_RESPONSE_CODE_FAILURE");

					if (!isExpectedFailure) {
						this.runtime.logger.warn(
							`Failed to fetch page content for ${url}: ${errorMsg}`,
						);
					}
					// Expected failures are silently handled - no logging needed
				}
			}
		}

		return { processedContent, attachments };
	}

	/**
	 * Asynchronously fetches the bot's username and discriminator from Discord API.
	 *
	 * @param {string} botToken The token of the bot to authenticate the request
	 * @returns {Promise<string>} A promise that resolves with the bot's username and discriminator
	 * @throws {Error} If there is an error while fetching the bot details
	 */

	async fetchBotName(botToken: string) {
		const url = "https://discord.com/api/v10/users/@me";
		const response = await fetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bot ${botToken}`,
			},
		});

		if (!response.ok) {
			throw new Error(`Error fetching bot details: ${response.statusText}`);
		}

		const data = await response.json();
		const discriminator = data.discriminator;
		return (
			(data as { username: string }).username +
			(discriminator ? `#${discriminator}` : "")
		);
	}
}
