/**
 * Structural adapters from live discord.js objects to the membership
 * bridge's plain shapes (#24365). Isolated here so both the ready-path
 * snapshot and the gateway delta hooks map channels identically, and so
 * thread/voice channels without permission overwrites are excluded once.
 */
import type { Guild, GuildBasedChannel, GuildMember } from "discord.js";
import type { ChannelLike, GuildMemberLike } from "./membership-bridge";

/** Text-channel types that carry membership evidence this tranche. */
const MEMBERSHIP_CHANNEL_TYPES = new Set<number>([0, 5]);

/**
 * Map the guild's channels to bridge shapes, keeping only text and
 * announcement channels (threads and voice channels are excluded: threads
 * inherit the parent's overwrites and voice is a follow-up tranche).
 */
export function membershipChannelsOf(guild: Guild): ChannelLike[] {
	const channels: ChannelLike[] = [];
	for (const channel of guild.channels.cache.values()) {
		if (!MEMBERSHIP_CHANNEL_TYPES.has(channel.type as number)) {
			continue;
		}
		channels.push(channelLikeOf(channel, guild));
	}
	return channels;
}

/** Map one non-thread guild channel to its bridge shape. */
export function channelLikeOf(
	channel: GuildBasedChannel,
	guild: Guild,
): ChannelLike {
	const withOverwrites = channel as GuildBasedChannel & {
		permissionOverwrites?: {
			cache?: Map<
				string,
				{
					id: string;
					type: "role" | "member" | number;
					allow?: { bitfield?: bigint };
					deny?: { bitfield?: bigint };
				}
			>;
		};
	};
	const overwrites = withOverwrites.permissionOverwrites?.cache
		? [...withOverwrites.permissionOverwrites.cache.values()].map(
				(overwrite) => ({
					id: overwrite.id,
					type: overwrite.type as "role" | "member",
					allow: overwrite.allow?.bitfield,
					deny: overwrite.deny?.bitfield,
				}),
			)
		: [];
	return {
		id: channel.id,
		name: channel.name,
		type: channel.type as number,
		overwrites,
		everyonePermissions: guild.roles.everyone?.permissions?.bitfield,
		everyoneRoleId: guild.roles.everyone?.id,
	};
}

/** Map a guild member to its bridge shape. */
export function memberLikeOf(member: GuildMember): GuildMemberLike {
	return {
		id: member.id,
		roles: [...member.roles.cache.keys()],
		permissions: member.permissions?.bitfield,
		pending: member.pending,
		user: { bot: member.user?.bot },
	};
}

/**
 * Accept either a live GuildMember or an already-mapped bridge shape (a
 * GuildMemberLike's roles are a string array, a GuildMember's are a
 * RoleManager) so synthesized member views can flow through the same
 * service hooks.
 */
export function asMemberLike(
	member: GuildMember | GuildMemberLike,
): GuildMemberLike {
	if (Array.isArray((member as GuildMemberLike).roles)) {
		return member as GuildMemberLike;
	}
	return memberLikeOf(member as GuildMember);
}

/**
 * Aggregate a member's guild permissions across a role permission change,
 * preserving discord.js owner semantics: the guild owner holds every
 * permission independently of roles (GuildMember.permissions resolves
 * PermissionsBitField.All for the ownerId), so a role bitfield transition
 * must not synthesize a permission change for them (#24365 RP r4).
 */
export function roleUpdatePermissionAggregates(options: {
	memberId: string;
	guildOwnerId: string | undefined | null;
	otherRolesBitfield: bigint;
	oldRoleBitfield: bigint;
	newRoleBitfield: bigint;
	allPermissions: bigint;
}): { oldPermissions: bigint; newPermissions: bigint } {
	if (
		typeof options.guildOwnerId === "string" &&
		options.memberId === options.guildOwnerId
	) {
		return {
			oldPermissions: options.allPermissions,
			newPermissions: options.allPermissions,
		};
	}
	return {
		oldPermissions: options.otherRolesBitfield | options.oldRoleBitfield,
		newPermissions: options.otherRolesBitfield | options.newRoleBitfield,
	};
}
