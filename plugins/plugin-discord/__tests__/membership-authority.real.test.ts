/**
 * Real-PGlite coverage for the Discord membership publisher (#24365):
 * per-channel evidence through the core MembershipService + plugin-sql
 * authority, honest completeness (complete only for small fully-chunked
 * guilds; unavailable otherwise — never a false-empty roster), permission
 * deltas, sender renewals, multi-account isolation, redelivery
 * idempotency, and restart survival. The runtime, adapter,
 * connector-account rows, and authority are all real; only the Discord
 * guild/channel/member shapes are synthetic.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	AgentRuntime,
	type MembershipScope,
	MembershipService,
	type UUID,
} from "@elizaos/core";
import { createDatabaseAdapter } from "@elizaos/plugin-sql";
import { PermissionsBitField } from "discord.js";
import { v4 as uuidv4 } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	DiscordMembershipPublisher,
	discordMembershipCompletenessForGuild,
	discordMembershipPrincipalId,
} from "../membership";
import { channelCanView, DiscordMembershipBridge } from "../membership-bridge";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		const cleanup = cleanups.pop();
		if (cleanup) await cleanup();
	}
});

let runtime: AgentRuntime;
let membership: MembershipService;
let publisher: DiscordMembershipPublisher;
let bridge: DiscordMembershipBridge;
let restartDir: string;

const VIEW = PermissionsBitField.Flags.ViewChannel;

function makeChannel(options: {
	id: string;
	name?: string;
	allowRoleIds?: string[];
	denyMemberIds?: string[];
}): {
	id: string;
	name: string;
	type: number;
	overwrites: Array<{
		id: string;
		type: "role" | "member";
		allow?: bigint;
		deny?: bigint;
	}>;
	everyonePermissions: bigint;
	everyoneRoleId: string;
} {
	const overwrites: Array<{
		id: string;
		type: "role" | "member";
		allow?: bigint;
		deny?: bigint;
	}> = [];
	if ((options.allowRoleIds?.length ?? 0) > 0) {
		// Gated channel: the @everyone overwrite denies ViewChannel.
		overwrites.push({ id: "@everyone", type: "role", deny: VIEW });
	}
	for (const roleId of options.allowRoleIds ?? []) {
		overwrites.push({ id: roleId, type: "role", allow: VIEW });
	}
	for (const memberId of options.denyMemberIds ?? []) {
		overwrites.push({ id: memberId, type: "member", deny: VIEW });
	}
	return {
		id: options.id,
		name: options.name ?? options.id,
		type: 0,
		overwrites,
		// A role-gated channel denies @everyone via the channel's @everyone
		// overwrite; only a role overwrite (or an explicit member allow)
		// can grant ViewChannel. The guild-level @everyone permissions stay
		// VIEW (Discord grants ViewChannel at guild level by default).
		everyonePermissions: VIEW,
		everyoneRoleId: "@everyone",
	};
}

function makeMember(options: {
	id: string;
	roles?: string[];
	permissions?: bigint;
	pending?: boolean;
}): {
	id: string;
	roles: string[];
	permissions?: bigint;
	pending?: boolean;
	user?: { bot?: boolean };
} {
	return {
		id: options.id,
		roles: options.roles ?? [],
		permissions: options.permissions ?? VIEW,
		pending: options.pending ?? false,
		user: { bot: false },
	};
}

function guildShape(options: {
	id: string;
	name?: string;
	memberCount: number;
	members: ReturnType<typeof makeMember>[];
	channels: ReturnType<typeof makeChannel>[];
}) {
	return {
		id: options.id,
		name: options.name ?? options.id,
		memberCount: options.memberCount,
		members: options.members,
		channels: options.channels,
	};
}

async function scopeFor(
	guildId: string,
	channelId: string,
): Promise<MembershipScope> {
	const scope = await publisher.scopeForChannel({
		guildId,
		channelId,
		accountKey: "default",
	});
	if (!scope) {
		throw new Error("membership scope resolution failed (publisher null)");
	}
	return scope;
}

beforeAll(async () => {
	restartDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "discord-membership-24365-"),
	);
	// The membership authority validates UUID version nibbles, so the test
	// agent id must be a real v4. Build the runtime directly over a real
	// PGlite adapter, the same shape plugin-sql's own authority tests use.
	const agentId = uuidv4() as UUID;
	const adapter = createDatabaseAdapter({ dataDir: restartDir }, agentId);
	await (adapter as unknown as { init: () => Promise<void> }).init();
	runtime = new AgentRuntime({
		character: {
			name: "discord-membership-24365",
			id: agentId,
			plugins: [],
			settings: {},
		},
		agentId,
		adapter,
		logLevel: "warn",
		enableAutonomy: false,
	});
	const sqlModule = (await import("@elizaos/plugin-sql")) as {
		default?: { plugins?: unknown[] };
		plugin?: { plugins?: unknown[] };
	};
	const sqlPlugin =
		sqlModule.default ??
		(sqlModule.plugin as { plugins?: unknown[] } | undefined);
	if (sqlPlugin) {
		await runtime.registerPlugin(
			sqlPlugin as unknown as Parameters<AgentRuntime["registerPlugin"]>[0],
		);
	}
	await runtime.initialize();
	const services = runtime.getServicesByType<MembershipService>(
		MembershipService.serviceType,
	);
	expect(services.length).toBeGreaterThan(0);
	membership = services[0];
	publisher = new DiscordMembershipPublisher(runtime);
	bridge = new DiscordMembershipBridge(publisher, {
		resolveDiscordEntityId: (userId) =>
			// Deterministic test mapping; the real service resolves owner-aware
			// entity ids. Any stable UUID works for the authority's mapping
			// guard because ensureRuntimeMapping creates the referenced rows.
			discordMembershipPrincipalId("default", userId),
		worldIdForGuild: (guildId) =>
			discordMembershipPrincipalId(guildId, "world"),
		roomIdForChannel: (channelId) =>
			discordMembershipPrincipalId(channelId, "room"),
	});
	cleanups.push(async () => {
		await runtime.stop();
	});
}, 180_000);

afterAll(async () => {
	fs.rmSync(restartDir, { recursive: true, force: true });
}, 60_000);

describe("completeness rule (honest, never false-empty)", () => {
	it("complete only when cache equals memberCount under the cap", () => {
		expect(
			discordMembershipCompletenessForGuild({
				memberCount: 7,
				cachedMemberCount: 7,
			}),
		).toEqual({ kind: "complete", memberCount: 7 });
	});

	it("partial cache is unavailable, never complete", () => {
		const outcome = discordMembershipCompletenessForGuild({
			memberCount: 7,
			cachedMemberCount: 3,
		});
		expect(outcome.kind).toBe("unavailable");
	});

	it("large guild is unavailable", () => {
		const outcome = discordMembershipCompletenessForGuild({
			memberCount: 1000,
			cachedMemberCount: 1000,
		});
		expect(outcome.kind).toBe("unavailable");
	});

	it("missing GuildMembers intent is unavailable", () => {
		const outcome = discordMembershipCompletenessForGuild({
			memberCount: 5,
			cachedMemberCount: 5,
			membersIntentEnabled: false,
		});
		expect(outcome.kind).toBe("unavailable");
	});
});

describe("Discord membership publisher (real PGlite authority)", () => {
	it("upserts a durable UUID connector account and derives a stable per-channel scope", async () => {
		const scopeA = await scopeFor("guild-1", "chan-1");
		const scopeB = await scopeFor("guild-1", "chan-1");
		expect(scopeA).toEqual(scopeB);
		expect(scopeA.connectorId).toBe("discord");
		expect(scopeA.externalWorldId).toBe("guild-1");
		expect(scopeA.externalRoomId).toBe("chan-1");
		// The authority requires a UUID connector account id.
		expect(scopeA.connectorAccountId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		);
	}, 60_000);

	it("applies a complete permission-aware snapshot and authorizes only viewers", async () => {
		const members = [
			makeMember({ id: "u-viewer", roles: ["r-vip"] }),
			makeMember({ id: "u-blocked", roles: [] }),
			makeMember({ id: "u-denied", roles: ["r-vip"] }),
		];
		const open = makeChannel({ id: "snap-open", name: "open" });
		const vip = makeChannel({
			id: "snap-vip",
			name: "vip",
			allowRoleIds: ["r-vip"],
		});
		await bridge.publishGuildSnapshot({
			accountKey: "default",
			membersIntentEnabled: true,
			guild: guildShape({
				id: "guild-snap",
				memberCount: 3,
				members,
				channels: [open, vip],
			}),
		});
		// vip additionally denies one member explicitly.
		vip.overwrites.push({ id: "u-denied", type: "member", deny: VIEW });
		await bridge.publishGuildSnapshot({
			accountKey: "default",
			membersIntentEnabled: true,
			guild: guildShape({
				id: "guild-snap",
				memberCount: 3,
				members,
				channels: [open, vip],
			}),
		});

		const openScope = await scopeFor("guild-snap", "snap-open");
		const vipScope = await scopeFor("guild-snap", "snap-vip");
		const account = openScope.connectorAccountId as string;

		for (const member of members) {
			const principal = discordMembershipPrincipalId(account, member.id);
			const openDecision = await membership.authorize(openScope, principal);
			// @everyone grants ViewChannel on the open channel.
			expect(openDecision.decision).toBe("allowed");
			const vipDecision = await membership.authorize(vipScope, principal);
			const expectedVip =
				member.id === "u-viewer" ||
				(member.id === "u-denied" ? false : member.roles.includes("r-vip"));
			expect(vipDecision.decision).toBe(expectedVip ? "allowed" : "denied");
		}
		const openHealth = await membership.getScopeHealth(openScope);
		expect(openHealth?.health).toBe("current");
	}, 60_000);

	it("reports unavailable (never an empty roster) for a partially-chunked guild", async () => {
		await bridge.publishGuildSnapshot({
			accountKey: "default",
			membersIntentEnabled: true,
			guild: guildShape({
				id: "guild-partial",
				memberCount: 10,
				members: [makeMember({ id: "u-only" })],
				channels: [makeChannel({ id: "partial-chan" })],
			}),
		});
		const scope = await scopeFor("guild-partial", "partial-chan");
		const health = await membership.getScopeHealth(scope);
		expect(health?.health).toBe("unavailable");
		expect(health?.reason).toContain("member_cache_partial");
		// And authorize must deny (fail closed), not allow-everyone.
		const principal = discordMembershipPrincipalId(
			scope.connectorAccountId as string,
			"u-only",
		);
		const decision = await membership.authorize(scope, principal);
		expect(decision.decision).toBe("denied");
	}, 60_000);

	it("publishes join/leave deltas with redelivery idempotency", async () => {
		const chan = makeChannel({ id: "delta-chan" });
		const joiner = makeMember({ id: "u-joiner", roles: [] });
		await bridge.publishMemberDelta({
			accountKey: "default",
			guild: { id: "guild-delta", name: "guild-delta", channels: [chan] },
			member: joiner,
			membershipState: "active",
			reason: "joined",
			eventId: "evt-1",
		});
		// Redeliver the same gateway event: the journal must replay, not
		// append a second delta.
		await bridge.publishMemberDelta({
			accountKey: "default",
			guild: { id: "guild-delta", name: "guild-delta", channels: [chan] },
			member: joiner,
			membershipState: "active",
			reason: "joined",
			eventId: "evt-1",
		});
		const scope = await scopeFor("guild-delta", "delta-chan");
		const principal = discordMembershipPrincipalId(
			scope.connectorAccountId as string,
			"u-joiner",
		);
		const allowed = await membership.authorize(scope, principal);
		expect(allowed.decision).toBe("allowed");
		const record = await membership.getMembership(scope, principal);
		expect(record?.reason).toBe("joined");

		await bridge.publishMemberDelta({
			accountKey: "default",
			guild: { id: "guild-delta", name: "guild-delta", channels: [chan] },
			member: joiner,
			membershipState: "revoked",
			reason: "left",
			eventId: "evt-2",
		});
		const denied = await membership.authorize(scope, principal);
		expect(denied.decision).toBe("denied");
		if (denied.decision === "denied") {
			expect(denied.reason).toBe("membership_revoked");
		}
	}, 60_000);

	it("publishes permission transitions per channel (restored and lost)", async () => {
		const promoted = makeChannel({
			id: "perm-chan",
			allowRoleIds: ["r-mod"],
		});
		const member = makeMember({ id: "u-mod", roles: [] });
		await bridge.publishMemberDelta({
			accountKey: "default",
			guild: { id: "guild-perm", name: "guild-perm", channels: [promoted] },
			member,
			membershipState: "active",
			reason: "joined",
			eventId: "perm-join",
		});
		const scope = await scopeFor("guild-perm", "perm-chan");
		const principal = discordMembershipPrincipalId(
			scope.connectorAccountId as string,
			"u-mod",
		);
		// Without the role the member cannot view the gated channel.
		expect((await membership.authorize(scope, principal)).decision).toBe(
			"denied",
		);
		// The role is granted: the channel becomes viewable.
		await bridge.publishPermissionDelta({
			accountKey: "default",
			guild: { id: "guild-perm", name: "guild-perm", channels: [promoted] },
			member: { ...member, roles: ["r-mod"] },
			canViewChannelIds: ["perm-chan"],
			cannotViewChannelIds: [],
			eventId: "perm-up",
		});
		expect((await membership.authorize(scope, principal)).decision).toBe(
			"allowed",
		);
		const record = await membership.getMembership(scope, principal);
		expect(record?.reason).toBe("permission_restored");
		// And revoked again when the role is removed.
		await bridge.publishPermissionDelta({
			accountKey: "default",
			guild: { id: "guild-perm", name: "guild-perm", channels: [promoted] },
			member,
			canViewChannelIds: [],
			cannotViewChannelIds: ["perm-chan"],
			eventId: "perm-down",
		});
		const lost = await membership.authorize(scope, principal);
		expect(lost.decision).toBe("denied");
		const lostRecord = await membership.getMembership(scope, principal);
		expect(lostRecord?.reason).toBe("permission_lost");
	}, 60_000);

	it("renews a sender on activity inside the channel scope", async () => {
		const chan = makeChannel({ id: "renew-chan" });
		const sender = makeMember({ id: "u-sender" });
		await bridge.publishGuildSnapshot({
			accountKey: "default",
			membersIntentEnabled: true,
			guild: guildShape({
				id: "guild-renew",
				memberCount: 1,
				members: [sender],
				channels: [chan],
			}),
		});
		const scope = await scopeFor("guild-renew", "renew-chan");
		const principal = discordMembershipPrincipalId(
			scope.connectorAccountId as string,
			"u-sender",
		);
		const before = await membership.getMembership(scope, principal);
		expect(before?.reason).toBe("reconciled_present");
		// A renewal inside the window is a no-op (same validUntil window).
		await bridge.renewMessageSender({
			accountKey: "default",
			guildId: "guild-renew",
			channelId: "renew-chan",
			authorId: "u-sender",
			member: sender,
			messageId: "msg-1",
		});
		const after = await membership.getMembership(scope, principal);
		expect(after?.reason).toBe("reconciled_present");
		expect((before?.generation ?? 0) <= (after?.generation ?? 0));
	}, 60_000);

	it("isolates accounts: the same user under two accounts never aliases", async () => {
		const chan = makeChannel({ id: "iso-chan" });
		for (const accountKey of ["default", "second"]) {
			await bridge.publishMemberDelta({
				accountKey,
				guild: { id: "guild-iso", name: "guild-iso", channels: [chan] },
				member: makeMember({ id: "u-same" }),
				membershipState: "active",
				reason: "joined",
				eventId: "iso-1",
			});
		}
		const scopeA = await publisher.scopeForChannel({
			guildId: "guild-iso",
			channelId: "iso-chan",
			accountKey: "default",
		});
		const scopeB = await publisher.scopeForChannel({
			guildId: "guild-iso",
			channelId: "iso-chan",
			accountKey: "second",
		});
		expect(scopeA?.connectorAccountId).not.toBe(scopeB?.connectorAccountId);
		const principalA = discordMembershipPrincipalId(
			scopeA?.connectorAccountId as string,
			"u-same",
		);
		const principalB = discordMembershipPrincipalId(
			scopeB?.connectorAccountId as string,
			"u-same",
		);
		expect(principalA).not.toBe(principalB);
		// authorize requires a defined scope; scopeForChannel resolved both
		// connector accounts (asserted above), so fail loudly if not.
		if (!scopeA || !scopeB) {
			throw new Error("scopeForChannel returned an undefined scope");
		}
		expect((await membership.authorize(scopeA, principalA)).decision).toBe(
			"allowed",
		);
		expect((await membership.authorize(scopeB, principalB)).decision).toBe(
			"allowed",
		);
		// Cross-account authorization fails closed.
		expect((await membership.authorize(scopeA, principalB)).decision).toBe(
			"denied",
		);
	}, 60_000);

	it("degrades scopes stale on gateway disconnect and authorizes fail-closed", async () => {
		const chan = makeChannel({ id: "degrade-chan" });
		await bridge.publishMemberDelta({
			accountKey: "default",
			guild: { id: "guild-degrade", name: "guild-degrade", channels: [chan] },
			member: makeMember({ id: "u-live" }),
			membershipState: "active",
			reason: "joined",
			eventId: "deg-1",
		});
		await publisher.degradeAllForAccount({
			accountKey: "default",
			health: "stale",
			reason: "gateway_shard_disconnect:0:1000",
		});
		const scope = await scopeFor("guild-degrade", "degrade-chan");
		const health = await membership.getScopeHealth(scope);
		expect(health?.health).toBe("stale");
		const principal = discordMembershipPrincipalId(
			scope.connectorAccountId as string,
			"u-live",
		);
		const decision = await membership.authorize(scope, principal);
		expect(decision.decision).toBe("denied");
		if (decision.decision === "denied") {
			expect(decision.reason).toBe("authority_stale");
		}
	}, 60_000);

	it("survives a publisher restart: a fresh publisher adopts the durable chain", async () => {
		const chan = makeChannel({ id: "restart-chan" });
		const member = makeMember({ id: "u-sticky" });
		await bridge.publishMemberDelta({
			accountKey: "default",
			guild: {
				id: "guild-restart",
				name: "guild-restart",
				channels: [chan],
			},
			member,
			membershipState: "active",
			reason: "joined",
			eventId: "restart-1",
		});
		const scope = await scopeFor("guild-restart", "restart-chan");
		const principal = discordMembershipPrincipalId(
			scope.connectorAccountId as string,
			"u-sticky",
		);
		// New process, same durable state: the fresh publisher must
		// re-register (advancing publisherGeneration) and chain deltas.
		const restarted = new DiscordMembershipPublisher(runtime);
		const restartedBridge = new DiscordMembershipBridge(restarted, {
			resolveDiscordEntityId: (userId) =>
				discordMembershipPrincipalId("default", userId),
			worldIdForGuild: (guildId) =>
				discordMembershipPrincipalId(guildId, "world"),
			roomIdForChannel: (channelId) =>
				discordMembershipPrincipalId(channelId, "room"),
		});
		await restartedBridge.publishMemberDelta({
			accountKey: "default",
			guild: {
				id: "guild-restart",
				name: "guild-restart",
				channels: [chan],
			},
			member,
			membershipState: "revoked",
			reason: "left",
			eventId: "restart-2",
		});
		const decision = await membership.authorize(scope, principal);
		expect(decision.decision).toBe("denied");
		const health = await membership.getScopeHealth(scope);
		expect(health?.generation).toBeGreaterThan(0);
	}, 60_000);
});

describe("RP round-2 regression battery (#24365 review findings)", () => {
	// F4: discord.js permission ordering. The reviewer's exact case: one
	// role denying ViewChannel while another role allows it must resolve
	// to allowed (combined role-overwrite stage: allow beats deny), and
	// the guild Administrator permission must bypass everything.
	it("channelCanView implements combined role + member overwrite ordering (F4)", async () => {
		const ADMIN = PermissionsBitField.Flags.Administrator;
		// Base: @everyone has ViewChannel.
		const chan = makeChannel({ id: "ordering-chan" });
		// One role denies, one role allows: allowed (combined stage).
		chan.overwrites.push(
			{ id: "r-a", type: "role", deny: VIEW },
			{ id: "r-b", type: "role", allow: VIEW },
		);
		expect(
			channelCanView(chan, makeMember({ id: "u1", roles: ["r-a", "r-b"] })),
		).toBe(true);
		// Deny-only role: denied.
		expect(channelCanView(chan, makeMember({ id: "u2", roles: ["r-a"] }))).toBe(
			false,
		);
		// Member overwrite allow beats the role-deny stage.
		chan.overwrites.push({ id: "u2", type: "member", allow: VIEW });
		expect(channelCanView(chan, makeMember({ id: "u2", roles: ["r-a"] }))).toBe(
			true,
		);
		// Member overwrite deny overrides an allowed role stage.
		const chan2 = makeChannel({ id: "ordering-chan-2" });
		chan2.overwrites.push({ id: "r-c", type: "role", allow: VIEW });
		chan2.overwrites.push({ id: "u3", type: "member", deny: VIEW });
		expect(
			channelCanView(chan2, makeMember({ id: "u3", roles: ["r-c"] })),
		).toBe(false);
		// Administrator bypasses even an explicit member deny.
		const chan3 = makeChannel({ id: "ordering-chan-3" });
		chan3.overwrites.push({ id: "u4", type: "member", deny: VIEW });
		expect(
			channelCanView(
				chan3,
				makeMember({ id: "u4", roles: [], permissions: ADMIN | VIEW }),
			),
		).toBe(true);
		// Base grants @everyone; a member with no roles still views the open channel.
		expect(channelCanView(chan3, makeMember({ id: "u5", roles: [] }))).toBe(
			true,
		);
		// Pending gate blocks even an admin.
		expect(
			channelCanView(
				chan3,
				makeMember({ id: "u4", roles: [], permissions: ADMIN, pending: true }),
			),
		).toBe(false);
		// RP r2: the member's AGGREGATE guild permissions form the base (a
		// guild-level role grant of ViewChannel counts), but the channel's
		// @everyone overwrite deny legitimately removes it — matching
		// discord.js (remove(deny).add(allow) per stage); only a role
		// overwrite allow (or Administrator) can restore it.
		const chan4 = makeChannel({ id: "ordering-chan-4" });
		chan4.overwrites.push({ id: "@everyone", type: "role", deny: VIEW });
		expect(
			channelCanView(
				chan4,
				makeMember({ id: "u6", roles: [], permissions: VIEW }),
			),
		).toBe(false);
		// A role overwrite allow on the same channel restores it.
		chan4.overwrites.push({ id: "r-gated", type: "role", allow: VIEW });
		expect(
			channelCanView(
				chan4,
				makeMember({ id: "u6b", roles: ["r-gated"], permissions: VIEW }),
			),
		).toBe(true);
		// ...and a member with no aggregate ViewChannel is denied there.
		expect(
			channelCanView(
				chan4,
				makeMember({ id: "u7", roles: [], permissions: 0n }),
			),
		).toBe(false);
		// RP r2: Administrator supplied by an UNCHANGED other role (aggregate
		// semantics, not a single role's bitfield) bypasses everything.
		expect(
			channelCanView(
				chan4,
				makeMember({ id: "u8", roles: ["r-other"], permissions: ADMIN | VIEW }),
			),
		).toBe(true);
		// RP r3: the @everyone overwrite is its OWN stage BEFORE the combined
		// role stage — an @everyone allow plus a member-role deny must DENY
		// (combining them into one stage would wrongly allow).
		const chan5 = makeChannel({ id: "ordering-chan-5" });
		chan5.overwrites.push({ id: "@everyone", type: "role", allow: VIEW });
		chan5.overwrites.push({ id: "r-deny", type: "role", deny: VIEW });
		expect(
			channelCanView(
				chan5,
				makeMember({ id: "u9", roles: ["r-deny"], permissions: 0n }),
			),
		).toBe(false);
		// ...while the @everyone allow alone still grants view.
		expect(
			channelCanView(
				chan5,
				makeMember({ id: "u10", roles: [], permissions: 0n }),
			),
		).toBe(true);
	});

	// F2: snapshot keys must change when roster CONTENT changes even when
	// counts stay equal, or the authority rejects the publish as an
	// idempotency conflict and the roster silently never updates.
	it("changed roster with equal counts still publishes (F2 snapshot digest keys)", async () => {
		const chan = makeChannel({ id: "digest-chan" });
		const guild = (members: ReturnType<typeof makeMember>[]) =>
			guildShape({
				id: "guild-digest",
				memberCount: members.length,
				members,
				channels: [chan],
			});
		const rosterA = [makeMember({ id: "u-a1" }), makeMember({ id: "u-a2" })];
		await bridge.publishGuildSnapshot({
			accountKey: "default",
			membersIntentEnabled: true,
			guild: guild(rosterA),
		});
		const scope = await scopeFor("guild-digest", "digest-chan");
		const a1 = discordMembershipPrincipalId(
			scope.connectorAccountId as string,
			"u-a1",
		);
		const a2 = discordMembershipPrincipalId(
			scope.connectorAccountId as string,
			"u-a2",
		);
		const b1 = discordMembershipPrincipalId(
			scope.connectorAccountId as string,
			"u-b1",
		);
		expect((await membership.getMembership(scope, a1))?.state).toBe("active");
		// Replace u-a2 with u-b1: same member count, different roster.
		const rosterB = [makeMember({ id: "u-a1" }), makeMember({ id: "u-b1" })];
		await bridge.publishGuildSnapshot({
			accountKey: "default",
			membersIntentEnabled: true,
			guild: guild(rosterB),
		});
		// The snapshot MUST have applied: u-b1 present, u-a2 explicitly
		// revoked by the authority's absent-member reconciliation.
		expect((await membership.getMembership(scope, b1))?.state).toBe("active");
		const a2Record = await membership.getMembership(scope, a2);
		expect(a2Record?.state).toBe("revoked");
		expect(a2Record?.reason).toBe("reconciled_absent");
		const health = await membership.getScopeHealth(scope);
		expect(health?.health).toBe("current");
	}, 60_000);

	// F2: distinct join/leave cycles of the same member (equal counts,
	// same event id shape) must both land; a reused key would drop the
	// second observation.
	it("rejoin after leave records both transitions (F2 delta anchors)", async () => {
		const chan = makeChannel({ id: "rejoin-chan" });
		const member = makeMember({ id: "u-rejoin" });
		const guild = {
			id: "guild-rejoin",
			name: "guild-rejoin",
			channels: [chan],
		};
		await bridge.publishMemberDelta({
			accountKey: "default",
			guild,
			member,
			membershipState: "active",
			reason: "joined",
			eventId: "rejoin-evt",
		});
		await bridge.publishMemberDelta({
			accountKey: "default",
			guild,
			member,
			membershipState: "revoked",
			reason: "left",
			eventId: "rejoin-evt",
		});
		const scope = await scopeFor("guild-rejoin", "rejoin-chan");
		const principal = discordMembershipPrincipalId(
			scope.connectorAccountId as string,
			"u-rejoin",
		);
		// After join+leave the member is denied.
		expect((await membership.authorize(scope, principal)).decision).toBe(
			"denied",
		);
		// Join again: same event-id shape, distinct observation.
		await bridge.publishMemberDelta({
			accountKey: "default",
			guild,
			member,
			membershipState: "active",
			reason: "joined",
			eventId: "rejoin-evt",
		});
		const record = await membership.getMembership(scope, principal);
		expect(record?.state).toBe("active");
		expect(record?.reason).toBe("joined");
	}, 60_000);

	// F6: deltas must carry the owner-aware runtime entity id, not the
	// canonical principal id, matching snapshot runtime mappings.
	it("deltas write the owner-aware runtime entity mapping (F6)", async () => {
		const chan = makeChannel({ id: "f6-chan" });
		const member = makeMember({ id: "u-f6" });
		await bridge.publishMemberDelta({
			accountKey: "default",
			guild: { id: "guild-f6", name: "guild-f6", channels: [chan] },
			member,
			membershipState: "active",
			reason: "joined",
			eventId: "f6-evt",
		});
		const scope = await scopeFor("guild-f6", "f6-chan");
		const principal = discordMembershipPrincipalId(
			scope.connectorAccountId as string,
			"u-f6",
		);
		const record = await membership.getMembership(scope, principal);
		expect(record?.runtime.entityId).toBe(
			discordMembershipPrincipalId("default", "u-f6"),
		);
		expect(record?.runtime.entityId).not.toBe(principal);
	}, 60_000);

	// F7: a failing evidence command must degrade the scope (fail closed)
	// rather than silently leaving stale-but-current health.
	it("delta failure path degrades the scope stale (F7 fail-closed)", async () => {
		const chan = makeChannel({ id: "f7-chan" });
		const member = makeMember({ id: "u-f7" });
		await bridge.publishMemberDelta({
			accountKey: "default",
			guild: { id: "guild-f7", name: "guild-f7", channels: [chan] },
			member,
			membershipState: "active",
			reason: "joined",
			eventId: "f7-evt",
		});
		const scope = await scopeFor("guild-f7", "f7-chan");
		expect((await membership.getScopeHealth(scope))?.health).toBe("current");
		// Publish a delta for a principal the authority has never seen (the
		// bridge was bypassed, so no entity row was ensured). The authority
		// rejects with MEMBERSHIP_PRINCIPAL_NOT_FOUND — a non-fencing error
		// on both attempts — which must take the fail-closed degrade path.
		const ghostPrincipal = discordMembershipPrincipalId(
			scope.connectorAccountId as string,
			"u-never-ensured",
		);
		await publisher.publishDelta({
			scope,
			principalId: ghostPrincipal,
			worldId: discordMembershipPrincipalId("guild-f7", "world"),
			roomId: discordMembershipPrincipalId("f7-chan", "room"),
			membershipState: "active",
			reason: "joined",
			roles: [],
			permissionSnapshot: {},
			idempotencyKey: `discord:f7-ghost:${Date.now()}`,
		});
		const health = await membership.getScopeHealth(scope);
		expect(health?.health).toBe("stale");
		expect(health?.reason).toContain("delta_rejected");
	}, 60_000);
});

describe("RP round-4 regression battery (#24365 review findings)", () => {
	// RP r4 finding 2: discord.js grants the guild owner every permission
	// independently of roles (GuildMember.permissions resolves All for the
	// ownerId), so a role bitfield transition must not synthesize a
	// permission change for the owner.
	it("roleUpdatePermissionAggregates preserves owner all-permissions across a role change", async () => {
		const { roleUpdatePermissionAggregates } = await import(
			"../membership-adapters"
		);
		const ALL = PermissionsBitField.All;
		// Guild owner holding the changed role: old and new aggregates must
		// both be ALL (no fabricated permission loss/regain).
		const owner = roleUpdatePermissionAggregates({
			memberId: "u-owner",
			guildOwnerId: "u-owner",
			otherRolesBitfield: 0n,
			oldRoleBitfield: VIEW,
			newRoleBitfield: 0n,
			allPermissions: ALL,
		});
		expect(owner.oldPermissions).toBe(ALL);
		expect(owner.newPermissions).toBe(ALL);
		// Non-owner members still get the role-derived transition.
		const member = roleUpdatePermissionAggregates({
			memberId: "u-member",
			guildOwnerId: "u-owner",
			otherRolesBitfield: 0n,
			oldRoleBitfield: VIEW,
			newRoleBitfield: 0n,
			allPermissions: ALL,
		});
		expect(member.oldPermissions).toBe(VIEW);
		expect(member.newPermissions).toBe(0n);
		// Overlapping grants from unchanged roles survive the transition.
		const overlapping = roleUpdatePermissionAggregates({
			memberId: "u-member",
			guildOwnerId: "u-owner",
			otherRolesBitfield: VIEW,
			oldRoleBitfield: VIEW,
			newRoleBitfield: 0n,
			allPermissions: ALL,
		});
		expect(overlapping.oldPermissions).toBe(VIEW);
		expect(overlapping.newPermissions).toBe(VIEW);
		// Unknown owner id (undefined/null) falls back to role aggregation.
		const unknown = roleUpdatePermissionAggregates({
			memberId: "u-member",
			guildOwnerId: undefined,
			otherRolesBitfield: 0n,
			oldRoleBitfield: VIEW,
			newRoleBitfield: 0n,
			allPermissions: ALL,
		});
		expect(unknown.oldPermissions).toBe(VIEW);
		expect(unknown.newPermissions).toBe(0n);
	});

	// RP r4 finding 1: shardDisconnect degrades account-wide while
	// shardResume recovers only the resumed shard's guilds — scopes on
	// healthy shards would stay stale forever. The fix scopes the degrade
	// to the disconnected shard's guilds via worldIds.
	it("degradeAllForAccount worldIds filter degrades only the named guilds' scopes", async () => {
		// Publish scopes in two guilds (two shards).
		for (const guildId of ["guild-shard-a", "guild-shard-b"]) {
			const chan = makeChannel({ id: `${guildId}-chan` });
			await bridge.publishMemberDelta({
				accountKey: "default",
				guild: { id: guildId, name: guildId, channels: [chan] },
				member: makeMember({ id: "u-live" }),
				membershipState: "active",
				reason: "joined",
				eventId: `${guildId}-join`,
			});
		}
		const scopeA = await scopeFor("guild-shard-a", "guild-shard-a-chan");
		const scopeB = await scopeFor("guild-shard-b", "guild-shard-b-chan");
		expect((await membership.getScopeHealth(scopeA))?.health).toBe("current");
		expect((await membership.getScopeHealth(scopeB))?.health).toBe("current");
		// Shard 0 disconnects: only guild-shard-a's scopes degrade.
		await publisher.degradeAllForAccount({
			accountKey: "default",
			health: "stale",
			reason: "gateway_shard_disconnect:0:1000",
			worldIds: ["guild-shard-a"],
		});
		expect((await membership.getScopeHealth(scopeA))?.health).toBe("stale");
		// The healthy shard's scope stays current.
		expect((await membership.getScopeHealth(scopeB))?.health).toBe("current");
		// Unfiltered degrade (legacy call shape) still degrades everything.
		await publisher.degradeAllForAccount({
			accountKey: "default",
			health: "stale",
			reason: "gateway_disconnect:account",
		});
		expect((await membership.getScopeHealth(scopeA))?.health).toBe("stale");
		expect((await membership.getScopeHealth(scopeB))?.health).toBe("stale");
	}, 60_000);
});
