/**
 * Contract tests for the resolution + persistence half of the addressed-to
 * pipeline (#29162): resolveAddressedTargets (Stage-1 tag → room-entity IDs)
 * and applyAddressedTo (speaker → target "addressed" relationship upsert).
 * The gate functions' invariants are owned by addressed-to.test.ts; this
 * suite owns the untested half. Deterministic harness — a recording
 * in-memory runtime stub with a room-lookup counter, no model or database.
 */
import { describe, expect, it } from "vitest";
import type { Entity, Relationship, UUID } from "../../types";
import type { Memory } from "../../types/memory";
import type { IAgentRuntime } from "../../types/runtime";
import { applyAddressedTo, resolveAddressedTargets } from "../addressed-to";

const AGENT_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const SPEAKER_ID = "00000000-0000-4000-8000-000000000002" as UUID;
const OTHER_ID = "00000000-0000-4000-8000-000000000003" as UUID;
const BYSTANDER_ID = "00000000-0000-4000-8000-000000000004" as UUID;
const AT_ELIZA_ID = "00000000-0000-4000-8000-000000000006" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-000000000005" as UUID;
const MESSAGE_ID = "00000000-0000-4000-8000-00000000000f" as UUID;

const AGENT_NAME = "Eliza";
/** Platform handle stored on the agent's entity, as connectors persist it. */
const AGENT_HANDLE = "eliza_bot";

function makeEntity(id: UUID, names: string[]): Entity {
	return { id, names } as Entity;
}

function makeMessage(text = "hi"): Memory {
	return {
		id: MESSAGE_ID,
		entityId: SPEAKER_ID,
		roomId: ROOM_ID,
		content: { text },
	} as Memory;
}

interface Harness {
	runtime: IAgentRuntime;
	relationships: Relationship[];
	roomLookups: number;
	writeCalls: number;
}

/**
 * Recording runtime stub: relationship storage is a plain array so assertions
 * inspect exactly what applyAddressedTo wrote (tags, metadata) rather than a
 * mock's echo, and room lookups are counted so the UUID fast-path can be
 * pinned. getRelationships honors the tags filter like the real store.
 */
function makeHarness(participants: Entity[]): Harness {
	const relationships: Relationship[] = [];
	const entities = [...participants];
	if (!entities.some((e) => e.id === AGENT_ID)) {
		// The agent's entity carries its platform handle, not the character
		// name — "eliza" then resolves only through the resolver's dedicated
		// character-name mapping, which is the path the suite is meant to pin.
		entities.push(makeEntity(AGENT_ID, [AGENT_HANDLE]));
	}
	const harness: Harness = {
		relationships,
		roomLookups: 0,
		writeCalls: 0,
		runtime: undefined as unknown as IAgentRuntime,
	};
	harness.runtime = {
		agentId: AGENT_ID,
		character: { name: AGENT_NAME, username: "eliza_bot" },
		getEntitiesForRoom: async (_roomId: UUID) => {
			harness.roomLookups += 1;
			return entities;
		},
		getRelationships: async (query: { entityIds?: UUID[]; tags?: string[] }) =>
			relationships.filter(
				(rel) =>
					(!query.entityIds || query.entityIds.includes(rel.sourceEntityId)) &&
					(!query.tags ||
						query.tags.some((tag) => (rel.tags ?? []).includes(tag))),
			),
		createRelationship: async (input: {
			sourceEntityId: UUID;
			targetEntityId: UUID;
			tags?: string[];
			metadata?: Record<string, unknown>;
		}) => {
			harness.writeCalls += 1;
			relationships.push({
				id: `rel-${relationships.length + 1}` as UUID,
				...input,
			} as unknown as Relationship);
			return relationships[relationships.length - 1];
		},
		updateRelationship: async (rel: Relationship) => {
			harness.writeCalls += 1;
			const index = relationships.findIndex((r) => r.id === rel.id);
			if (index === -1) throw new Error("relationship not found");
			relationships[index] = rel;
		},
	} as unknown as IAgentRuntime;
	return harness;
}

function defaultRoom(): Entity[] {
	return [
		// A participant stored under "@Eliza" with its own id: today the
		// leading-@ store spelling is a distinct key from "eliza", so it
		// must NOT capture the character-name lookup. If the resolver's
		// normalize ever strips a leading @ from STORED names (the #29168
		// direction), that participant's entry overwrites the dedicated
		// character-name mapping — written earlier — and the
		// character-name test below goes red.
		makeEntity(AT_ELIZA_ID, ["@Eliza"]),
		makeEntity(SPEAKER_ID, ["nubilio"]),
		makeEntity(OTHER_ID, ["sol"]),
		makeEntity(BYSTANDER_ID, ["shaw"]),
	];
}

describe("resolveAddressedTargets", () => {
	it("passes well-formed UUIDs through, deduplicated, with zero room lookups", async () => {
		const harness = makeHarness([]);
		const targets = await resolveAddressedTargets({
			runtime: harness.runtime,
			message: makeMessage(),
			addressedTo: [OTHER_ID, OTHER_ID, "  "],
		});
		expect(targets).toEqual([OTHER_ID]);
		expect(harness.roomLookups).toBe(0);
	});

	it("resolves participant names case-insensitively and strips @ handles", async () => {
		const { runtime } = makeHarness(defaultRoom());
		const targets = await resolveAddressedTargets({
			runtime,
			message: makeMessage(),
			addressedTo: ["@Sol", "NUBILIO"],
		});
		expect(targets.sort()).toEqual([OTHER_ID, SPEAKER_ID].sort());
	});

	it("mixes direct UUIDs with resolved names in one pass", async () => {
		const { runtime } = makeHarness(defaultRoom());
		const targets = await resolveAddressedTargets({
			runtime,
			message: makeMessage(),
			addressedTo: [BYSTANDER_ID, "sol"],
		});
		expect(targets.sort()).toEqual([OTHER_ID, BYSTANDER_ID].sort());
	});

	it("maps the agent's own character name to agentId", async () => {
		const { runtime } = makeHarness(defaultRoom());
		const targets = await resolveAddressedTargets({
			runtime,
			message: makeMessage(),
			addressedTo: ["eliza"],
		});
		expect(targets).toEqual([AGENT_ID]);
	});

	it("drops names that resolve to no room participant", async () => {
		const { runtime } = makeHarness(defaultRoom());
		const targets = await resolveAddressedTargets({
			runtime,
			message: makeMessage(),
			addressedTo: ["ghost", "sol"],
		});
		expect(targets).toEqual([OTHER_ID]);
	});
});

describe("applyAddressedTo (relationship upsert)", () => {
	it("creates an addressed edge per resolved target and reports counts", async () => {
		const { runtime, relationships } = makeHarness(defaultRoom());
		const result = await applyAddressedTo({
			runtime,
			message: makeMessage("sol and shaw take a look"),
			addressedTo: ["sol", "shaw"],
		});
		expect(result.created).toBe(2);
		expect(result.updated).toBe(0);
		expect(result.resolved.sort()).toEqual([OTHER_ID, BYSTANDER_ID].sort());
		expect(relationships).toHaveLength(2);
		for (const rel of relationships) {
			expect(rel.sourceEntityId).toBe(SPEAKER_ID);
			expect(rel.tags).toContain("addressed");
			const metadata = rel.metadata as Record<string, unknown>;
			expect(metadata.lastInteractionAt).toBeTypeOf("string");
			expect(metadata.source).toBe("message_handler_addressedTo");
		}
	});

	it("updates the existing edge: dedupes tags, preserves prior metadata, refreshes the interaction stamp", async () => {
		const { runtime, relationships } = makeHarness(defaultRoom());
		// Seed a pre-existing addressed edge carrying legacy metadata and only
		// the base tag, exactly as an older writer would have left it.
		relationships.push({
			id: "rel-seed" as UUID,
			sourceEntityId: SPEAKER_ID,
			targetEntityId: OTHER_ID,
			tags: ["addressed"],
			metadata: {
				lastInteractionAt: "2020-01-01T00:00:00.000Z",
				source: "legacy_writer",
				roomContext: "keep-me",
			},
		} as unknown as Relationship);

		const result = await applyAddressedTo({
			runtime,
			message: makeMessage("sol look again"),
			addressedTo: ["sol"],
		});
		expect(result).toMatchObject({ created: 0, updated: 1 });
		expect(relationships).toHaveLength(1);
		const updated = relationships[0];
		expect(updated.id).toBe("rel-seed");
		// both addressed tags present, no duplicates
		expect(updated.tags).toEqual(["addressed", "addressed:auto"]);
		const metadata = updated.metadata as Record<string, unknown>;
		expect(metadata.roomContext).toBe("keep-me"); // prior keys preserved
		expect(metadata.source).toBe("message_handler_addressedTo"); // replaced
		expect(metadata.lastInteractionAt).not.toBe("2020-01-01T00:00:00.000Z");
	});

	it("skips the speaker as a target but still records an addressed-to-agent edge", async () => {
		const { runtime, relationships } = makeHarness(defaultRoom());
		const result = await applyAddressedTo({
			runtime,
			message: makeMessage("nubilio here"),
			addressedTo: ["nubilio", AGENT_NAME],
		});
		// The speaker tag is an extraction error, never an address target; the
		// agent itself is a legitimate participant of the addressed set.
		expect(result.resolved).toEqual([AGENT_ID]);
		expect(result.created).toBe(1);
		expect(relationships).toHaveLength(1);
		expect(relationships[0].sourceEntityId).toBe(SPEAKER_ID);
		expect(relationships[0].targetEntityId).toBe(AGENT_ID);
	});

	it("returns an explicit empty result when the message carries no entityId", async () => {
		const harness = makeHarness(defaultRoom());
		const { runtime, relationships } = harness;
		const result = await applyAddressedTo({
			runtime,
			// entityId is required on the Memory type, but the pipeline consumes
			// unvalidated message records — the guard exists for exactly this
			// shape, so the double cast mirrors the harness stub pattern above.
			message: { ...makeMessage(), entityId: undefined } as unknown as Memory,
			addressedTo: ["sol"],
		});
		expect(result).toEqual({ created: 0, updated: 0, resolved: [] });
		expect(relationships).toHaveLength(0);
		// The guard must fire BEFORE resolution: an authorless message never
		// reaches the room roster and never issues a relationship write.
		expect(harness.roomLookups).toBe(0);
		expect(harness.writeCalls).toBe(0);
	});

	it("writes nothing when nothing resolves (unresolvable names only)", async () => {
		const harness = makeHarness(defaultRoom());
		const { runtime, relationships } = harness;
		const result = await applyAddressedTo({
			runtime,
			message: makeMessage(),
			addressedTo: ["ghost"],
		});
		expect(result).toEqual({ created: 0, updated: 0, resolved: [] });
		expect(relationships).toHaveLength(0);
		// A no-op must never touch a write method: an implementation that
		// writes and rolls back is distinguishable from one that never writes.
		expect(harness.writeCalls).toBe(0);
	});

	it("returns an explicit empty result for empty addressedTo", async () => {
		const harness = makeHarness(defaultRoom());
		const { runtime, relationships } = harness;
		const result = await applyAddressedTo({
			runtime,
			message: makeMessage(),
			addressedTo: [],
		});
		expect(result).toEqual({ created: 0, updated: 0, resolved: [] });
		expect(relationships).toHaveLength(0);
		expect(harness.writeCalls).toBe(0);
	});
});
