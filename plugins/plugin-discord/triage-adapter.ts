/**
 * Discord message-triage adapter.
 *
 * Bridges the core cross-connector triage contract (BaseMessageAdapter /
 * MessageRef) onto the Discord connector's already-proven channel plumbing:
 * DiscordService.fetchConnectorMessages (REST GET /channels/:id/messages via
 * discord.js, mapped to core Memory by buildMemoryFromMessage) and
 * DiscordService.handleSendMessage for outbound drafts.
 *
 * Registered into the shared TriageService at plugin init so MESSAGE
 * op=triage / list_inbox / respond and the app inbox can sweep Discord
 * channels alongside the other connectors.
 *
 * Read-state note: Discord exposes no per-bot read cursor, so every fetched
 * message is reported isRead=false; callers bound the sweep with sinceMs.
 */

import {
	BaseMessageAdapter,
	type Content,
	type DraftRequest,
	getDefaultTriageService,
	type IAgentRuntime,
	type ListOptions,
	logger,
	type Memory,
	type MessageAdapterCapabilities,
	type MessageConnectorQueryContext,
	type MessageConnectorTarget,
	type MessageRef,
	type MessageSource,
	type TargetInfo,
} from "@elizaos/core";
import { DISCORD_SERVICE_NAME } from "./constants";

/** Default number of merged messages returned by a channel sweep. */
const DEFAULT_LIST_LIMIT = 50;
/** Upper bound on channels swept when no explicit channelIds are given. */
const MAX_CHANNELS_PER_SWEEP = 15;
/** Discord REST caps a single message fetch at 100. */
const PER_CHANNEL_FETCH_CAP = 100;
/** Bounded MessageRef cache so long-running agents don't grow unbounded. */
const MESSAGE_CACHE_CAP = 2000;
const SNIPPET_LENGTH = 240;

interface DiscordConnectorFetchParams {
	target?: TargetInfo;
	channelId?: string;
	limit?: number;
}

/**
 * Structural view of the DiscordService surface this adapter needs. Checked
 * at runtime (see isDiscordTriageService) so the adapter never assumes a
 * stale service shape.
 */
interface DiscordTriageCapableService {
	fetchConnectorMessages(
		context: MessageConnectorQueryContext,
		params: DiscordConnectorFetchParams,
	): Promise<Memory[]>;
	listConnectorRooms(
		context: MessageConnectorQueryContext,
	): Promise<MessageConnectorTarget[]>;
	handleSendMessage(
		runtime: IAgentRuntime,
		target: TargetInfo,
		content: Content,
	): Promise<Memory | undefined>;
}

const REQUIRED_SERVICE_METHODS = [
	"fetchConnectorMessages",
	"listConnectorRooms",
	"handleSendMessage",
] as const;

function isDiscordTriageService(
	service: object,
): service is DiscordTriageCapableService {
	return REQUIRED_SERVICE_METHODS.every(
		(method) => typeof Reflect.get(service, method) === "function",
	);
}

function getDiscordTriageService(
	runtime: IAgentRuntime,
): DiscordTriageCapableService | null {
	const service = runtime.getService(DISCORD_SERVICE_NAME);
	return service &&
		typeof service === "object" &&
		isDiscordTriageService(service)
		? service
		: null;
}

function metaString(
	meta: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = meta[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function clip(value: string, maxLength: number): string {
	return value.length > maxLength
		? `${value.slice(0, maxLength - 3)}...`
		: value;
}

function refId(discordMessageId: string): string {
	return `discord:${discordMessageId}`;
}

interface DiscordDraftContext {
	readonly request: DraftRequest;
	readonly channelId: string;
	readonly accountId?: string;
	readonly preview: string;
}

/**
 * Map a Discord-connector Memory (buildMemoryFromMessage output) to the
 * cross-connector MessageRef shape. Returns null for memories missing the
 * Discord identity metadata the triage store keys on.
 */
export function mapDiscordMemoryToRef(memory: Memory): MessageRef | null {
	const meta = (memory.metadata ?? {}) as Record<string, unknown>;
	const externalId = metaString(meta, "discordMessageId");
	const channelId = metaString(meta, "discordChannelId");
	if (!externalId || !channelId) return null;
	const text = memory.content?.text?.trim() ?? "";
	const fromId = metaString(meta, "fromId") ?? String(memory.entityId);
	const attachments = memory.content?.attachments;
	return {
		id: refId(externalId),
		source: "discord",
		externalId,
		from: {
			identifier: fromId,
			displayName:
				metaString(meta, "entityName") ?? metaString(meta, "entityUserName"),
		},
		to: [{ identifier: channelId }],
		snippet: clip(text, SNIPPET_LENGTH),
		body: text,
		receivedAtMs: Number(memory.createdAt ?? Date.now()),
		hasAttachments: Array.isArray(attachments) && attachments.length > 0,
		// Discord has no bot-visible read cursor; callers bound with sinceMs.
		isRead: false,
		worldId: metaString(meta, "discordServerId"),
		channelId,
		metadata: {
			accountId: metaString(meta, "accountId"),
			coreMemoryId: memory.id,
			roomId: memory.roomId,
			url: memory.content?.url,
			fromBot: meta.fromBot === true,
		},
	};
}

export class DiscordTriageAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "discord";

	private readonly messageCache = new Map<string, MessageRef>();
	private readonly draftCache = new Map<string, DiscordDraftContext>();
	private draftCounter = 0;

	isAvailable(runtime: IAgentRuntime): boolean {
		return getDiscordTriageService(runtime) !== null;
	}

	capabilities(): MessageAdapterCapabilities {
		// search stays false: DiscordService's native search needs a resolvable
		// channel target, so the base list-then-filter degrade path is the
		// correct channel-agnostic behavior for inbox queries.
		return {
			list: true,
			search: false,
			manage: {},
			send: { reply: true, new: true, schedule: false },
			worlds: "multi",
			channels: "explicit",
		};
	}

	protected async listMessagesImpl(
		runtime: IAgentRuntime,
		opts: ListOptions,
	): Promise<MessageRef[]> {
		const service = this.requireService(runtime);
		const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
		const channelIds = await this.resolveChannelIds(runtime, service, opts);
		if (channelIds.length === 0) return [];

		const perChannelLimit = Math.min(Math.max(limit, 1), PER_CHANNEL_FETCH_CAP);
		const merged: MessageRef[] = [];
		for (const channelId of channelIds) {
			let memories: Memory[];
			try {
				memories = await service.fetchConnectorMessages(
					{ runtime },
					{ channelId, limit: perChannelLimit },
				);
			} catch (error) {
				// error-policy:J4 one unreadable channel (permissions, deletion)
				// degrades to a partial sweep instead of killing the rest of the server
				logger.debug(
					`[DiscordTriageAdapter] channel ${channelId} fetch failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				continue;
			}
			for (const memory of memories) {
				// The agent's own messages are not triage candidates.
				if (memory.entityId === runtime.agentId) continue;
				const ref = mapDiscordMemoryToRef(memory);
				if (!ref) continue;
				if (opts.sinceMs !== undefined && ref.receivedAtMs < opts.sinceMs) {
					continue;
				}
				if (
					opts.worldIds &&
					(!ref.worldId || !opts.worldIds.includes(ref.worldId))
				) {
					continue;
				}
				merged.push(ref);
			}
		}

		merged.sort((a, b) => b.receivedAtMs - a.receivedAtMs);
		const out = merged.slice(0, limit);
		for (const ref of out) this.cacheRef(ref);
		return out;
	}

	protected async getMessageImpl(
		runtime: IAgentRuntime,
		id: string,
	): Promise<MessageRef | null> {
		const cached =
			this.messageCache.get(id) ?? this.messageCache.get(refId(id));
		if (cached) return cached;
		const listed = await this.listMessages(runtime, {
			limit: PER_CHANNEL_FETCH_CAP,
		});
		return listed.find((ref) => ref.id === id || ref.id === refId(id)) ?? null;
	}

	protected async createDraftImpl(
		_runtime: IAgentRuntime,
		draft: DraftRequest,
	): Promise<{ draftId: string; preview: string }> {
		const channelId = this.resolveDraftChannelId(draft);
		if (!channelId) {
			throw new Error(
				"[DiscordTriageAdapter] Discord drafts need a channelId or an inReplyToId that resolves to a listed message.",
			);
		}
		const original = draft.inReplyToId
			? (this.messageCache.get(draft.inReplyToId) ??
				this.messageCache.get(refId(draft.inReplyToId)))
			: undefined;
		const accountId =
			typeof original?.metadata?.accountId === "string"
				? original.metadata.accountId
				: undefined;
		this.draftCounter += 1;
		const draftId = `discord-draft:${channelId}:${Date.now()}:${this.draftCounter}`;
		const preview = clip(draft.body, SNIPPET_LENGTH);
		this.draftCache.set(draftId, {
			request: draft,
			channelId,
			accountId,
			preview,
		});
		return { draftId, preview };
	}

	protected async sendDraftImpl(
		runtime: IAgentRuntime,
		draftId: string,
	): Promise<{ externalId: string }> {
		const draft = this.draftCache.get(draftId);
		if (!draft) {
			throw new Error(`[DiscordTriageAdapter] no cached draft for ${draftId}`);
		}
		const service = this.requireService(runtime);
		const target: TargetInfo = {
			source: "discord",
			channelId: draft.channelId,
			...(draft.accountId ? { accountId: draft.accountId } : {}),
		};
		const content: Content = {
			text: draft.request.body,
			source: "discord",
		};
		const sent = await service.handleSendMessage(runtime, target, content);
		this.draftCache.delete(draftId);
		const sentMeta = (sent?.metadata ?? {}) as Record<string, unknown>;
		return {
			externalId:
				metaString(sentMeta, "discordMessageId") ??
				`discord-sent:${draft.channelId}:${Date.now()}`,
		};
	}

	private requireService(runtime: IAgentRuntime): DiscordTriageCapableService {
		const service = getDiscordTriageService(runtime);
		if (!service) {
			throw new Error("[DiscordTriageAdapter] Discord service is unavailable");
		}
		return service;
	}

	private async resolveChannelIds(
		runtime: IAgentRuntime,
		service: DiscordTriageCapableService,
		opts: ListOptions,
	): Promise<string[]> {
		if (opts.channelIds && opts.channelIds.length > 0) {
			return [...new Set(opts.channelIds)].slice(0, MAX_CHANNELS_PER_SWEEP);
		}
		const rooms = await service.listConnectorRooms({ runtime });
		const worlds = opts.worldIds ? new Set(opts.worldIds) : null;
		const channelIds: string[] = [];
		for (const room of rooms) {
			const channelId = room.target.channelId;
			if (!channelId) continue;
			if (
				worlds &&
				(!room.target.serverId || !worlds.has(room.target.serverId))
			) {
				continue;
			}
			channelIds.push(channelId);
		}
		return [...new Set(channelIds)].slice(0, MAX_CHANNELS_PER_SWEEP);
	}

	private resolveDraftChannelId(draft: DraftRequest): string | undefined {
		if (draft.channelId) return draft.channelId;
		if (!draft.inReplyToId) return undefined;
		const original =
			this.messageCache.get(draft.inReplyToId) ??
			this.messageCache.get(refId(draft.inReplyToId));
		return original?.channelId;
	}

	private cacheRef(ref: MessageRef): void {
		this.messageCache.set(ref.id, ref);
		this.messageCache.set(ref.externalId, ref);
		while (this.messageCache.size > MESSAGE_CACHE_CAP) {
			const oldest = this.messageCache.keys().next().value;
			if (oldest === undefined) break;
			this.messageCache.delete(oldest);
		}
	}
}

/** Registers the "discord" source with the shared TriageService (plugin init). */
export function registerDiscordTriageAdapter(): void {
	getDefaultTriageService().register(new DiscordTriageAdapter());
}
