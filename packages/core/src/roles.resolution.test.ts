/**
 * Cross-connector owner resolution through resolveEntityRole: the paths that
 * decide whether a connector-originated sender (Discord/Telegram/…) is the app
 * owner. Driven over a deterministic fake runtime (no DB, no live model):
 * configured-owner identity, connector-identity matching against the owner
 * entity's verified pairing metadata, non-authoritative identity links, the
 * connector-admin whitelist ceiling (ADMIN, never OWNER), and the fail-closed
 * defaults for unlinked strangers and stale world OWNER grants.
 */
import { describe, expect, it } from "vitest";
import { type RolesWorldMetadata, resolveEntityRole } from "./roles.ts";
import type { Entity, IAgentRuntime, Relationship, UUID } from "./types";
import type { OwnerBindingEvaluation } from "./types/identity";

const OWNER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SENDER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const OWNER_DISCORD_ID = "123456789012345678";
const IMPOSTER_DISCORD_ID = "876543210987654321";

type FakeRuntimeOptions = {
	settings?: Record<string, string>;
	entities?: Record<string, Entity>;
	relationships?: Relationship[];
	ownerBindingEvaluation?: OwnerBindingEvaluation;
	canonicalPrincipalId?: UUID;
	canonicalAgentId?: UUID;
	canonicalRequestedPrincipalId?: UUID;
	canonicalGeneration?: number;
};

function makeRuntime(options: FakeRuntimeOptions = {}): IAgentRuntime {
	const settings = options.settings ?? {};
	const entities = options.entities ?? {};
	return {
		agentId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		getSetting: (key: string) => settings[key],
		getEntityById: async (id: UUID) => entities[id] ?? null,
		getRelationships: async () => options.relationships ?? [],
		getService: () =>
			options.ownerBindingEvaluation
				? {
						resolveCanonicalPrincipal: async () => ({
							agentId:
								options.canonicalAgentId ??
								("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID),
							requestedPrincipalId:
								options.canonicalRequestedPrincipalId ?? (SENDER_ID as UUID),
							canonicalPrincipalId:
								options.canonicalPrincipalId ??
								(options.ownerBindingEvaluation?.decision === "bound"
									? options.ownerBindingEvaluation.actorCanonicalPrincipalId
									: (SENDER_ID as UUID)),
							redirectIds: [],
							generation: options.canonicalGeneration ?? 1,
						}),
						evaluateOwnerBinding: async () => options.ownerBindingEvaluation,
					}
				: null,
		reportError: () => undefined,
	} as unknown as IAgentRuntime;
}

function ownerEntity(discordId: string): Entity {
	return {
		id: OWNER_ID as UUID,
		names: ["Owner"],
		agentId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID,
		metadata: {
			discord: {
				id: discordId,
				userId: discordId,
				username: "owner",
				ownerBindVerifiedAt: 1,
			},
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
	it("grants OWNER from a verified canonical identity-service decision", async () => {
		const runtime = makeRuntime({
			settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
			ownerBindingEvaluation: {
				decision: "bound",
				actorCanonicalPrincipalId: OWNER_ID as UUID,
				ownerPrincipalId: OWNER_ID as UUID,
				claimId: "dddddddd-dddd-dddd-dddd-dddddddddddd" as UUID,
				ownerBindingId: "binding-1",
				generation: 1,
				reason: "verified_owner_binding",
			},
		});
		expect(await resolveEntityRole(runtime, null, {}, SENDER_ID)).toBe("OWNER");
	});

	it("does not fall back when the identity service is unavailable", async () => {
		const runtime = makeRuntime({
			settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
			entities: {
				[OWNER_ID]: ownerEntity(OWNER_DISCORD_ID),
				[SENDER_ID]: senderEntity(OWNER_DISCORD_ID, "owner"),
			},
			ownerBindingEvaluation: {
				decision: "unavailable",
				reason: "read_failed",
			},
		});
		expect(await resolveEntityRole(runtime, null, {}, SENDER_ID)).toBe("GUEST");
	});

	it("rejects a bound result for a different canonical actor", async () => {
		const runtime = makeRuntime({
			settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
			canonicalPrincipalId: SENDER_ID as UUID,
			ownerBindingEvaluation: {
				decision: "bound",
				actorCanonicalPrincipalId: OWNER_ID as UUID,
				ownerPrincipalId: OWNER_ID as UUID,
				claimId: "dddddddd-dddd-dddd-dddd-dddddddddddd" as UUID,
				ownerBindingId: "binding-1",
				generation: 1,
				reason: "verified_owner_binding",
			},
		});
		expect(await resolveEntityRole(runtime, null, {}, SENDER_ID)).toBe("GUEST");
	});

	const boundToOwner: OwnerBindingEvaluation = {
		decision: "bound",
		actorCanonicalPrincipalId: OWNER_ID as UUID,
		ownerPrincipalId: OWNER_ID as UUID,
		claimId: "dddddddd-dddd-dddd-dddd-dddddddddddd" as UUID,
		ownerBindingId: "binding-1",
		generation: 1,
		reason: "verified_owner_binding",
	};

	it("rejects a canonical resolution echoed for a different agent", async () => {
		const runtime = makeRuntime({
			settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
			canonicalAgentId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" as UUID,
			ownerBindingEvaluation: boundToOwner,
		});
		expect(await resolveEntityRole(runtime, null, {}, SENDER_ID)).toBe("GUEST");
	});

	it("rejects a canonical resolution echoed for a different requested actor", async () => {
		const runtime = makeRuntime({
			settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
			canonicalRequestedPrincipalId: OWNER_ID as UUID,
			ownerBindingEvaluation: boundToOwner,
		});
		expect(await resolveEntityRole(runtime, null, {}, SENDER_ID)).toBe("GUEST");
	});

	it("rejects a binding evaluated at a different generation than the canonical read", async () => {
		const runtime = makeRuntime({
			settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
			canonicalGeneration: 2,
			ownerBindingEvaluation: boundToOwner,
		});
		expect(await resolveEntityRole(runtime, null, {}, SENDER_ID)).toBe("GUEST");
	});

	it("rejects a malformed negative canonical generation", async () => {
		const runtime = makeRuntime({
			settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
			canonicalGeneration: -1,
			ownerBindingEvaluation: { ...boundToOwner, generation: -1 },
		});
		expect(await resolveEntityRole(runtime, null, {}, SENDER_ID)).toBe("GUEST");
	});

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

	it("preserves confirmed-link authority until the canonical service is installed", async () => {
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

describe("resolveEntityRole — stored OWNER grants and provenance (#14707 residual)", () => {
	it("folds a sourceless legacy stored OWNER grant to GUEST even with no canonical owner configured", async () => {
		// Worlds persisted before guild-owner grants carried provenance still
		// hold OWNER grants the old Discord code wrote for every guild owner.
		// Without a configured canonical owner these used to resolve to app
		// OWNER — any guild owner hosting the bot inherited the deployment.
		const runtime = makeRuntime();
		const metadata: RolesWorldMetadata = {
			roles: { [SENDER_ID]: "OWNER" },
		};
		expect(await resolveEntityRole(runtime, null, metadata, SENDER_ID)).toBe(
			"GUEST",
		);
	});

	it("folds a connector_admin-sourced stored OWNER grant to GUEST with no canonical owner configured", async () => {
		const runtime = makeRuntime();
		const metadata: RolesWorldMetadata = {
			roles: { [SENDER_ID]: "OWNER" },
			roleSources: { [SENDER_ID]: "connector_admin" },
		};
		expect(await resolveEntityRole(runtime, null, metadata, SENDER_ID)).toBe(
			"GUEST",
		);
	});

	it("honors a deliberate manual OWNER grant with no canonical owner configured", async () => {
		const runtime = makeRuntime();
		const metadata: RolesWorldMetadata = {
			roles: { [SENDER_ID]: "OWNER" },
			roleSources: { [SENDER_ID]: "manual" },
		};
		expect(await resolveEntityRole(runtime, null, metadata, SENDER_ID)).toBe(
			"OWNER",
		);
	});

	it("honors a manual OWNER grant made by the canonical owner (deliberate co-owner)", async () => {
		// canModifyRole only lets an existing OWNER write an OWNER grant, so a
		// manual OWNER grant is a deliberate co-owner appointment — resolution
		// must not silently ignore what the role-management surface permits.
		const runtime = makeRuntime({
			settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
		});
		const metadata: RolesWorldMetadata = {
			roles: { [SENDER_ID]: "OWNER" },
			roleSources: { [SENDER_ID]: "manual" },
		};
		expect(await resolveEntityRole(runtime, null, metadata, SENDER_ID)).toBe(
			"OWNER",
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
