import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEntityDetails } from "../../entities.ts";
import type { Entity, IAgentRuntime, Memory, UUID } from "../../types/index.ts";
import { reflectionEvaluator } from "./reflection.ts";

vi.mock("../../entities.ts", async () => {
	const actual =
		await vi.importActual<typeof import("../../entities.ts")>(
			"../../entities.ts",
		);

	return {
		...actual,
		getEntityDetails: vi.fn(),
	};
});

const getEntityDetailsMock = vi.mocked(getEntityDetails);

const mockEntities: Entity[] = [
	{
		id: "user-a" as UUID,
		agentId: "test-agent" as UUID,
		names: ["Alice"],
	} as Entity,
	{
		id: "user-b" as UUID,
		agentId: "test-agent" as UUID,
		names: ["Bob"],
	} as Entity,
];

function createMockRuntime(): IAgentRuntime {
	return {
		agentId: "test-agent" as UUID,
		character: {
			name: "TestAgent",
			templates: {},
		},
		getRelationships: vi.fn().mockResolvedValue([]),
		getMemories: vi.fn().mockResolvedValue([]),
		createMemory: vi.fn().mockResolvedValue("fact-memory-id" as UUID),
		queueEmbeddingGeneration: vi.fn().mockResolvedValue(undefined),
		updateRelationship: vi.fn().mockResolvedValue(true),
		getActionResults: vi.fn().mockReturnValue([]),
		getCache: vi.fn().mockResolvedValue(undefined),
		deleteCache: vi.fn().mockResolvedValue(true),
		createRelationship: vi.fn().mockResolvedValue(true),
		setCache: vi.fn().mockResolvedValue(undefined),
		useModel: vi.fn(),
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
			error: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

function createMessage(entityId: UUID): Memory {
	return {
		id: "message-1" as UUID,
		agentId: "test-agent" as UUID,
		entityId,
		roomId: "room-1" as UUID,
		content: {
			text: "hello",
			channelType: "DM",
		},
		createdAt: Date.now(),
	} as Memory;
}

function getMockEntityId(index: number): UUID {
	const entityId = mockEntities.at(index)?.id;

	if (!entityId) {
		throw new Error(`Missing mock entity id at index ${index}`);
	}

	return entityId as UUID;
}

describe("advanced capabilities reflectionEvaluator", () => {
	let runtime: IAgentRuntime;

	beforeEach(() => {
		vi.clearAllMocks();
		runtime = createMockRuntime();
		getEntityDetailsMock.mockResolvedValue(mockEntities);
	});

	it("only auto-runs after the agent responds", () => {
		expect(reflectionEvaluator.alwaysRun).toBe(false);
	});

	it("stores facts even when the relationships block is omitted", async () => {
		const message = createMessage(getMockEntityId(0));
		const useModel = runtime.useModel as unknown as ReturnType<typeof vi.fn>;
		const warn = runtime.logger.warn as unknown as ReturnType<typeof vi.fn>;

		useModel.mockResolvedValue(`<response>
			<thought>All good</thought>
			<task_completed>true</task_completed>
			<task_completion_reason>The greeting exchange is complete.</task_completion_reason>
			<facts>
				<fact>
					<claim>Bob is a builder</claim>
					<type>fact</type>
					<in_bio>false</in_bio>
					<already_known>false</already_known>
				</fact>
			</facts>
		</response>`);

		await reflectionEvaluator.handler(runtime, message);

		const createMemoryCalls = vi.mocked(runtime.createMemory).mock.calls;
		expect(
			createMemoryCalls.filter(([, tableName]) => tableName === "facts"),
		).toHaveLength(1);
		expect(
			createMemoryCalls.filter(([, tableName]) => tableName === "memories"),
		).toHaveLength(1);
		expect(runtime.createRelationship).not.toHaveBeenCalled();

		const warnedMessages = warn.mock.calls.map((call) =>
			String(call[1] ?? call[0] ?? ""),
		);
		expect(warnedMessages).not.toContain(
			"Getting reflection failed - invalid relationships structure",
		);
	});

	it("creates relationships even when the facts block is omitted", async () => {
		const message = createMessage(getMockEntityId(0));
		const useModel = runtime.useModel as unknown as ReturnType<typeof vi.fn>;
		const warn = runtime.logger.warn as unknown as ReturnType<typeof vi.fn>;

		useModel.mockResolvedValue(`<response>
			<thought>All good</thought>
			<task_completed>true</task_completed>
			<task_completion_reason>The interaction is complete.</task_completion_reason>
			<relationships>
				<relationship>
					<sourceEntityId>Alice</sourceEntityId>
					<targetEntityId>Bob</targetEntityId>
					<tags>dm_interaction</tags>
				</relationship>
			</relationships>
		</response>`);

		await reflectionEvaluator.handler(runtime, message);

		expect(
			vi
				.mocked(runtime.createMemory)
				.mock.calls.filter(([, tableName]) => tableName === "facts"),
		).toHaveLength(0);
		expect(
			vi
				.mocked(runtime.createMemory)
				.mock.calls.filter(([, tableName]) => tableName === "memories"),
		).toHaveLength(1);
		expect(runtime.createRelationship).toHaveBeenCalledOnce();
		expect(runtime.createRelationship).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceEntityId: getMockEntityId(0),
				targetEntityId: getMockEntityId(1),
				tags: ["dm_interaction"],
			}),
		);

		const warnedMessages = warn.mock.calls.map((call) =>
			String(call[1] ?? call[0] ?? ""),
		);
		expect(warnedMessages).not.toContain(
			"Getting reflection failed - invalid facts structure",
		);
	});

	it("parses a fenced TOON reflection even when the model adds extra prose", async () => {
		const message = createMessage(getMockEntityId(0));
		const useModel = runtime.useModel as unknown as ReturnType<typeof vi.fn>;
		const warn = runtime.logger.warn as unknown as ReturnType<typeof vi.fn>;

		useModel.mockResolvedValue(`Here is the reflection:

\`\`\`toon
thought: All good
task_completed: true
task_completion_reason: The user got what they needed.
facts[1]{claim,type,in_bio,already_known}:
  "Bob is a builder",fact,false,false
\`\`\`

Thanks.`);

		await reflectionEvaluator.handler(runtime, message);

		expect(
			vi
				.mocked(runtime.createMemory)
				.mock.calls.filter(([, tableName]) => tableName === "facts"),
		).toHaveLength(1);

		const warnedMessages = warn.mock.calls.map((call) =>
			String(call[1] ?? call[0] ?? ""),
		);
		expect(warnedMessages).not.toContain(
			"Getting reflection failed - failed to parse structured response",
		);
	});

	it("parses a fenced JSON reflection without warning", async () => {
		const message = createMessage(getMockEntityId(0));
		const useModel = runtime.useModel as unknown as ReturnType<typeof vi.fn>;
		const warn = runtime.logger.warn as unknown as ReturnType<typeof vi.fn>;

		useModel.mockResolvedValue(`Here is the reflection:

\`\`\`json
{
  "thought": "All good",
  "task_completed": true,
  "task_completion_reason": "The user got a complete answer.",
  "facts": [
    {
      "claim": "Bob is a builder",
      "type": "fact",
      "in_bio": false,
      "already_known": false
    }
  ],
  "relationships": [
    {
      "sourceEntityId": "Alice",
      "targetEntityId": "Bob",
      "tags": ["dm_interaction"]
    }
  ]
}
\`\`\``);

		await reflectionEvaluator.handler(runtime, message);

		expect(
			vi
				.mocked(runtime.createMemory)
				.mock.calls.filter(([, tableName]) => tableName === "facts"),
		).toHaveLength(1);
		expect(runtime.createRelationship).toHaveBeenCalledOnce();
		expect(runtime.createRelationship).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceEntityId: getMockEntityId(0),
				targetEntityId: getMockEntityId(1),
				tags: ["dm_interaction"],
			}),
		);

		const warnedMessages = warn.mock.calls.map((call) =>
			String(call[1] ?? call[0] ?? ""),
		);
		expect(warnedMessages).not.toContain(
			"Getting reflection failed - failed to parse structured response",
		);
	});

	it("parses a wrapped JSON reflection object", async () => {
		const message = createMessage(getMockEntityId(0));
		const useModel = runtime.useModel as unknown as ReturnType<typeof vi.fn>;

		useModel.mockResolvedValue(`{
  "response": {
    "task_completed": true,
    "task_completion_reason": "The response wrapped up the task.",
    "facts": [
      {
        "claim": "Bob is a builder",
        "type": "fact",
        "in_bio": false,
        "already_known": false
      }
    ],
    "relationships": []
  }
}`);

		await reflectionEvaluator.handler(runtime, message);

		expect(
			vi
				.mocked(runtime.createMemory)
				.mock.calls.filter(([, tableName]) => tableName === "facts"),
		).toHaveLength(1);
		expect(runtime.createRelationship).not.toHaveBeenCalled();
	});

	it("skips unstructured reflection output without warning", async () => {
		const message = createMessage(getMockEntityId(0));
		const useModel = runtime.useModel as unknown as ReturnType<typeof vi.fn>;
		const warn = runtime.logger.warn as unknown as ReturnType<typeof vi.fn>;

		useModel.mockResolvedValue("No new facts or relationships to record.");

		await reflectionEvaluator.handler(runtime, message);

		expect(runtime.createMemory).not.toHaveBeenCalled();
		expect(runtime.createRelationship).not.toHaveBeenCalled();

		const warnedMessages = warn.mock.calls.map((call) =>
			String(call[1] ?? call[0] ?? ""),
		);
		expect(warnedMessages).not.toContain(
			"Getting reflection failed - failed to parse structured response",
		);
	});

	it("filters out temporary status facts before storing them", async () => {
		const message = createMessage(getMockEntityId(0));
		const useModel = runtime.useModel as unknown as ReturnType<typeof vi.fn>;

		useModel.mockResolvedValue(`thought: "All good"
task_completed: true
task_completion_reason: The preference was captured successfully.
facts[3]{claim,type,in_bio,already_known}:
  "Shaw prefers concise status updates",fact,false,false
  "shaw thinks he fixed a bug in Eliza's simple-response handling",fact,false,false
  "abaeze and others are actively debugging stalled chat replies on both Discord and OpenAI-compat routes",fact,false,false`);

		await reflectionEvaluator.handler(runtime, message);

		expect(
			vi
				.mocked(runtime.createMemory)
				.mock.calls.filter(([, tableName]) => tableName === "facts"),
		).toHaveLength(1);
		expect(vi.mocked(runtime.createMemory)).toHaveBeenCalledWith(
			expect.objectContaining({
				content: { text: "Shaw prefers concise status updates" },
			}),
			"facts",
			true,
		);
	});

	it("stores task completion assessments in memories and cache", async () => {
		const message = createMessage(getMockEntityId(0));
		const useModel = runtime.useModel as unknown as ReturnType<typeof vi.fn>;

		useModel.mockResolvedValue(`thought: "Need one more step"
task_completed: false
task_completion_reason: The user asked for a follow-up action that has not run yet.`);

		const result = await reflectionEvaluator.handler(runtime, message);

		expect(result?.values).toMatchObject({
			taskCompleted: false,
			taskCompletionAssessed: true,
			taskCompletionReason:
				"The user asked for a follow-up action that has not run yet.",
		});
		expect(vi.mocked(runtime.createMemory)).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.objectContaining({
					type: "task_completion_reflection",
					text: expect.stringContaining("incomplete"),
				}),
				metadata: expect.objectContaining({
					taskCompleted: false,
					taskAssessed: true,
					taskCompletionReason:
						"The user asked for a follow-up action that has not run yet.",
				}),
			}),
			"memories",
		);
		expect(vi.mocked(runtime.setCache)).toHaveBeenCalledWith(
			expect.stringContaining("reflection-task-completion"),
			expect.objectContaining({
				assessed: true,
				completed: false,
			}),
		);
	});

	it("validates once per message instead of waiting for a conversation interval", async () => {
		const message = createMessage(getMockEntityId(0));
		const getCacheMock = runtime.getCache as unknown as ReturnType<typeof vi.fn>;

		getCacheMock.mockResolvedValueOnce(undefined);
		await expect(reflectionEvaluator.validate(runtime, message)).resolves.toBe(
			true,
		);

		getCacheMock.mockResolvedValueOnce(message.id);
		await expect(reflectionEvaluator.validate(runtime, message)).resolves.toBe(
			false,
		);
	});
});
