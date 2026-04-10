import { describe, expect, it, vi } from "vitest";
import { relationshipExtractionEvaluator as advancedCapabilitiesEvaluator } from "../advanced-capabilities/evaluators/relationshipExtraction.ts";
import { relationshipExtractionEvaluator as advancedMemoryEvaluator } from "../advanced-memory/evaluators/relationshipExtraction.ts";
import type { Entity, Memory, Relationship, UUID } from "../types/index.ts";
import type { IAgentRuntime } from "../types/runtime.ts";

const agentId = "90000000-0000-0000-0000-000000000001" as UUID;
const entityId = "90000000-0000-0000-0000-000000000002" as UUID;
const otherEntityId = "90000000-0000-0000-0000-000000000005" as UUID;
const roomId = "90000000-0000-0000-0000-000000000003" as UUID;

it("only the active relationship extractor waits for a response", () => {
	expect(advancedCapabilitiesEvaluator.alwaysRun).toBe(false);
	expect(advancedMemoryEvaluator.alwaysRun).toBe(true);
});

function createRuntime(options?: { relationships?: Relationship[] }) {
	const entities = new Map<UUID, Entity>([
		[
			entityId,
			{
				id: entityId,
				names: ["Casey"],
				agentId,
				metadata: {},
				components: [],
			},
		],
		[
			otherEntityId,
			{
				id: otherEntityId,
				names: ["Riley"],
				agentId,
				metadata: {},
				components: [],
			},
		],
	]);

	const recentMessages: Memory[] = [
		{
			id: "90000000-0000-0000-0000-000000000006" as UUID,
			entityId,
			roomId,
			content: {
				text: "Can you take a look at this code review before the project meeting?",
			},
		},
		{
			id: "90000000-0000-0000-0000-000000000007" as UUID,
			entityId: otherEntityId,
			roomId,
			content: {
				text: "Yes, let's work together on that deadline.",
			},
		},
	];

	const runtime = {
		agentId,
		getService: vi.fn((serviceName: string) =>
			serviceName === "relationships" ? {} : null,
		),
		getMemories: vi.fn(async (params?: { tableName?: string }) =>
			params?.tableName === "messages" ? recentMessages : [],
		),
		getEntityById: vi.fn(
			async (requestedEntityId: UUID) =>
				entities.get(requestedEntityId) ?? null,
		),
		updateEntity: vi.fn(async (updated: Entity) => {
			entities.set(updated.id, updated);
		}),
		createComponent: vi.fn(async () => true),
		createEntity: vi.fn(async () => true),
		getEntitiesForRoom: vi.fn(async () => []),
		getRelationships: vi.fn(async () => options?.relationships ?? []),
		createRelationship: vi.fn(async () => true),
		updateRelationship: vi.fn(async () => undefined),
	} as unknown as IAgentRuntime;

	return {
		runtime,
		updateEntity: runtime.updateEntity as ReturnType<typeof vi.fn>,
		createRelationship: runtime.createRelationship as ReturnType<typeof vi.fn>,
		updateRelationship: runtime.updateRelationship as ReturnType<typeof vi.fn>,
	};
}

function createMessage(text: string): Memory {
	return {
		id: "90000000-0000-0000-0000-000000000004" as UUID,
		entityId,
		roomId,
		content: {
			text,
		},
	};
}

describe.each([
	["advanced capabilities", advancedCapabilitiesEvaluator],
	["advanced memory", advancedMemoryEvaluator],
])("%s relationship extraction evaluator", (_label, evaluator) => {
	it("does not treat generic @mentions as twitter identities", async () => {
		const { runtime, updateEntity } = createRuntime();

		const result = await evaluator.handler(
			runtime,
			createMessage("cc @alice about this"),
		);

		expect(result?.values?.identitiesFound).toBe(0);
		expect(
			updateEntity.mock.calls.some((call) =>
				Array.isArray((call[0] as Entity).metadata?.platformIdentities),
			),
		).toBe(false);
	});

	it("extracts explicit github, discord, telegram, and twitter identities", async () => {
		const { runtime, updateEntity } = createRuntime();

		const result = await evaluator.handler(
			runtime,
			createMessage(
				"GitHub username is octo-cat, my Discord is octocat, my Telegram is @octogram, and twitter handle is @octo_cat.",
			),
		);

		expect(result?.values?.identitiesFound).toBe(4);
		const updatedEntity = updateEntity.mock.calls
			.map((call) => call[0] as Entity)
			.find((candidate) =>
				Array.isArray(candidate.metadata?.platformIdentities),
			);
		const identities = Array.isArray(
			updatedEntity?.metadata?.platformIdentities,
		)
			? updatedEntity.metadata.platformIdentities
			: [];
		const identityMap = new Map(
			identities.map((identity) => [
				`${String(identity.platform)}:${String(identity.handle)}`,
				identity,
			]),
		);

		expect(identityMap.get("github:octo-cat")).toMatchObject({
			platform: "github",
			handle: "octo-cat",
		});
		expect(identityMap.get("discord:octocat")).toMatchObject({
			platform: "discord",
			handle: "octocat",
		});
		expect(identityMap.get("telegram:@octogram")).toMatchObject({
			platform: "telegram",
			handle: "@octogram",
		});
		expect(identityMap.get("twitter:octo_cat")).toMatchObject({
			platform: "twitter",
			handle: "octo_cat",
		});
	});

	it("creates a relationship when analysis finds a new pair", async () => {
		const { runtime, createRelationship, updateRelationship } = createRuntime();

		await evaluator.handler(
			runtime,
			createMessage("Following up on the project meeting."),
		);

		expect(createRelationship).toHaveBeenCalledTimes(1);
		expect(updateRelationship).not.toHaveBeenCalled();
		expect(createRelationship.mock.calls[0]?.[0]).toMatchObject({
			sourceEntityId: entityId,
			targetEntityId: otherEntityId,
			tags: expect.arrayContaining(["relationships", "colleague"]),
		});
	});

	it("updates an existing relationship instead of creating a duplicate", async () => {
		const existingRelationship = {
			id: "90000000-0000-0000-0000-000000000008" as UUID,
			sourceEntityId: entityId,
			targetEntityId: otherEntityId,
			agentId,
			tags: ["relationships", "community"],
			metadata: {
				indicators: [
					{
						type: "community",
						sentiment: "neutral",
						confidence: 0.6,
						context: "existing relationship context",
					},
				],
			},
		} as Relationship;
		const { runtime, createRelationship, updateRelationship } = createRuntime({
			relationships: [existingRelationship],
		});

		await evaluator.handler(
			runtime,
			createMessage("Following up on the project meeting."),
		);

		expect(createRelationship).not.toHaveBeenCalled();
		expect(updateRelationship).toHaveBeenCalledTimes(1);
		expect(updateRelationship.mock.calls[0]?.[0]).toMatchObject({
			id: existingRelationship.id,
			sourceEntityId: entityId,
			targetEntityId: otherEntityId,
			agentId,
			tags: expect.arrayContaining([
				"relationships",
				"community",
				"colleague",
				"updated",
			]),
			metadata: expect.objectContaining({
				relationshipType: "colleague",
				sentiment: "neutral",
			}),
		});
	});
});
