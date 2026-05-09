import { describe, expect, it, vi } from "vitest";
import type { Memory } from "../../types/memory";
import { ModelType } from "../../types/model";
import type { UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import {
	parseFactsAndRelationshipsOutput,
	runFactsAndRelationshipsStage,
} from "../facts-and-relationships";

type FactsRuntime = IAgentRuntime & {
	useModel: ReturnType<typeof vi.fn>;
};

function makeMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-00000000aaaa" as UUID,
		entityId: "00000000-0000-0000-0000-000000000001" as UUID,
		agentId: "00000000-0000-0000-0000-000000000002" as UUID,
		roomId: "00000000-0000-0000-0000-000000000003" as UUID,
		content: { text: "my birthday is March 5", source: "test" },
		createdAt: 1,
	};
}

function makeState(): State {
	return {
		values: {},
		data: {
			providers: {
				ENTITIES: {
					data: {
						entities: [{ names: ["Alice"] }, { names: ["Bob"] }],
					},
				},
			},
		},
		text: "",
	};
}

function makeRuntime(modelResponse: unknown): FactsRuntime {
	const runtime = {
		agentId: "00000000-0000-0000-0000-000000000002" as UUID,
		character: { name: "Eliza", system: "You are concise.", bio: "" },
		actions: [],
		providers: [],
		useModel: vi.fn(async (modelType: string) => {
			if (modelType === ModelType.TEXT_EMBEDDING) {
				return [0.1, 0.2, 0.3];
			}
			return modelResponse;
		}),
		searchMemories: vi.fn(async () => [
			{
				id: "00000000-0000-0000-0000-00000000bbbb" as UUID,
				entityId: "00000000-0000-0000-0000-000000000001" as UUID,
				agentId: "00000000-0000-0000-0000-000000000002" as UUID,
				roomId: "00000000-0000-0000-0000-000000000003" as UUID,
				content: { text: "the user's birthday is 1990-03-05", type: "fact" },
				createdAt: 0,
			} as Memory,
		]),
		getRelationships: vi.fn(async () => []),
		createMemory: vi.fn(async () => "00000000-0000-0000-0000-00000000cccc"),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
	};
	return runtime as FactsRuntime;
}

describe("parseFactsAndRelationshipsOutput", () => {
	it("returns empty arrays for empty input", () => {
		const result = parseFactsAndRelationshipsOutput("");
		expect(result.facts).toEqual([]);
		expect(result.relationships).toEqual([]);
	});

	it("parses text-shape JSON output", () => {
		const result = parseFactsAndRelationshipsOutput(
			JSON.stringify({
				facts: ["the user's birthday is 1990-03-05"],
				relationships: [
					{ subject: "user", predicate: "works_with", object: "Alice" },
				],
				thought: "kept one fact and one rel",
			}),
		);
		expect(result.facts).toEqual(["the user's birthday is 1990-03-05"]);
		expect(result.relationships).toEqual([
			{ subject: "user", predicate: "works_with", object: "Alice" },
		]);
		expect(result.thought).toBe("kept one fact and one rel");
	});

	it("parses tool-call shape (toolCalls[0].arguments)", () => {
		const result = parseFactsAndRelationshipsOutput({
			toolCalls: [
				{
					arguments: {
						facts: ["a"],
						relationships: [],
						thought: "ok",
					},
				},
			],
		});
		expect(result.facts).toEqual(["a"]);
	});

	it("drops malformed relationship entries", () => {
		const result = parseFactsAndRelationshipsOutput(
			JSON.stringify({
				facts: [],
				relationships: [
					{ subject: "user", predicate: "", object: "Alice" },
					{ subject: "user", predicate: "manages", object: "Bob" },
				],
				thought: "",
			}),
		);
		expect(result.relationships).toEqual([
			{ subject: "user", predicate: "manages", object: "Bob" },
		]);
	});
});

describe("runFactsAndRelationshipsStage", () => {
	it("short-circuits when extract has no candidates", async () => {
		const runtime = makeRuntime("");
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: {},
		});
		expect(result.parsed.facts).toEqual([]);
		expect(result.parsed.relationships).toEqual([]);
		expect(result.written).toEqual({ facts: 0, relationships: 0 });
		expect(runtime.useModel).not.toHaveBeenCalled();
	});

	it("composes a system+user prompt with candidates and existing context", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: ["the user's birthday is March 5"],
				relationships: [],
				thought: "new fact",
			}),
		);
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: {
				facts: ["the user's birthday is March 5"],
			},
		});

		// Vector search ran with the embedding seed
		expect(runtime.searchMemories).toHaveBeenCalledWith(
			expect.objectContaining({
				tableName: "facts",
				embedding: expect.any(Array),
			}),
		);

		// Existing relationships fetched
		expect(runtime.getRelationships).toHaveBeenCalledWith(
			expect.objectContaining({
				entityIds: expect.any(Array),
			}),
		);

		// Validation model call uses messages, not prompt
		const validationCall = runtime.useModel.mock.calls.find(
			(call) =>
				typeof call[0] === "string" &&
				(call[0] === ModelType.TEXT_LARGE || call[0] === "TEXT_LARGE"),
		);
		expect(validationCall).toBeDefined();
		const params = validationCall?.[1] as {
			messages?: Array<{ role: string; content: string }>;
			prompt?: string;
		};
		expect(params.prompt).toBeUndefined();
		expect(params.messages?.[0]?.role).toBe("system");
		expect(params.messages?.[1]?.role).toBe("user");
		expect(params.messages?.[1]?.content).toContain("candidates:");
		expect(params.messages?.[1]?.content).toContain("- fact: the user's");
		expect(params.messages?.[1]?.content).toContain("existing_similar_facts:");
		expect(params.messages?.[1]?.content).toContain("room_entities:");

		// Result parsed and persisted
		expect(result.parsed.facts).toEqual(["the user's birthday is March 5"]);
		expect(result.written.facts).toBe(1);
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.objectContaining({
					text: "the user's birthday is March 5",
					type: "fact",
				}),
			}),
			"facts",
			true,
		);
	});

	it("persists relationships under the facts table when kept", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: [],
				relationships: [
					{ subject: "user", predicate: "works_with", object: "Alice" },
				],
				thought: "new rel",
			}),
		);
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: {
				relationships: [
					{ subject: "user", predicate: "works_with", object: "Alice" },
				],
			},
		});
		expect(result.written.relationships).toBe(1);
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.objectContaining({
					type: "relationship",
					subject: "user",
					predicate: "works_with",
					object: "Alice",
				}),
			}),
			"facts",
			true,
		);
	});

	it("returns gracefully when the model omits candidates from the response", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: [],
				relationships: [],
				thought: "all duplicates",
			}),
		);
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: { facts: ["something already known"] },
		});
		expect(result.parsed.facts).toEqual([]);
		expect(result.written).toEqual({ facts: 0, relationships: 0 });
		expect(runtime.createMemory).not.toHaveBeenCalled();
	});
});
