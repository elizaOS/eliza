/**
 * Byte-identical preservation corpus for issue #24765: valid resolution
 * response shapes must return the exact same entity objects (serialized)
 * after the evidence-consistency change as the documented pre-change
 * semantics produced. Every case here resolved on origin/develop and must
 * keep resolving to the identical serialized entity. Harness: deterministic
 * stubs at runtime adapter seams; findEntityByName is the real module.
 */
import { describe, expect, it } from "vitest";
import { findEntityByName } from "./entities";
import type {
	Entity,
	IAgentRuntime,
	Memory,
	Relationship,
	State,
	UUID,
} from "./types";

const AGENT = "00000000-0000-0000-0000-0000000000aa" as UUID;
const BOB = "00000000-0000-0000-0000-0000000000b0" as UUID;
const ALICE = "00000000-0000-0000-0000-0000000000a1" as UUID;
const ROOM = "00000000-0000-0000-0000-0000000000c0" as UUID;

function component(
	id: string,
	username: string,
): NonNullable<Entity["components"]>[number] {
	return {
		id: id as UUID,
		entityId: ALICE,
		agentId: AGENT,
		roomId: ROOM,
		worldId: ROOM,
		sourceEntityId: ALICE,
		type: "discord",
		createdAt: 1,
		data: { username, handle: username, channelId: `dm-${username}` },
	};
}

const alice = {
	id: ALICE,
	agentId: AGENT,
	names: ["Alice", "Alice Smith"],
	metadata: { origin: "test-corpus" },
	components: [component("d2", "alice")],
} as Entity;
const bob = {
	id: BOB,
	agentId: AGENT,
	names: ["Bob"],
	components: [],
} as Entity;

function message(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000m1" as UUID,
		entityId: BOB,
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

function runtime(
	modelResult: unknown,
	relationships: Relationship[] = [],
): IAgentRuntime {
	return {
		agentId: AGENT,
		character: { name: "Eliza" },
		getRoom: async () => ({ id: ROOM, name: "DM", worldId: null }),
		getWorld: async () => null,
		getEntitiesForRoom: async () => [
			structuredClone(alice),
			structuredClone(bob),
		],
		getRelationships: async () => relationships,
		getEntityById: async () => null,
		getMemories: async () => [],
		useModel: async () => modelResult,
	} as unknown as IAgentRuntime;
}

/** Cases that resolved on develop and must keep resolving byte-identically. */
const CORPUS = [
	{
		what: "EXACT_MATCH with consistent in-scope id, empty matches",
		model: { type: "EXACT_MATCH", entityId: ALICE, matches: [] },
		expectId: ALICE,
	},
	{
		what: "EXACT_MATCH id plus a matching label",
		model: {
			type: "EXACT_MATCH",
			entityId: ALICE,
			matches: [{ name: "Alice", reason: "exact" }],
		},
		expectId: ALICE,
	},
	{
		what: "NAME_MATCH unique label, no id",
		model: {
			type: "NAME_MATCH",
			entityId: null,
			matches: [{ name: "Alice", reason: "named" }],
		},
		expectId: ALICE,
	},
	{
		what: "NAME_MATCH consistent id and unique label",
		model: {
			type: "NAME_MATCH",
			entityId: ALICE,
			matches: [{ name: "Alice", reason: "named" }],
		},
		expectId: ALICE,
	},
	{
		what: "USERNAME_MATCH via username component",
		model: {
			type: "USERNAME_MATCH",
			entityId: null,
			matches: [{ name: "alice", reason: "username" }],
		},
		expectId: ALICE,
	},
	{
		what: "multiple aliases all naming the same entity",
		model: {
			type: "NAME_MATCH",
			entityId: null,
			matches: [
				{ name: "Alice", reason: "primary" },
				{ name: "Alice Smith", reason: "full name" },
			],
		},
		expectId: ALICE,
	},
	{
		what: "RELATIONSHIP_MATCH with positive interaction evidence",
		model: {
			type: "RELATIONSHIP_MATCH",
			entityId: null,
			matches: [{ name: "Alice", reason: "contact" }],
		},
		expectId: ALICE,
		relationships: [
			{
				id: "00000000-0000-0000-0000-0000000000r1",
				sourceEntityId: BOB,
				targetEntityId: ALICE,
				agentId: AGENT,
				metadata: { interactions: 2 },
			} as Relationship,
		],
	},
	{
		what: "@-prefixed label",
		model: {
			type: "NAME_MATCH",
			entityId: null,
			matches: [{ name: "@alice", reason: "handle" }],
		},
		expectId: ALICE,
	},
	{
		what: "JSON string response with consistent evidence",
		model: JSON.stringify({
			type: "NAME_MATCH",
			entityId: ALICE,
			matches: [{ name: "Alice", reason: "named" }],
		}),
		expectId: ALICE,
	},
];

describe("preservation corpus: previously-valid outputs stay byte-identical", () => {
	for (const entry of CORPUS) {
		it(`resolves ${entry.what}`, async () => {
			const found = await findEntityByName(
				runtime(entry.model, entry.relationships ?? []),
				message("who should I ping"),
				state,
			);
			expect(found).not.toBeNull();
			expect(found?.id).toBe(entry.expectId);
			// Byte-identity: the full serialized entity (names, components,
			// metadata) is the in-scope candidate, unchanged by resolution.
			const expected = [alice, bob].find((e) => e.id === entry.expectId);
			expect(JSON.stringify(found)).toBe(JSON.stringify(expected));
		});
	}

	it("keeps the no-model unique referent shortcut byte-identical", async () => {
		const found = await findEntityByName(
			runtime("not-json"),
			message("Alice Smith"),
			state,
		);
		expect(JSON.stringify(found)).toBe(JSON.stringify(alice));
	});
});

describe("adversarial: supplied-but-invalid evidence invalidates the response", () => {
	it("returns null when the id is out of scope and a unique label is supplied", async () => {
		const found = await findEntityByName(
			runtime({
				type: "NAME_MATCH",
				entityId: "00000000-0000-0000-0000-0000000000ff" as UUID,
				matches: [{ name: "Alice", reason: "named" }],
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null for a valid id plus a hallucinated label", async () => {
		const found = await findEntityByName(
			runtime({
				type: "NAME_MATCH",
				entityId: ALICE,
				matches: [{ name: "Nobody", reason: "hallucinated" }],
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null for a valid id plus an ambiguous (duplicate-name) label", async () => {
		const alex1 = {
			id: "00000000-0000-0000-0000-0000000000e1" as UUID,
			agentId: AGENT,
			names: ["Alex"],
			components: [],
		} as Entity;
		const alex2 = {
			id: "00000000-0000-0000-0000-0000000000e2" as UUID,
			agentId: AGENT,
			names: ["Alex"],
			components: [],
		} as Entity;
		const rt = runtime({
			type: "NAME_MATCH",
			entityId: ALICE,
			matches: [{ name: "Alex", reason: "dup" }],
		});
		rt.getEntitiesForRoom = async () => [
			structuredClone(alice),
			structuredClone(bob),
			alex1,
			alex2,
		];
		const found = await findEntityByName(
			rt,
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null for EXACT_MATCH with a contradictory label", async () => {
		const found = await findEntityByName(
			runtime({
				type: "EXACT_MATCH",
				entityId: ALICE,
				matches: [{ name: "Bob", reason: "contradictory" }],
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null for EXACT_MATCH with an out-of-scope id", async () => {
		const found = await findEntityByName(
			runtime({
				type: "EXACT_MATCH",
				entityId: "00000000-0000-0000-0000-0000000000ff" as UUID,
				matches: [],
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null for ID-only RELATIONSHIP_MATCH with zero interactions", async () => {
		const found = await findEntityByName(
			runtime({ type: "RELATIONSHIP_MATCH", entityId: ALICE, matches: [] }, [
				{
					id: "00000000-0000-0000-0000-0000000000r1",
					sourceEntityId: BOB,
					targetEntityId: ALICE,
					agentId: AGENT,
					metadata: { interactions: 0 },
				} as Relationship,
			]),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("resolves ID-only RELATIONSHIP_MATCH with positive interactions", async () => {
		const found = await findEntityByName(
			runtime({ type: "RELATIONSHIP_MATCH", entityId: ALICE, matches: [] }, [
				{
					id: "00000000-0000-0000-0000-0000000000r1",
					sourceEntityId: BOB,
					targetEntityId: ALICE,
					agentId: AGENT,
					metadata: { interactions: 5 },
				} as Relationship,
			]),
			message("who should I ping"),
			state,
		);
		expect(found?.id).toBe(ALICE);
	});
});

describe("adversarial: parse-boundary malformed evidence", () => {
	it("returns null when the type is missing even with a valid id", async () => {
		const found = await findEntityByName(
			runtime({ entityId: ALICE, matches: [] }),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null when the type is not a supported decisive value", async () => {
		const found = await findEntityByName(
			runtime({ type: "NOT_A_REAL_TYPE", entityId: ALICE, matches: [] }),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null for a non-string entityId even with a unique valid label", async () => {
		const found = await findEntityByName(
			runtime({
				type: "NAME_MATCH",
				entityId: 42,
				matches: [{ name: "Alice", reason: "named" }],
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null for conflicting entityId and resolvedId strings", async () => {
		const found = await findEntityByName(
			runtime({
				type: "NAME_MATCH",
				entityId: ALICE,
				resolvedId: BOB,
				matches: [{ name: "Alice", reason: "named" }],
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null when a supplied match entry has no usable name", async () => {
		const found = await findEntityByName(
			runtime({
				type: "EXACT_MATCH",
				entityId: ALICE,
				matches: [{}],
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null when matches is supplied as an empty object", async () => {
		const found = await findEntityByName(
			runtime({
				type: "EXACT_MATCH",
				entityId: ALICE,
				matches: {},
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null when matches is supplied as a number", async () => {
		const found = await findEntityByName(
			runtime({
				type: "EXACT_MATCH",
				entityId: ALICE,
				matches: 42,
			}),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("returns null for malformed-only evidence with no type or id", async () => {
		const found = await findEntityByName(
			runtime({ matches: 42 }),
			message("who should I ping"),
			state,
		);
		expect(found).toBeNull();
	});

	it("still unwraps the documented { match: … } wrapper shape", async () => {
		const found = await findEntityByName(
			runtime({
				type: "NAME_MATCH",
				entityId: null,
				matches: { match: [{ name: "Alice", reason: "wrapped" }] },
			}),
			message("who should I ping"),
			state,
		);
		expect(found?.id).toBe(ALICE);
	});

	it("still treats JSON null entityId as absent (contract encoding)", async () => {
		const found = await findEntityByName(
			runtime({
				type: "NAME_MATCH",
				entityId: null,
				matches: [{ name: "Alice", reason: "named" }],
			}),
			message("who should I ping"),
			state,
		);
		expect(found?.id).toBe(ALICE);
	});
});

describe("adversarial: contextual binding containment", () => {
	function contextualRuntime(
		entities: Entity[],
		modelResult: unknown,
	): IAgentRuntime {
		return {
			agentId: AGENT,
			character: { name: "Eliza" },
			getRoom: async () => ({ id: ROOM, name: "DM", worldId: null }),
			getWorld: async () => null,
			getEntitiesForRoom: async () => entities,
			getRelationships: async () => [],
			getEntityById: async () => null,
			getMemories: async () => [],
			useModel: async () => modelResult,
		} as unknown as IAgentRuntime;
	}

	it("returns null for 'me' when the sender is absent and a literal Me entity is present", async () => {
		const meEntity = {
			id: "00000000-0000-0000-0000-0000000000be" as UUID,
			agentId: AGENT,
			names: ["Me"],
			components: [],
		} as Entity;
		let modelCalls = 0;
		const rt = contextualRuntime([meEntity], "not-json");
		rt.useModel = async () => {
			modelCalls += 1;
			return "not-json";
		};
		const found = await findEntityByName(rt, message("me"), state);
		expect(found).toBeNull();
		// The contextual miss is decided before the model call: no wasted
		// TEXT_SMALL round-trip, and no re-entry into the ordinary path.
		expect(modelCalls).toBe(0);
	});

	it("returns null for 'you' when the agent entity is absent and a literal You entity is present", async () => {
		const youEntity = {
			id: "00000000-0000-0000-0000-0000000000b9" as UUID,
			agentId: AGENT,
			names: ["You"],
			components: [],
		} as Entity;
		const found = await findEntityByName(
			contextualRuntime([youEntity, bob], "not-json"),
			message("you"),
			state,
		);
		expect(found).toBeNull();
	});

	it("resolves @me to the sender (stripAtPrefix normalization)", async () => {
		const found = await findEntityByName(
			contextualRuntime([bob, alice], "not-json"),
			message("@me"),
			state,
		);
		expect(found?.id).toBe(BOB);
	});

	it("does not treat '@you-something' as contextual", async () => {
		const youEntity = {
			id: "00000000-0000-0000-0000-0000000000b9" as UUID,
			agentId: AGENT,
			names: ["You"],
			components: [],
		} as Entity;
		const found = await findEntityByName(
			contextualRuntime([youEntity, bob], "not-json"),
			message("@you-something"),
			state,
		);
		expect(found).toBeNull();
	});

	it("binds 'ME' case-insensitively to the sender", async () => {
		const found = await findEntityByName(
			contextualRuntime([bob, alice], "not-json"),
			message("ME"),
			state,
		);
		expect(found?.id).toBe(BOB);
	});

	it("does not bind 'tell me about Alice' (sentence, not exact token)", async () => {
		const found = await findEntityByName(
			contextualRuntime([bob, alice], "not-json"),
			message("tell me about Alice"),
			state,
		);
		// Full sentence is not an exact contextual token; it proceeds to the
		// ordinary path where the unparseable model result leaves it null.
		expect(found).toBeNull();
	});
});
