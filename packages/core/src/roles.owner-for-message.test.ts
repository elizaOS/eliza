/**
 * Regression coverage for the owner-private disclosure gate's owner resolution
 * (resolveCanonicalOwnerIdForMessage). A connector may persist the world's
 * canonical owner under a DIFFERENT entity UUID than the one it stamps on the
 * owner's own inbound messages — e.g. plugin-discord records
 * `ownership.ownerId` as the synthetic `stringToUuid("<name>-admin-entity")`
 * fallback while the owner's message carries `createUniqueUuid(runtime,
 * <snowflake>)`. Both denote the same human, but the gate compares this id to
 * the message actor with strict equality, so a naive resolver returns the
 * synthetic id, the equality fails, and every owner-private surface is denied
 * with `owner_mismatch` — even in a 2-person owner DM/guild.
 *
 * This proves BOTH directions: the genuine owner (matched via connector-stable
 * identity) resolves to the ACTOR's id so the gate matches, while a non-owner
 * sender never does and stays denied.
 */
import { describe, expect, it } from "vitest";
import { resolveCanonicalOwnerIdForMessage } from "./roles.ts";
import type { Entity, IAgentRuntime, Memory, Room, UUID, World } from "./types";

const AGENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID;
const WORLD_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd" as UUID;
const ROOM_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" as UUID;

// The synthetic owner UUID a connector persisted onto the world.
const SYNTHETIC_OWNER_ID = "0afe069b-83d3-0ea3-aa07-a47dd72ade03" as UUID;
// The owner's ACTUAL message-actor entity UUID (createUniqueUuid(snowflake)).
const OWNER_ACTOR_ID = "1ac7128f-c24b-0773-a5e5-472dfcff09b1" as UUID;
// A non-owner sender.
const STRANGER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc" as UUID;

const OWNER_SNOWFLAKE = "308276393450668032";
const STRANGER_SNOWFLAKE = "876543210987654321";

type FakeOptions = {
	entities?: Record<string, Entity>;
	worldMetadata?: Record<string, unknown>;
};

function makeRuntime(options: FakeOptions = {}): IAgentRuntime {
	const entities = options.entities ?? {};
	const world: World = {
		id: WORLD_ID,
		name: "owner guild",
		agentId: AGENT_ID,
		metadata: (options.worldMetadata ?? {}) as World["metadata"],
	};
	return {
		agentId: AGENT_ID,
		// No configured canonical owner — force world-metadata resolution.
		getSetting: () => undefined,
		getRoom: async (id: UUID): Promise<Room | null> =>
			id === ROOM_ID
				? ({
						id: ROOM_ID,
						agentId: AGENT_ID,
						worldId: WORLD_ID,
						source: "discord",
					} as Room)
				: null,
		getWorld: async (id: UUID): Promise<World | null> =>
			id === WORLD_ID ? world : null,
		getEntityById: async (id: UUID) => entities[id] ?? null,
		getRelationships: async () => [],
	} as unknown as IAgentRuntime;
}

function ownerEntity(): Entity {
	return {
		id: OWNER_ACTOR_ID,
		names: ["Owner"],
		agentId: AGENT_ID,
		metadata: {
			discord: {
				id: OWNER_SNOWFLAKE,
				userId: OWNER_SNOWFLAKE,
				username: "owner",
			},
		},
	};
}

// The synthetic owner entity the connector linked the world ownership to; it
// carries the SAME stable platform snowflake as the owner actor entity.
function syntheticOwnerEntity(): Entity {
	return {
		id: SYNTHETIC_OWNER_ID,
		names: ["Owner"],
		agentId: AGENT_ID,
		metadata: {
			discord: {
				id: OWNER_SNOWFLAKE,
				userId: OWNER_SNOWFLAKE,
				username: "owner",
			},
		},
	};
}

function strangerEntity(): Entity {
	return {
		id: STRANGER_ID,
		names: ["Stranger"],
		agentId: AGENT_ID,
		metadata: {
			discord: {
				id: STRANGER_SNOWFLAKE,
				userId: STRANGER_SNOWFLAKE,
				username: "stranger",
			},
		},
	};
}

function message(entityId: UUID): Memory {
	return {
		id: "66666666-6666-6666-6666-666666666666" as UUID,
		entityId,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text: "what have we talked about?", source: "discord" },
	} as Memory;
}

describe("resolveCanonicalOwnerIdForMessage — split owner-UUID reconciliation", () => {
	it("without the fix, the recorded synthetic owner would never equal the actor (the bug)", async () => {
		// This asserts the raw invariant the gate relies on: the world records a
		// DIFFERENT id than the owner's own message actor. A resolver that returns
		// the recorded id verbatim fails the gate's strict equality.
		expect(SYNTHETIC_OWNER_ID).not.toBe(OWNER_ACTOR_ID);
	});

	it("resolves the genuine owner (matched by connector identity) to the ACTOR id so the gate matches", async () => {
		const runtime = makeRuntime({
			worldMetadata: { ownership: { ownerId: SYNTHETIC_OWNER_ID } },
			entities: {
				[SYNTHETIC_OWNER_ID]: syntheticOwnerEntity(),
				[OWNER_ACTOR_ID]: ownerEntity(),
			},
		});
		const resolved = await resolveCanonicalOwnerIdForMessage(
			runtime,
			message(OWNER_ACTOR_ID),
		);
		// The genuine owner resolves to their OWN actor id, so the gate's
		// `actorEntityId === canonicalOwnerEntityId` check passes.
		expect(resolved).toBe(OWNER_ACTOR_ID);
	});

	it("keeps a non-owner sender denied (resolver returns the recorded owner, not the stranger)", async () => {
		const runtime = makeRuntime({
			worldMetadata: { ownership: { ownerId: SYNTHETIC_OWNER_ID } },
			entities: {
				[SYNTHETIC_OWNER_ID]: syntheticOwnerEntity(),
				[STRANGER_ID]: strangerEntity(),
			},
		});
		const resolved = await resolveCanonicalOwnerIdForMessage(
			runtime,
			message(STRANGER_ID),
		);
		// A stranger never satisfies resolveOwnershipRole, so the resolver returns
		// the recorded owner id — which is NOT the stranger, so the gate's strict
		// equality denies the stranger with owner_mismatch.
		expect(resolved).toBe(SYNTHETIC_OWNER_ID);
		expect(resolved).not.toBe(STRANGER_ID);
	});

	it("returns the recorded owner unchanged when it already equals the actor", async () => {
		const runtime = makeRuntime({
			worldMetadata: { ownership: { ownerId: OWNER_ACTOR_ID } },
			entities: { [OWNER_ACTOR_ID]: ownerEntity() },
		});
		const resolved = await resolveCanonicalOwnerIdForMessage(
			runtime,
			message(OWNER_ACTOR_ID),
		);
		expect(resolved).toBe(OWNER_ACTOR_ID);
	});
});
