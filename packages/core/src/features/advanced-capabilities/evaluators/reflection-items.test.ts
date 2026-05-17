import { describe, expect, it, vi } from "vitest";
import type {
	EvaluatorProcessorContext,
	IAgentRuntime,
	Memory,
	UUID,
} from "../../../types/index.ts";
import { factMemoryEvaluator } from "./reflection-items.ts";

const agentId = "00000000-0000-0000-0000-0000000000aa" as UUID;
const entityId = "00000000-0000-0000-0000-0000000000bb" as UUID;
const roomId = "00000000-0000-0000-0000-0000000000cc" as UUID;

function message(text = "Berlin has been treating me well"): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000dd" as UUID,
		entityId,
		agentId,
		roomId,
		content: { text },
		createdAt: Date.now(),
	};
}

function makeRuntime() {
	let createdMemory: Memory | null = null;
	const createdId = "00000000-0000-0000-0000-0000000000ee" as UUID;
	const runtime = {
		agentId,
		createMemory: vi.fn(async (memoryArg: Memory) => {
			createdMemory = { ...memoryArg, id: createdId };
			return createdId;
		}),
		getMemoryById: vi.fn(async () => createdMemory),
		updateMemory: vi.fn(async () => undefined),
		deleteMemory: vi.fn(async () => undefined),
		useModel: vi.fn(async () => {
			throw new Error("fact evaluator must not request embeddings");
		}),
		queueEmbeddingGeneration: vi.fn(async () => undefined),
	};
	return runtime as unknown as IAgentRuntime & {
		createMemory: ReturnType<typeof vi.fn>;
		getMemoryById: ReturnType<typeof vi.fn>;
		updateMemory: ReturnType<typeof vi.fn>;
		useModel: ReturnType<typeof vi.fn>;
		queueEmbeddingGeneration: ReturnType<typeof vi.fn>;
	};
}

function processFactOps(
	runtime: ReturnType<typeof makeRuntime>,
	knownFacts: Memory[],
	output: unknown,
) {
	const processor = factMemoryEvaluator.processors?.[0];
	if (!processor) throw new Error("missing fact processor");
	return processor.process({
		runtime,
		message: message(),
		state: { values: {}, data: {}, text: "" },
		options: {},
		evaluatorName: "factMemory",
		prepared: {
			recentMessages: [],
			existingRelationships: [],
			entities: [],
			knownFacts,
		},
		output,
	} as EvaluatorProcessorContext);
}

describe("factMemoryEvaluator keyword dedupe", () => {
	it("stores extracted keywords and does not queue fact embeddings", async () => {
		const runtime = makeRuntime();

		await processFactOps(runtime, [], {
			ops: [
				{
					op: "add_durable",
					claim: "lives in Berlin",
					category: "identity",
					structured_fields: { city: "Berlin" },
					keywords: ["berlin", "home"],
				},
			],
		});

		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(runtime.queueEmbeddingGeneration).not.toHaveBeenCalled();
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					keywords: expect.arrayContaining(["berlin", "home"]),
				}),
			}),
			"facts",
			true,
		);
	});

	it("strengthens a lexical duplicate instead of embedding the candidate", async () => {
		const runtime = makeRuntime();
		const existingFact: Memory = {
			id: "00000000-0000-0000-0000-0000000000ff" as UUID,
			entityId,
			agentId,
			roomId,
			content: { text: "lives in Berlin" },
			metadata: {
				kind: "durable",
				category: "identity",
				confidence: 0.7,
				keywords: ["berlin", "lives"],
			},
			createdAt: Date.now(),
		};

		const result = await processFactOps(runtime, [existingFact], {
			ops: [
				{
					op: "add_durable",
					claim: "Berlin has been treating me well",
					category: "identity",
					structured_fields: { city: "Berlin" },
					keywords: ["berlin"],
				},
			],
		});

		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(runtime.createMemory).not.toHaveBeenCalled();
		expect(runtime.updateMemory).toHaveBeenCalledWith(
			expect.objectContaining({ id: existingFact.id }),
		);
		const updateArg = runtime.updateMemory.mock.calls[0]?.[0] as {
			metadata?: { confidence?: number };
		};
		expect(updateArg.metadata?.confidence).toBeCloseTo(0.8);
		expect(result?.data).toMatchObject({ added: 0, strengthened: 1 });
	});
});
