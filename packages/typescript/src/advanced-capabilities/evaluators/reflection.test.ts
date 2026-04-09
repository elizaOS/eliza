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

describe("advanced capabilities reflectionEvaluator", () => {
	let runtime: IAgentRuntime;

	beforeEach(() => {
		vi.clearAllMocks();
		runtime = createMockRuntime();
		getEntityDetailsMock.mockResolvedValue(mockEntities);
	});

	it("stores facts even when the relationships block is omitted", async () => {
		const message = createMessage(mockEntities[0]!.id!);
		const useModel = runtime.useModel as unknown as ReturnType<typeof vi.fn>;
		const warn = runtime.logger.warn as unknown as ReturnType<typeof vi.fn>;

		useModel.mockResolvedValue(`<response>
			<thought>All good</thought>
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

		expect(runtime.createMemory).toHaveBeenCalledOnce();
		expect(runtime.createRelationship).not.toHaveBeenCalled();

		const warnedMessages = warn.mock.calls.map((call) =>
			String(call[1] ?? call[0] ?? ""),
		);
		expect(warnedMessages).not.toContain(
			"Getting reflection failed - invalid relationships structure",
		);
	});

	it("creates relationships even when the facts block is omitted", async () => {
		const message = createMessage(mockEntities[0]!.id!);
		const useModel = runtime.useModel as unknown as ReturnType<typeof vi.fn>;
		const warn = runtime.logger.warn as unknown as ReturnType<typeof vi.fn>;

		useModel.mockResolvedValue(`<response>
			<thought>All good</thought>
			<relationships>
				<relationship>
					<sourceEntityId>Alice</sourceEntityId>
					<targetEntityId>Bob</targetEntityId>
					<tags>dm_interaction</tags>
				</relationship>
			</relationships>
		</response>`);

		await reflectionEvaluator.handler(runtime, message);

		expect(runtime.createMemory).not.toHaveBeenCalled();
		expect(runtime.createRelationship).toHaveBeenCalledOnce();
		expect(runtime.createRelationship).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceEntityId: mockEntities[0]!.id,
				targetEntityId: mockEntities[1]!.id,
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
		const message = createMessage(mockEntities[0]!.id!);
		const useModel = runtime.useModel as unknown as ReturnType<typeof vi.fn>;
		const warn = runtime.logger.warn as unknown as ReturnType<typeof vi.fn>;

		useModel.mockResolvedValue(`Here is the reflection:

\`\`\`toon
thought: All good
facts[1]{claim,type,in_bio,already_known}:
  "Bob is a builder",fact,false,false
\`\`\`

Thanks.`);

		await reflectionEvaluator.handler(runtime, message);

		expect(runtime.createMemory).toHaveBeenCalledOnce();

		const warnedMessages = warn.mock.calls.map((call) =>
			String(call[1] ?? call[0] ?? ""),
		);
		expect(warnedMessages).not.toContain(
			"Getting reflection failed - failed to parse structured response",
		);
	});

	it("skips unstructured reflection output without warning", async () => {
		const message = createMessage(mockEntities[0]!.id!);
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
		const message = createMessage(mockEntities[0]!.id!);
		const useModel = runtime.useModel as unknown as ReturnType<typeof vi.fn>;

		useModel.mockResolvedValue(`thought: "All good"
facts[3]{claim,type,in_bio,already_known}:
  "Shaw prefers concise status updates",fact,false,false
  "shaw thinks he fixed a bug in Eliza's simple-response handling",fact,false,false
  "abaeze and others are actively debugging stalled chat replies on both Discord and OpenAI-compat routes",fact,false,false`);

		await reflectionEvaluator.handler(runtime, message);

		expect(runtime.createMemory).toHaveBeenCalledOnce();
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				content: { text: "Shaw prefers concise status updates" },
			}),
			"facts",
			true,
		);
	});
});
