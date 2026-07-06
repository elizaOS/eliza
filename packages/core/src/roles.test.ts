/**
 * Unit tests for the role + permission helpers, driven as pure functions over
 * hand-built world metadata and a deterministic fake runtime (no live model or
 * DB). canModifyRole is the privilege-escalation gate: OWNER may change anyone,
 * ADMIN may only manage strictly-lower ranks and may never grant OWNER, and
 * USER/GUEST may change no one. normalizeRole must fold unknown input to GUEST
 * (never silently grant a higher role), and the connector-admin whitelist
 * matches an entity only on its stable platform id.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	getConnectorIdentityMetadataMapping,
	getConnectorWorldIdMetadataKeys,
	LEGACY_DISCORD_CONNECTOR_SOURCE_METADATA,
	registerConnectorSourceMetadata,
	unregisterConnectorSourceMetadataOwner,
} from "./connectors.ts";
import { createUniqueUuid } from "./entities.ts";
import {
	CANONICAL_ROLE_RANK,
	canModifyRole,
	getEntityRole,
	getLiveEntityMetadataFromMessage,
	getUnresolvedSenderRoleFloor,
	hasAtLeastRole,
	hasRoleAccess,
	isAdminRank,
	isAgentSelf,
	matchEntityToConnectorAdminWhitelist,
	normalizeRole,
	ROLE_RANK,
	recordOwnerGrant,
	recordRoleGrant,
	resolveEntityRole,
	resolveWorldForMessage,
} from "./roles.ts";
import {
	roleRank as gateRoleRank,
	satisfiesRoleGate,
} from "./runtime/context-gates.ts";
import type { IAgentRuntime, Memory } from "./types";

describe("normalizeRole", () => {
	it("recognizes the three named roles, else GUEST", () => {
		expect(normalizeRole("owner")).toBe("OWNER");
		expect(normalizeRole("Admin")).toBe("ADMIN");
		expect(normalizeRole("USER")).toBe("USER");
		expect(normalizeRole("superuser")).toBe("GUEST");
		expect(normalizeRole(null)).toBe("GUEST");
	});

	// #12087 Item 6: MEMBER is the USER-tier alias, not GUEST. Folding it to GUEST
	// (the prior bug) demoted a stored MEMBER world role below a minRole:USER gate
	// that the context-gate path grants — the two paths must agree on MEMBER.
	it("resolves the MEMBER alias to its canonical USER tier (not GUEST)", () => {
		expect(normalizeRole("MEMBER")).toBe("USER");
		expect(normalizeRole("member")).toBe("USER");
		expect(ROLE_RANK[normalizeRole("MEMBER")]).toBe(CANONICAL_ROLE_RANK.USER);
	});

	it("a stored MEMBER role clears a minRole:USER gate via both role paths", () => {
		// getEntityRole (checkSenderRole path) must resolve MEMBER to a USER-rank
		// role that satisfies a USER gate — matching satisfiesRoleGate (context path).
		const stored = getEntityRole(
			{ roles: { "entity-1": "MEMBER" as never } },
			"entity-1",
		);
		expect(ROLE_RANK[stored]).toBeGreaterThanOrEqual(CANONICAL_ROLE_RANK.USER);
		expect(satisfiesRoleGate(["MEMBER"], { minRole: "USER" })).toBe(true);
		expect(gateRoleRank("MEMBER")).toBe(gateRoleRank("USER"));
	});
});

describe("hasAtLeastRole / isAdminRank (#12087 Item 31)", () => {
	it("ranks roles by CANONICAL_ROLE_RANK, not string identity", () => {
		expect(hasAtLeastRole("OWNER", "ADMIN")).toBe(true);
		expect(hasAtLeastRole("ADMIN", "ADMIN")).toBe(true);
		expect(hasAtLeastRole("USER", "ADMIN")).toBe(false);
		expect(hasAtLeastRole("MEMBER", "USER")).toBe(true); // alias resolves
		expect(hasAtLeastRole("GUEST", "USER")).toBe(false);
	});

	it("fails closed for unknown/empty roles", () => {
		expect(hasAtLeastRole(undefined, "ADMIN")).toBe(false);
		expect(hasAtLeastRole(null, "USER")).toBe(false);
		expect(hasAtLeastRole("superuser", "ADMIN")).toBe(false);
	});

	it("isAdminRank is true only for ADMIN and OWNER (case-insensitive)", () => {
		expect(isAdminRank("owner")).toBe(true);
		expect(isAdminRank("ADMIN")).toBe(true);
		expect(isAdminRank("USER")).toBe(false);
		expect(isAdminRank("member")).toBe(false);
		expect(isAdminRank("GUEST")).toBe(false);
		expect(isAdminRank(undefined)).toBe(false);
	});
});

describe("getEntityRole", () => {
	it("reads + normalizes a role from world metadata, GUEST when absent", () => {
		const meta = { roles: { e1: "ADMIN", e2: "nonsense" } } as never;
		expect(getEntityRole(meta, "e1")).toBe("ADMIN");
		expect(getEntityRole(meta, "e2")).toBe("GUEST");
		expect(getEntityRole(undefined, "e1")).toBe("GUEST");
	});
});

describe("canModifyRole — privilege escalation gate", () => {
	it("OWNER can change anyone (but not a no-op)", () => {
		expect(canModifyRole("OWNER", "USER", "ADMIN")).toBe(true);
		expect(canModifyRole("OWNER", "ADMIN", "USER")).toBe(true);
		expect(canModifyRole("OWNER", "USER", "USER")).toBe(false); // no-op
	});

	it("ADMIN may only manage strictly-lower ranks and never grant OWNER", () => {
		expect(canModifyRole("ADMIN", "USER", "ADMIN")).toBe(true);
		expect(canModifyRole("ADMIN", "GUEST", "USER")).toBe(true);
		expect(canModifyRole("ADMIN", "ADMIN", "USER")).toBe(false); // same rank
		expect(canModifyRole("ADMIN", "USER", "OWNER")).toBe(false); // can't grant OWNER
	});

	it("USER and GUEST can change no one", () => {
		expect(canModifyRole("USER", "GUEST", "USER")).toBe(false);
		expect(canModifyRole("GUEST", "GUEST", "USER")).toBe(false);
	});
});

describe("isAgentSelf", () => {
	it("is true only when the message sender is the agent itself", () => {
		const runtime = { agentId: "agent-1" } as IAgentRuntime;
		expect(isAgentSelf(runtime, { entityId: "agent-1" } as Memory)).toBe(true);
		expect(isAgentSelf(runtime, { entityId: "someone-else" } as Memory)).toBe(
			false,
		);
		expect(isAgentSelf(undefined, { entityId: "agent-1" } as Memory)).toBe(
			false,
		);
	});
});

describe("hasRoleAccess — fail-closed on unresolved role", () => {
	// A message with a real entity/room but no resolvable world (deleted or
	// inaccessible world, or a source that yields no world id) makes
	// checkSenderRole return null. Connector-originated senders must fall to
	// GUEST so they do not outrank a fully resolved stranger; local/API harness
	// traffic keeps USER so no-world local usage still works.
	const makeRuntime = (settings: Record<string, string> = {}) =>
		({
			agentId: "agent-1",
			getRoom: async () => null,
			getWorld: async () => null,
			getEntityById: async () => null,
			getComponents: async () => [],
			getMemories: async () => [],
			getRelationships: async () => [],
			getSetting: (key: string) => settings[key],
			character: {},
		}) as unknown as IAgentRuntime;
	const guestMessage = {
		entityId: "guest-entity-1",
		roomId: "room-1",
		content: { text: "run df -h on the server", source: "test" },
	} as unknown as Memory;
	const connectorMessage = {
		entityId: "guest-entity-1",
		roomId: "room-1",
		content: { text: "run df -h on the server", source: "discord" },
	} as unknown as Memory;

	it("uses USER only for local unresolved sources", () => {
		expect(getUnresolvedSenderRoleFloor(guestMessage)).toBe("USER");
		for (const source of [
			"api",
			"dashboard",
			"owner_app",
			"local-voice",
			"sub_agent",
			"coding-agent",
		]) {
			expect(
				getUnresolvedSenderRoleFloor({
					...guestMessage,
					content: { text: `from ${source}`, source },
				} as unknown as Memory),
			).toBe("USER");
		}
	});

	it("uses GUEST for unresolved connector sources", () => {
		expect(getUnresolvedSenderRoleFloor(connectorMessage)).toBe("GUEST");
		expect(
			getUnresolvedSenderRoleFloor({
				...connectorMessage,
				content: { text: "from Telegram", source: "telegram" },
			} as unknown as Memory),
		).toBe("GUEST");
	});

	it("denies OWNER and ADMIN when the sender role cannot be resolved", async () => {
		const runtime = makeRuntime();
		expect(await hasRoleAccess(runtime, guestMessage, "OWNER")).toBe(false);
		expect(await hasRoleAccess(runtime, guestMessage, "ADMIN")).toBe(false);
	});

	it("still allows USER for unresolved local/API traffic and always allows GUEST", async () => {
		const runtime = makeRuntime();
		expect(await hasRoleAccess(runtime, guestMessage, "USER")).toBe(true);
		expect(await hasRoleAccess(runtime, guestMessage, "GUEST")).toBe(true);
	});

	it("denies USER for an unresolved connector sender", async () => {
		const runtime = makeRuntime();
		expect(await hasRoleAccess(runtime, connectorMessage, "USER")).toBe(false);
		expect(await hasRoleAccess(runtime, connectorMessage, "GUEST")).toBe(true);
	});

	it("still allows the canonical owner through the OWNER gate", async () => {
		const runtime = makeRuntime({ ELIZA_ADMIN_ENTITY_ID: "owner-entity-1" });
		const ownerMessage = {
			entityId: "owner-entity-1",
			roomId: "room-1",
			content: { text: "run df -h on the server", source: "test" },
		} as unknown as Memory;
		expect(await hasRoleAccess(runtime, ownerMessage, "OWNER")).toBe(true);
		expect(await hasRoleAccess(runtime, ownerMessage, "ADMIN")).toBe(true);
	});

	it("still allows the agent itself", async () => {
		const runtime = makeRuntime();
		const selfMessage = {
			entityId: "agent-1",
			roomId: "room-1",
			content: { text: "internal", source: "test" },
		} as unknown as Memory;
		expect(await hasRoleAccess(runtime, selfMessage, "OWNER")).toBe(true);
	});
});

describe("matchEntityToConnectorAdminWhitelist", () => {
	it("matches an entity's stable platform id against the whitelist", () => {
		const whitelist = { discord: ["user-123"] };
		const match = matchEntityToConnectorAdminWhitelist(
			{ discord: { userId: "user-123" } },
			whitelist,
		);
		expect(match).toMatchObject({
			connector: "discord",
			matchedValue: "user-123",
		});
		expect(
			matchEntityToConnectorAdminWhitelist(
				{ discord: { userId: "other" } },
				whitelist,
			),
		).toBeNull();
		expect(matchEntityToConnectorAdminWhitelist(null, whitelist)).toBeNull();
	});

	it("does not match mutable username fields against the whitelist", () => {
		const whitelist = { discord: ["alice"] };

		expect(
			matchEntityToConnectorAdminWhitelist(
				{ discord: { username: "alice", userName: "alice" } },
				whitelist,
			),
		).toBeNull();
	});
});

describe("canonical role rank (#9948)", () => {
	it("orders all tiers NONE < GUEST < USER < ADMIN < OWNER", () => {
		expect(CANONICAL_ROLE_RANK.NONE).toBeLessThan(CANONICAL_ROLE_RANK.GUEST);
		expect(CANONICAL_ROLE_RANK.GUEST).toBeLessThan(CANONICAL_ROLE_RANK.USER);
		expect(CANONICAL_ROLE_RANK.USER).toBeLessThan(CANONICAL_ROLE_RANK.ADMIN);
		expect(CANONICAL_ROLE_RANK.ADMIN).toBeLessThan(CANONICAL_ROLE_RANK.OWNER);
	});

	it("treats USER and MEMBER as the same tier", () => {
		expect(CANONICAL_ROLE_RANK.MEMBER).toBe(CANONICAL_ROLE_RANK.USER);
	});

	it("derives the RoleName-keyed ROLE_RANK from the canonical table", () => {
		expect(ROLE_RANK.GUEST).toBe(CANONICAL_ROLE_RANK.GUEST);
		expect(ROLE_RANK.USER).toBe(CANONICAL_ROLE_RANK.USER);
		expect(ROLE_RANK.ADMIN).toBe(CANONICAL_ROLE_RANK.ADMIN);
		expect(ROLE_RANK.OWNER).toBe(CANONICAL_ROLE_RANK.OWNER);
	});

	it("makes context-gates ranking share the one source of truth", () => {
		// Previously context-gates kept its own literal that could drift.
		expect(gateRoleRank("OWNER")).toBe(CANONICAL_ROLE_RANK.OWNER);
		expect(gateRoleRank("ADMIN")).toBe(CANONICAL_ROLE_RANK.ADMIN);
		expect(gateRoleRank("USER")).toBe(CANONICAL_ROLE_RANK.USER);
		expect(gateRoleRank("MEMBER")).toBe(CANONICAL_ROLE_RANK.USER);
		expect(gateRoleRank("GUEST")).toBe(CANONICAL_ROLE_RANK.GUEST);
		expect(gateRoleRank("NONE")).toBe(CANONICAL_ROLE_RANK.NONE);
	});

	it("gates a minRole:OWNER context to OWNER only", () => {
		expect(satisfiesRoleGate(["OWNER"], { minRole: "OWNER" })).toBe(true);
		expect(satisfiesRoleGate(["ADMIN"], { minRole: "OWNER" })).toBe(false);
		expect(satisfiesRoleGate(["USER"], { minRole: "ADMIN" })).toBe(false);
		expect(satisfiesRoleGate(["MEMBER"], { minRole: "USER" })).toBe(true);
	});
});

describe("role gate rejects unknown tiers (#9948)", () => {
	it("ranks an unknown role as 0 (below GUEST) so a stray value can never pass a gate", () => {
		// The RoleGateRole type no longer has a `(string & {})` escape, but the
		// runtime must still fail closed if an unknown value reaches roleRank.
		expect(gateRoleRank("SUPERUSER" as never)).toBe(0);
		expect(
			satisfiesRoleGate(["SUPERUSER" as never], { minRole: "GUEST" }),
		).toBe(false);
		expect(satisfiesRoleGate(["OWNER"], { minRole: "GUEST" })).toBe(true);
	});
});

describe("recordRoleGrant (#12087 Item 11 generic auditable grant)", () => {
	it("pairs a non-owner role with its grant source", () => {
		const metadata: {
			roles?: Record<string, string>;
			roleSources?: Record<string, string>;
		} = {};
		const changed = recordRoleGrant(
			metadata as never,
			"user-1",
			"USER",
			"connector_admin",
		);
		expect(changed).toBe(true);
		expect(metadata.roles?.["user-1"]).toBe("USER");
		expect(metadata.roleSources?.["user-1"]).toBe("connector_admin");
	});

	it("clears the grant source for a GUEST role (mirrors setEntityRole)", () => {
		const metadata = {
			roles: { "u-1": "USER" },
			roleSources: { "u-1": "connector_admin" },
		} as never;
		expect(recordRoleGrant(metadata, "u-1", "GUEST")).toBe(true);
		const md = metadata as {
			roles: Record<string, string>;
			roleSources: Record<string, string>;
		};
		expect(md.roles["u-1"]).toBe("GUEST");
		expect(md.roleSources["u-1"]).toBeUndefined();
	});

	it("is idempotent", () => {
		const metadata = {} as never;
		recordRoleGrant(metadata, "user-1", "USER", "manual");
		expect(recordRoleGrant(metadata, "user-1", "USER", "manual")).toBe(false);
	});
});

describe("recordOwnerGrant (#9948 explicit auditable owner grant)", () => {
	it("records OWNER role AND the 'owner' grant source", () => {
		const metadata: {
			roles?: Record<string, string>;
			roleSources?: Record<string, string>;
		} = {};
		const changed = recordOwnerGrant(metadata as never, "owner-1");
		expect(changed).toBe(true);
		expect(metadata.roles?.["owner-1"]).toBe("OWNER");
		// The audit trail — what made this entity OWNER — is now queryable.
		expect(metadata.roleSources?.["owner-1"]).toBe("owner");
	});

	it("is idempotent (no change on a second call)", () => {
		const metadata: {
			roles?: Record<string, string>;
			roleSources?: Record<string, string>;
		} = {};
		recordOwnerGrant(metadata as never, "owner-1");
		expect(recordOwnerGrant(metadata as never, "owner-1")).toBe(false);
	});

	it("upgrades a bare roles entry that lacks a recorded source", () => {
		// The previous emergent path wrote roles[id]="OWNER" with NO source.
		const metadata = { roles: { "owner-1": "OWNER" } } as never;
		expect(recordOwnerGrant(metadata, "owner-1")).toBe(true);
		expect(
			(metadata as { roleSources?: Record<string, string> }).roleSources?.[
				"owner-1"
			],
		).toBe("owner");
	});
});

describe("connector metadata is registry-driven, not Discord-special-cased (#12090 item 22 / #12087)", () => {
	// The two paths that used to carry a `source === "discord"` literal branch in
	// core (identity projection + world-id derivation) now read a connector-owned
	// mapping from the connector-source registry. Discord's legacy fields are
	// registered as declared metadata in connectors.ts, so the coupling moved out
	// of core's authorization code and the same generic path serves any connector.

	it("keeps Discord's legacy flat->identity mapping declared in the registry", () => {
		expect(getConnectorIdentityMetadataMapping("discord")).toEqual({
			userIdField: "fromId",
			nameField: "entityName",
		});
		expect(getConnectorWorldIdMetadataKeys("discord")).toEqual([
			"discordServerId",
			"discordChannelId",
		]);
		// The exported legacy default is the single source of those literals now.
		expect(
			LEGACY_DISCORD_CONNECTOR_SOURCE_METADATA.identityMetadataMapping,
		).toEqual({ userIdField: "fromId", nameField: "entityName" });
	});

	it("projects flat Discord metadata into nested identity via the registry (behavior preserved)", () => {
		const message = {
			entityId: "e-1",
			roomId: "room-1",
			content: { text: "hi", source: "discord" },
			metadata: { fromId: "user-123", entityName: "alice" },
		} as unknown as Memory;

		// Same nested identity object the old `source === "discord"` branch built.
		expect(getLiveEntityMetadataFromMessage(message)).toEqual({
			discord: {
				userId: "user-123",
				id: "user-123",
				name: "alice",
				username: "alice",
			},
		});
	});

	it("omits name/username when the declared name field is absent", () => {
		const message = {
			entityId: "e-1",
			roomId: "room-1",
			content: { text: "hi", source: "discord" },
			metadata: { fromId: "user-123" },
		} as unknown as Memory;
		expect(getLiveEntityMetadataFromMessage(message)).toEqual({
			discord: { userId: "user-123", id: "user-123" },
		});
	});

	it("fails closed: no identity when the declared user-id field is missing/blank", () => {
		const blank = {
			entityId: "e-1",
			roomId: "room-1",
			content: { text: "hi", source: "discord" },
			metadata: { fromId: "   ", entityName: "alice" },
		} as unknown as Memory;
		expect(getLiveEntityMetadataFromMessage(blank)).toBeUndefined();

		const missing = {
			entityId: "e-1",
			roomId: "room-1",
			content: { text: "hi", source: "discord" },
			metadata: { entityName: "alice" },
		} as unknown as Memory;
		expect(getLiveEntityMetadataFromMessage(missing)).toBeUndefined();
	});

	it("still prefers an explicit nested metadata[source] object over the flat mapping", () => {
		const message = {
			entityId: "e-1",
			roomId: "room-1",
			content: { text: "hi", source: "discord" },
			metadata: { discord: { userId: "nested-1" }, fromId: "flat-1" },
		} as unknown as Memory;
		expect(getLiveEntityMetadataFromMessage(message)).toEqual({
			discord: { userId: "nested-1" },
		});
	});

	it("yields no identity for a connector with no registered mapping", () => {
		const message = {
			entityId: "e-1",
			roomId: "room-1",
			content: { text: "hi", source: "telegram" },
			metadata: { fromId: "user-123" },
		} as unknown as Memory;
		// Telegram declares no identityMetadataMapping default -> no fabricated identity.
		expect(getLiveEntityMetadataFromMessage(message)).toBeUndefined();
	});

	it("falls back to declared flat mapping when nested connector metadata has no stable id", () => {
		const owner = "test:telegram-connector";
		try {
			registerConnectorSourceMetadata(
				"telegram",
				{
					identityMetadataMapping: {
						userIdField: "fromId",
						nameField: "entityName",
					},
				},
				owner,
			);
			const message = {
				entityId: "e-1",
				roomId: "room-1",
				content: { text: "hi", source: "telegram" },
				metadata: {
					telegram: { chatId: "chat-1", messageId: "message-1" },
					fromId: "user-123",
					entityName: "Ada",
				},
			} as unknown as Memory;

			expect(getLiveEntityMetadataFromMessage(message)).toEqual({
				telegram: {
					userId: "user-123",
					id: "user-123",
					name: "Ada",
					username: "Ada",
				},
			});
		} finally {
			unregisterConnectorSourceMetadataOwner(owner);
		}
	});

	it("works for a NEW connector purely by registering mapping metadata (no core edit)", () => {
		const owner = "test:matrix-connector";
		try {
			registerConnectorSourceMetadata(
				"matrix",
				{
					identityMetadataMapping: {
						userIdField: "senderMxid",
						nameField: "displayName",
					},
				},
				owner,
			);
			const message = {
				entityId: "e-1",
				roomId: "room-1",
				content: { text: "hi", source: "matrix" },
				metadata: { senderMxid: "@bob:hs", displayName: "bob" },
			} as unknown as Memory;
			expect(getLiveEntityMetadataFromMessage(message)).toEqual({
				matrix: {
					userId: "@bob:hs",
					id: "@bob:hs",
					name: "bob",
					username: "bob",
				},
			});
		} finally {
			unregisterConnectorSourceMetadataOwner(owner);
		}
	});

	it("uses stored sender metadata when live connector metadata has no stable id", async () => {
		const ownerEntityId = "owner-entity";
		const senderEntityId = "sender-entity";
		const runtime = {
			agentId: "agent-1",
			getSetting: () => undefined,
			getRelationships: async () => [],
			getEntityById: async (id: string) => {
				if (id === ownerEntityId || id === senderEntityId) {
					return {
						id,
						metadata: { telegram: { id: "telegram-owner" } },
					};
				}
				return null;
			},
		} as unknown as IAgentRuntime;

		await expect(
			resolveEntityRole(
				runtime,
				null,
				{ ownership: { ownerId: ownerEntityId } } as never,
				senderEntityId,
				{ liveEntityMetadata: { telegram: { chatId: "chat-1" } } },
			),
		).resolves.toBe("OWNER");
	});

	it("derives the world id from the declared world-id keys (first present wins)", async () => {
		const runtime = {
			agentId: "agent-1",
			getRoom: async () => null,
			getWorld: async (id: string) => ({ id, metadata: {} }),
		} as unknown as IAgentRuntime;

		const serverMsg = {
			entityId: "e-1",
			roomId: "room-1",
			content: { text: "hi", source: "discord" },
			metadata: { discordServerId: "srv-9", discordChannelId: "chan-9" },
		} as unknown as Memory;
		const resolvedServer = await resolveWorldForMessage(runtime, serverMsg);
		// serverId is preferred (first key), matching the prior literal-branch order.
		expect(resolvedServer?.world?.id).toBe(createUniqueUuid(runtime, "srv-9"));

		const channelMsg = {
			entityId: "e-1",
			roomId: "room-1",
			content: { text: "hi", source: "discord" },
			metadata: { discordChannelId: "chan-9" },
		} as unknown as Memory;
		const resolvedChannel = await resolveWorldForMessage(runtime, channelMsg);
		expect(resolvedChannel?.world?.id).toBe(
			createUniqueUuid(runtime, "chan-9"),
		);
	});

	it("derives no world id when none of the declared keys are present", async () => {
		const runtime = {
			agentId: "agent-1",
			getRoom: async () => null,
			getWorld: async (id: string) => ({ id, metadata: {} }),
		} as unknown as IAgentRuntime;
		const msg = {
			entityId: "e-1",
			roomId: "room-1",
			content: { text: "hi", source: "discord" },
			metadata: { unrelated: "x" },
		} as unknown as Memory;
		expect(await resolveWorldForMessage(runtime, msg)).toBeNull();
	});

	it('grep guard: no `source === "discord"` literal branch survives in roles.ts', () => {
		const rolesSource = readFileSync(
			fileURLToPath(new URL("./roles.ts", import.meta.url)),
			"utf8",
		);
		// The Discord authorization coupling now lives in the connector-source
		// registry (connectors.ts), not as a literal branch in core's roles.ts.
		expect(rolesSource).not.toMatch(/source\s*===\s*["']discord["']/);
		expect(rolesSource).not.toContain("discordServerId");
		expect(rolesSource).not.toContain("discordChannelId");
	});
});
