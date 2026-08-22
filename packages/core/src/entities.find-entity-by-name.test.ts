/**
 * Behavioral tests for `findEntityByName` candidate confinement. Drives the
 * production resolver through its real runtime seams (`getEntitiesForRoom`,
 * `getRelationships`, `getEntityById`, `useModel`). Deterministic TEXT_SMALL
 * results — no live model.
 */
import { describe, expect, it } from "vitest";
import { findEntityByName } from "./entities";
import { createMockRuntime } from "./testing/mock-runtime";
import type {
	Component,
	Entity,
	IAgentRuntime,
	Memory,
	Relationship,
	State,
	UUID,
} from "./types";

const AGENT = "00000000-0000-0000-0000-0000000000aa" as UUID;
const SENDER = "00000000-0000-0000-0000-0000000000s1" as UUID;
const ALICE = "00000000-0000-0000-0000-0000000000a1" as UUID;
const BOB = "00000000-0000-0000-0000-0000000000b1" as UUID;
const STRANGER = "00000000-0000-0000-0000-0000000000ff" as UUID;
const ROOM = "00000000-0000-0000-0000-0000000000bb" as UUID;
const GUEST_SOURCE = "00000000-0000-0000-0000-0000000000g1" as UUID;

function entity(
	id: UUID,
	names: string[],
	components: Component[] = [],
): Entity {
	return {
		id,
		agentId: AGENT,
		names,
		components,
		metadata: {},
	};
}

function component(
	entityId: UUID,
	sourceEntityId: UUID,
	data: Record<string, string>,
): Component {
	return {
		id: `${entityId}-comp` as UUID,
		entityId,
		agentId: AGENT,
		roomId: ROOM,
		worldId: "00000000-0000-0000-0000-0000000000w1" as UUID,
		sourceEntityId,
		type: "discord",
		createdAt: 1,
		data,
	};
}

function message(): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000m1" as UUID,
		roomId: ROOM,
		entityId: SENDER,
		agentId: AGENT,
		content: { text: "tell them hi" },
		createdAt: 1,
	} as Memory;
}

function state(): State {
	return {
		values: {},
		data: { room: { id: ROOM, name: "room", worldId: null } },
		text: "",
	};
}

function runtimeWith(options: {
	roomEntities: Entity[];
	byId?: Record<string, Entity>;
	relationships?: Relationship[];
	modelResult: unknown;
}): IAgentRuntime {
	const byId = { ...(options.byId ?? {}) };
	for (const roomEntity of options.roomEntities) {
		if (roomEntity.id && byId[roomEntity.id] === undefined) {
			byId[roomEntity.id] = roomEntity;
		}
	}
	return createMockRuntime({
		agentId: AGENT,
		getEntitiesForRoom: (async () =>
			options.roomEntities) as IAgentRuntime["getEntitiesForRoom"],
		getEntityById: (async (id: UUID) =>
			byId[id] ?? null) as IAgentRuntime["getEntityById"],
		getRelationships: (async () =>
			options.relationships ?? []) as IAgentRuntime["getRelationships"],
		getMemories: (async () => []) as IAgentRuntime["getMemories"],
		useModel: (async () => options.modelResult) as IAgentRuntime["useModel"],
	});
}

describe("findEntityByName candidate confinement", () => {
	it("does not return an EXACT_MATCH entity outside the room and relationship set", async () => {
		const stranger = entity(STRANGER, ["Stranger"]);
		const resolved = await findEntityByName(
			runtimeWith({
				roomEntities: [entity(ALICE, ["Alice"]), entity(BOB, ["Bob"])],
				byId: { [STRANGER]: stranger },
				modelResult: {
					type: "EXACT_MATCH",
					entityId: STRANGER,
					matches: [],
				},
			}),
			message(),
			state(),
		);

		expect(resolved?.id).not.toBe(STRANGER);
		expect(resolved).toBeNull();
	});

	it("still returns an EXACT_MATCH that is a room participant", async () => {
		const alice = entity(ALICE, ["Alice"]);
		const resolved = await findEntityByName(
			runtimeWith({
				roomEntities: [alice, entity(BOB, ["Bob"])],
				modelResult: {
					type: "EXACT_MATCH",
					entityId: ALICE,
					matches: [{ name: "Alice", reason: "id in room list" }],
				},
			}),
			message(),
			state(),
		);

		expect(resolved?.id).toBe(ALICE);
	});

	it("still returns an EXACT_MATCH that is relationship-backed but not in the room", async () => {
		const friend = entity(STRANGER, ["Friend"]);
		const resolved = await findEntityByName(
			runtimeWith({
				roomEntities: [entity(ALICE, ["Alice"]), entity(BOB, ["Bob"])],
				byId: { [STRANGER]: friend },
				relationships: [
					{
						id: "00000000-0000-0000-0000-0000000000r1" as UUID,
						sourceEntityId: SENDER,
						targetEntityId: STRANGER,
						agentId: AGENT,
						tags: ["knows"],
						createdAt: 1,
					} as Relationship,
				],
				modelResult: {
					type: "EXACT_MATCH",
					entityId: STRANGER,
					matches: [],
				},
			}),
			message(),
			state(),
		);

		expect(resolved?.id).toBe(STRANGER);
	});

	it("does not treat a guest handle on a relationship copy as a match after room trust filtering", async () => {
		const leaked = component(ALICE, GUEST_SOURCE, { handle: "secret-handle" });
		const roomAlice = entity(ALICE, ["Alice"], [leaked]);
		const relationshipAlice = entity(ALICE, ["Alice"], [leaked]);
		const resolved = await findEntityByName(
			runtimeWith({
				roomEntities: [roomAlice, entity(BOB, ["Bob"])],
				byId: { [ALICE]: relationshipAlice },
				relationships: [
					{
						id: "00000000-0000-0000-0000-0000000000r2" as UUID,
						sourceEntityId: SENDER,
						targetEntityId: ALICE,
						agentId: AGENT,
						tags: ["knows"],
						createdAt: 1,
					} as Relationship,
				],
				modelResult: {
					type: "NAME_MATCH",
					entityId: null,
					matches: [{ name: "secret-handle", reason: "handle in message" }],
				},
			}),
			message(),
			state(),
		);

		expect(resolved).toBeNull();
	});

	it("does not resolve type UNKNOWN to a room member whose handle is a substring of the model JSON", async () => {
		const casey = entity(
			ALICE,
			["Casey"],
			[component(ALICE, AGENT, { username: "unknown" })],
		);
		const resolved = await findEntityByName(
			runtimeWith({
				roomEntities: [casey, entity(BOB, ["Drew"])],
				modelResult: { type: "UNKNOWN", entityId: null, matches: [] },
			}),
			message(),
			state(),
		);

		expect(resolved).toBeNull();
	});

	it("still matches an honest username on a trusted (agent-authored) component", async () => {
		const alice = entity(
			ALICE,
			["Alice"],
			[component(ALICE, AGENT, { username: "alice" })],
		);
		const resolved = await findEntityByName(
			runtimeWith({
				roomEntities: [alice, entity(BOB, ["Bob"])],
				modelResult: {
					type: "USERNAME_MATCH",
					entityId: null,
					matches: [{ name: "@alice", reason: "mentioned handle" }],
				},
			}),
			message(),
			state(),
		);

		expect(resolved?.id).toBe(ALICE);
	});

	it("still returns the sole room candidate when model JSON is unparseable", async () => {
		const alice = entity(ALICE, ["Alice"]);
		const resolved = await findEntityByName(
			runtimeWith({
				roomEntities: [alice],
				modelResult: "not-json",
			}),
			message(),
			state(),
		);

		expect(resolved?.id).toBe(ALICE);
	});

	it("does not mutate components on the adapter-returned room entity", async () => {
		const leaked = component(ALICE, GUEST_SOURCE, { handle: "secret-handle" });
		const roomAlice = entity(ALICE, ["Alice"], [leaked]);
		await findEntityByName(
			runtimeWith({
				roomEntities: [roomAlice, entity(BOB, ["Bob"])],
				modelResult: {
					type: "NAME_MATCH",
					entityId: null,
					matches: [{ name: "Alice", reason: "name in room" }],
				},
			}),
			message(),
			state(),
		);

		expect(roomAlice.components).toEqual([leaked]);
	});

	it("still resolves an exact handle that appears only in the match reason", async () => {
		const alice = entity(
			ALICE,
			["Alice"],
			[component(ALICE, AGENT, { handle: "alice" })],
		);
		const resolved = await findEntityByName(
			runtimeWith({
				roomEntities: [alice, entity(BOB, ["Bob"])],
				modelResult: {
					type: "USERNAME_MATCH",
					entityId: null,
					matches: [{ name: "the user", reason: "alice" }],
				},
			}),
			message(),
			state(),
		);

		expect(resolved?.id).toBe(ALICE);
	});

	it("returns byte-identical ids for a corpus of previously valid room EXACT_MATCH values", async () => {
		const roomEntities = Array.from({ length: 24 }, (_, index) =>
			entity(
				`00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}` as UUID,
				[`Person-${index + 1}`],
			),
		);
		const ids: Array<string | null> = [];
		for (const candidate of roomEntities) {
			const resolved = await findEntityByName(
				runtimeWith({
					roomEntities,
					modelResult: {
						type: "EXACT_MATCH",
						entityId: candidate.id,
						matches: [{ name: candidate.names[0], reason: "room member" }],
					},
				}),
				message(),
				state(),
			);
			ids.push(resolved?.id ?? null);
		}

		expect(ids).toEqual(roomEntities.map((candidate) => candidate.id));
	});
});
