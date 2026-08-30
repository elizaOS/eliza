/**
 * Regression tests for issue #24765 on the real module: (1) AMBIGUOUS/UNKNOWN
 * are terminal unresolved results even when diagnostic matches name a valid
 * entity; (2) decisive resolution requires consistent evidence — a non-EXACT
 * in-scope entityId and every unique match label must agree on exactly one
 * id-bearing candidate, exact me/myself/you/yourself referents bind to the
 * sender/agent before the unique-hit shortcut, and a label matching several
 * candidates stays unresolved; (3) getEntityDetails rejects an id-less
 * persisted room entity with a typed integrity error instead of silently
 * shortening the roster. Runtime collaborators are stubbed at documented
 * seams; findEntityByName/getEntityDetails are not replaced.
 */
import { describe, expect, it } from "vitest";
import { findEntityByName, getEntityDetails } from "./entities";
import { isElizaError } from "./errors";
import type { Entity, IAgentRuntime, Memory, State, UUID } from "./types";

const AGENT = "00000000-0000-0000-0000-0000000000aa" as UUID;
const BOB = "00000000-0000-0000-0000-0000000000b0" as UUID;
const ALICE = "00000000-0000-0000-0000-0000000000a1" as UUID;
const OTHER = "00000000-0000-0000-0000-0000000000f1" as UUID;
const ROOM = "00000000-0000-0000-0000-0000000000c0" as UUID;

function component(
	entityId: UUID,
	sourceEntityId: UUID,
	data: Record<string, unknown>,
	id: string,
): NonNullable<Entity["components"]>[number] {
	return {
		id: id as UUID,
		entityId,
		agentId: AGENT,
		roomId: ROOM,
		worldId: ROOM,
		sourceEntityId,
		type: "discord",
		createdAt: 1,
		data: data as NonNullable<Entity["components"]>[number]["data"],
	};
}

function entity(
	id: UUID,
	names: string[],
	components: NonNullable<Entity["components"]> = [],
): Entity {
	return { id, agentId: AGENT, names, components };
}

const bob = entity(
	BOB,
	["Bob"],
	[component(BOB, BOB, { username: "bob", handle: "bob" }, "d1")],
);
const alice = entity(
	ALICE,
	["Alice"],
	[component(ALICE, ALICE, { username: "alice", handle: "alice" }, "d2")],
);
const other = entity(OTHER, ["Zed"]);

function message(text: string, entityId: UUID = BOB): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000m1" as UUID,
		entityId,
		roomId: ROOM,
		agentId: AGENT,
		content: { text },
	} as Memory;
}

const state = {
	values: {},
	data: { room: { id: ROOM, name: "DM", worldId: null } },
	text: "",
} as unknown as State;

type ModelResult = Record<string, unknown> | string;

function runtime(
	entitiesInRoom: Entity[],
	modelResult: ModelResult,
	overrides: Partial<IAgentRuntime> = {},
	relationships: unknown[] = [],
): IAgentRuntime {
	const byId = new Map<string, Entity>(
		entitiesInRoom.map((e) => [String(e.id), structuredClone(e)]),
	);
	return {
		agentId: AGENT,
		character: { name: "Eliza" },
		getRoom: async () => ({ id: ROOM, name: "DM", worldId: null }),
		getWorld: async () => null,
		getEntitiesForRoom: async () =>
			entitiesInRoom.map((e) => structuredClone(e)),
		getRelationships: async () => relationships,
		getEntityById: async (id: UUID) => {
			const found = byId.get(String(id));
			return found ? structuredClone(found) : null;
		},
		getMemories: async () => [],
		useModel: async () => modelResult,
		...overrides,
	} as unknown as IAgentRuntime;
}

describe("terminal unresolved model results", () => {
	it("returns null for AMBIGUOUS even when its diagnostic matches name a valid entity", async () => {
		const found = await findEntityByName(
			runtime([structuredClone(bob), structuredClone(alice)], {
				type: "AMBIGUOUS",
				entityId: null,
				matches: [{ name: "Alice", reason: "names match" }],
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null for UNKNOWN even when its diagnostic matches name a valid entity", async () => {
		const found = await findEntityByName(
			runtime([structuredClone(bob), structuredClone(alice)], {
				type: "UNKNOWN",
				entityId: null,
				matches: [{ name: "Alice", reason: "names match" }],
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});
});

describe("decisive evidence consistency", () => {
	it("resolves a non-EXACT decisive result that carries a consistent in-scope entityId", async () => {
		const found = await findEntityByName(
			runtime([structuredClone(bob), structuredClone(alice)], {
				type: "NAME_MATCH",
				entityId: ALICE,
				matches: [],
			}),
			message("who should I ping"),
			state,
		);
		expect(found?.id).toBe(ALICE);
	});

	it("returns null when the model's entityId contradicts its matches", async () => {
		const found = await findEntityByName(
			runtime([structuredClone(bob), structuredClone(alice)], {
				type: "NAME_MATCH",
				entityId: ALICE,
				matches: [{ name: "Bob", reason: "contradictory" }],
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null when a match label belongs to multiple candidates", async () => {
		const alex1 = entity("00000000-0000-0000-0000-0000000000e1" as UUID, [
			"Alex",
		]);
		const alex2 = entity("00000000-0000-0000-0000-0000000000e2" as UUID, [
			"Alex",
		]);
		const found = await findEntityByName(
			runtime([alex1, alex2], {
				type: "NAME_MATCH",
				entityId: null,
				matches: [{ name: "Alex", reason: "names match" }],
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null when a match label names no known entity", async () => {
		const found = await findEntityByName(
			runtime([structuredClone(bob)], {
				type: "NAME_MATCH",
				entityId: null,
				matches: [{ name: "Nobody", reason: "hallucinated" }],
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null when decisive evidence disagrees across multiple match labels", async () => {
		const found = await findEntityByName(
			runtime(
				[structuredClone(bob), structuredClone(alice), structuredClone(other)],
				{
					type: "NAME_MATCH",
					entityId: null,
					matches: [
						{ name: "Alice", reason: "one" },
						{ name: "Zed", reason: "two" },
					],
				},
			),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});
});

describe("contextual me/you binding precedence", () => {
	it("binds an exact 'me' referent to the sender before a literal Me entity wins the unique-hit shortcut", async () => {
		const meEntity = entity("00000000-0000-0000-0000-0000000000be" as UUID, [
			"Me",
		]);
		const found = await findEntityByName(
			runtime([meEntity, structuredClone(bob)], "not-json"),
			message("me"),
			state,
		);
		expect(found?.id).toBe(BOB);
	});

	it("binds an exact 'myself' referent to the sender before a literal Me entity", async () => {
		const meEntity = entity("00000000-0000-0000-0000-0000000000be" as UUID, [
			"Me",
		]);
		const found = await findEntityByName(
			runtime([meEntity, structuredClone(bob)], "not-json"),
			message("myself"),
			state,
		);
		expect(found?.id).toBe(BOB);
	});

	it("binds an exact 'you' referent to the agent even when a literal You entity is present", async () => {
		const youEntity = entity("00000000-0000-0000-0000-0000000000b9" as UUID, [
			"You",
		]);
		const agentEntity = entity(AGENT, ["Eliza"]);
		const found = await findEntityByName(
			runtime([youEntity, agentEntity, structuredClone(bob)], "not-json"),
			message("you"),
			state,
		);
		expect(found?.id).toBe(AGENT);
	});

	it("binds an exact 'yourself' referent to the agent even when a literal You entity is present", async () => {
		const youEntity = entity("00000000-0000-0000-0000-0000000000b9" as UUID, [
			"You",
		]);
		const agentEntity = entity(AGENT, ["Eliza"]);
		const found = await findEntityByName(
			runtime([youEntity, agentEntity, structuredClone(bob)], "not-json"),
			message("yourself"),
			state,
		);
		expect(found?.id).toBe(AGENT);
	});

	it("does not capture a compound referent containing me/you as a substring", async () => {
		const meEntity = entity("00000000-0000-0000-0000-0000000000be" as UUID, [
			"Me",
		]);
		const found = await findEntityByName(
			runtime([meEntity, structuredClone(bob)], "not-json"),
			message("Meagan"),
			state,
		);
		// "Meagan" is not an exact contextual reference and does not exactly
		// match the literal Me entity's name, so no shortcut fires and the
		// unparseable model result leaves the referent unresolved.
		expect(found).toBeNull();
	});
});

describe("relationship match evidence gate", () => {
	it("still requires positive interaction evidence for RELATIONSHIP_MATCH", async () => {
		const found = await findEntityByName(
			runtime([structuredClone(bob), structuredClone(alice)], {
				type: "RELATIONSHIP_MATCH",
				entityId: null,
				matches: [{ name: "Alice", reason: "contact" }],
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("resolves RELATIONSHIP_MATCH when interaction evidence is positive", async () => {
		const found = await findEntityByName(
			runtime(
				[structuredClone(bob), structuredClone(alice)],
				{
					type: "RELATIONSHIP_MATCH",
					entityId: null,
					matches: [{ name: "Alice", reason: "contact" }],
				},
				{},
				[
					{
						id: "00000000-0000-0000-0000-0000000000r1",
						sourceEntityId: BOB,
						targetEntityId: ALICE,
						agentId: AGENT,
						metadata: { interactions: 3 },
					},
				],
			),
			message("who should I ping"),
			state,
		);
		expect(found?.id).toBe(ALICE);
	});
});

describe("supplied evidence must be well-formed (RP r4 P1s)", () => {
	it.each(["", "   "])(
		"returns null when entityId is the blank string %j alongside a valid match",
		async (entityId) => {
			const found = await findEntityByName(
				runtime([structuredClone(bob), structuredClone(alice)], {
					type: "NAME_MATCH",
					entityId,
					matches: [{ name: "Alice" }],
				}),
				message("who should I ping"),
				state,
			);
			expect(found).toBeNull();
		},
	);

	it.each(["", "   "])(
		"returns null when resolvedId is the blank string %j alongside a valid match",
		async (resolvedId) => {
			const found = await findEntityByName(
				runtime([structuredClone(bob), structuredClone(alice)], {
					type: "NAME_MATCH",
					resolvedId,
					matches: [{ name: "Alice" }],
				}),
				message("who should I ping"),
				state,
			);
			expect(found).toBeNull();
		},
	);

	it("returns null for a whitespace match even when a candidate normalizes to the same label", async () => {
		const blankNamed = entity(OTHER, ["   "]);
		const found = await findEntityByName(
			runtime([structuredClone(bob), blankNamed], {
				type: "NAME_MATCH",
				entityId: null,
				matches: [{ name: "   " }],
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null when entityId is a number even though resolvedId names a valid entity", async () => {
		const found = await findEntityByName(
			runtime([structuredClone(bob), structuredClone(alice)], {
				type: "NAME_MATCH",
				entityId: 42,
				resolvedId: ALICE,
				matches: [],
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null when resolvedId is a number even though entityId names a valid entity", async () => {
		const found = await findEntityByName(
			runtime([structuredClone(bob), structuredClone(alice)], {
				type: "NAME_MATCH",
				entityId: ALICE,
				resolvedId: 42,
				matches: [],
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null when matches is null even though entityId names a valid entity", async () => {
		const found = await findEntityByName(
			runtime([structuredClone(bob), structuredClone(alice)], {
				type: "EXACT_MATCH",
				entityId: ALICE,
				matches: null,
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null when a wrapped matches entry is malformed", async () => {
		const found = await findEntityByName(
			runtime([structuredClone(bob), structuredClone(alice)], {
				type: "EXACT_MATCH",
				entityId: ALICE,
				matches: { match: 42 },
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null when a wrapped matches array contains malformed entries", async () => {
		const found = await findEntityByName(
			runtime([structuredClone(bob), structuredClone(alice)], {
				type: "EXACT_MATCH",
				entityId: ALICE,
				matches: { match: [{ name: "Alice" }, {}] },
			}),
			message("who should I ping"),
			// A dropped entry alongside a valid one must still invalidate:
			// the response supplied evidence that vanished at the parse
			// boundary (#24765).
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null when a direct matches array contains malformed entries", async () => {
		const found = await findEntityByName(
			runtime([structuredClone(bob), structuredClone(alice)], {
				type: "EXACT_MATCH",
				entityId: ALICE,
				matches: [{ name: "Alice" }, {}],
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});
});

describe("id-less room entity integrity rejection", () => {
	it("throws a typed ROOM_ENTITY_ID_MISSING error instead of silently skipping", async () => {
		const withId = entity(ALICE, ["Alice"]);
		const idless = entity(undefined as unknown as UUID, ["Ghost"]);
		const runtimeInstance = {
			agentId: AGENT,
			getRoom: async () => ({ id: ROOM }),
			getEntitiesForRoom: async () => [withId, idless],
		} as unknown as IAgentRuntime;
		await expect(
			getEntityDetails({ runtime: runtimeInstance, roomId: ROOM }),
		).rejects.toMatchObject({
			code: "ROOM_ENTITY_ID_MISSING",
		});
		const threw = await getEntityDetails({
			runtime: runtimeInstance,
			roomId: ROOM,
		}).catch((error: unknown) => error);
		expect(isElizaError(threw)).toBe(true);
	});
});
