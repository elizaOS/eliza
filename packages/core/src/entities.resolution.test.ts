/**
 * Deterministic tests for `findEntityByName` on the real module: the resolution
 * prompt must carry the referent, EXACT_MATCH must stay inside the candidate
 * set, substring fallback must not bind a shorter handle, and a target's own
 * identity components must remain visible. Runtime collaborators are stubbed
 * at documented seams; findEntityByName is not replaced.
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
const STRANGER = "00000000-0000-0000-0000-0000000000ee" as UUID;
const ROOM = "00000000-0000-0000-0000-0000000000c0" as UUID;

function component(
	entityId: UUID,
	sourceEntityId: UUID,
	data: Record<string, unknown>,
	id = "00000000-0000-0000-0000-0000000000d1",
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
		data,
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
	[component(BOB, BOB, { username: "bob", handle: "ali" }, "d1")],
);
const alice = entity(
	ALICE,
	["Alice Smith"],
	[
		component(
			ALICE,
			ALICE,
			{ username: "alice", handle: "alice", channelId: "dm-alice" },
			"d2",
		),
	],
);
const stranger = entity(STRANGER, ["Eve"]);

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

function runtime(
	overrides: Partial<IAgentRuntime> & { prompts?: string[] } = {},
): IAgentRuntime {
	const prompts = overrides.prompts ?? [];
	const byId = new Map<UUID, Entity>([
		[BOB, structuredClone(bob)],
		[ALICE, structuredClone(alice)],
		[STRANGER, structuredClone(stranger)],
	]);
	return {
		agentId: AGENT,
		character: { name: "Eliza" },
		getRoom: async () => ({ id: ROOM, name: "DM", worldId: null }),
		getWorld: async () => null,
		getEntitiesForRoom: async () => [structuredClone(bob)],
		getRelationships: async () =>
			[
				{
					id: "00000000-0000-0000-0000-0000000000r1",
					sourceEntityId: BOB,
					targetEntityId: ALICE,
					agentId: AGENT,
					tags: ["knows"],
				},
			] as Relationship[],
		getEntityById: async (id: UUID) => {
			const found = byId.get(id);
			return found ? structuredClone(found) : null;
		},
		getMemories: async () => [],
		useModel: async (_type: unknown, params: { prompt?: string }) => {
			if (typeof params?.prompt === "string") prompts.push(params.prompt);
			return "not-json";
		},
		...overrides,
	} as unknown as IAgentRuntime;
}

describe("findEntityByName referent and candidate containment", () => {
	it("puts the message text, sender name, and agent id in the resolution prompt", async () => {
		const prompts: string[] = [];
		await findEntityByName(
			runtime({ prompts, getRelationships: async () => [] }),
			message("tell Alice Smith to call me"),
			state,
		);
		const prompt = prompts[0] ?? "";
		expect(prompt).toContain("tell Alice Smith to call me");
		expect(prompt).toContain("00000000-0000-0000-0000-0000000000aa");
		expect(prompt).toContain("Eliza");
	});

	it("does not return the sole room entity when the referent names a relationship contact", async () => {
		const found = await findEntityByName(runtime({}), message("Alice"), state);
		expect(found?.id).not.toBe(BOB);
	});

	it("returns the uniquely named relationship contact for an exact referent without a model", async () => {
		const prompts: string[] = [];
		const found = await findEntityByName(
			runtime({ prompts }),
			message("Alice Smith"),
			state,
		);
		expect(found?.id).toBe(ALICE);
		expect(prompts).toHaveLength(0);
	});

	it("does not resolve EXACT_MATCH to an entity outside the room and relationship set", async () => {
		const found = await findEntityByName(
			runtime({
				getRelationships: async () => [],
				useModel: async () => ({
					type: "EXACT_MATCH",
					entityId: STRANGER,
					matches: [],
				}),
			}),
			message("who is that"),
			state,
		);
		expect(found?.id).not.toBe(STRANGER);
		expect(found).toBeNull();
	});

	it("does not bind a shorter handle that is a substring of the model's match name", async () => {
		const found = await findEntityByName(
			runtime({
				getEntitiesForRoom: async () => [
					structuredClone(bob),
					structuredClone(alice),
				],
				getRelationships: async () => [],
				useModel: async () => ({
					type: "NAME_MATCH",
					entityId: null,
					matches: [{ name: "Alice", reason: "the user named Alice" }],
				}),
			}),
			message("who should I ping"),
			state,
		);
		expect(found?.id).not.toBe(BOB);
		expect(found?.id).toBe(ALICE);
	});

	it("keeps the target's own identity components when the sender is someone else", async () => {
		const aliceInRoom = structuredClone(alice);
		const found = await findEntityByName(
			runtime({
				getEntitiesForRoom: async () => [aliceInRoom],
				getRelationships: async () => [],
			}),
			message("Alice Smith"),
			state,
		);
		expect(found?.id).toBe(ALICE);
		expect(found?.components).toHaveLength(1);
		expect(found?.components?.[0]?.data).toMatchObject({
			channelId: "dm-alice",
		});
		expect(aliceInRoom.components).toHaveLength(1);
	});

	it("still returns the uniquely named room entity when the model output is unparseable", async () => {
		const shadow = entity(ALICE, ["Shadow"]);
		const found = await findEntityByName(
			runtime({
				getEntitiesForRoom: async () => [shadow],
				getRelationships: async () => [],
				useModel: async () => "not-json",
			}),
			message("shadow"),
			state,
		);
		expect(found?.id).toBe(ALICE);
		expect(found?.names).toEqual(["Shadow"]);
	});

	it("still honors EXACT_MATCH for a candidate already in the room", async () => {
		const found = await findEntityByName(
			runtime({
				getEntitiesForRoom: async () => [
					structuredClone(bob),
					structuredClone(alice),
				],
				getRelationships: async () => [],
				useModel: async () => ({
					type: "EXACT_MATCH",
					entityId: ALICE,
					matches: [],
				}),
			}),
			message("who is that"),
			state,
		);
		expect(found?.id).toBe(ALICE);
	});
});
