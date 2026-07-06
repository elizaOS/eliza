/**
 * Cross-connector owner resolution through resolveEntityRole: the paths that
 * decide whether a connector-originated sender (Discord/Telegram/…) is the app
 * owner. Driven over a deterministic fake runtime (no DB, no live model):
 * configured-owner identity, connector-identity matching against the owner
 * entity's metadata (the owner-pairing bridge), confirmed identity links, the
 * connector-admin whitelist ceiling (ADMIN, never OWNER), and the fail-closed
 * defaults for unlinked strangers and stale world OWNER grants.
 */
import { describe, expect, it } from "vitest";
import { type RolesWorldMetadata, resolveEntityRole } from "./roles.ts";
import type { Entity, IAgentRuntime, Relationship, UUID } from "./types";

const OWNER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SENDER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const OWNER_DISCORD_ID = "123456789012345678";
const IMPOSTER_DISCORD_ID = "876543210987654321";

type FakeRuntimeOptions = {
	settings?: Record<string, string>;
	entities?: Record<string, Entity>;
	relationships?: Relationship[];
};

function makeRuntime(options: FakeRuntimeOptions = {}): IAgentRuntime {
	const settings = options.settings ?? {};
	const entities = options.entities ?? {};
	return {
		agentId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		getSetting: (key: string) => settings[key],
		getEntityById: async (id: UUID) => entities[id] ?? null,
		getRelationships: async () => options.relationships ?? [],
	} as unknown as IAgentRuntime;
}

function ownerEntity(discordId: string): Entity {
	return {
		id: OWNER_ID as UUID,
		names: ["Owner"],
		agentId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID,
		metadata: {
			discord: { id: discordId, userId: discordId, username: "owner" },
		},
	};
}

function senderEntity(discordId: string, username = "someone"): Entity {
	return {
		id: SENDER_ID as UUID,
		names: [username],
		agentId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID,
		metadata: {
			discord: { id: discordId, userId: discordId, username },
		},
	};
}

describe("resolveEntityRole — configured canonical owner", () => {
	it("resolves the configured owner id itself to OWNER", async () => {
		const runtime = makeRuntime({
			settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
		});
		expect(await resolveEntityRole(runtime, null, {}, OWNER_ID)).toBe("OWNER");
	});

	it("resolves an unlinked connector sender to GUEST", async () => {
		const runtime = makeRuntime({
			settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
			entities: {
				[OWNER_ID]: ownerEntity(OWNER_DISCORD_ID),
				[SENDER_ID]: senderEntity(IMPOSTER_DISCORD_ID),
			},
		});
		expect(await resolveEntityRole(runtime, null, {}, SENDER_ID)).toBe("GUEST");
	});
});

describe("resolveEntityRole — connector identity binding (owner pairing)", () => {
	it("grants OWNER when the sender entity's stable platform id matches the owner entity's", async () => {
		// This is exactly the state the OWNER_BIND_VERIFY pairing flow writes:
		// the verified snowflake recorded on the owner entity's metadata.
		const runtime = makeRuntime({
			settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
			entities: {
				[OWNER_ID]: ownerEntity(OWNER_DISCORD_ID),
				[SENDER_ID]: senderEntity(OWNER_DISCORD_ID, "owner"),
			},
		});
		expect(await resolveEntityRole(runtime, null, {}, SENDER_ID)).toBe("OWNER");
	});

	it("grants OWNER from live connector-stamped metadata on the message", async () => {
		const runtime = makeRuntime({
			settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
			entities: { [OWNER_ID]: ownerEntity(OWNER_DISCORD_ID) },
		});
		const role = await resolveEntityRole(runtime, null, {}, SENDER_ID, {
			liveEntityMetadata: {
				discord: { id: OWNER_DISCORD_ID, userId: OWNER_DISCORD_ID },
			},
			liveEntityId: SENDER_ID,
		});
		expect(role).toBe("OWNER");
	});

	it("an imposter matching only the display name stays GUEST", async () => {
		const runtime = makeRuntime({
			settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
			entities: {
				[OWNER_ID]: ownerEntity(OWNER_DISCORD_ID),
				// Same username as the owner, different snowflake — mutable display
				// fields must never participate in owner matching.
				[SENDER_ID]: senderEntity(IMPOSTER_DISCORD_ID, "owner"),
			},
		});
		expect(await resolveEntityRole(runtime, null, {}, SENDER_ID)).toBe("GUEST");
	});
});

describe("resolveEntityRole — confirmed identity links (merge engine)", () => {
	function identityLink(status: string): Relationship {
		return {
			id: "99999999-9999-9999-9999-999999999999" as UUID,
			sourceEntityId: SENDER_ID as UUID,
			targetEntityId: OWNER_ID as UUID,
			agentId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID,
			tags: ["identity_link"],
			metadata: { status },
		} as Relationship;
	}

	it("a confirmed identity link to the owner inherits OWNER", async () => {
		const runtime = makeRuntime({
			settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
			relationships: [identityLink("confirmed")],
		});
		expect(await resolveEntityRole(runtime, null, {}, SENDER_ID)).toBe("OWNER");
	});

	it("an unconfirmed identity link grants nothing", async () => {
		const runtime = makeRuntime({
			settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
			relationships: [identityLink("pending")],
		});
		expect(await resolveEntityRole(runtime, null, {}, SENDER_ID)).toBe("GUEST");
	});
});

describe("resolveEntityRole — stored grants under a configured owner", () => {
	it("demotes a stored world OWNER grant for a non-owner to GUEST", async () => {
		// Connectors write world-level OWNER grants (Discord guild owner,
		// Telegram chat creator). Once a canonical owner is configured those
		// grants must not outrank it.
		const runtime = makeRuntime({
			settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
		});
		const metadata: RolesWorldMetadata = {
			roles: { [SENDER_ID]: "OWNER" },
		};
		expect(await resolveEntityRole(runtime, null, metadata, SENDER_ID)).toBe(
			"GUEST",
		);
	});

	it("honors a manual ADMIN grant (no escalation to OWNER)", async () => {
		const runtime = makeRuntime({
			settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
		});
		const metadata: RolesWorldMetadata = {
			roles: { [SENDER_ID]: "ADMIN" },
			roleSources: { [SENDER_ID]: "manual" },
		};
		expect(await resolveEntityRole(runtime, null, metadata, SENDER_ID)).toBe(
			"ADMIN",
		);
	});
});

describe("resolveEntityRole — connector-admin whitelist ceiling", () => {
	const whitelistSettings = {
		ELIZA_ADMIN_ENTITY_ID: OWNER_ID,
		ELIZA_ROLES_CONNECTOR_ADMINS_JSON: JSON.stringify({
			discord: [IMPOSTER_DISCORD_ID],
		}),
	};

	it("grants a whitelisted connector user ADMIN, never OWNER", async () => {
		const runtime = makeRuntime({
			settings: whitelistSettings,
			entities: { [SENDER_ID]: senderEntity(IMPOSTER_DISCORD_ID) },
		});
		expect(await resolveEntityRole(runtime, null, {}, SENDER_ID)).toBe("ADMIN");
	});

	it("revokes a connector_admin-sourced grant when the whitelist empties", async () => {
		const runtime = makeRuntime({
			settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
			entities: { [SENDER_ID]: senderEntity(IMPOSTER_DISCORD_ID) },
		});
		const metadata: RolesWorldMetadata = {
			roles: { [SENDER_ID]: "ADMIN" },
			roleSources: { [SENDER_ID]: "connector_admin" },
		};
		expect(await resolveEntityRole(runtime, null, metadata, SENDER_ID)).toBe(
			"GUEST",
		);
	});
});
