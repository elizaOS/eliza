/**
 * Unit tests for the advanced RELATIONSHIPS provider using a deterministic
 * runtime boundary while exercising the real clustering, ordering, counterpart
 * resolution, batching, and rendering implementation.
 */
import { describe, expect, it, vi } from "vitest";
import type {
	Entity,
	IAgentRuntime,
	Memory,
	Relationship,
	UUID,
} from "../../../types/index.ts";
import { relationshipsProvider } from "./relationships.ts";

const agentId = "20000000-0000-0000-0000-000000000001" as UUID;
const speakerId = "20000000-0000-0000-0000-000000000002" as UUID;
const aliasId = "20000000-0000-0000-0000-000000000003" as UUID;
const bobId = "20000000-0000-0000-0000-000000000004" as UUID;
const carolId = "20000000-0000-0000-0000-000000000005" as UUID;
const daveId = "20000000-0000-0000-0000-000000000006" as UUID;
const eveId = "20000000-0000-0000-0000-000000000007" as UUID;
const missingId = "20000000-0000-0000-0000-000000000008" as UUID;
const unrelatedId = "20000000-0000-0000-0000-000000000009" as UUID;
const roomId = "20000000-0000-0000-0000-000000000010" as UUID;

const message: Memory = {
	id: "20000000-0000-0000-0000-000000000011" as UUID,
	agentId,
	entityId: speakerId,
	roomId,
	content: { text: "Who do I interact with?", senderName: "Alice" },
};

function relationship(
	id: number,
	sourceEntityId: UUID,
	targetEntityId: UUID,
	interactions?: number,
	tags: string[] = [],
): Relationship {
	return {
		id: `21000000-0000-0000-0000-0000000000${id.toString().padStart(2, "0")}` as UUID,
		agentId,
		sourceEntityId,
		targetEntityId,
		tags,
		metadata: interactions === undefined ? undefined : { interactions },
	};
}

function entity(
	id: UUID | undefined,
	names: string[],
	metadata?: Entity["metadata"],
): Entity {
	return { id, agentId, names, metadata };
}

function makeRuntime(args: {
	relationships?: Relationship[];
	entities?: Entity[];
	relatedEntityIds?: UUID[];
}) {
	const getRelationships = vi.fn(async () => args.relationships);
	const getEntitiesByIds = vi.fn(async () => args.entities ?? []);
	const getMemberEntityIds = vi.fn(async () => args.relatedEntityIds ?? []);
	const runtime = {
		agentId,
		character: { name: "Eliza" },
		getService: vi.fn((name: string) =>
			name === "relationships" && args.relatedEntityIds
				? { getMemberEntityIds }
				: null,
		),
		getRelationships,
		getEntitiesByIds,
	} as unknown as IAgentRuntime;

	return { runtime, getRelationships, getEntitiesByIds, getMemberEntityIds };
}

describe("relationshipsProvider", () => {
	it("exposes the provider contract used by contact and memory contexts", () => {
		expect(relationshipsProvider).toMatchObject({
			name: "RELATIONSHIPS",
			dynamic: true,
			contexts: ["contacts", "memory"],
			contextGate: { anyOf: ["contacts", "memory"] },
			cacheStable: false,
			cacheScope: "turn",
			roleGate: { minRole: "USER" },
		});
		expect(relationshipsProvider.description).toEqual(expect.any(String));
	});

	it.each([
		["an absent result", undefined],
		["an empty result", []],
	] as const)(
		"returns the explicit empty state for %s",
		async (_label, rows) => {
			const { runtime, getEntitiesByIds } = makeRuntime({
				relationships: rows as Relationship[] | undefined,
			});

			const result = await relationshipsProvider.get(runtime, message, {
				values: {},
				data: {},
				text: "",
			});

			expect(result).toEqual({
				data: { relationships: [] },
				values: { relationships: "No relationships found." },
				text: "No relationships found.",
			});
			expect(getEntitiesByIds).not.toHaveBeenCalled();
		},
	);

	it("ignores edges without a positive or negative interaction count", async () => {
		const { runtime, getEntitiesByIds } = makeRuntime({
			relationships: [
				relationship(1, speakerId, bobId),
				relationship(2, speakerId, carolId, 0),
			],
		});

		const result = await relationshipsProvider.get(runtime, message, {
			values: {},
			data: {},
			text: "",
		});

		expect(result.text).toBe("No relationships found.");
		expect(getEntitiesByIds).not.toHaveBeenCalled();
	});

	it("sorts by interactions, keeps tie order, resolves both edge directions, and batches unique counterparts", async () => {
		const { runtime, getRelationships, getEntitiesByIds, getMemberEntityIds } =
			makeRuntime({
				relatedEntityIds: [aliasId, speakerId],
				relationships: [
					relationship(1, speakerId, bobId, 1, ["friend"]),
					relationship(2, carolId, aliasId, 5, ["lead"]),
					relationship(3, speakerId, daveId, 3, ["first-tie"]),
					relationship(4, eveId, aliasId, 3, ["second-tie"]),
					relationship(5, speakerId, bobId, 2, ["neighbor"]),
					relationship(6, speakerId, missingId, 4, ["missing"]),
					relationship(7, unrelatedId, missingId, 9, ["unrelated"]),
				],
				entities: [
					entity(carolId, ["Carol", "C"], {
						profile: { role: "lead" },
						active: true,
						score: 0,
						note: "",
					}),
					entity(daveId, ["Dave"]),
					entity(eveId, ["Eve"]),
					entity(bobId, ["Bob"]),
					entity(undefined, ["No stable id"]),
				],
			});

		const result = await relationshipsProvider.get(runtime, message, {
			values: {},
			data: {},
			text: "",
		});

		expect(getMemberEntityIds).toHaveBeenCalledWith(speakerId);
		expect(getRelationships).toHaveBeenCalledWith({
			entityIds: [speakerId, aliasId],
		});
		expect(getEntitiesByIds).toHaveBeenCalledOnce();
		expect(getEntitiesByIds).toHaveBeenCalledWith([
			carolId,
			missingId,
			daveId,
			eveId,
			bobId,
		]);

		const rendered = result.data.relationships as string;
		expect(rendered).toContain("Carol aka C\nlead");
		expect(rendered).toContain('"profile": {\n    "role": "lead"');
		expect(rendered).toContain("active: true");
		expect(rendered).toContain("score: 0");
		expect(rendered).toContain("note: ");
		expect(rendered.indexOf("Carol aka C")).toBeLessThan(
			rendered.indexOf("Dave"),
		);
		expect(rendered.indexOf("Dave")).toBeLessThan(rendered.indexOf("Eve"));
		expect(rendered.indexOf("Eve")).toBeLessThan(rendered.indexOf("Bob"));
		expect(rendered.match(/Bob/g)).toHaveLength(2);
		expect(rendered).not.toContain("No stable id");
		expect(rendered).not.toContain("missing");
		expect(rendered).not.toContain("unrelated");
		expect(result.values.relationships).toBe(rendered);
		expect(result.text).toBe(
			`# Eliza has observed Alice interacting with these people:\n${rendered}`,
		);
	});

	it("returns the empty state when interacting edges have no current counterpart", async () => {
		const { runtime, getEntitiesByIds } = makeRuntime({
			relationships: [
				relationship(1, unrelatedId, missingId, -1, ["external"]),
			],
		});

		const result = await relationshipsProvider.get(runtime, message, {
			values: {},
			data: {},
			text: "",
		});

		expect(result.text).toBe("No relationships found.");
		expect(getEntitiesByIds).not.toHaveBeenCalled();
	});

	it("falls back to content.name when senderName is absent", async () => {
		const { runtime } = makeRuntime({
			relationships: [relationship(1, speakerId, bobId, 1)],
			entities: [entity(bobId, ["Bob"])],
		});
		const namedMessage: Memory = {
			...message,
			content: { text: message.content.text, name: "Alicia" },
		};

		const result = await relationshipsProvider.get(runtime, namedMessage, {
			values: {},
			data: {},
			text: "",
		});

		expect(result.text).toContain("Eliza has observed Alicia interacting");
	});
});
