import { describe, expect, it, vi } from "vitest";
import { ModelType } from "../../types/index.ts";
import {
	parseReflectionResponse,
	reflectionEvaluator,
	resolveReflectionModelType,
} from "./reflection.ts";

describe("parseReflectionResponse", () => {
	it("parses YAML list output for reflection facts and relationships", () => {
		const result = parseReflectionResponse(`
thought: kept the conversation grounded
facts:
  - claim: User prefers text reminders over phone calls
    type: fact
    in_bio: false
    already_known: false
relationships:
  - sourceEntityId: agent-1
    targetEntityId: user-1
    tags:
      - dm_interaction
`);

		expect(result.lookedStructured).toBe(true);
		expect(result.reflection).toMatchObject({
			facts: [
				{
					claim: "User prefers text reminders over phone calls",
					type: "fact",
				},
			],
			relationships: [
				{
					sourceEntityId: "agent-1",
					targetEntityId: "user-1",
					tags: ["dm_interaction"],
				},
			],
		});
	});

	it("parses fenced YAML reflection output", () => {
		const result = parseReflectionResponse(`
\`\`\`yaml
thought: reflected clearly
facts:
  - claim: User often forgets Invisalign after lunch
    type: fact
    in_bio: false
    already_known: false
\`\`\`
`);

		expect(result.lookedStructured).toBe(true);
		expect(result.reflection).toMatchObject({
			facts: [
				{
					claim: "User often forgets Invisalign after lunch",
					type: "fact",
				},
			],
		});
	});

	it("parses indexed TOON reflection output from the live reflection prompt", () => {
		const result = parseReflectionResponse(`
thought: "I captured the user's durable preferences."
task_completed: false
task_completion_reason: "The conversation is ongoing."
facts[0]:
  claim: shaw prefers text reminders only, with no phone-call reminders
  type: fact
  in_bio: false
  already_known: false
facts[1]:
  claim: shaw often forgets to put Invisalign back in after lunch
  type: fact
  in_bio: false
  already_known: false
relationships[0]:
  sourceEntityId: agent-1
  targetEntityId: user-1
  tags[0]: dm_interaction
`);

		expect(result.lookedStructured).toBe(true);
		expect(result.reflection).toMatchObject({
			facts: [
				{
					claim:
						"shaw prefers text reminders only, with no phone-call reminders",
					type: "fact",
				},
				{
					claim: "shaw often forgets to put Invisalign back in after lunch",
					type: "fact",
				},
			],
			relationships: [
				{
					sourceEntityId: "agent-1",
					targetEntityId: "user-1",
					tags: ["dm_interaction"],
				},
			],
		});
	});

	it("uses the configured reflection model type when present", () => {
		const runtime = {
			getSetting(key: string) {
				if (key === "MEMORY_REFLECTION_MODEL_TYPE") {
					return ModelType.TEXT_LARGE;
				}
				return null;
			},
		} as const;

		expect(resolveReflectionModelType(runtime as never)).toBe(
			ModelType.TEXT_LARGE,
		);
	});

	it("falls back to TEXT_SMALL for invalid reflection model settings", () => {
		const runtime = {
			getSetting(key: string) {
				if (key === "MEMORY_REFLECTION_MODEL_TYPE") {
					return "not-a-real-model-type";
				}
				return null;
			},
		} as const;

		expect(resolveReflectionModelType(runtime as never)).toBe(
			ModelType.TEXT_SMALL,
		);
	});

	it("stores reflection facts even when the triggering user message omits agentId", async () => {
		const createdFacts: Array<Record<string, unknown>> = [];
		const runtime = {
			agentId: "agent-1",
			character: {
				templates: {},
			},
			getSetting: () => null,
			logger: {
				warn: vi.fn(),
				debug: vi.fn(),
			},
			getRelationships: vi.fn(async () => []),
			getMemories: vi.fn(async () => []),
			getRoom: vi.fn(async () => ({ source: "telegram" })),
			getEntitiesForRoom: vi.fn(async () => [
				{
					id: "agent-1",
					names: ["Eliza"],
					metadata: {},
					components: [],
				},
				{
					id: "user-1",
					names: ["shaw"],
					metadata: {
						telegram: {
							name: "shaw",
						},
					},
					components: [],
				},
			]),
			useModel: vi.fn(
				async () => `
facts:
  - claim: User prefers text reminders over phone calls
    type: fact
    in_bio: false
    already_known: false
relationships: []
`,
			),
			createMemory: vi.fn(async (memory: Record<string, unknown>) => {
				createdFacts.push(memory);
				return memory.id;
			}),
			queueEmbeddingGeneration: vi.fn(async () => undefined),
			setCache: vi.fn(async () => undefined),
		};
		const message = {
			id: "message-1",
			entityId: "user-1",
			roomId: "room-1",
			content: {
				text: "text reminders only",
				channelType: "DM",
			},
		};

		await reflectionEvaluator.handler?.(
			runtime as never,
			message as never,
			{ values: {} } as never,
			{} as never,
			undefined,
			[],
		);

		expect(createdFacts).toHaveLength(1);
		expect(createdFacts[0]?.agentId).toBe("agent-1");
		expect(createdFacts[0]?.content).toMatchObject({
			text: "User prefers text reminders over phone calls",
		});
	});
});
