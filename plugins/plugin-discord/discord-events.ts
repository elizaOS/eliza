/**
 * Wires the discord.js Client event stream into DiscordService. Binds every
 * `client.on(...)` listener — messageCreate, reactions, guild lifecycle,
 * interactions, voice streams, and permission audit events — to the service's
 * handlers.
 */
import {
	createUniqueUuid,
	type ChannelType as ElizaChannelType,
	type EventPayload,
	resolveEffectiveMuteState,
	type UUID,
} from "@elizaos/core";
import {
	AuditLogEvent,
	type Channel,
	ChannelType as DiscordChannelType,
	type Role as DiscordRole,
	type GuildChannel,
	type GuildMember,
	type Interaction,
	type Message,
	PermissionsBitField,
	type User,
} from "discord.js";
import { isDiscordUserAddressed } from "./addressing";
import { DISCORD_SERVICE_NAME } from "./constants";
import { type ChannelDebouncer, createChannelDebouncer } from "./debouncer";
import {
	asMemberLike,
	roleUpdatePermissionAggregates,
} from "./membership-adapters";
import type { ChannelLike } from "./membership-bridge";
import {
	getDiscordMessageCoalesceConfig,
	makeCoalescedDiscordMessage,
} from "./message-coalesce";
import {
	diffMemberRoles,
	diffOverwrites,
	diffRolePermissions,
	fetchAuditEntry,
} from "./permissionEvents";
import { waitForDiscordIngressReadiness } from "./readiness";
import type { DiscordService } from "./service";
import {
	handleAutocomplete as handleBuiltinAutocomplete,
	handleSlashCommand as handleBuiltinSlashCommand,
} from "./slash-commands";
import { recordDiscordChannelMessageSeen } from "./staleness";
import {
	DiscordEventTypes,
	type DiscordListenChannelPayload,
	type DiscordNotInChannelsPayload,
	type DiscordSlashCommand,
} from "./types";

/**
 * Subset of DiscordService fields needed by the event listeners.
 * Because many of the relevant fields are private, the caller passes
 * `this as DiscordServiceInternals`.
 */
export interface DiscordServiceInternals {
	accountId?: string;
	client: NonNullable<DiscordService["client"]>;
	runtime: DiscordService["runtime"];
	character: DiscordService["character"];
	messageManager: DiscordService["messageManager"];
	voiceManager: DiscordService["voiceManager"];
	channelDebouncer: ChannelDebouncer | undefined;
	discordSettings: {
		shouldIgnoreBotMessages: boolean;
		shouldRespondOnlyToMentions?: boolean;
	};
	allowedChannelIds: string[] | undefined;
	listenChannelIds?: string[];
	allowAllSlashCommands: Set<string>;
	slashCommands: DiscordSlashCommand[];
	timeouts: ReturnType<typeof setTimeout>[];
	clientReadyPromise?: Promise<void> | null;
	/** Atomically accept an inbound delivery or record its shutdown drop. */
	admitInboundMessage?(messageId: string, channelId: string): boolean;

	// Methods
	isChannelAllowed(channelId: string): boolean;
	resolveDiscordEntityId(userId: string): UUID;
	buildMemoryFromMessage(
		message: Message,
	): Promise<import("@elizaos/core").Memory | null>;
	getChannelType(channel: Channel): Promise<ElizaChannelType>;
	handleInteractionCreate(interaction: Interaction): Promise<void>;
	handleGuildCreate(guild: import("discord.js").Guild): Promise<void>;
	handleGuildMemberAdd(member: GuildMember): Promise<void>;
	/**
	 * Canonical membership delta hook (#24365): join/leave/kick/ban/permission
	 * change evidence into the MembershipService authority. Optional so hosts
	 * without the authority can omit it.
	 */
	publishMemberMembershipDelta?(options: {
		accountId: string;
		guild: import("discord.js").Guild;
		member: GuildMember | import("./membership-bridge").GuildMemberLike;
		membershipState: "active" | "revoked";
		reason:
			| "joined"
			| "left"
			| "kicked"
			| "banned"
			| "permission_restored"
			| "permission_lost";
		eventId?: string;
	}): Promise<void>;
	/**
	 * Canonical membership sender-renewal hook (#24365). Optional.
	 */
	renewSenderMembershipEvidence?(options: {
		accountId: string;
		guildId: string;
		channelId: string;
		authorId: string;
		member?: GuildMember | null;
		messageId: string;
	}): Promise<void>;
	/**
	 * Canonical membership permission-delta hook (#24365): role/overwrite
	 * transitions per channel. Accepts live GuildMembers or pre-mapped
	 * bridge shapes (synthesized old/new views). Optional.
	 */
	publishMemberPermissionDelta?(options: {
		accountId: string;
		guild: import("discord.js").Guild;
		oldMember: GuildMember | import("./membership-bridge").GuildMemberLike;
		newMember: GuildMember | import("./membership-bridge").GuildMemberLike;
		eventId?: string;
		oldChannelOverwrites?: Map<
			string,
			import("./membership-bridge").ChannelLike["overwrites"]
		>;
	}): Promise<void>;
	/**
	 * Ready-path membership snapshot hook (#24365): used by the ready pass
	 * and by shard-resume resnapshots. Optional.
	 */
	publishGuildMembershipEvidence?(
		accountId: string,
		guild: import("discord.js").Guild,
	): Promise<void>;
	/**
	 * Degrade all membership scopes of one account (gateway disconnect).
	 * When `worldIds` is set, only scopes of those guilds degrade (a single
	 * shard disconnect must not poison healthy shards' scopes). Optional.
	 */
	degradeMembershipForAccount?(
		accountId: string,
		reason: string,
		worldIds?: string[],
	): Promise<void>;
	handleReactionAdd(
		reaction:
			| import("discord.js").MessageReaction
			| import("discord.js").PartialMessageReaction,
		user: User | import("discord.js").PartialUser,
	): Promise<void>;
	handleReactionRemove(
		reaction:
			| import("discord.js").MessageReaction
			| import("discord.js").PartialMessageReaction,
		user: User | import("discord.js").PartialUser,
	): Promise<void>;
}

/**
 * Parsed debouncer / listen configuration for setupDiscordEventListeners.
 */
interface EventListenerConfig {
	listenCids: string[];
	channelDebounceMs: number;
	recentContextTtlMs: number;
	shouldRespondOnlyToMentions: boolean;
}

/**
 * The guilds served by one gateway shard (#24365). discord.js stamps each
 * guild with its owning shard id (GUILD_CREATE handler). Geometry is exact
 * in two cases: every cached guild carries a stamp, or no guild does while
 * the shard count is known and >1 — Discord's gateway sharding assignment
 * is deterministic ((id >> 22) % shardCount), so the formula is protocol
 * authority, not a guess. In both exact cases a shard that owns zero
 * cached guilds returns an empty list — degrading it must not sweep
 * healthy sibling shards' guilds. Mixed stamps or an unknown count leave
 * the geometry only partially known, so the conservative every-guild
 * fallback keeps degrade/resume symmetric (an incomplete subset could
 * silently skip degrading guilds the disconnected shard actually serves).
 */
function guildsForShard<T extends { id: string; shardId?: number }>(
	client: unknown,
	shardId: number,
): T[] {
	const c = client as {
		guilds?: { cache?: { values?: () => Iterable<T> } };
		options?: { shards?: unknown; shardCount?: unknown };
		ws?: { shards?: { size?: number } };
	};
	// discord.js Collection extends Map: spreading the collection itself
	// yields [id, guild] tuples — always iterate .values().
	const allGuilds = [...(c.guilds?.cache?.values?.() ?? [])];
	const shardOptions = c.options?.shards;
	const shardCount = Array.isArray(shardOptions)
		? shardOptions.length
		: typeof c.options?.shardCount === "number"
			? c.options.shardCount
			: (c.ws?.shards?.size ?? 0);
	const shardGuilds = allGuilds.filter((guild) => {
		const guildShard = guild.shardId;
		if (typeof guildShard === "number") {
			return guildShard === shardId;
		}
		return (
			shardCount > 1 && Number(BigInt(guild.id) >> 22n) % shardCount === shardId
		);
	});
	if (
		allGuilds.length > 0 &&
		(allGuilds.every((g) => typeof g.shardId === "number") ||
			(allGuilds.every((g) => typeof g.shardId !== "number") && shardCount > 1))
	) {
		return shardGuilds;
	}
	return allGuilds;
}

function parseSettingInt(
	raw: string | number | undefined,
	fallback: number,
): number {
	if (typeof raw === "number")
		return Number.isSafeInteger(raw) && raw >= 0 ? raw : fallback;
	if (typeof raw === "string") {
		const t = raw.trim();
		if (!/^\d+$/.test(t)) return fallback;
		const n = Number(t);
		return Number.isSafeInteger(n) ? n : fallback;
	}
	return fallback;
}

function parseEventListenerConfig(
	service: DiscordServiceInternals,
): EventListenerConfig {
	const listenCidsRaw = service.runtime.getSetting(
		"DISCORD_LISTEN_CHANNEL_IDS",
	) as string | string[] | undefined;
	const listenCids = service.listenChannelIds
		? service.listenChannelIds
		: Array.isArray(listenCidsRaw)
			? listenCidsRaw
			: listenCidsRaw &&
					typeof listenCidsRaw === "string" &&
					listenCidsRaw.trim()
				? listenCidsRaw
						.trim()
						.split(",")
						.map((s) => s.trim())
						.filter((s) => s.length > 0)
				: [];

	const channelDebounceMsSetting = service.runtime.getSetting(
		"DISCORD_CHANNEL_DEBOUNCE_MS",
	) as string | number | undefined;
	const channelDebounceMs = parseSettingInt(channelDebounceMsSetting, 3000);

	// How long a recent unaddressed message stays eligible to be folded into a
	// following pointer's "[Recent channel context]". Tunable like its siblings;
	// the debouncer clamps it up to the channel debounce window. Default 90s:
	// humans split a question across messages and add the bare "@bot" pointer
	// tens of seconds later (live #11118: question at :2x, pointer at :51 — a
	// 10s TTL had already pruned the question, so the bot answered the bare
	// mention with a contextless greeting). The fold buffer stays bounded
	// (50 entries, pointer-gated), so the longer window costs no unbounded
	// growth.
	const recentContextTtlMsSetting = service.runtime.getSetting(
		"DISCORD_RECENT_CONTEXT_TTL_MS",
	) as string | number | undefined;
	const recentContextTtlMs = parseSettingInt(recentContextTtlMsSetting, 90000);

	const shouldRespondOnlyToMentions =
		service.discordSettings.shouldRespondOnlyToMentions !== false;

	return {
		listenCids,
		channelDebounceMs,
		recentContextTtlMs,
		shouldRespondOnlyToMentions,
	};
}

/**
 * Wire up all Discord.js event listeners on `service.client`.
 *
 * Returns the created debouncers so the caller can store them on the service
 * instance (they must be destroyed on stop).
 */
export function setupDiscordEventListeners(service: DiscordServiceInternals): {
	channelDebouncer: ChannelDebouncer;
} {
	const accountId = service.accountId ?? "default";
	const {
		listenCids,
		channelDebounceMs,
		recentContextTtlMs,
		shouldRespondOnlyToMentions,
	} = parseEventListenerConfig(service);
	const messageCoalesce = getDiscordMessageCoalesceConfig((key) =>
		service.runtime.getSetting(key),
	);
	const effectiveChannelDebounceMs = messageCoalesce.enabled
		? messageCoalesce.windowMs
		: channelDebounceMs;

	// ── Channel debouncer ──────────────────────────────────────────────
	const channelDebouncer = createChannelDebouncer(
		(messages) => {
			if (!service.messageManager || messages.length === 0) {
				return;
			}

			let anchor: Message | undefined;
			const botId = service.client?.user?.id;
			if (botId) {
				anchor = messages.find((message) =>
					isDiscordUserAddressed({
						text: message.content,
						userId: botId,
						hasMessageReference: Boolean(message.reference?.messageId),
						repliedUserId: message.mentions?.repliedUser?.id,
					}),
				);
			}

			const botAddressed = anchor !== undefined;
			anchor ??= messages[messages.length - 1];
			if (
				!anchor ||
				service.admitInboundMessage?.(anchor.id, anchor.channel.id) === false
			) {
				return;
			}
			if (messageCoalesce.enabled) {
				const combined = makeCoalescedDiscordMessage(
					messages,
					anchor,
					messageCoalesce,
				);
				if (messages.length > 1) {
					service.runtime.logger.info(
						{
							src: "plugin:discord",
							agentId: service.runtime.agentId,
							channelId: messages[0]?.channel?.id,
							messageIds: messages.map((message) => message.id),
							count: messages.length,
							path: "channelDebouncer",
						},
						"Coalesced inbound Discord messages",
					);
				}
				void service.messageManager.handleMessage(combined as Message);
			} else if (messages.length === 1) {
				void service.messageManager.handleMessage(anchor);
			} else {
				const contextLines = messages
					.filter((message) => message.id !== anchor?.id)
					.map(
						(message) =>
							`${message.member?.displayName ?? message.author.globalName ?? message.author.displayName ?? message.author.username}: ${message.content}`,
					);
				const combinedText =
					contextLines.length > 0
						? `[Recent channel context]\n${contextLines.join("\n")}\n\n${anchor.content || ""}`
						: anchor.content || "";
				const combined = Object.create(anchor, {
					content: { value: combinedText, writable: true, enumerable: true },
					__discordAddressingContent: {
						value: anchor.content,
						writable: false,
						enumerable: false,
						configurable: true,
					},
				});
				void service.messageManager.handleMessage(combined as Message);
			}

			// Clear the answered-context buffer only when the bot actually engages
			// with this batch — a purely-unaddressed batch (channel chatter the bot
			// is not replying to) must keep its buffer so a following "@bot ^^"
			// pointer can still fold that question in.
			if (botAddressed || !shouldRespondOnlyToMentions) {
				channelDebouncer?.markResponded(messages[0].channel.id);
			}
		},
		{
			debounceMs: effectiveChannelDebounceMs,
			getBotUserId: () => service.client?.user?.id,
			coalesceEnabled: messageCoalesce.enabled,
			maxBatch: messageCoalesce.maxBatch,
			shouldRespondOnlyToMentions,
			bufferTtlMs: recentContextTtlMs,
		},
	);

	service.channelDebouncer = channelDebouncer;

	// ── Per-DM-channel serialization ───────────────────────────────────
	// discord.js invokes the messageCreate listener WITHOUT awaiting it, so N
	// rapid DMs from one author would otherwise launch N concurrent
	// handleMessage runs → interleaved / out-of-order / duplicate replies. DMs
	// are dispatched directly (not batched), so we chain each DM channel's
	// handleMessage calls through a promise tail: a given DM channel is processed
	// strictly in order, one message at a time, and nothing is dropped. Guild
	// channels are unaffected — they still route through the channel debouncer.
	const dmChannelQueues = new Map<string, Promise<void>>();
	const dispatchDmInOrder = (
		channelId: string,
		message: Message,
	): Promise<void> => {
		// Start only after the prior message on this channel settles — success OR
		// failure (a failed turn must never stall the queue).
		const prior = dmChannelQueues.get(channelId) ?? Promise.resolve();
		const run = prior
			.catch(() => undefined)
			.then(() => {
				if (
					service.admitInboundMessage?.(message.id, message.channel.id) ===
					false
				) {
					return;
				}
				// Re-read at dispatch time: the manager can be torn down between
				// enqueue and this deferred run (service stop). If it's gone, skip
				// rather than throw.
				const manager = service.messageManager;
				if (!manager) {
					return;
				}
				return manager.handleMessage(message);
			});
		dmChannelQueues.set(channelId, run);
		// Once this settles and nothing newer is queued behind it, drop the map
		// entry so the map stays bounded by the number of *active* DM channels.
		// The extra `.catch` keeps this cleanup branch from surfacing as an
		// unhandled rejection; the awaiting caller still observes + logs failures.
		void run
			.catch(() => undefined)
			.finally(() => {
				if (dmChannelQueues.get(channelId) === run) {
					dmChannelQueues.delete(channelId);
				}
			});
		return run;
	};

	// ── messageCreate ──────────────────────────────────────────────────
	service.client.on("messageCreate", async (message) => {
		// This must be the first gate in the listener: `stop()` closes admissions
		// synchronously before taking its drain snapshot. Deliveries arriving after
		// that point are designed-ignore drops, not new turns racing teardown.
		if (
			service.admitInboundMessage?.(message.id, message.channel.id) === false
		) {
			return;
		}
		const clientUser = service.client?.user;
		if (
			(clientUser && message.author.id === clientUser.id) ||
			(message.author.bot && service.discordSettings.shouldIgnoreBotMessages)
		) {
			service.runtime.logger.debug(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					authorId: message.author.id,
					isBot: message.author.bot,
				},
				"Ignoring message from bot or self",
			);
			return;
		}

		// `messageCreate` may arrive as soon as the gateway reports ClientReady,
		// while the async ready sequence is still hydrating canonical owner aliases.
		// Gate every ingress branch here, including listen-only ingestion, and keep
		// the MessageManager gate as defense for direct/replay callers.
		try {
			await waitForDiscordIngressReadiness(service.clientReadyPromise);
		} catch (error) {
			service.runtime.reportError(
				"discord:gateway-message-before-ready",
				error,
				{
					accountId,
					messageId: message.id,
					channelId: message.channel.id,
				},
			);
			return;
		}
		// Readiness and every later policy lookup cross await boundaries. Recheck
		// here, and again at dispatch below, so a message accepted just before the
		// cordon cannot start a turn behind the shutdown snapshot.
		if (
			service.admitInboundMessage?.(message.id, message.channel.id) === false
		) {
			return;
		}

		if (service.messageManager) {
			recordDiscordChannelMessageSeen(
				service.messageManager,
				message.channel.id,
				message.id,
			);
			// Canonical membership evidence (#24365): an inbound guild message
			// is itself the observation that renews the sender's membership
			// evidence for this channel scope. Degrade-only, never awaited on
			// the hot path beyond this turn.
			if (
				message.guild &&
				typeof service.renewSenderMembershipEvidence === "function"
			) {
				void service
					.renewSenderMembershipEvidence({
						accountId,
						guildId: message.guild.id,
						channelId: message.channel.id,
						authorId: message.author.id,
						member: message.member ?? null,
						messageId: message.id,
					})
					.catch((error: unknown) => {
						// error-policy:J4 degrade-only sender renewal; the hook
						// logs and degrades internally, this keeps the gateway
						// hot path clear of the rejection.
						service.runtime.logger.debug(
							{
								src: "plugin:discord",
								agentId: service.runtime.agentId,
								channelId: message.channel.id,
								authorId: message.author.id,
								error: error instanceof Error ? error.message : String(error),
							},
							"Discord membership sender renewal failed",
						);
					});
			}
			// P4 group coordination: only human (non-bot) messages advance the
			// conversation edge; bot messages never do, which is one half of the
			// bot-to-bot loop breaker (see group-coordination.ts). This writes the
			// DURABLE edge row (not an in-process map) so every human message the
			// gateway sees supersedes in-flight generations across all contenders,
			// including messages that never trigger a dispatch on this agent.
			if (
				!message.author.bot &&
				message.guild &&
				typeof service.messageManager.noteHumanEdge === "function"
			) {
				await service.messageManager.noteHumanEdge(
					message.channel.id,
					message.id,
					message.createdTimestamp ?? Date.now(),
				);
			}
		}

		// Persisted mute gate. Consults the same participant/world mute state
		// the ROOM action writes (and the core message service enforces), but
		// BEFORE ingestion: a muted channel costs zero memory writes and zero
		// model calls, and — unlike the boot-frozen CHANNEL_IDS whitelist —
		// the muted set is runtime-mutable and survives restarts. Drops even a
		// direct @mention: on mention-gated deployments every processed turn
		// is a mention, so any mention bypass makes mute a no-op. Threads
		// inherit their parent channel's mute.
		try {
			const muteRoomIds = [
				createUniqueUuid(service.runtime, message.channel.id),
			];
			const parentChannelId =
				"parentId" in message.channel &&
				typeof message.channel.parentId === "string"
					? message.channel.parentId
					: undefined;
			if (parentChannelId) {
				muteRoomIds.push(createUniqueUuid(service.runtime, parentChannelId));
			}
			const muteState = await resolveEffectiveMuteState(service.runtime, {
				roomIds: muteRoomIds,
				// Same world derivation as the message manager: guild id, or the
				// channel id itself for DMs (messages.ts ensureConnection).
				worldId: createUniqueUuid(
					service.runtime,
					message.guildId ?? message.channel.id,
				),
			});
			if (muteState.muted) {
				service.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						channelId: message.channel.id,
						scope: muteState.scope,
					},
					"Dropping message for muted channel",
				);
				return;
			}
		} catch (error) {
			// error-policy:J7 a broken mute lookup must not take down inbound
			// message handling; surface it and fail open (core's own mute check
			// still guards the planner).
			service.runtime.reportError("discord:mute-gate", error, {
				channelId: message.channel.id,
			});
		}

		if (listenCids.includes(message.channel.id) && message) {
			if (
				service.admitInboundMessage?.(message.id, message.channel.id) === false
			) {
				return;
			}
			const newMessage = await service.buildMemoryFromMessage(message);

			if (!newMessage) {
				service.runtime.logger.warn(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						messageId: message.id,
					},
					"Failed to build memory from listen channel message",
				);
				return;
			}

			const listenPayload: DiscordListenChannelPayload = {
				runtime: service.runtime,
				message: newMessage,
				source: "discord",
				accountId,
			};
			service.runtime.emitEvent(
				DiscordEventTypes.LISTEN_CHANNEL_MESSAGE,
				listenPayload,
			);
		}

		const channelType = message.channel.type as DiscordChannelType;
		const isDm =
			channelType === DiscordChannelType.DM ||
			channelType === DiscordChannelType.GroupDM;

		// Skip if channel restrictions are set and this channel is not allowed.
		// DMs (and group DMs) are exempt: CHANNEL_IDS scopes which *guild*
		// surfaces the bot participates in, while DM access is governed by the
		// DM policy (dmPolicy/allowFrom, enforced in the message manager via
		// dm-access.ts). Without this exemption any CHANNEL_IDS deployment
		// silently drops every DM before the DM policy ever runs.
		if (
			!isDm &&
			service.allowedChannelIds &&
			!service.isChannelAllowed(message.channel.id)
		) {
			const channel = service.client
				? await service.client.channels.fetch(message.channel.id)
				: null;

			const notInChannelsPayload: DiscordNotInChannelsPayload = {
				runtime: service.runtime,
				message: message,
				source: "discord",
				accountId,
			};
			service.runtime.emitEvent(
				DiscordEventTypes.NOT_IN_CHANNELS_MESSAGE,
				notInChannelsPayload,
			);

			if (!channel) {
				service.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						channelId: message.channel.id,
					},
					"Channel not found",
				);
				return;
			}
			if (channel.isThread()) {
				if (!channel.parentId || !service.isChannelAllowed(channel.parentId)) {
					service.runtime.logger.debug(
						{
							src: "plugin:discord",
							agentId: service.runtime.agentId,
							parentChannelId: channel.parentId,
						},
						"Thread not in allowed channel",
					);
					return;
				}
			} else {
				if (
					channel?.isTextBased &&
					typeof channel.isTextBased === "function" &&
					channel.isTextBased()
				) {
					service.runtime.logger.debug(
						{
							src: "plugin:discord",
							agentId: service.runtime.agentId,
							channelId: channel.id,
						},
						"Channel not allowed",
					);
				}
				return;
			}
		}

		try {
			if (!service.messageManager) {
				return;
			}
			if (
				service.admitInboundMessage?.(message.id, message.channel.id) === false
			) {
				return;
			}

			if (isDm) {
				// DMs are 1:1 and gain nothing from channel-style debouncing.
				// Dispatch directly, but serialize per DM channel so rapid messages
				// from one author are handled strictly in order, one at a time, with
				// no drop (see dispatchDmInOrder above).
				//
				// Direct dispatch does not coalesce — each DM is its own turn, unlike
				// channel messages which the debouncer may merge. For 1:1 DMs this is
				// acceptable and avoids a debounce-window drop; ordering and no-drop
				// are guaranteed by the per-channel queue.
				await dispatchDmInOrder(message.channel.id, message);
			} else if (service.channelDebouncer) {
				service.channelDebouncer.enqueue(message);
			} else {
				await service.messageManager.handleMessage(message);
			}
		} catch (error) {
			service.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error handling message",
			);
		}
	});

	// ── messageReactionAdd ─────────────────────────────────────────────
	service.client.on("messageReactionAdd", async (reaction, user) => {
		const clientUser = service.client?.user;
		if (clientUser && user.id === clientUser.id) {
			return;
		}
		if (
			service.allowedChannelIds &&
			reaction.message.channel &&
			!service.isChannelAllowed(reaction.message.channel.id)
		) {
			return;
		}
		try {
			await service.handleReactionAdd(reaction, user);
		} catch (error) {
			service.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error handling reaction add",
			);
		}
	});

	// ── messageReactionRemove ──────────────────────────────────────────
	service.client.on("messageReactionRemove", async (reaction, user) => {
		const clientUser = service.client?.user;
		if (clientUser && user.id === clientUser.id) {
			return;
		}
		if (
			service.allowedChannelIds &&
			reaction.message.channel &&
			!service.isChannelAllowed(reaction.message.channel.id)
		) {
			return;
		}
		try {
			await service.handleReactionRemove(reaction, user);
		} catch (error) {
			service.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error handling reaction remove",
			);
		}
	});

	// ── guildCreate ────────────────────────────────────────────────────
	service.client.on("guildCreate", async (guild) => {
		try {
			await service.handleGuildCreate(guild);
		} catch (error) {
			service.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error handling guild create",
			);
		}
	});

	// ── guildMemberAdd ─────────────────────────────────────────────────
	service.client.on("guildMemberAdd", async (member) => {
		try {
			await service.handleGuildMemberAdd(member);
		} catch (error) {
			service.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error handling guild member add",
			);
		}
		// Canonical membership evidence (#24365): a joined member becomes
		// active in every membership channel they can view. Degrade-only.
		if (typeof service.publishMemberMembershipDelta === "function") {
			try {
				await service.publishMemberMembershipDelta({
					accountId,
					guild: member.guild,
					member,
					membershipState: "active",
					reason: "joined",
					eventId: member.id,
				});
			} catch {
				// error-policy:J4 membership evidence must never break the
				// gateway handler; the hook logs internally.
			}
		}
	});

	// ── guildMemberRemove ──────────────────────────────────────────────
	// Discord does not distinguish self-leave from kick in this event; the
	// audit log may, but fetching it here on the hot path is not worth the
	// latency, so the delta records the reason we can defend: "left". A
	// kick/ban refinement can join on the audit entry later. A partial
	// member may fail to fetch (the user already left); the revocation is
	// still published from the partial shape — an unfetched member must not
	// silently drop leave evidence.
	service.client.on("guildMemberRemove", async (member) => {
		if (typeof service.publishMemberMembershipDelta === "function") {
			let full: GuildMember | null = null;
			try {
				full =
					member.partial && typeof member.fetch === "function"
						? await member.fetch()
						: (member as GuildMember);
			} catch {
				// error-policy:J3 the fetch failure is expected for a user
				// who already left; fall through with the partial shape.
				full = null;
			}
			try {
				await service.publishMemberMembershipDelta({
					accountId,
					guild: member.guild,
					member: full ?? {
						id: member.id,
						roles: [],
						pending: false,
					},
					membershipState: "revoked",
					reason: "left",
					eventId: member.id,
				});
			} catch {
				// error-policy:J4 degrade-only membership evidence.
			}
		}
	});

	// ── guildBanAdd ────────────────────────────────────────────────────
	service.client.on("guildBanAdd", async (ban) => {
		if (typeof service.publishMemberMembershipDelta === "function") {
			try {
				// The ban payload carries the user, not a GuildMember: publish
				// the revocation with the bare principal shape (roles empty,
				// revoked state carries the authority).
				await service.publishMemberMembershipDelta({
					accountId,
					guild: ban.guild,
					member: {
						id: ban.user.id,
						roles: [],
						permissions: undefined,
						pending: false,
						user: { bot: ban.user.bot },
					},
					membershipState: "revoked",
					reason: "banned",
					eventId: `ban:${ban.user.id}`,
				});
			} catch {
				// error-policy:J4 degrade-only membership evidence.
			}
		}
	});

	// ── interactionCreate ──────────────────────────────────────────────
	service.client.on("interactionCreate", async (interaction) => {
		if (interaction.isAutocomplete()) {
			try {
				await handleBuiltinAutocomplete(interaction);
			} catch (error) {
				service.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						error: error instanceof Error ? error.message : String(error),
					},
					"Error handling Discord autocomplete interaction",
				);
			}
			return;
		}

		// Commands, modals, and components can enter the same privileged runtime
		// paths as messages. Do not let them race canonical owner hydration either.
		try {
			await waitForDiscordIngressReadiness(service.clientReadyPromise);
		} catch (error) {
			service.runtime.reportError(
				`${DISCORD_SERVICE_NAME}:gateway-interaction-before-ready`,
				error,
				{
					accountId,
					interactionId: interaction.id,
					interactionType: interaction.type,
				},
			);
			return;
		}

		const isSlashCommand = interaction.isCommand();
		const isModalSubmit = interaction.isModalSubmit();
		const isComponent = interaction.isMessageComponent();

		const bypassChannelRestriction =
			isSlashCommand &&
			service.allowAllSlashCommands.has(interaction.commandName ?? "");

		service.runtime.logger.debug(
			{
				src: "plugin:discord",
				agentId: service.runtime.agentId,
				interactionType: interaction.type,
				commandName: isSlashCommand ? interaction.commandName : undefined,
				channelId: interaction.channelId,
				inGuild: interaction.inGuild(),
				bypassChannelRestriction,
			},
			"[DiscordService] interactionCreate received",
		);

		const isFollowUpInteraction = Boolean(
			interaction.isModalSubmit() ||
				interaction.isMessageComponent() ||
				interaction.isAutocomplete(),
		);

		if (
			!isFollowUpInteraction &&
			service.allowedChannelIds &&
			interaction.channelId &&
			!service.isChannelAllowed(interaction.channelId) &&
			!bypassChannelRestriction
		) {
			if (isSlashCommand && interaction.isCommand()) {
				try {
					await interaction.reply({
						content: "This command is not available in this channel.",
						ephemeral: true,
					});
				} catch (responseError) {
					service.runtime.logger.debug(
						{
							src: "plugin:discord",
							agentId: service.runtime.agentId,
							error:
								responseError instanceof Error
									? responseError.message
									: String(responseError),
						},
						"Could not send channel restriction response",
					);
				}
			}
			service.runtime.logger.debug(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					channelId: interaction.channelId,
					allowedChannelIds: service.allowedChannelIds,
					isSlashCommand,
					isModalSubmit,
					isComponent,
					bypassChannelRestriction,
				},
				"[DiscordService] interactionCreate ignored (channel not allowed)",
			);
			return;
		}

		// Run custom validator if provided for slash commands
		if (isSlashCommand && interaction.commandName) {
			const command = service.slashCommands.find(
				(cmd) => cmd.name === interaction.commandName,
			);
			if (command?.validator) {
				try {
					const isValid = await command.validator(interaction, service.runtime);
					if (!isValid) {
						if (!interaction.replied) {
							try {
								const errorMessage =
									"You do not have permission to use this command.";
								if (interaction.deferred) {
									await interaction.editReply({ content: errorMessage });
								} else {
									await interaction.reply({
										content: errorMessage,
										ephemeral: true,
									});
								}
							} catch (responseError) {
								service.runtime.logger.debug(
									{
										src: "plugin:discord",
										agentId: service.runtime.agentId,
										commandName: interaction.commandName,
										error:
											responseError instanceof Error
												? responseError.message
												: String(responseError),
									},
									"Could not send validator rejection response (may have already responded)",
								);
							}
						}
						service.runtime.logger.debug(
							{
								src: "plugin:discord",
								agentId: service.runtime.agentId,
								commandName: interaction.commandName,
							},
							"[DiscordService] interactionCreate ignored (custom validator returned false)",
						);
						return;
					}
				} catch (error) {
					if (!interaction.replied) {
						try {
							const errorMessage =
								"An error occurred while validating this command.";
							if (interaction.deferred) {
								await interaction.editReply({ content: errorMessage });
							} else {
								await interaction.reply({
									content: errorMessage,
									ephemeral: true,
								});
							}
						} catch (responseError) {
							service.runtime.logger.debug(
								{
									src: "plugin:discord",
									agentId: service.runtime.agentId,
									commandName: interaction.commandName,
									error:
										responseError instanceof Error
											? responseError.message
											: String(responseError),
								},
								"Could not send validator error response (may have already responded)",
							);
						}
					}
					service.runtime.logger.error(
						{
							src: "plugin:discord",
							agentId: service.runtime.agentId,
							commandName: interaction.commandName,
							error: error instanceof Error ? error.message : String(error),
						},
						"[DiscordService] Custom validator threw error",
					);
					return;
				}
			}
		}

		try {
			await service.handleInteractionCreate(interaction);
			if (interaction.isChatInputCommand()) {
				const entityId = service.resolveDiscordEntityId(interaction.user.id);
				const roomId = createUniqueUuid(
					service.runtime,
					interaction.channelId || interaction.user.username,
				);
				await handleBuiltinSlashCommand(interaction, service.runtime, {
					entityId,
					roomId,
					accountId,
				});
			}
		} catch (error) {
			service.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error handling interaction",
			);
		}
	});

	// ── userStream (voice) ─────────────────────────────────────────────
	service.client.on("voiceStateUpdate", async (oldState, newState) => {
		try {
			await service.voiceManager?.handleVoiceStateUpdate(oldState, newState);
		} catch (error) {
			service.runtime.logger.error(
				{
					src: "plugin:discord:service:voice",
					agentId: service.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error handling Discord voice state update",
			);
		}
	});

	service.client.on(
		"userStream",
		(entityId, name, userName, channel, opusDecoder) => {
			const clientUser = service.client?.user;
			if (clientUser && entityId !== clientUser.id) {
				if (service.voiceManager) {
					service.voiceManager.handleUserStream(
						entityId,
						name,
						userName,
						channel,
						opusDecoder,
					);
				}
			}
		},
	);

	// ── Permission Audit Events ────────────────────────────────────────
	const auditLogSetting = service.runtime.getSetting(
		"DISCORD_AUDIT_LOG_ENABLED",
	);
	const isAuditLogEnabled =
		auditLogSetting === "true" ||
		auditLogSetting === true ||
		auditLogSetting === "1" ||
		auditLogSetting === 1;

	if (isAuditLogEnabled) {
		// channelUpdate
		service.client.on("channelUpdate", async (oldChannel, newChannel) => {
			try {
				let channel = newChannel;
				if (channel.partial) {
					channel = await channel.fetch();
				}

				if (!("permissionOverwrites" in oldChannel) || !("guild" in channel)) {
					return;
				}

				const guildChannel = channel as GuildChannel;
				const oldGuildChannel = oldChannel as GuildChannel;
				const oldOverwrites = oldGuildChannel.permissionOverwrites.cache;
				const newOverwrites = guildChannel.permissionOverwrites.cache;

				const allIds = new Set([
					...oldOverwrites.keys(),
					...newOverwrites.keys(),
				]);

				for (const id of allIds) {
					const oldOw = oldOverwrites.get(id);
					const newOw = newOverwrites.get(id);
					const { changes, action } = diffOverwrites(oldOw, newOw);

					if (changes.length === 0) {
						continue;
					}

					const auditAction =
						action === "DELETE"
							? AuditLogEvent.ChannelOverwriteDelete
							: action === "CREATE"
								? AuditLogEvent.ChannelOverwriteCreate
								: AuditLogEvent.ChannelOverwriteUpdate;

					const audit = await fetchAuditEntry(
						guildChannel.guild,
						auditAction,
						guildChannel.id,
						service.runtime,
					);

					const clientUser = service.client?.user;
					if (
						audit?.executorId &&
						clientUser &&
						audit.executorId === clientUser.id
					) {
						continue;
					}

					const oldOwType =
						oldOw && oldOw.type !== undefined ? oldOw.type : null;
					const newOwType =
						newOw && newOw.type !== undefined ? newOw.type : null;
					const targetType =
						(oldOwType ?? newOwType ?? 1) === 0 ? "role" : "user";
					let targetName: string;
					if (targetType === "role") {
						const role = guildChannel.guild.roles.cache.get(id);
						targetName = role?.name ?? "Unknown";
					} else {
						const user = service.client
							? await service.client.users.fetch(id).catch(() => null)
							: null;
						targetName = user?.tag ?? "Unknown";
					}

					service.runtime.emitEvent(
						DiscordEventTypes.CHANNEL_PERMISSIONS_CHANGED,
						{
							runtime: service.runtime,
							source: "discord",
							guild: {
								id: guildChannel.guild.id,
								name: guildChannel.guild.name,
							},
							channel: { id: guildChannel.id, name: guildChannel.name },
							target: { type: targetType, id, name: targetName },
							action,
							changes,
							audit,
						} as EventPayload,
					);
				}
			} catch (err) {
				service.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						error: err instanceof Error ? err.message : String(err),
					},
					"Error in channelUpdate handler",
				);
			}
		});

		// roleUpdate
		service.client.on("roleUpdate", async (oldRole, newRole) => {
			try {
				const changes = diffRolePermissions(oldRole, newRole);
				if (changes.length === 0) {
					return;
				}

				const audit = await fetchAuditEntry(
					newRole.guild,
					AuditLogEvent.RoleUpdate,
					newRole.id,
					service.runtime,
				);

				const clientUser = service.client?.user;
				if (
					audit?.executorId &&
					clientUser &&
					audit.executorId === clientUser.id
				) {
					return;
				}

				service.runtime.emitEvent(DiscordEventTypes.ROLE_PERMISSIONS_CHANGED, {
					runtime: service.runtime,
					source: "discord",
					guild: { id: newRole.guild.id, name: newRole.guild.name },
					role: { id: newRole.id, name: newRole.name },
					changes,
					audit,
				} as EventPayload);
			} catch (err) {
				service.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						error: err instanceof Error ? err.message : String(err),
					},
					"Error in roleUpdate handler",
				);
			}
		});

		// guildMemberUpdate
		service.client.on("guildMemberUpdate", async (oldMember, newMember) => {
			try {
				if (!oldMember) {
					return;
				}

				let fullOldMember = oldMember;
				if (oldMember.partial) {
					try {
						fullOldMember = await oldMember.fetch();
					} catch {
						return;
					}
				}

				const { added, removed } = diffMemberRoles(
					fullOldMember as GuildMember,
					newMember,
				);
				if (added.length === 0 && removed.length === 0) {
					return;
				}

				const audit = await fetchAuditEntry(
					newMember.guild,
					AuditLogEvent.MemberRoleUpdate,
					newMember.id,
					service.runtime,
				);

				const clientUser = service.client?.user;
				if (
					audit?.executorId &&
					clientUser &&
					audit.executorId === clientUser.id
				) {
					return;
				}

				service.runtime.emitEvent(DiscordEventTypes.MEMBER_ROLES_CHANGED, {
					runtime: service.runtime,
					source: "discord",
					guild: { id: newMember.guild.id, name: newMember.guild.name },
					member: { id: newMember.id, tag: newMember.user.tag },
					added: added.map((r: DiscordRole) => ({
						id: r.id,
						name: r.name,
						permissions: r.permissions.toArray(),
					})),
					removed: removed.map((r: DiscordRole) => ({
						id: r.id,
						name: r.name,
						permissions: r.permissions.toArray(),
					})),
					audit,
				} as EventPayload);
			} catch (err) {
				service.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						error: err instanceof Error ? err.message : String(err),
					},
					"Error in guildMemberUpdate handler",
				);
			}
		});

		// roleCreate
		service.client.on("roleCreate", async (role) => {
			try {
				const audit = await fetchAuditEntry(
					role.guild,
					AuditLogEvent.RoleCreate,
					role.id,
					service.runtime,
				);

				const clientUser = service.client?.user;
				if (
					audit?.executorId &&
					clientUser &&
					audit.executorId === clientUser.id
				) {
					return;
				}

				service.runtime.emitEvent(DiscordEventTypes.ROLE_CREATED, {
					runtime: service.runtime,
					source: "discord",
					guild: { id: role.guild.id, name: role.guild.name },
					role: {
						id: role.id,
						name: role.name,
						permissions: role.permissions.toArray(),
					},
					audit,
				} as EventPayload);
			} catch (err) {
				service.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						error: err instanceof Error ? err.message : String(err),
					},
					"Error in roleCreate handler",
				);
			}
		});

		// roleDelete
		service.client.on("roleDelete", async (role) => {
			try {
				const audit = await fetchAuditEntry(
					role.guild,
					AuditLogEvent.RoleDelete,
					role.id,
					service.runtime,
				);

				const clientUser = service.client?.user;
				if (
					audit?.executorId &&
					clientUser &&
					audit.executorId === clientUser.id
				) {
					return;
				}

				service.runtime.emitEvent(DiscordEventTypes.ROLE_DELETED, {
					runtime: service.runtime,
					source: "discord",
					guild: { id: role.guild.id, name: role.guild.name },
					role: {
						id: role.id,
						name: role.name,
						permissions: role.permissions.toArray(),
					},
					audit,
				} as EventPayload);
			} catch (err) {
				service.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						error: err instanceof Error ? err.message : String(err),
					},
					"Error in roleDelete handler",
				);
			}
		});
	} // end if (isAuditLogEnabled)

	// ── Membership evidence: permission-relevant updates (#24365) ──────
	// The canonical membership publisher must observe channel-overwrite,
	// role-permission, and member-role transitions under the DEFAULT
	// configuration: these events grant or revoke authorization evidence,
	// and a revocation that never reaches the publisher leaves stale
	// evidence authorizing a removed member until expiry or resnapshot.
	// They are deliberately registered OUTSIDE the DISCORD_AUDIT_LOG_ENABLED
	// block above — that gate exists because audit-log enrichment
	// (fetchAuditEntry) requires the View Audit Log permission, which is
	// an opt-in intent; membership state must not depend on it (RP #29748
	// blocker 3).

	service.client.on("channelUpdate", async (oldChannel, newChannel) => {
		try {
			let channel = newChannel;
			if (channel.partial) {
				channel = await channel.fetch();
			}

			if (!("permissionOverwrites" in oldChannel) || !("guild" in channel)) {
				return;
			}

			const guildChannel = channel as GuildChannel;
			const oldGuildChannel = oldChannel as GuildChannel;
			const oldOverwrites = oldGuildChannel.permissionOverwrites.cache;
			const newOverwrites = guildChannel.permissionOverwrites.cache;

			const allIds = new Set([
				...oldOverwrites.keys(),
				...newOverwrites.keys(),
			]);

			for (const id of allIds) {
				const oldOw = oldOverwrites.get(id);
				const newOw = newOverwrites.get(id);
				const { changes } = diffOverwrites(oldOw, newOw);

				if (changes.length === 0) {
					continue;
				}

				// An overwrite change can flip channel visibility for the
				// affected role or member; publish permission deltas for the
				// members whose view changed, diffing against the channel's
				// PRE-change overwrites (comparing post-change state against
				// itself would always report no transition). Degrade-only.
				const oldOwType = oldOw && oldOw.type !== undefined ? oldOw.type : null;
				const newOwType = newOw && newOw.type !== undefined ? newOw.type : null;
				const targetType =
					(oldOwType ?? newOwType ?? 1) === 0 ? "role" : "user";
				const previousOverwrites = new Map<string, ChannelLike["overwrites"]>();
				previousOverwrites.set(
					guildChannel.id,
					[...oldOverwrites.values()].map((ow) => ({
						id: ow.id,
						type: ow.type === 0 ? "role" : "member",
						allow: ow.allow?.bitfield,
						deny: ow.deny?.bitfield,
					})),
				);
				if (targetType === "user") {
					const targetMember = guildChannel.guild.members.cache.get(id) ?? null;
					if (
						targetMember &&
						typeof service.publishMemberPermissionDelta === "function"
					) {
						try {
							await service.publishMemberPermissionDelta({
								accountId,
								guild: guildChannel.guild,
								oldMember: targetMember,
								newMember: targetMember,
								eventId: `overwrite:${guildChannel.id}:${id}:${Date.now()}`,
								oldChannelOverwrites: previousOverwrites,
							});
						} catch (error) {
							// error-policy:J4 degrade-only membership evidence:
							// log and continue the channelUpdate flow.
							service.runtime.logger.debug(
								{
									src: "plugin:discord",
									agentId: service.runtime.agentId,
									channelId: guildChannel.id,
									targetId: id,
									error: error instanceof Error ? error.message : String(error),
								},
								"Discord membership overwrite delta publish failed",
							);
						}
					}
				} else {
					// A role overwrite change can affect every member holding
					// the role; diff each cached member's view before/after.
					for (const member of guildChannel.guild.members.cache.values()) {
						if (
							member.roles.cache.has(id) &&
							typeof service.publishMemberPermissionDelta === "function"
						) {
							try {
								await service.publishMemberPermissionDelta({
									accountId,
									guild: guildChannel.guild,
									oldMember: member,
									newMember: member,
									eventId: `overwrite:${guildChannel.id}:${id}:${member.id}:${Date.now()}`,
									oldChannelOverwrites: previousOverwrites,
								});
							} catch (error) {
								// error-policy:J4 degrade-only membership evidence:
								// log and continue the sweep.
								service.runtime.logger.debug(
									{
										src: "plugin:discord",
										agentId: service.runtime.agentId,
										channelId: guildChannel.id,
										roleId: id,
										memberId: member.id,
										error:
											error instanceof Error ? error.message : String(error),
									},
									"Discord membership role-overwrite delta publish failed",
								);
							}
						}
					}
				}
			}
		} catch (err) {
			// error-policy:J7 handler diagnostics must not kill the gateway
			// listener; surfaced via reportError per the repo error policy.
			service.runtime.reportError(
				"discord:membership-channel-update",
				err instanceof Error ? err : new Error(String(err)),
				{ accountId, channelId: newChannel?.id },
			);
		}
	});

	service.client.on("roleUpdate", async (oldRole, newRole) => {
		try {
			const changes = diffRolePermissions(oldRole, newRole);
			if (changes.length === 0) {
				return;
			}

			// A role permission change can flip channel visibility for
			// every member holding the role. Recompute the member's
			// aggregate from their OTHER live roles so overlapping grants
			// from unchanged roles survive the transition (bit-masking the
			// changed role off the old aggregate would remove bits those
			// roles also grant). Degrade-only.
			if (typeof service.publishMemberPermissionDelta === "function") {
				for (const member of newRole.guild.members.cache.values()) {
					if (!member.roles.cache.has(newRole.id)) {
						continue;
					}
					try {
						const base = asMemberLike(member);
						let otherRoles = 0n;
						for (const role of member.roles.cache.values()) {
							if (role.id !== newRole.id) {
								otherRoles |= role.permissions.bitfield;
							}
						}
						// discord.js grants the guild owner every permission
						// independently of roles; preserve that invariant so a
						// role transition never fabricates a permission change
						// for the owner (RP r4 finding 2).
						const aggregates = roleUpdatePermissionAggregates({
							memberId: member.id,
							guildOwnerId: newRole.guild.ownerId,
							otherRolesBitfield: otherRoles,
							oldRoleBitfield: oldRole.permissions.bitfield,
							newRoleBitfield: newRole.permissions.bitfield,
							allPermissions: PermissionsBitField.All,
						});
						const oldAggregate = aggregates.oldPermissions;
						const newAggregate = aggregates.newPermissions;
						await service.publishMemberPermissionDelta({
							accountId,
							guild: newRole.guild,
							oldMember: { ...base, permissions: oldAggregate },
							newMember: { ...base, permissions: newAggregate },
							eventId: `roleperm:${newRole.id}:${member.id}:${Date.now()}`,
						});
					} catch (error) {
						// error-policy:J4 degrade-only membership evidence:
						// log and continue the role-member sweep.
						service.runtime.logger.debug(
							{
								src: "plugin:discord",
								agentId: service.runtime.agentId,
								roleId: newRole.id,
								memberId: member.id,
								error: error instanceof Error ? error.message : String(error),
							},
							"Discord membership role-permission delta publish failed",
						);
					}
				}
			}
		} catch (err) {
			// error-policy:J7 handler diagnostics must not kill the gateway
			// listener; surfaced via reportError per the repo error policy.
			service.runtime.reportError(
				"discord:membership-role-update",
				err instanceof Error ? err : new Error(String(err)),
				{ accountId, roleId: newRole?.id },
			);
		}
	});

	service.client.on("guildMemberUpdate", async (oldMember, newMember) => {
		try {
			if (!oldMember) {
				return;
			}

			let fullOldMember = oldMember;
			if (oldMember.partial) {
				try {
					fullOldMember = await oldMember.fetch();
				} catch (error) {
					// error-policy:J7 the pre-change state is unavailable, so
					// this transition cannot be diffed and is skipped — but a
					// fetch failure that silently drops permission evidence
					// must be observable, not mute.
					service.runtime.reportError(
						"discord:membership-guild-member-update-prefetch",
						error instanceof Error ? error : new Error(String(error)),
						{ accountId, memberId: oldMember?.id },
					);
					return;
				}
			}

			const { added, removed } = diffMemberRoles(
				fullOldMember as GuildMember,
				newMember,
			);
			if (added.length === 0 && removed.length === 0) {
				return;
			}

			// Role transitions change channel visibility; publish the
			// per-channel permission delta. Degrade-only.
			if (typeof service.publishMemberPermissionDelta === "function") {
				try {
					await service.publishMemberPermissionDelta({
						accountId,
						guild: newMember.guild,
						oldMember: fullOldMember as GuildMember,
						newMember,
						eventId: newMember.id,
					});
				} catch (error) {
					// error-policy:J4 degrade-only membership evidence.
					service.runtime.logger.debug(
						{
							src: "plugin:discord",
							agentId: service.runtime.agentId,
							memberId: newMember.id,
							error: error instanceof Error ? error.message : String(error),
						},
						"Discord membership role-change delta publish failed",
					);
				}
			}
		} catch (err) {
			// error-policy:J7 handler diagnostics must not kill the gateway
			// listener; surfaced via reportError per the repo error policy.
			service.runtime.reportError(
				"discord:membership-guild-member-update",
				err instanceof Error ? err : new Error(String(err)),
				{ accountId, memberId: newMember?.id },
			);
		}
	});

	// ── gateway shard lifecycle ────────────────────────────────────────
	// Observability only. A live incident (2026-08-02 04:01 UTC) lost a
	// MESSAGE_CREATE dispatch with zero process-side evidence: no ingress
	// log, no memory, no trajectory — the connection was delivering events
	// 39s before and 31s after. Without these handlers a silent zombie
	// resume/re-identify that drops a dispatch is unattributable; with them,
	// any recurrence carries a shard-lifecycle timestamp to correlate.
	// Deliberately no recovery/backfill here — replaying missed history has
	// duplicate-delivery risk and stays gated on an attributed recurrence.
	service.client.on("shardDisconnect", (event, shardId) => {
		service.runtime.logger.warn(
			{
				src: "plugin:discord",
				agentId: service.runtime.agentId,
				shardId,
				code: event?.code,
			},
			"Gateway shard disconnected",
		);
		// Canonical membership evidence (#24365): events may have been missed
		// during the outage, so scopes must fail closed as stale until the
		// next ready-path resnapshot. Fire-and-forget degrade. Shard-scoped:
		// only the guilds served by the disconnected shard degrade, so
		// healthy shards' scopes stay fresh and shardResume recovery (which
		// resnapshots only that shard's guilds) is symmetric (RP r4 finding 1).
		if (typeof service.degradeMembershipForAccount === "function") {
			const shardGuildIds = guildsForShard(service.client, shardId).map(
				(guild) => guild.id,
			);
			void service
				.degradeMembershipForAccount(
					accountId,
					`gateway_shard_disconnect:${shardId}:${event?.code ?? "unknown"}`,
					shardGuildIds,
				)
				.catch((error: unknown) => {
					// error-policy:J4 the degrade itself is best-effort; scopes
					// simply remain at their current health and the reshard
					// ready pass republishes fresh evidence.
					service.runtime.logger.debug(
						{
							src: "plugin:discord",
							agentId: service.runtime.agentId,
							shardId,
							error: error instanceof Error ? error.message : String(error),
						},
						"Discord membership account degrade after shard disconnect failed",
					);
				});
		}
	});
	service.client.on("shardResume", (shardId, replayedEvents) => {
		service.runtime.logger.warn(
			{
				src: "plugin:discord",
				agentId: service.runtime.agentId,
				shardId,
				replayedEvents,
			},
			"Gateway shard resumed",
		);
		// Canonical membership evidence (#24365): the disconnect degraded
		// this account's scopes stale; a resume without a resnapshot would
		// leave them fail-closed indefinitely. Recovery is bounded: only the
		// guilds on the resumed shard, processed sequentially (a full account
		// fan-out per resume on sharded clients would multiply the work by
		// the shard count). Degrade-only.
		if (
			typeof service.publishGuildMembershipEvidence === "function" &&
			service.client.guilds
		) {
			void (async () => {
				const publishGuild = service.publishGuildMembershipEvidence;
				if (!publishGuild) {
					return;
				}
				// discord.js stamps each guild with its owning shard id;
				// unknown shard geometry conservatively resnapshots all
				// cached guilds (symmetric with the shardDisconnect degrade).
				const targets = guildsForShard<import("discord.js").Guild>(
					service.client,
					shardId,
				);
				for (const guild of targets) {
					try {
						await publishGuild(accountId, guild);
					} catch (error) {
						// error-policy:J4 degrade-only resnapshot; the scope
						// stays stale and the next ready pass retries.
						service.runtime.logger.debug(
							{
								src: "plugin:discord",
								agentId: service.runtime.agentId,
								guildId: guild.id,
								shardId,
								error: error instanceof Error ? error.message : String(error),
							},
							"Discord membership resnapshot after shard resume failed",
						);
					}
				}
			})();
		}
	});
	service.client.on("shardError", (error, shardId) => {
		service.runtime.logger.warn(
			{
				src: "plugin:discord",
				agentId: service.runtime.agentId,
				shardId,
				error: error instanceof Error ? error.message : String(error),
			},
			"Gateway shard error",
		);
	});
	service.client.on("invalidated", () => {
		service.runtime.logger.error(
			{ src: "plugin:discord", agentId: service.runtime.agentId },
			"Gateway session invalidated — client will not auto-reconnect",
		);
	});

	return { channelDebouncer };
}
