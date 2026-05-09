import { describe, expect, it, vi } from "vitest";
import type { Memory, UUID } from "../../../types";
import { MemoryType, ModelType } from "../../../types";
import { bm25Scores, normalizeBm25Scores, tokenize } from "../bm25";
import { DocumentService } from "../service";

// ── BM25 unit tests ────────────────────────────────────────────────────────

describe("tokenize", () => {
	it("lowercases and splits on whitespace", () => {
		expect(tokenize("Hello World")).toEqual(["hello", "world"]);
	});

	it("strips punctuation", () => {
		expect(tokenize("foo, bar! baz.")).toEqual(["foo", "bar", "baz"]);
	});

	it("returns empty array for blank input", () => {
		expect(tokenize("  ")).toEqual([]);
		expect(tokenize("")).toEqual([]);
	});

	it("keeps numbers", () => {
		expect(tokenize("agent007 is alive")).toEqual(["agent007", "is", "alive"]);
	});
});

describe("bm25Scores", () => {
	const docs = [
		{ id: "d1", text: "The quick brown fox jumps over the lazy dog" },
		{ id: "d2", text: "A fast fox ran quickly through the forest" },
		{ id: "d3", text: "Banana apple mango tropical fruits" },
	];
	const scoreById = (
		scores: ReturnType<typeof bm25Scores>,
		id: string,
	): number => {
		const match = scores.find((s) => s.id === id);
		expect(match).toBeDefined();
		return match?.score ?? Number.NaN;
	};

	it("returns a score entry for every document", () => {
		const scores = bm25Scores("fox", docs);
		expect(scores).toHaveLength(docs.length);
		expect(scores.map((s) => s.id)).toEqual(["d1", "d2", "d3"]);
	});

	it("gives positive scores to docs containing the query term", () => {
		const scores = bm25Scores("fox", docs);
		expect(scoreById(scores, "d1")).toBeGreaterThan(0);
		expect(scoreById(scores, "d2")).toBeGreaterThan(0);
		expect(scoreById(scores, "d3")).toBe(0); // "fox" not in d3
	});

	it("scores docs with the rarest matching term higher (IDF effect)", () => {
		// "fox" appears in d1 and d2; "lazy" appears only in d1
		const scores = bm25Scores("lazy", docs);
		expect(scoreById(scores, "d1")).toBeGreaterThan(0);
		expect(scoreById(scores, "d2")).toBe(0);
	});

	it("returns all-zero scores for empty query", () => {
		const scores = bm25Scores("", docs);
		for (const s of scores) {
			expect(s.score).toBe(0);
		}
	});

	it("returns empty array for empty corpus", () => {
		expect(bm25Scores("fox", [])).toEqual([]);
	});
});

describe("normalizeBm25Scores", () => {
	it("scales max score to 1", () => {
		const scores = [
			{ id: "a", score: 0 },
			{ id: "b", score: 5 },
			{ id: "c", score: 10 },
		];
		const norm = normalizeBm25Scores(scores);
		expect(norm.find((s) => s.id === "c")?.score).toBeCloseTo(1);
		expect(norm.find((s) => s.id === "b")?.score).toBeCloseTo(0.5);
		expect(norm.find((s) => s.id === "a")?.score).toBeCloseTo(0);
	});

	it("returns unchanged when all scores are zero", () => {
		const scores = [
			{ id: "a", score: 0 },
			{ id: "b", score: 0 },
		];
		const norm = normalizeBm25Scores(scores);
		expect(norm.every((s) => s.score === 0)).toBe(true);
	});
});

// ── DocumentService.searchDocuments integration-style tests ───────────────

function makeFragment(
	id: string,
	text: string,
	similarity?: number,
	metadata: Record<string, unknown> = {},
): Memory {
	return {
		id: id as UUID,
		agentId: "agent-1" as UUID,
		roomId: "room-1" as UUID,
		content: { text },
		metadata: {
			type: MemoryType.FRAGMENT,
			documentId: "doc-1" as UUID,
			position: 0,
			timestamp: Date.now(),
			...metadata,
		},
		createdAt: Date.now(),
		...(similarity !== undefined ? { similarity } : {}),
	};
}

function buildRuntime(opts: { hasEmbedding: boolean; fragments?: Memory[] }) {
	const fragments = opts.fragments ?? [];
	const agentId = "agent-1" as UUID;

	return {
		agentId,
		getModel: vi.fn((modelType: string) => {
			if (modelType === ModelType.TEXT_EMBEDDING) {
				return opts.hasEmbedding ? vi.fn() : undefined;
			}
			return undefined;
		}),
		useModel: vi.fn(async (_modelType: string, _params: unknown) => {
			// Return a fake embedding array
			return Array.from({ length: 8 }, () => Math.random());
		}),
		searchMemories: vi.fn(async (_params: unknown) => fragments),
		getMemories: vi.fn(async (_params: unknown) => fragments),
	};
}

function buildService(
	runtime: ReturnType<typeof buildRuntime>,
): DocumentService {
	// DocumentService constructor accepts runtime as first param
	const svc = new (
		DocumentService as unknown as new (
			runtime: unknown,
		) => DocumentService
	)(runtime);
	return svc;
}

function makeMessage(text: string, entityId?: UUID): Memory {
	return {
		id: "msg-1" as UUID,
		agentId: "agent-1" as UUID,
		roomId: "room-1" as UUID,
		...(entityId ? { entityId } : {}),
		content: { text },
		createdAt: Date.now(),
	};
}

describe("DocumentService.searchDocuments", () => {
	describe("empty / invalid input", () => {
		it("returns empty array for empty message text", async () => {
			const rt = buildRuntime({ hasEmbedding: true });
			const svc = buildService(rt);
			const result = await svc.searchDocuments(makeMessage(""), undefined);
			expect(result).toEqual([]);
		});

		it("returns empty array for whitespace-only message text", async () => {
			const rt = buildRuntime({ hasEmbedding: true });
			const svc = buildService(rt);
			const result = await svc.searchDocuments(makeMessage("   "), undefined);
			expect(result).toEqual([]);
		});
	});

	describe("vector-only mode", () => {
		it("delegates to searchMemories and maps results", async () => {
			const frag = makeFragment(
				"frag-1",
				"The capital of France is Paris",
				0.9,
			);
			const rt = buildRuntime({ hasEmbedding: true, fragments: [frag] });
			const svc = buildService(rt);

			const results = await svc.searchDocuments(
				makeMessage("capital of France"),
				undefined,
				"vector",
			);

			expect(rt.searchMemories).toHaveBeenCalledOnce();
			expect(rt.getMemories).not.toHaveBeenCalled();
			expect(results).toHaveLength(1);
			expect(results[0].id).toBe("frag-1");
		});

		it("filters out fragments with no id", async () => {
			const frag = makeFragment("", "orphan fragment", 0.8);
			frag.id = undefined as unknown as UUID;
			const rt = buildRuntime({ hasEmbedding: true, fragments: [frag] });
			const svc = buildService(rt);

			const results = await svc.searchDocuments(
				makeMessage("orphan"),
				undefined,
				"vector",
			);
			expect(results).toHaveLength(0);
		});
	});

	describe("keyword-only mode", () => {
		it("uses getMemories (not searchMemories) and scores via BM25", async () => {
			const fragments = [
				makeFragment("frag-a", "quantum computing and qubits"),
				makeFragment("frag-b", "classical computing transistors"),
				makeFragment("frag-c", "banana smoothie recipe"),
			];
			const rt = buildRuntime({ hasEmbedding: false, fragments });
			const svc = buildService(rt);

			const results = await svc.searchDocuments(
				makeMessage("quantum computing"),
				undefined,
				"keyword",
			);

			expect(rt.searchMemories).not.toHaveBeenCalled();
			expect(rt.getMemories).toHaveBeenCalledOnce();

			// frag-a should score highest (both "quantum" and "computing" match)
			expect(results[0].id).toBe("frag-a");
			// frag-b has "computing" but not "quantum"
			expect(results.map((r) => r.id)).toContain("frag-b");
			// frag-c has neither term — should be excluded (score 0)
			expect(results.map((r) => r.id)).not.toContain("frag-c");
		});

		it("returns empty when no fragments match the query", async () => {
			const fragments = [makeFragment("frag-x", "completely unrelated text")];
			const rt = buildRuntime({ hasEmbedding: false, fragments });
			const svc = buildService(rt);

			const results = await svc.searchDocuments(
				makeMessage("quantum"),
				undefined,
				"keyword",
			);
			expect(results).toHaveLength(0);
		});

		it("filters user-private fragments to the scoped user", async () => {
			const userOne = "user-1" as UUID;
			const userTwo = "user-2" as UUID;
			const fragments = [
				makeFragment("frag-owned", "private launch note", undefined, {
					scope: "user-private",
					scopedToEntityId: userOne,
					addedBy: userOne,
				}),
				makeFragment("frag-other", "private launch note", undefined, {
					scope: "user-private",
					scopedToEntityId: userTwo,
					addedBy: userTwo,
				}),
			];
			const rt = buildRuntime({ hasEmbedding: false, fragments });
			const svc = buildService(rt);

			const results = await svc.searchDocuments(
				makeMessage("launch", userOne),
				undefined,
				"keyword",
			);

			expect(results.map((result) => result.id)).toEqual(["frag-owned"]);
		});
	});

	describe("hybrid mode", () => {
		it("BM25 lifts keyword match when vector similarities are equal", async () => {
			// When vector similarity is identical, BM25 keyword match breaks the tie.
			// frag-a: same vector score, no keyword match on "quantum"
			// frag-b: same vector score, strong keyword match on "quantum"
			const fragA = makeFragment("frag-a", "abstract unrelated concepts", 0.5);
			const fragB = makeFragment(
				"frag-b",
				"quantum computing qubits quantum",
				0.5,
			);
			const rt = buildRuntime({
				hasEmbedding: true,
				fragments: [fragA, fragB],
			});
			const svc = buildService(rt);

			const results = await svc.searchDocuments(
				makeMessage("quantum"),
				undefined,
				"hybrid",
			);

			expect(rt.searchMemories).toHaveBeenCalledOnce();
			expect(rt.getMemories).not.toHaveBeenCalled();
			expect(results).toHaveLength(2);

			// frag-b should be ranked higher because BM25 breaks the vector tie
			expect(results[0].id).toBe("frag-b");
		});

		it("all result similarities are in [0, 1]", async () => {
			const fragments = [
				makeFragment("frag-1", "the quick brown fox", 0.8),
				makeFragment("frag-2", "lazy dog over fence", 0.5),
				makeFragment("frag-3", "unrelated banana smoothie", 0.2),
			];
			const rt = buildRuntime({ hasEmbedding: true, fragments });
			const svc = buildService(rt);

			const results = await svc.searchDocuments(
				makeMessage("fox"),
				undefined,
				"hybrid",
			);

			for (const r of results) {
				expect(r.similarity).toBeGreaterThanOrEqual(0);
				expect(r.similarity).toBeLessThanOrEqual(1);
			}
		});
	});

	describe("fallback: no embedding model", () => {
		it("falls back to keyword mode when no TEXT_EMBEDDING model is registered", async () => {
			const fragments = [
				makeFragment("frag-keyword", "typescript strongly typed language"),
				makeFragment("frag-other", "cooking pasta recipe"),
			];
			const rt = buildRuntime({ hasEmbedding: false, fragments });
			const svc = buildService(rt);

			// Request hybrid — should silently fall back to keyword
			const results = await svc.searchDocuments(
				makeMessage("typescript"),
				undefined,
				"hybrid",
			);

			// Should have used getMemories (keyword path), not searchMemories
			expect(rt.searchMemories).not.toHaveBeenCalled();
			expect(rt.getMemories).toHaveBeenCalled();
			expect(results[0].id).toBe("frag-keyword");
		});

		it("falls back to keyword mode when explicitly requesting vector without embedding", async () => {
			const fragments = [makeFragment("frag-v", "vector test content")];
			const rt = buildRuntime({ hasEmbedding: false, fragments });
			const svc = buildService(rt);

			// Requesting "vector" mode but no embedding model is registered:
			// should fall back to keyword search without throwing
			const results = await svc.searchDocuments(
				makeMessage("vector test"),
				undefined,
				"vector",
			);

			expect(rt.searchMemories).not.toHaveBeenCalled();
			expect(results).toHaveLength(1);
		});
	});
});
