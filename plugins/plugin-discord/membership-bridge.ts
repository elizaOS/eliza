/**
 * Service-level bridge between the Discord gateway objects and the
 * membership publisher (#24365): builds scopes, principal ids, role lists,
 * and permission snapshots from Guild/GuildMember/Channel objects and drives
 * the publisher for snapshot, delta, renewal, and degrade observations.
 * Kept separate from membership.ts so the publisher core stays free of
 * discord.js types and unit-testable against the authority contract alone.
 */
import type { JsonObject, logger, MembershipScope, UUID } from "@elizaos/core";
import { PermissionsBitField } from "discord.js";
import {
	type DiscordMembershipPublisher,
	type DiscordSnapshotMemberEvidence,
	discordMembershipCompletenessForGuild,
	discordMembershipIdempotencyKey,
	discordMembershipPrincipalId,
} from "./membership";

/** Text channels are the membership-evidence surface for this tranche. */
function isMembershipChannel(channel: { type: number }): boolean {
	// GuildText (0) and GuildAnnouncement (5) share member-visibility
	// semantics for ViewChannel; voice channels are deferred to a follow-up.
	return channel.type === 0 || channel.type === 5;
}

export interface DiscordMembershipBridgeDeps {
	runtime: {
		agentId: UUID;
		logger: typeof logger;
	};
	/** Resolve the runtime entity id for a Discord user (owner-alias aware). */
	resolveDiscordEntityId(userId: string): UUID;
	/** World/room runtime ids for a guild channel (process-stable). */
	worldIdForGuild(guildId: string): UUID;
	roomIdForChannel(channelId: string): UUID;
}

export class DiscordMembershipBridge {
	private readonly publisher: DiscordMembershipPublisher;
	private readonly deps: DiscordMembershipBridgeDeps;

	constructor(
		publisher: DiscordMembershipPublisher,
		deps: DiscordMembershipBridgeDeps,
	) {
		this.publisher = publisher;
		this.deps = deps;
	}

	/** Underlying publisher (service ownership + tests). */
	get underlying(): DiscordMembershipPublisher {
		return this.publisher;
	}

	/**
	 * Publish the ready-path evidence for one guild: per text channel, a
	 * complete snapshot when the guild is small and fully chunked, an
	 * unavailable report otherwise. Never an empty roster.
	 */
	async publishGuildSnapshot(options: {
		accountKey: string;
		guild: {
			id: string;
			name: string;
			memberCount: number;
			members: GuildMemberLike[];
			channels: ChannelLike[];
		};
		membersIntentEnabled: boolean;
	}): Promise<void> {
		const completeness = discordMembershipCompletenessForGuild({
			memberCount: options.guild.memberCount,
			cachedMemberCount: options.guild.members.length,
			membersIntentEnabled: options.membersIntentEnabled,
		});
		for (const channel of options.guild.channels) {
			if (!isMembershipChannel(channel)) {
				continue;
			}
			const scope = await this.publisher.scopeForChannel({
				guildId: options.guild.id,
				channelId: channel.id,
				accountKey: options.accountKey,
			});
			if (!scope) {
				return;
			}
			const worldId = this.deps.worldIdForGuild(options.guild.id);
			const roomId = this.deps.roomIdForChannel(channel.id);
			await this.publisher.ensureRuntimeMapping({
				worldId,
				roomId,
				guildId: options.guild.id,
				channelId: channel.id,
				guildName: options.guild.name,
				channelName: channel.name,
				accountKey: options.accountKey,
			});
			const accountKey = options.accountKey;
			if (completeness.kind === "unavailable") {
				await this.publisher.publishSnapshot({
					scope,
					worldId,
					roomId,
					completeness,
					idempotencyKey: discordMembershipIdempotencyKey([
						scope.connectorAccountId,
						channel.id,
						"snapshot-unavailable",
						completeness.reason,
					]),
				});
				continue;
			}
			const members: DiscordSnapshotMemberEvidence[] = [];
			for (const member of options.guild.members) {
				if (!channelCanView(channel, member)) {
					continue;
				}
				members.push(
					await this.memberEvidence(scope, accountKey, worldId, roomId, member),
				);
			}
			await this.publisher.publishSnapshot({
				scope,
				worldId,
				roomId,
				completeness,
				members,
				idempotencyKey: discordMembershipIdempotencyKey([
					scope.connectorAccountId,
					channel.id,
					"snapshot",
					String(options.guild.memberCount),
					String(members.length),
				]),
			});
		}
	}

	/**
	 * Publish a member-delta observation for every text channel of the guild
	 * the member can view (join/leave/kick/ban/permission change).
	 */
	async publishMemberDelta(options: {
		accountKey: string;
		guild: {
			id: string;
			name: string;
			channels: ChannelLike[];
		};
		member: GuildMemberLike;
		membershipState: "active" | "revoked";
		reason:
			| "joined"
			| "left"
			| "kicked"
			| "banned"
			| "permission_restored"
			| "permission_lost";
		/** Gateway event id anchoring the observation, when known. */
		eventId?: string;
	}): Promise<void> {
		const scopeless = await this.publisher.scopeForChannel({
			guildId: options.guild.id,
			channelId: options.guild.channels[0]?.id ?? "",
			accountKey: options.accountKey,
		});
		if (!scopeless) {
			return;
		}
		const durableAccountId = scopeless.connectorAccountId as string;
		const principalId = discordMembershipPrincipalId(
			durableAccountId,
			options.member.id,
		);
		await this.publisher.ensurePrincipalEntity({
			principalId,
			discordUserId: options.member.id,
			accountKey: options.accountKey,
		});
		for (const channel of options.guild.channels) {
			if (!isMembershipChannel(channel)) {
				continue;
			}
			// A revoked member can no longer view anything; an active member
			// only produces evidence for channels they can view.
			if (
				options.membershipState === "active" &&
				!channelCanView(channel, options.member)
			) {
				continue;
			}
			const scope = await this.publisher.scopeForChannel({
				guildId: options.guild.id,
				channelId: channel.id,
				accountKey: options.accountKey,
			});
			if (!scope) {
				return;
			}
			const worldId = this.deps.worldIdForGuild(options.guild.id);
			const roomId = this.deps.roomIdForChannel(channel.id);
			await this.publisher.ensureRuntimeMapping({
				worldId,
				roomId,
				guildId: options.guild.id,
				channelId: channel.id,
				guildName: options.guild.name,
				channelName: channel.name,
				accountKey: options.accountKey,
			});
			await this.publisher.publishDelta({
				scope,
				principalId,
				worldId,
				roomId,
				membershipState: options.membershipState,
				reason: options.reason,
				roles: rolesOf(options.member),
				permissionSnapshot: permissionSnapshotOf(options.member),
				idempotencyKey: discordMembershipIdempotencyKey([
					scope.connectorAccountId,
					channel.id,
					options.reason,
					options.member.id,
					options.eventId ?? "observed",
				]),
			});
		}
	}

	/**
	 * Publish a permission-transition delta for one member whose view of a
	 * channel set changed (role add/remove, member overwrite change). The
	 * caller supplies the view outcome per channel; each channel scope
	 * records permission_restored or permission_lost independently.
	 */
	async publishPermissionDelta(options: {
		accountKey: string;
		guild: {
			id: string;
			name: string;
			channels: ChannelLike[];
		};
		member: GuildMemberLike;
		/** Channel ids the member can now view after the change. */
		canViewChannelIds: string[];
		/** Channel ids the member can no longer view after the change. */
		cannotViewChannelIds: string[];
		eventId?: string;
	}): Promise<void> {
		const canView = new Set(options.canViewChannelIds);
		const cannotView = new Set(options.cannotViewChannelIds);
		for (const channel of options.guild.channels) {
			const restored = canView.has(channel.id);
			const lost = cannotView.has(channel.id);
			if (!restored && !lost) {
				continue;
			}
			const scope = await this.publisher.scopeForChannel({
				guildId: options.guild.id,
				channelId: channel.id,
				accountKey: options.accountKey,
			});
			if (!scope) {
				return;
			}
			const principalId = discordMembershipPrincipalId(
				scope.connectorAccountId as string,
				options.member.id,
			);
			await this.publisher.ensurePrincipalEntity({
				principalId,
				discordUserId: options.member.id,
				accountKey: options.accountKey,
			});
			const worldId = this.deps.worldIdForGuild(options.guild.id);
			const roomId = this.deps.roomIdForChannel(channel.id);
			await this.publisher.ensureRuntimeMapping({
				worldId,
				roomId,
				guildId: options.guild.id,
				channelId: channel.id,
				guildName: options.guild.name,
				channelName: channel.name,
				accountKey: options.accountKey,
			});
			await this.publisher.publishDelta({
				scope,
				principalId,
				worldId,
				roomId,
				membershipState: restored ? "active" : "revoked",
				reason: restored ? "permission_restored" : "permission_lost",
				roles: restored ? rolesOf(options.member) : [],
				permissionSnapshot: restored
					? permissionSnapshotOf(options.member)
					: {},
				idempotencyKey: discordMembershipIdempotencyKey([
					scope.connectorAccountId,
					channel.id,
					restored ? "permission_restored" : "permission_lost",
					options.member.id,
					options.eventId ?? "observed",
				]),
			});
		}
	}

	/**
	 * Renew the sender of an inbound guild message for that channel scope.
	 */
	async renewMessageSender(options: {
		accountKey: string;
		guildId: string;
		channelId: string;
		authorId: string;
		member?: GuildMemberLike;
		messageId: string;
	}): Promise<void> {
		const scope = await this.publisher.scopeForChannel({
			guildId: options.guildId,
			channelId: options.channelId,
			accountKey: options.accountKey,
		});
		if (!scope) {
			return;
		}
		const principalId = discordMembershipPrincipalId(
			scope.connectorAccountId as string,
			options.authorId,
		);
		await this.publisher.ensurePrincipalEntity({
			principalId,
			discordUserId: options.authorId,
			accountKey: options.accountKey,
		});
		const entityId = this.deps.resolveDiscordEntityId(options.authorId);
		await this.publisher.ensurePrincipalEntity({
			principalId: entityId,
			discordUserId: options.authorId,
			accountKey: options.accountKey,
		});
		const worldId = this.deps.worldIdForGuild(options.guildId);
		const roomId = this.deps.roomIdForChannel(options.channelId);
		await this.publisher.ensureRuntimeMapping({
			worldId,
			roomId,
			guildId: options.guildId,
			channelId: options.channelId,
			accountKey: options.accountKey,
		});
		const member = options.member;
		await this.publisher.renewSender({
			scope,
			principalId,
			worldId,
			roomId,
			roles: member ? rolesOf(member) : ["member"],
			permissionSnapshot: member
				? permissionSnapshotOf(member)
				: { observed: true },
			idempotencyKey: discordMembershipIdempotencyKey([
				scope.connectorAccountId,
				options.channelId,
				"renewal",
				options.authorId,
				options.messageId,
			]),
		});
	}

	private async memberEvidence(
		scope: MembershipScope,
		accountKey: string,
		worldId: UUID,
		roomId: UUID,
		member: GuildMemberLike,
	): Promise<DiscordSnapshotMemberEvidence> {
		const principalId = discordMembershipPrincipalId(
			scope.connectorAccountId as string,
			member.id,
		);
		await this.publisher.ensurePrincipalEntity({
			principalId,
			discordUserId: member.id,
			accountKey,
		});
		const entityId = this.deps.resolveDiscordEntityId(member.id);
		await this.publisher.ensurePrincipalEntity({
			principalId: entityId,
			discordUserId: member.id,
			accountKey,
		});
		return {
			canonicalPrincipalId: principalId,
			roles: rolesOf(member),
			permissionSnapshot: permissionSnapshotOf(member),
			runtime: {
				worldId,
				roomId,
				entityId: this.deps.resolveDiscordEntityId(member.id),
			},
		};
	}
}

/** Minimal structural shape of a discord.js GuildMember the bridge needs. */
export interface GuildMemberLike {
	id: string;
	roles: string[];
	/** Raw permission bitfield the member holds in the guild. */
	permissions?: bigint;
	/** Whether the member's presence indicates a pending gate. */
	pending?: boolean;
	user?: { bot?: boolean };
}

/** Minimal structural shape of a discord.js guild channel the bridge needs. */
export interface ChannelLike {
	id: string;
	name: string;
	type: number;
	/** Permission overwrites: role id (or @everyone) -> allow/deny bitfields. */
	overwrites?: Array<{
		id: string;
		type: "role" | "member" | number;
		allow?: bigint;
		deny?: bigint;
	}>;
	/** Bitfield of the @everyone role's guild-level permissions. */
	everyonePermissions?: bigint;
}

/**
 * Compute whether a member can ViewChannel per Discord's overwrite
 * semantics: base @everyone permissions, + every role overwrite the member
 * has (allow OR, deny AND), + the member overwrite last.
 */
export function channelCanView(
	channel: ChannelLike,
	member: GuildMemberLike,
): boolean {
	if (member.pending) {
		return false;
	}
	const base = channel.everyonePermissions ?? PermissionsBitField.Default;
	let allow = base;
	let deny = 0n;
	const memberRoles = new Set(member.roles);
	for (const overwrite of channel.overwrites ?? []) {
		const isRoleOverwrite = overwrite.type === "role" || overwrite.type === 0;
		const isMemberOverwrite =
			overwrite.type === "member" || overwrite.type === 1;
		if (isRoleOverwrite && memberRoles.has(overwrite.id)) {
			allow |= overwrite.allow ?? 0n;
			deny |= overwrite.deny ?? 0n;
		} else if (isMemberOverwrite && overwrite.id === member.id) {
			// Member overwrite replaces the role-computed decision.
			allow = (allow & ~deny) | (overwrite.allow ?? 0n);
			deny = overwrite.deny ?? 0n;
			allow &= ~deny;
		}
	}
	const viewBit = PermissionsBitField.Flags.ViewChannel;
	return (allow & viewBit) === viewBit && (deny & viewBit) === 0n;
}

function rolesOf(member: GuildMemberLike): string[] {
	return [...member.roles];
}

function permissionSnapshotOf(member: GuildMemberLike): JsonObject {
	return {
		observed: true,
		permissions:
			typeof member.permissions === "bigint"
				? member.permissions.toString()
				: null,
		bot: member.user?.bot ?? false,
	};
}
