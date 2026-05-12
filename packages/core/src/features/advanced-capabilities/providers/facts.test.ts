import { afterEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "../../../types/index.ts";
import { factsProvider } from "./facts.ts";

const agentId = "00000000-0000-0000-0000-0000000000aa" as UUID;
const entityId = "00000000-0000-0000-0000-0000000000bb" as UUID;
const roomId = "00000000-0000-0000-0000-0000000000cc" as UUID;

function memory(
	id: string,
	text: string,
	metadata: Record<string, unknown> = {},
	createdAt = Date.now(),
): Memory {
	return {
		id: id as UUID,
		entityId,
		agentId,
		roomId,
		content: { text },
		metadata,
		createdAt,
	};
}

function makeRuntime(args: {
	facts: Memory[];
	recentMessages?: Memory[];
}): IAgentRuntime & {
	getMemories: ReturnType<typeof vi.fn>;
	useModel: ReturnType<typeof vi.fn>;
} {
	const runtime = {
		agentId,
		character: { name: "Eliza", bio: "", system: "" },
		getService: vi.fn(() => null),
		getMemories: vi.fn(async (params: { tableName: string }) => {
			if (params.tableName === "messages") {
				return args.recentMessages ?? [];
			}
			if (params.tableName === "facts") {
				return args.facts;
			}
			return [];
		}),
		useModel: vi.fn(async () => {
			throw new Error("FACTS provider must not request embeddings");
		}),
	};
	return runtime as unknown as IAgentRuntime & {
		getMemories: ReturnType<typeof vi.fn>;
		useModel: ReturnType<typeof vi.fn>;
	};
}

describe("factsProvider keyword retrieval", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("retrieves matching facts with BM25 keywords without calling embeddings", async () => {
		const runtime = makeRuntime({
			recentMessages: [memory("msg-1", "Berlin keeps coming up today")],
			facts: [
				memory("fact-1", "the user lives in Berlin", {
					kind: "durable",
					category: "identity",
					confidence: 0.9,
					keywords: ["berlin", "lives"],
				}),
				memory("fact-2", "the user likes Tokyo hotels", {
					kind: "durable",
					category: "preference",
					confidence: 0.9,
					keywords: ["tokyo", "hotels"],
				}),
			],
		});

		const result = await factsProvider.get(
			runtime,
			memory("msg-current", "Do you remember anything about Berlin?", {
				source: "test",
			}),
			{ values: {}, data: {}, text: "" },
		);

		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(runtime.getMemories).toHaveBeenCalledWith(
			expect.objectContaining({ tableName: "facts", count: 120 }),
		);
		expect(result.text).toContain("the user lives in Berlin");
		expect(result.text).not.toContain("Tokyo hotels");
	});

	it("uses stored keywords even when the exact query word is not in fact text", async () => {
		const runtime = makeRuntime({
			facts: [
				memory("fact-1", "the user prefers aisle seats", {
					kind: "durable",
					category: "preference",
					confidence: 0.8,
					keywords: ["flight", "seat", "aisle"],
				}),
			],
		});

		const result = await factsProvider.get(
			runtime,
			memory("msg-current", "Book the flight with my seat preference"),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).toContain("the user prefers aisle seats");
	});

	it("applies current-fact time weighting after keyword relevance", async () => {
		// bun's vitest compat layer doesn't implement vi.useFakeTimers /
		// vi.setSystemTime, so pin Date.now() directly. This is the only
		// timestamp facts.ts reads when ranking current facts.
		const fixedNow = Date.parse("2026-05-11T12:00:00.000Z");
		const _nowSpy = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
		const runtime = makeRuntime({
			facts: [
				memory(
					"fact-old",
					"the user is anxious about launch",
					{
						kind: "current",
						category: "feeling",
						confidence: 0.9,
						keywords: ["anxious", "launch"],
						validAt: "2026-03-01T12:00:00.000Z",
					},
					Date.parse("2026-03-01T12:00:00.000Z"),
				),
				memory(
					"fact-new",
					"the user is anxious about launch today",
					{
						kind: "current",
						category: "feeling",
						confidence: 0.7,
						keywords: ["anxious", "launch"],
						validAt: "2026-05-11T09:00:00.000Z",
					},
					Date.parse("2026-05-11T09:00:00.000Z"),
				),
			],
		});

		const result = await factsProvider.get(
			runtime,
			memory("msg-current", "I am still anxious about launch"),
			{ values: {}, data: {}, text: "" },
		);

		const currentFacts = result.data.currentFacts as Memory[];
		expect(currentFacts.map((fact) => fact.id)).toEqual([
			"fact-new",
			"fact-old",
		]);
	});
});
