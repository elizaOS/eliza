/**
 * Covers the Stage-1 facts/relationships extraction: parseFactsAndRelationshipsOutput
 * across the text and tool-call (arguments/input/args/params) response shapes, and
 * runFactsAndRelationshipsStage's candidate filtering, secret-like redaction,
 * persistence, and voice/text extraction parity. Deterministic — a mock runtime
 * whose useModel/getMemories/createMemory are vi.fn, no live model or DB.
 */
import { describe, expect, it, vi } from "vitest";
import type { Memory } from "../../types/memory";
import { ModelType } from "../../types/model";
import { ChannelType, type UUID } from "../../types/primitives";
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

// The facts stage no longer scrapes room entities off the Stage-1 provider
// state (that path was dead — it read data.entities but the ENTITIES provider
// publishes data.entitiesData, and #13195 defers the provider off Stage-1
// entirely). Room entities are now fetched directly via getEntityDetails, which
// the mock runtime backs with getRoom + getEntitiesForRoom below. State is
// therefore just an empty carrier here.
function makeState(): State {
	return {
		values: {},
		data: { providers: {} },
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
		// Backs getEntityDetails({ runtime, roomId }) — the facts stage now sources
		// room entities here instead of scraping Stage-1 provider state (#13196).
		getRoom: vi.fn(async () => ({
			id: "00000000-0000-0000-0000-000000000003" as UUID,
			source: "test",
		})),
		getEntitiesForRoom: vi.fn(async () => [
			{
				id: "00000000-0000-0000-0000-0000000000a1" as UUID,
				names: ["Alice"],
				components: [],
				metadata: {},
			},
			{
				id: "00000000-0000-0000-0000-0000000000b2" as UUID,
				names: ["Bob"],
				components: [],
				metadata: {},
			},
		]),
		reportError: vi.fn(),
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
					// Stage-1 facts are unverified single-message extractions: they
					// must be classified as time-decaying `current` (not the reader's
					// `durable` default) with explicit confidence/category/validAt so
					// they never persist as permanent durable identity claims.
					kind: "current",
					category: "uncategorized",
					confidence: 0.6,
					verificationStatus: "self_reported",
					validAt: expect.any(String),
				}),
			}),
			"facts",
			true,
		);
	});

	it("carries the provider that served THIS TEXT_LARGE call on the result (#13623)", async () => {
		const runtime = makeRuntime(
			JSON.stringify({ facts: ["a fact"], relationships: [], thought: "t" }),
		);
		// The facts stage must capture the provider synchronously at call time; the
		// mock resolves TEXT_LARGE via "cerebras".
		(
			runtime as unknown as {
				getLastResolvedModelProvider: (m: string) => string | undefined;
			}
		).getLastResolvedModelProvider = vi.fn((modelType: string) =>
			modelType === ModelType.TEXT_LARGE ? "cerebras" : undefined,
		);

		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: { facts: ["a fact"] },
		});

		expect(result.provider).toBe("cerebras");
	});

	it("leaves provider undefined (never fabricated) when the runtime can't report it (#13623)", async () => {
		const runtime = makeRuntime(
			JSON.stringify({ facts: ["a fact"], relationships: [], thought: "t" }),
		);
		// No getLastResolvedModelProvider on this runtime — the optional call must
		// leave provider undefined, not fabricate a value.
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: makeState(),
			extract: { facts: ["a fact"] },
		});

		expect(result.provider).toBeUndefined();
	});

	// #13196: room-entity grounding must come from getEntityDetails, NOT from
	// scraping the Stage-1 provider state. Two prior defects made the old path
	// dead: (1) it read state...providers.ENTITIES.data.entities but the ENTITIES
	// provider publishes data.entitiesData, and (2) #13195 deferred the ENTITIES
	// provider off the Stage-1 execution path entirely, so the state has no
	// ENTITIES entry to scrape. Prove the grounding survives an EMPTY Stage-1
	// state as long as the room has participants.
	it("grounds room_entities from getEntityDetails even when Stage-1 state carries no ENTITIES entry (#13196)", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: ["the user works with Alice"],
				relationships: [
					{ subject: "user", predicate: "works_with", object: "Alice" },
				],
				thought: "new",
			}),
		);
		// Empty state: no providers.ENTITIES at all (matches post-#13195 Stage-1).
		const emptyState: State = {
			values: {},
			data: { providers: {} },
			text: "",
		};
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: emptyState,
			extract: {
				facts: ["the user works with Alice"],
				relationships: [
					{ subject: "user", predicate: "works_with", object: "Alice" },
				],
			},
		});

		// Room entities came from getEntityDetails, not state.
		expect(runtime.getEntitiesForRoom).toHaveBeenCalledWith(
			makeMessage().roomId,
			true,
		);
		const validationCall = runtime.useModel.mock.calls.find(
			(call) =>
				typeof call[0] === "string" &&
				(call[0] === ModelType.TEXT_LARGE || call[0] === "TEXT_LARGE"),
		);
		const params = validationCall?.[1] as {
			messages?: Array<{ role: string; content: string }>;
		};
		// The room_entities: grounding block is present with the resolved UUID
		// (the whole point of the audit's "prefer that UUID" rule).
		expect(params.messages?.[1]?.content).toContain("room_entities:");
		expect(params.messages?.[1]?.content).toContain(
			"Alice (id: 00000000-0000-0000-0000-0000000000a1)",
		);
		// And persist-time name->UUID resolution used the room entity: the
		// relationship edge's target resolves to Alice's UUID (not undefined).
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					sourceEntityId: makeMessage().entityId,
					targetEntityId: "00000000-0000-0000-0000-0000000000a1",
				}),
			}),
			"facts",
			true,
		);
		expect(result.written.relationships).toBe(1);
	});

	// #13196 P2 (codex): getEntityDetails returns EVERY room participant (no
	// display cap), so a busy room must not flood the room_entities: prompt
	// block. The grounding set is bounded to 12, prioritizing entities whose
	// names match a candidate relationship subject/object.
	it("bounds room_entities to 12 and prioritizes candidate-named entities in a large room (#13196 P2)", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: [],
				relationships: [
					{ subject: "user", predicate: "works_with", object: "Zoey" },
				],
				thought: "new",
			}),
		);
		// 40 participants; "Zoey" (candidate object) is intentionally last so a
		// naive slice(0,12) would drop it. The bounding must still surface it.
		const many = Array.from({ length: 39 }, (_, i) => ({
			id: `00000000-0000-0000-0000-0000000${String(i).padStart(5, "0")}` as UUID,
			names: [`Person${i}`],
			components: [],
			metadata: {},
		}));
		const zoe = {
			id: "00000000-0000-0000-0000-0000000000a9" as UUID,
			names: ["Zoey"],
			components: [],
			metadata: {},
		};
		(
			runtime.getEntitiesForRoom as ReturnType<typeof vi.fn>
		).mockResolvedValueOnce([...many, zoe]);
		await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: { values: {}, data: { providers: {} }, text: "" },
			extract: {
				relationships: [
					{ subject: "user", predicate: "works_with", object: "Zoey" },
				],
			},
		});
		const validationCall = runtime.useModel.mock.calls.find(
			(call) =>
				typeof call[0] === "string" &&
				(call[0] === ModelType.TEXT_LARGE || call[0] === "TEXT_LARGE"),
		);
		const params = validationCall?.[1] as {
			messages?: Array<{ role: string; content: string }>;
		};
		const content = params.messages?.[1]?.content ?? "";
		// Isolate just the room_entities: block (blocks are separated by a blank
		// line), so the candidate lines (also `- ` prefixed) aren't miscounted.
		const roomBlock =
			content
				.split("\n\n")
				.find((block) => block.startsWith("room_entities:")) ?? "";
		const entityLines = roomBlock
			.split("\n")
			.filter((line) => line.startsWith("- "));
		// Capped at 12 lines.
		expect(entityLines.length).toBe(12);
		// The candidate-named entity survived the cap.
		expect(content).toContain("Zoey (id:");
	});

	// Fail-closed: a broken getEntityDetails must surface via reportError and
	// degrade to no grounding, never crash the stage (error-policy:J7).
	it("reports and degrades (no crash) when room-entity fetch fails (#13196)", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: ["the user's birthday is March 5"],
				relationships: [],
				thought: "ok",
			}),
		);
		(
			runtime.getEntitiesForRoom as ReturnType<typeof vi.fn>
		).mockRejectedValueOnce(new Error("boom"));
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(),
			state: { values: {}, data: { providers: {} }, text: "" },
			extract: { facts: ["the user's birthday is March 5"] },
		});
		// Stage still completed and persisted the fact.
		expect(result.written.facts).toBe(1);
		// Failure surfaced, not swallowed.
		expect(runtime.reportError).toHaveBeenCalledWith(
			"FactsAndRelationships.fetchRoomEntities",
			expect.any(Error),
			expect.objectContaining({ roomId: makeMessage().roomId }),
		);
		// No room_entities: block when grounding is unavailable.
		const validationCall = runtime.useModel.mock.calls.find(
			(call) =>
				typeof call[0] === "string" &&
				(call[0] === ModelType.TEXT_LARGE || call[0] === "TEXT_LARGE"),
		);
		const params = validationCall?.[1] as {
			messages?: Array<{ role: string; content: string }>;
		};
		expect(params.messages?.[1]?.content).not.toContain("room_entities:");
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

// ── Voice extraction parity (#8786) ──────────────────────────────────────────
//
// Regression-proves criterion 5: a voice message (VOICE_DM / VOICE_GROUP) runs
// the IDENTICAL facts/relationships extraction as the same text message. The
// stage must never branch on channel type — if a future change added an
// `if (isVoiceChannelMessage) skip` it would drop name/relationship inference
// from speech ("John is my brother"), exactly the bug #8786 set out to prevent.
describe("runFactsAndRelationshipsStage — voice/text parity (#8786)", () => {
	function messageOn(channelType?: ChannelType): Memory {
		return {
			id: "00000000-0000-0000-0000-00000000aaaa" as UUID,
			entityId: "00000000-0000-0000-0000-000000000001" as UUID,
			agentId: "00000000-0000-0000-0000-000000000002" as UUID,
			roomId: "00000000-0000-0000-0000-000000000003" as UUID,
			content: {
				text: "John is my brother",
				source: "test",
				...(channelType ? { channelType } : {}),
			},
			createdAt: 1,
		};
	}

	const MODEL_RESPONSE = JSON.stringify({
		facts: ["the user has a brother named John"],
		relationships: [
			{ subject: "user", predicate: "has_brother", object: "John" },
		],
		thought: "new family relationship",
	});

	const EXTRACT = {
		facts: ["the user has a brother named John"],
		relationships: [
			{ subject: "user", predicate: "has_brother", object: "John" },
		],
	};

	async function runOn(channelType?: ChannelType) {
		const runtime = makeRuntime(MODEL_RESPONSE);
		const result = await runFactsAndRelationshipsStage({
			runtime,
			message: messageOn(channelType),
			state: makeState(),
			extract: EXTRACT,
		});
		return { runtime, result };
	}

	it("VOICE_DM extracts the same facts + relationships as a text message", async () => {
		const text = await runOn();
		const voice = await runOn(ChannelType.VOICE_DM);

		// Identical parsed extraction.
		expect(voice.result.parsed.facts).toEqual(text.result.parsed.facts);
		expect(voice.result.parsed.relationships).toEqual(
			text.result.parsed.relationships,
		);
		// Identical persistence (the name/relationship is written either way).
		expect(voice.result.written).toEqual(text.result.written);
		expect(voice.result.written.facts).toBe(1);
		expect(voice.result.written.relationships).toBe(1);
		// The extraction model was invoked for the voice turn just like text.
		expect(voice.runtime.useModel).toHaveBeenCalled();
		expect(voice.runtime.createRelationship).toHaveBeenCalledTimes(
			text.runtime.createRelationship.mock.calls.length,
		);
	});

	it("VOICE_GROUP also runs the identical extraction (no channel gate)", async () => {
		const text = await runOn();
		const group = await runOn(ChannelType.VOICE_GROUP);
		expect(group.result.parsed.facts).toEqual(text.result.parsed.facts);
		expect(group.result.parsed.relationships).toEqual(
			text.result.parsed.relationships,
		);
		expect(group.result.written).toEqual(text.result.written);
	});
});
