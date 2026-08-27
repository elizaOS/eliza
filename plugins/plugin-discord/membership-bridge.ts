/**
 * Service-level bridge between the Discord gateway objects and the
 * membership publisher (#24365): builds scopes, principal ids, role lists,
 * and permission snapshots from Guild/GuildMember/Channel objects and drives
 * the publisher for snapshot, delta, renewal, and degrade observations.
 * Kept separate from membership.ts so the publisher core stays free of
 * discord.js types and unit-testable against the authority contract alone.
 */
import { createHash } from "node:crypto";
import type { JsonObject, MembershipScope, UUID } from "@elizaos/core";
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

/**
 * Stable content digest of one channel snapshot's member evidence. The
 * authority digests the full command (including observedAt), so reusing an
 * idempotency key across commands with different content is rejected as
 * MEMBERSHIP_IDEMPOTENCY_CONFLICT and the observation is silently dropped.
 * Anchoring the snapshot key on this digest guarantees the key changes
 * whenever the roster or permission content changes, while a redelivery of
 * an identical roster reuses the key (conflict-drop is a benign no-op there:
 * the first delivery already committed the same evidence).
 */
function snapshotRosterDigest(
	members: DiscordSnapshotMemberEvidence[],
): string {
	const stable = members
		.map(
			(member) =>
				`${member.canonicalPrincipalId}|${[...member.roles].sort().join(",")}|${stablePermissionJson(member.permissionSnapshot)}`,
		)
		.sort()
		.join(";");
	return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

function stablePermissionJson(value: JsonObject): string {
	const keys = Object.keys(value).sort();
	const parts: string[] = [];
	for (const key of keys) {
		const entry = value[key];
		parts.push(
			`${JSON.stringify(key)}:${typeof entry === "object" && entry !== null ? JSON.stringify(entry) : JSON.stringify(entry)}`,
		);
	}
	return `{${parts.join(",")}}`;
}

/**
 * Observation anchor for delta idempotency keys: gateway event ids (or
 * member ids) are NOT unique across distinct commands (a member can join,
 * leave, and rejoin; roles can transition repeatedly), so a bare id would
 * collide across distinct events and the second observation would be
 * dropped as an idempotency conflict. Anchoring on the observation
 * wall clock makes each distinct command unique.
 */
function deltaAnchor(eventId: string | undefined): string {
	return `${eventId ?? "observed"}:${Date.now()}`;
}

export interface DiscordMembershipBridgeDeps {
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
					snapshotRosterDigest(members),
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
		/** Anchor unique to one gateway observation, when the caller has one. */
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
		const runtimeEntityId = this.deps.resolveDiscordEntityId(options.member.id);
		await this.publisher.ensurePrincipalEntity({
			principalId: runtimeEntityId,
			discordUserId: options.member.id,
			accountKey: options.accountKey,
		});
		const anchor = deltaAnchor(options.eventId);
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
				runtimeEntityId,
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
					anchor,
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
		const anchor = deltaAnchor(options.eventId);
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
			const runtimeEntityId = this.deps.resolveDiscordEntityId(
				options.member.id,
			);
			await this.publisher.ensurePrincipalEntity({
				principalId: runtimeEntityId,
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
				runtimeEntityId,
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
					anchor,
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
			runtimeEntityId: entityId,
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
				entityId,
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
 * Compute whether a member can ViewChannel per Discord's permission
 * resolution order: the guild Administrator permission bypasses everything;
 * otherwise start from the @everyone role's base permissions, apply all
 * matching role overwrites combined (allow bits OR-accumulated, deny bits
 * OR-accumulated, then allow beats deny within that stage), and apply the
 * member overwrite last (its allow beats its deny, and its deny beats the
 * role stage unless its allow grants). One role denying ViewChannel while
 * another allows it therefore resolves to allowed, matching discord.js.
 */
export function channelCanView(
	channel: ChannelLike,
	member: GuildMemberLike,
): boolean {
	if (member.pending) {
		return false;
	}
	const admin = PermissionsBitField.Flags.Administrator;
	if (
		member.permissions !== undefined &&
		(member.permissions & admin) === admin
	) {
		return true;
	}
	const view = PermissionsBitField.Flags.ViewChannel;
	const base = channel.everyonePermissions ?? PermissionsBitField.Default;
	const memberRoles = new Set(member.roles);
	let roleAllow = 0n;
	let roleDeny = 0n;
	let memberAllow = 0n;
	let memberDeny = 0n;
	let hasMemberOverwrite = false;
	for (const overwrite of channel.overwrites ?? []) {
		const isRoleOverwrite = overwrite.type === "role" || overwrite.type === 0;
		const isMemberOverwrite =
			overwrite.type === "member" || overwrite.type === 1;
		if (isRoleOverwrite && memberRoles.has(overwrite.id)) {
			roleAllow |= overwrite.allow ?? 0n;
			roleDeny |= overwrite.deny ?? 0n;
		} else if (isMemberOverwrite && overwrite.id === member.id) {
			// One member overwrite per channel per target; the last wins.
			hasMemberOverwrite = true;
			memberAllow = overwrite.allow ?? 0n;
			memberDeny = overwrite.deny ?? 0n;
		}
	}
	let resolved = (base & ~roleDeny) | roleAllow;
	if (hasMemberOverwrite) {
		resolved = (resolved & ~memberDeny) | memberAllow;
	}
	return (resolved & view) === view;
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
