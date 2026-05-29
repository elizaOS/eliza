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
						entities: [
							{
								id: "00000000-0000-0000-0000-0000000000a1" as UUID,
								names: ["Alice"],
							},
							{
								id: "00000000-0000-0000-0000-0000000000b2" as UUID,
								names: ["Bob"],
							},
						],
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
		redactSecrets: vi.fn((text: string) =>
			text.replace(/\b(?:sk|csk)-[A-Za-z0-9_-]+/g, "[REDACTED]"),
		),
		useModel: vi.fn(async (_modelType: string) => {
			return modelResponse;
		}),
		getMemories: vi.fn(async () => [
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
		createRelationship: vi.fn(async () => true),
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

	it("parses AI SDK v5 / Cerebras tool-call shape (toolCalls[0].input)", () => {
		// Live regression on 2026-05-28 (tj-80ba4e3920d7bd): the user said
		// "my dogs name is Jeff", Stage 1 extracted the fact, and the validate
		// model returned a correct tool call — but the args were under `input`
		// (AI SDK v5 / Cerebras gpt-oss-120b shape), not `arguments`. The old
		// extractText only read `arguments`, so the parse came back empty and
		// the fact was silently dropped (written.facts=0). Nothing persisted,
		// so cross-turn recall only worked while the source message stayed in
		// the recent-message window. Pin all tool-arg field names.
		const result = parseFactsAndRelationshipsOutput({
			text: "",
			toolCalls: [
				{
					type: "tool-call",
					toolName: "FACTS_AND_RELATIONSHIPS_VALIDATE",
					input: {
						facts: ["my dog's name is Jeff"],
						relationships: [
							{ subject: "user", predicate: "has_dog_named", object: "Jeff" },
						],
						thought: "new, not duplicated",
					},
				},
			],
		});
		expect(result.facts).toEqual(["my dog's name is Jeff"]);
		expect(result.relationships).toEqual([
			{ subject: "user", predicate: "has_dog_named", object: "Jeff" },
		]);
	});

	it("parses tool-call args under `args` and `params` keys too", () => {
		const viaArgs = parseFactsAndRelationshipsOutput({
			toolCalls: [{ args: { facts: ["x"], relationships: [], thought: "" } }],
		});
		expect(viaArgs.facts).toEqual(["x"]);
		const viaParams = parseFactsAndRelationshipsOutput({
			toolCalls: [{ params: { facts: ["y"], relationships: [], thought: "" } }],
		});
		expect(viaParams.facts).toEqual(["y"]);
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

		// Existing facts are fetched and keyword-ranked without embeddings.
		expect(runtime.getMemories).toHaveBeenCalledWith(
			expect.objectContaining({
				tableName: "facts",
				roomId: expect.any(String),
			}),
		);
		expect(runtime.useModel).not.toHaveBeenCalledWith(
			ModelType.TEXT_EMBEDDING,
			expect.anything(),
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
		expect(params.messages?.[1]?.content).toContain(
			"Alice (id: 00000000-0000-0000-0000-0000000000a1)",
		);

		// Result parsed and persisted
		expect(result.parsed.facts).toEqual(["the user's birthday is March 5"]);
		expect(result.written.facts).toBe(1);
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.objectContaining({
					text: "the user's birthday is March 5",
					type: "fact",
				}),
				metadata: expect.objectContaining({
					source: "facts_and_relationships_stage",
					tags: expect.arrayContaining(["fact", "extracted", "stage1"]),
					keywords: expect.arrayContaining(["birthday", "march"]),
				}),
			}),
			"facts",
			true,
		);
	});

	it("persists relationships under the facts table and upserts resolved entity edges when kept", async () => {
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
				metadata: expect.objectContaining({
					source: "facts_and_relationships_stage",
					sourceEntityId: makeMessage().entityId,
					targetEntityId: "00000000-0000-0000-0000-0000000000a1",
				}),
			}),
			"facts",
			true,
		);
		expect(runtime.createRelationship).toHaveBeenCalledWith({
			sourceEntityId: makeMessage().entityId,
			targetEntityId: "00000000-0000-0000-0000-0000000000a1",
			tags: ["works_with"],
			metadata: expect.objectContaining({
				source: "facts_and_relationships_stage",
				messageId: makeMessage().id,
			}),
		});
	});

	it("filters low-signal and secret-like candidates before calling the model", async () => {
		const runtime = makeRuntime("");
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: {
				facts: [
					"by the way thanks",
					"my api key is csk-redaction-test-token-000000000000",
				],
				relationships: [],
			},
		});

		expect(result.parsed.facts).toEqual([]);
		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(runtime.createMemory).not.toHaveBeenCalled();
	});

	it("filters secret-like relationship endpoints before calling the model", async () => {
		const runtime = makeRuntime("");
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: {
				relationships: [
					{
						subject: "user",
						predicate: "owns_api_key",
						object: "csk-redaction-test-token-000000000000",
					},
				],
			},
		});

		expect(result.parsed.relationships).toEqual([]);
		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(runtime.createMemory).not.toHaveBeenCalled();
	});

	it("skips synthetic compaction messages before candidate filtering", async () => {
		const runtime = makeRuntime("");
		const synthetic = {
			...makeMessage(),
			content: { text: "[conversation summary] user likes squash" },
			metadata: { source: "conversation-compaction", tags: ["compaction"] },
		} as Memory;

		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: synthetic,
			state: makeState(),
			extract: { facts: ["the user likes squash"] },
		});

		expect(result.parsed.thought).toBe("synthetic message skipped");
		expect(runtime.useModel).not.toHaveBeenCalled();
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
