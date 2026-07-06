/**
 * Deterministic unit tests for the reflection evaluators (reflection-items.ts):
 * fact keyword dedupe / strengthen without embeddings, the strict-structured-output
 * schema invariant across every reflection schema, and the tolerant per-op
 * factExtractor parse. Runtime and model are vi.fn stubs — no live model, no DB.
 */
import { describe, expect, it, vi } from "vitest";
import { logger } from "../../../logger.ts";
import type {
	Entity,
	EvaluatorProcessorContext,
	IAgentRuntime,
	Memory,
	UUID,
} from "../../../types/index.ts";
import { parseExtractorOutputTolerant } from "./factExtractor.schema.ts";
import {
	factMemoryEvaluator,
	REFLECTION_ENTITY_LIMIT,
	relationshipEvaluator,
} from "./reflection-items.ts";

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

describe("reflection evaluator schemas are strict-structured-output safe", () => {
	// Strict-mode validators (Cerebras, Groq, OpenAI strict) reject any object
	// node that lacks an explicit `properties` map or allows additional
	// properties — the WHOLE extraction request 400s ("Bad Request"), so the
	// agent silently never writes fact/relationship memories. Walk every
	// evaluator's response schema and assert the invariant on each object node.
	function assertStrictObjectNodes(node: unknown, path: string): void {
		if (node === null || typeof node !== "object") return;
		if (Array.isArray(node)) {
			node.forEach((item, i) => {
				assertStrictObjectNodes(item, `${path}[${i}]`);
			});
			return;
		}
		const record = node as Record<string, unknown>;
		// Strict mode also rejects value-constraint keywords (maxItems,
		// minItems, maxLength, pattern, minimum, ...) — enforce caps in code,
		// never on the wire.
		for (const banned of [
			"maxItems",
			"minItems",
			"uniqueItems",
			"maxLength",
			"minLength",
			"pattern",
			"format",
			"minimum",
			"maximum",
			"multipleOf",
			"minProperties",
			"maxProperties",
		]) {
			expect(
				record[banned],
				`${path} must not use strict-unsupported keyword "${banned}"`,
			).toBeUndefined();
		}
		if (record.type === "object") {
			expect(record.properties, `${path} must declare properties`).toBeTypeOf(
				"object",
			);
			expect(
				record.additionalProperties,
				`${path} must set additionalProperties: false`,
			).toBe(false);
		}
		for (const [key, value] of Object.entries(record)) {
			assertStrictObjectNodes(value, `${path}.${key}`);
		}
	}

	it("every object node in every reflection schema has explicit properties + additionalProperties:false", async () => {
		const { reflectionItems } = await import("./reflection-items.ts");
		// preferenceItems ships in the same merged post-turn call, so its wire
		// schema must satisfy the identical strict-mode invariant.
		const { preferenceItems } = await import("./preference-items.ts");
		for (const evaluator of [...reflectionItems, ...preferenceItems]) {
			const schema = (evaluator as { schema?: unknown }).schema;
			if (!schema) continue;
			assertStrictObjectNodes(schema, evaluator.name ?? "evaluator");
		}
	});

	it("fact extraction advertises structured fields consumed by LifeOps projections", () => {
		const schema = factMemoryEvaluator.schema as {
			properties?: {
				ops?: {
					items?: {
						properties?: {
							structured_fields?: {
								properties?: Record<string, unknown>;
								additionalProperties?: boolean;
							};
						};
					};
				};
			};
		};
		const structured =
			schema.properties?.ops?.items?.properties?.structured_fields;
		expect(structured?.additionalProperties).toBe(false);
		expect(structured?.properties).toMatchObject({
			preferredName: { type: "string" },
			person: { type: "string" },
			relationshipType: { type: "string" },
			platform: { type: "string" },
			handle: { type: "string" },
			travelBookingPreferences: { type: "string" },
			timezone: { type: "string" },
		});
	});

	it("fact extraction prompt names structured fields on the production evaluator path", () => {
		const prompt = factMemoryEvaluator.prompt?.({
			runtime: makeRuntime(),
			message: message(
				"Je m'appelle Camille et mon fuseau horaire est Europe/Paris",
			),
			state: { values: {}, data: {}, text: "" },
			options: {},
			evaluatorName: "factMemory",
			prepared: {
				recentMessages: [message("Je m'appelle Camille")],
				existingRelationships: [],
				entities: [],
				knownFacts: [],
			},
		});
		expect(prompt).toContain("structured_fields");
		expect(prompt).toContain("Use English key names");
		expect(prompt).toContain("preferredName");
		expect(prompt).toContain("relationshipType");
		expect(prompt).toContain("travelBookingPreferences");
	});
});

describe("factExtractor tolerant parsing (#11235)", () => {
	it("accepts an add op that omits structured_fields (wire-optional)", () => {
		const parsed = parseExtractorOutputTolerant({
			ops: [
				{ op: "add_durable", claim: "lives in Berlin", category: "identity" },
			],
		});
		expect(parsed).not.toBeNull();
		expect(parsed?.ops).toHaveLength(1);
		// The default keeps structured_fields a concrete record for downstream use.
		expect(parsed?.ops[0]).toMatchObject({
			op: "add_durable",
			structured_fields: {},
		});
	});

	it("accepts fenced JSON text that uses type as the op discriminator", () => {
		const parsed = parseExtractorOutputTolerant(`\`\`\`json
{
  "ops": [
    {
      "type": "add_durable",
      "claim": "User's preferred name is Camille and timezone is Europe/Paris.",
      "category": "identity",
      "keywords": ["name", "camille", "timezone", "europe/paris"],
      "structured_fields": {
        "preferredName": "Camille",
        "timezone": "Europe/Paris"
      }
    }
  ]
}
\`\`\``);

		expect(parsed?.ops).toEqual([
			expect.objectContaining({
				op: "add_durable",
				category: "identity",
				structured_fields: {
					preferredName: "Camille",
					timezone: "Europe/Paris",
				},
			}),
		]);
	});

	it("keeps valid ops when one op is malformed, and warns about the drop", () => {
		// The evaluator parse contract (`parse?(output): TOutput | null`) has no
		// runtime/logger, so the drop MUST be logged where it is computed —
		// otherwise per-op loss is silent in prod (the regression #11241 killed).
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const parsed = parseExtractorOutputTolerant({
				ops: [
					{ op: "add_durable", claim: "likes tea", category: "preference" },
					{ op: "contradict" }, // invalid: missing required factId + reason
					{ op: "strengthen", factId: "fact-123" },
				],
			});
			expect(parsed).not.toBeNull();
			expect(parsed?.ops.map((o) => o.op)).toEqual([
				"add_durable",
				"strengthen",
			]);
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					src: "factMemory",
					count: 1,
					issues: [expect.stringContaining("factId")],
				}),
				"dropped malformed extractor op(s)",
			);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("does not warn when every op parses", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			parseExtractorOutputTolerant({
				ops: [{ op: "strengthen", factId: "fact-123" }],
			});
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("returns null only when the envelope itself is not { ops: array }", () => {
		expect(parseExtractorOutputTolerant({ nope: true })).toBeNull();
		expect(parseExtractorOutputTolerant(null)).toBeNull();
		// An empty ops array is a VALID (zero-op) turn, not a parse failure.
		expect(parseExtractorOutputTolerant({ ops: [] })).toEqual({ ops: [] });
	});
});

describe("reflection context bounds the room entity slice (#15087)", () => {
	const authorId = "00000000-0000-0000-0000-0000000000cf" as UUID;

	function subAgentEntityId(index: number): UUID {
		return `00000000-0000-0000-0001-${String(index).padStart(12, "0")}` as UUID;
	}

	// Names are chosen so the human participants sort AFTER every sub-agent
	// entity — getEntityDetails returns the room alphabetically, so a naive
	// slice would drop exactly the entities the extractors need.
	function roomEntities(subAgentCount: number): Entity[] {
		const entities: Entity[] = [
			{ id: agentId, agentId, names: ["zed-agent"], metadata: {} },
			{ id: entityId, agentId, names: ["zoe-sender"], metadata: {} },
			{ id: authorId, agentId, names: ["yuki-author"], metadata: {} },
		];
		for (let index = 0; index < subAgentCount; index += 1) {
			entities.push({
				id: subAgentEntityId(index),
				agentId,
				names: [
					`sub-agent: Build and deploy web app number ${index} — ${"with detailed task requirements ".repeat(16)}`,
				],
				metadata: {},
			});
		}
		return entities;
	}

	function contextRuntime(entities: Entity[]): IAgentRuntime {
		return {
			agentId,
			getMemories: vi.fn(async () => [
				{
					id: "00000000-0000-0000-0000-0000000000d1" as UUID,
					entityId,
					agentId,
					roomId,
					content: { text: "can you check the weather for me?" },
					createdAt: 1,
				},
				{
					id: "00000000-0000-0000-0000-0000000000d2" as UUID,
					entityId: authorId,
					agentId,
					roomId,
					content: { text: "ping me when it's done" },
					createdAt: 2,
				},
			]),
			getRelationships: vi.fn(async () => []),
			getRoom: vi.fn(async () => null),
			getEntitiesForRoom: vi.fn(async () => entities),
		} as unknown as IAgentRuntime;
	}

	async function prepareContext(runtime: IAgentRuntime) {
		const prepared = await relationshipEvaluator.prepare?.({
			runtime,
			message: message(),
			state: { values: {}, data: {}, text: "" },
			options: {},
		});
		if (!prepared) throw new Error("relationship prepare returned nothing");
		return prepared;
	}

	it("keeps conversation participants and caps the remainder in an entity-flooded room", async () => {
		// 850 sub-agent entities observed live; 400 is just as far past the cap.
		const runtime = contextRuntime(roomEntities(400));
		const prepared = await prepareContext(runtime);

		expect(prepared.entities).toHaveLength(REFLECTION_ENTITY_LIMIT);
		const keptIds = new Set(prepared.entities.map((entity) => entity.id));
		expect(keptIds.has(agentId)).toBe(true);
		expect(keptIds.has(entityId)).toBe(true);
		expect(keptIds.has(authorId)).toBe(true);
		// Participants lead the slice; the sub-agent flood fills the remainder.
		expect(
			prepared.entities
				.slice(0, 3)
				.map((entity) => entity.id)
				.sort(),
		).toEqual([agentId, entityId, authorId].sort());
	});

	it("renders a bounded Entities-in-Room block into the relationships prompt", async () => {
		const runtime = contextRuntime(roomEntities(400));
		const prepared = await prepareContext(runtime);

		const prompt = relationshipEvaluator.prompt({
			runtime,
			message: message(),
			state: { values: {}, data: {}, text: "" },
			options: {},
			evaluatorName: "relationships",
			prepared,
		});
		// Pre-fix, 400 entities with ~550-char task-description names rendered a
		// ~220KB block; the slice cap + per-line name bound keep the whole section
		// prompt-sized for the TEXT_SMALL tier.
		expect(prompt.length).toBeLessThan(20_000);
		expect(prompt).toContain("…[truncated]");
		expect(prompt).toContain(entityId);
	});

	it("passes rooms under the cap through untouched", async () => {
		const entities = roomEntities(3);
		const runtime = contextRuntime(entities);
		const prepared = await prepareContext(runtime);
		expect(prepared.entities).toHaveLength(entities.length);
	});
});
