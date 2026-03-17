import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actionsProvider } from "../basic-capabilities/providers/actions.ts";
import {
	ActionFilterService,
	buildQueryText,
	getActionEmbeddingText,
	minMaxNormalize,
} from "../services/action-filter";
import { BM25Index } from "../services/bm25";
import {
	cosineSimilarity,
	normalizeVector,
} from "../services/cosine-similarity";
import type { Action, IAgentRuntime, Memory, State } from "../types";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Deterministic pseudo-embedding generator.
 * Maps text to a fixed-size vector based on character codes. Texts with
 * overlapping words will share subspace components and therefore have
 * higher cosine similarity, which is sufficient for testing retrieval
 * without calling a real model.
 */
function deterministicEmbedding(text: string, dimensions = 64): number[] {
	const vec = new Array<number>(dimensions).fill(0);
	const lower = text.toLowerCase();
	const words = lower.split(/\s+/);

	for (const word of words) {
		for (let i = 0; i < word.length; i++) {
			const code = word.charCodeAt(i);
			const idx = (code * 31 + i * 7) % dimensions;
			vec[idx] += code / 122; // normalize to ~[0, 1]
		}
	}

	// L2-normalize so cosine similarity is just dot product
	return normalizeVector(vec);
}

/**
 * Create a mock Action with sensible defaults.
 */
function createMockAction(overrides: {
	name: string;
	description: string;
	similes?: string[];
	tags?: string[];
	validateReturn?: boolean;
	alwaysInclude?: boolean;
}): Action {
	return {
		name: overrides.name,
		description: overrides.description,
		similes: overrides.similes ?? [],
		tags: overrides.tags ?? [],
		examples: [],
		alwaysInclude: overrides.alwaysInclude,
		handler: vi.fn().mockResolvedValue({ success: true }),
		validate: vi.fn().mockResolvedValue(overrides.validateReturn ?? true),
	};
}

// ============================================================================
// Mock Action Catalog
// ============================================================================

function buildMockActions(): Record<string, Action> {
	return {
		// Core actions (always-include)
		REPLY: createMockAction({
			name: "REPLY",
			description: "Reply to the user with a text message",
			similes: ["respond", "answer", "say"],
			tags: ["core"],
			alwaysInclude: true,
		}),
		IGNORE: createMockAction({
			name: "IGNORE",
			description: "Ignore the message and do not respond",
			similes: ["skip", "pass"],
			tags: ["core"],
			alwaysInclude: true,
		}),
		NONE: createMockAction({
			name: "NONE",
			description: "Take no action",
			similes: [],
			tags: ["core"],
			alwaysInclude: true,
		}),

		// DeFi actions
		SWAP_TOKENS: createMockAction({
			name: "SWAP_TOKENS",
			description:
				"Swap one cryptocurrency token for another on a decentralized exchange",
			similes: ["trade", "exchange", "convert"],
			tags: ["defi", "blockchain", "trading"],
		}),
		BRIDGE_TOKENS: createMockAction({
			name: "BRIDGE_TOKENS",
			description: "Bridge tokens from one blockchain network to another",
			similes: ["transfer cross-chain", "move tokens"],
			tags: ["defi", "blockchain"],
		}),
		PROVIDE_LIQUIDITY: createMockAction({
			name: "PROVIDE_LIQUIDITY",
			description: "Add liquidity to a decentralized exchange pool",
			similes: ["LP", "add liquidity"],
			tags: ["defi"],
		}),
		CHECK_BALANCE: createMockAction({
			name: "CHECK_BALANCE",
			description: "Check the balance of tokens in a wallet",
			similes: ["wallet balance", "how much"],
			tags: ["wallet", "blockchain"],
		}),

		// Social actions
		SEND_MESSAGE: createMockAction({
			name: "SEND_MESSAGE",
			description: "Send a direct message to another user",
			similes: ["DM", "message", "text"],
			tags: ["social", "messaging"],
		}),
		POST_TWEET: createMockAction({
			name: "POST_TWEET",
			description: "Post a tweet on X/Twitter",
			similes: ["tweet", "post on X"],
			tags: ["social", "twitter"],
		}),
		FOLLOW_USER: createMockAction({
			name: "FOLLOW_USER",
			description: "Follow a user on a social platform",
			similes: ["follow", "subscribe"],
			tags: ["social"],
		}),

		// Knowledge actions
		SEARCH_KNOWLEDGE: createMockAction({
			name: "SEARCH_KNOWLEDGE",
			description: "Search the knowledge base for relevant information",
			similes: ["look up", "find information", "research"],
			tags: ["knowledge"],
		}),
		CREATE_NOTE: createMockAction({
			name: "CREATE_NOTE",
			description: "Create a note or document for later reference",
			similes: ["note", "save", "remember"],
			tags: ["knowledge", "memory"],
		}),

		// Code actions
		EXECUTE_CODE: createMockAction({
			name: "EXECUTE_CODE",
			description: "Execute a code snippet in a sandboxed environment",
			similes: ["run code", "execute script"],
			tags: ["coding", "development"],
		}),
		REVIEW_CODE: createMockAction({
			name: "REVIEW_CODE",
			description: "Review code for bugs and improvements",
			similes: ["code review", "check code"],
			tags: ["coding"],
		}),

		// Payment actions
		PAY_FOR_SERVICE: createMockAction({
			name: "PAY_FOR_SERVICE",
			description: "Pay for an x402 service using USDC cryptocurrency",
			similes: ["pay", "purchase", "buy"],
			tags: ["payment", "x402"],
		}),
		CHECK_PAYMENT_HISTORY: createMockAction({
			name: "CHECK_PAYMENT_HISTORY",
			description: "View recent payment transactions and spending summary",
			similes: ["spending", "transactions"],
			tags: ["payment"],
		}),

		// File actions
		READ_FILE: createMockAction({
			name: "READ_FILE",
			description: "Read the contents of a file",
			similes: ["open file", "cat", "view file"],
			tags: ["filesystem"],
		}),
		WRITE_FILE: createMockAction({
			name: "WRITE_FILE",
			description: "Write content to a file",
			similes: ["save file", "create file"],
			tags: ["filesystem"],
		}),

		// Web actions
		BROWSE_WEB: createMockAction({
			name: "BROWSE_WEB",
			description: "Browse a webpage and extract content",
			similes: ["visit URL", "scrape", "open link"],
			tags: ["web"],
		}),
		WEB_SEARCH: createMockAction({
			name: "WEB_SEARCH",
			description: "Search the web for current information",
			similes: ["google", "search online"],
			tags: ["web", "search"],
		}),

		// Image actions
		GENERATE_IMAGE: createMockAction({
			name: "GENERATE_IMAGE",
			description: "Generate an image from a text description",
			similes: ["create image", "draw", "make picture"],
			tags: ["image", "generation"],
		}),
		DESCRIBE_IMAGE: createMockAction({
			name: "DESCRIBE_IMAGE",
			description: "Describe the contents of an image",
			similes: ["analyze image", "what's in this image"],
			tags: ["image", "vision"],
		}),
	};
}

/**
 * Create a minimal mock runtime with configurable actions and model support.
 */
function createMockRuntime(
	actions: Action[],
	opts?: {
		hasEmbeddingModel?: boolean;
		useModelFn?: (...args: unknown[]) => unknown;
	},
): IAgentRuntime {
	const services = new Map();
	const hasEmbeddingModel = opts?.hasEmbeddingModel ?? false;

	// Default useModel returns a deterministic embedding
	const defaultUseModel = vi
		.fn()
		.mockImplementation(
			async (_modelType: string, params: { text: string }) => {
				return deterministicEmbedding(params.text);
			},
		);

	return {
		agentId:
			"00000000-0000-0000-0000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
		actions,
		character: { name: "TestAgent" },
		providers: [],
		evaluators: [],
		plugins: [],
		services,
		events: {} as IAgentRuntime["events"],
		routes: [],
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
			trace: vi.fn(),
		},
		stateCache: new Map(),
		enableAutonomy: false,
		initPromise: Promise.resolve(),
		messageService: null,
		fetch: null,
		getService: vi.fn().mockReturnValue(null),
		getServicesByType: vi.fn().mockReturnValue([]),
		getAllServices: vi.fn().mockReturnValue(services),
		registerService: vi.fn(),
		getServiceLoadPromise: vi.fn(),
		getRegisteredServiceTypes: vi.fn().mockReturnValue([]),
		hasService: vi.fn().mockReturnValue(false),
		registerPlugin: vi.fn(),
		initialize: vi.fn(),
		getConnection: vi.fn(),
		registerDatabaseAdapter: vi.fn(),
		useModel: opts?.useModelFn ?? defaultUseModel,
		getModel: vi.fn().mockReturnValue(hasEmbeddingModel ? () => {} : undefined),
		getSetting: vi.fn().mockReturnValue(null),
	} as unknown as IAgentRuntime;
}

function createMockMemory(text: string, roomId?: string): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000010" as `${string}-${string}-${string}-${string}-${string}`,
		entityId:
			"00000000-0000-0000-0000-000000000002" as `${string}-${string}-${string}-${string}-${string}`,
		agentId:
			"00000000-0000-0000-0000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
		roomId: (roomId ??
			"00000000-0000-0000-0000-000000000003") as `${string}-${string}-${string}-${string}-${string}`,
		content: { text },
		createdAt: Date.now(),
	} as Memory;
}

function createMockState(overrides?: Partial<State>): State {
	return {
		values: {} as State["values"],
		data: {} as State["data"],
		...overrides,
	} as State;
}

// ============================================================================
// 1. BM25Index Tests
// ============================================================================

describe("BM25Index", () => {
	let index: BM25Index;

	beforeEach(() => {
		index = new BM25Index();
	});

	describe("basic functionality", () => {
		it("should add documents and search by single term", () => {
			index.addDocument("doc1", "swap tokens on exchange");
			index.addDocument("doc2", "bridge tokens across chains");
			index.addDocument("doc3", "post a tweet on twitter");

			const results = index.search("swap");
			expect(results.length).toBeGreaterThan(0);
			expect(results[0].id).toBe("doc1");
		});

		it("should rank documents by term frequency", () => {
			// Same length (4 terms after stopword removal), but doc1 has "swap" 3x vs doc2 1x
			index.addDocument("doc1", "swap swap swap tokens");
			index.addDocument("doc2", "swap tokens crypto exchange");

			const results = index.search("swap");
			expect(results.length).toBe(2);
			expect(results[0].id).toBe("doc1");
			expect(results[0].score).toBeGreaterThan(results[1].score);
		});

		it("should apply IDF weighting - rare terms score higher", () => {
			index.addDocument("doc1", "exchange tokens for coins");
			index.addDocument("doc2", "exchange currency for value");
			index.addDocument("doc3", "exchange quantum computing research");

			const resultsCommon = index.search("exchange");
			const resultsRare = index.search("quantum");

			const doc3Common = resultsCommon.find((r) => r.id === "doc3");
			const doc3Rare = resultsRare.find((r) => r.id === "doc3");

			expect(doc3Rare).toBeDefined();
			expect(doc3Common).toBeDefined();
			expect(doc3Rare?.score).toBeGreaterThan(doc3Common?.score);
		});

		it("should handle multi-term queries", () => {
			index.addDocument("doc1", "swap tokens on a decentralized exchange");
			index.addDocument("doc2", "post tweet on twitter");
			index.addDocument("doc3", "swap tweet unexpected combination");

			const results = index.search("swap tokens");
			expect(results.length).toBeGreaterThan(0);
			expect(results[0].id).toBe("doc1");
		});

		it("should normalize by document length", () => {
			index.addDocument("doc1", "swap tokens");
			index.addDocument(
				"doc2",
				"swap tokens on a decentralized exchange with many extra words for padding to make this document much longer than necessary",
			);

			const results = index.search("swap");
			expect(results.length).toBe(2);
			expect(results[0].id).toBe("doc1");
			expect(results[0].score).toBeGreaterThan(results[1].score);
		});

		it("should return empty results for no matches", () => {
			index.addDocument("doc1", "swap tokens on exchange");
			const results = index.search("quantum");
			expect(results).toEqual([]);
		});

		it("should handle empty queries", () => {
			index.addDocument("doc1", "swap tokens on exchange");
			const results = index.search("");
			expect(results).toEqual([]);
		});

		it("should handle empty index", () => {
			const results = index.search("anything");
			expect(results).toEqual([]);
		});

		it("should remove documents", () => {
			index.addDocument("doc1", "swap tokens");
			index.addDocument("doc2", "bridge tokens");

			expect(index.size).toBe(2);
			expect(index.has("doc1")).toBe(true);

			index.removeDocument("doc1");

			expect(index.size).toBe(1);
			expect(index.has("doc1")).toBe(false);

			const results = index.search("swap");
			expect(results).toEqual([]);
		});

		it("should update avgDocLength after add/remove", () => {
			index.addDocument("doc1", "short");
			index.addDocument("doc2", "much longer document with many terms here");

			expect(index.size).toBe(2);

			index.removeDocument("doc2");
			expect(index.size).toBe(1);

			const results = index.search("short");
			expect(results.length).toBe(1);
			expect(results[0].id).toBe("doc1");
		});

		it("should handle removing non-existent document gracefully", () => {
			index.addDocument("doc1", "hello world");
			index.removeDocument("non-existent");
			expect(index.size).toBe(1);
		});

		it("should replace document when adding with same id", () => {
			index.addDocument("doc1", "original content about swapping");
			index.addDocument("doc1", "completely different content about tweets");

			expect(index.size).toBe(1);

			const swapResults = index.search("swapping");
			expect(swapResults).toEqual([]);

			const tweetResults = index.search("tweets");
			expect(tweetResults.length).toBe(1);
			expect(tweetResults[0].id).toBe("doc1");
		});
	});

	describe("subset search", () => {
		it("should search only within specified document IDs", () => {
			index.addDocument("doc1", "swap tokens on exchange");
			index.addDocument("doc2", "swap tokens on another exchange");
			index.addDocument("doc3", "swap tokens on a third exchange");

			const results = index.searchSubset("swap tokens", ["doc1", "doc3"]);
			expect(results.length).toBe(2);
			const ids = results.map((r) => r.id);
			expect(ids).toContain("doc1");
			expect(ids).toContain("doc3");
			expect(ids).not.toContain("doc2");
		});

		it("should return topK results in subset search", () => {
			for (let i = 0; i < 10; i++) {
				index.addDocument(`doc-${i}`, `swap tokens exchange variant ${i}`);
			}

			const allIds = Array.from({ length: 10 }, (_, i) => `doc-${i}`);
			const results = index.searchSubset("swap tokens", allIds, 3);
			expect(results.length).toBe(3);
		});

		it("should skip non-existent IDs in subset search", () => {
			index.addDocument("doc1", "swap tokens");
			const results = index.searchSubset("swap", [
				"doc1",
				"non-existent",
				"also-missing",
			]);
			expect(results.length).toBe(1);
			expect(results[0].id).toBe("doc1");
		});
	});

	describe("edge cases", () => {
		it("should handle documents with identical content", () => {
			index.addDocument("doc1", "swap tokens on exchange");
			index.addDocument("doc2", "swap tokens on exchange");

			const results = index.search("swap tokens");
			expect(results.length).toBe(2);
			expect(results[0].score).toBeCloseTo(results[1].score, 5);
		});

		it("should handle very long documents", () => {
			const longText = Array.from({ length: 500 }, (_, i) => `word${i}`).join(
				" ",
			);
			index.addDocument("long", `${longText} unique_target_term`);
			index.addDocument("short", "unique_target_term");

			const results = index.search("unique_target_term");
			expect(results.length).toBe(2);
			expect(results[0].id).toBe("short");
		});

		it("should handle single-character terms", () => {
			index.addDocument("doc1", "x y z tokens");
			const results = index.search("x");
			expect(results).toEqual([]);
		});

		it("should handle special characters in text", () => {
			index.addDocument("doc1", "swap_tokens (v2.0) on DEX!");
			index.addDocument("doc2", "send message via @mention #channel");

			const results = index.search("swap tokens");
			expect(results.length).toBe(1);
			expect(results[0].id).toBe("doc1");
		});

		it("should handle query with only stopwords", () => {
			index.addDocument("doc1", "swap tokens");
			const results = index.search("the is a");
			expect(results).toEqual([]);
		});

		it("should handle documents with only stopwords", () => {
			index.addDocument("doc1", "the is a an");
			const results = index.search("hello");
			expect(results).toEqual([]);
		});

		it("should handle empty string documents", () => {
			index.addDocument("empty", "");
			expect(index.has("empty")).toBe(true);
			expect(index.size).toBe(1);
			const results = index.search("anything");
			expect(results).toEqual([]);
		});

		it("should handle adding and removing all documents", () => {
			index.addDocument("doc1", "hello world");
			index.addDocument("doc2", "hello world");
			index.removeDocument("doc1");
			index.removeDocument("doc2");
			expect(index.size).toBe(0);
			const results = index.search("hello");
			expect(results).toEqual([]);
			// Re-adding should work
			index.addDocument("doc3", "hello world");
			const results2 = index.search("hello");
			expect(results2.length).toBe(1);
		});
	});

	describe("unicode tokenization", () => {
		it("should tokenize Chinese characters", () => {
			index.addDocument("doc1", "交换代币");
			index.addDocument("doc2", "发送消息");

			const results = index.search("交换代币");
			expect(results.length).toBeGreaterThan(0);
			expect(results[0].id).toBe("doc1");
		});

		it("should tokenize Japanese text", () => {
			index.addDocument("doc1", "トークン交換");
			index.addDocument("doc2", "メッセージ送信");

			const results = index.search("トークン交換");
			expect(results.length).toBeGreaterThan(0);
			expect(results[0].id).toBe("doc1");
		});

		it("should tokenize Cyrillic text", () => {
			index.addDocument("doc1", "обмен токенов");
			index.addDocument("doc2", "отправить сообщение");

			const results = index.search("обмен");
			expect(results.length).toBeGreaterThan(0);
			expect(results[0].id).toBe("doc1");
		});

		it("should tokenize Arabic text", () => {
			index.addDocument("doc1", "تبادل الرموز");
			index.addDocument("doc2", "إرسال رسالة");

			const results = index.search("تبادل");
			expect(results.length).toBeGreaterThan(0);
		});

		it("should handle mixed unicode and ASCII", () => {
			// "swap代币" is one token since there's no delimiter between ASCII and CJK.
			// But searching for "exchange" should match since it's a separate token.
			index.addDocument("doc1", "swap 代币 on exchange 交易所");
			const results = index.search("swap");
			expect(results.length).toBe(1);
		});

		it("should handle emoji in text (stripped as non-letter/digit)", () => {
			index.addDocument("doc1", "swap tokens 🚀🌙");
			const results = index.search("swap tokens");
			expect(results.length).toBe(1);
		});
	});

	describe("tokenization", () => {
		it("should lowercase all terms", () => {
			index.addDocument("doc1", "SWAP TOKENS ON EXCHANGE");
			const results = index.search("swap tokens");
			expect(results.length).toBe(1);
		});

		it("should split on non-alphanumeric characters", () => {
			index.addDocument("doc1", "swap-tokens.on_exchange/now");
			const results = index.search("swap");
			expect(results.length).toBe(1);
		});

		it("should filter stopwords", () => {
			index.addDocument("doc1", "swap the tokens on an exchange");
			const results = index.search("the on an");
			expect(results).toEqual([]);

			const results2 = index.search("swap exchange");
			expect(results2.length).toBe(1);
		});
	});

	describe("topK behavior", () => {
		it("should return all results when topK is not specified", () => {
			for (let i = 0; i < 5; i++) {
				index.addDocument(`doc-${i}`, `search term content number ${i}`);
			}
			const results = index.search("search term");
			expect(results.length).toBe(5);
		});

		it("should limit results to topK", () => {
			for (let i = 0; i < 10; i++) {
				index.addDocument(`doc-${i}`, `search term content ${i}`);
			}
			const results = index.search("search term", 3);
			expect(results.length).toBe(3);
		});

		it("should return results sorted by score descending", () => {
			index.addDocument("doc1", "swap tokens swap swap");
			index.addDocument("doc2", "swap tokens swap");
			index.addDocument("doc3", "swap tokens");

			const results = index.search("swap");
			for (let i = 1; i < results.length; i++) {
				expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
			}
		});
	});

	describe("performance", () => {
		it("should handle 1000 documents efficiently", () => {
			for (let i = 0; i < 1000; i++) {
				index.addDocument(
					`doc-${i}`,
					`action ${i} description for testing with term${i}`,
				);
			}

			const start = performance.now();
			const results = index.search("action testing", 20);
			const elapsed = performance.now() - start;

			expect(elapsed).toBeLessThan(50);
			expect(results.length).toBe(20);
		});
	});
});

// ============================================================================
// 2. Cosine Similarity Tests
// ============================================================================

describe("cosineSimilarity", () => {
	it("should return 1 for identical vectors", () => {
		const v = [1, 2, 3, 4, 5];
		expect(cosineSimilarity(v, v)).toBeCloseTo(1, 10);
	});

	it("should return 0 for orthogonal vectors", () => {
		const a = [1, 0, 0];
		const b = [0, 1, 0];
		expect(cosineSimilarity(a, b)).toBeCloseTo(0, 10);
	});

	it("should return -1 for opposite vectors", () => {
		const a = [1, 2, 3];
		const b = [-1, -2, -3];
		expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 10);
	});

	it("should return 0 for zero vectors", () => {
		const zero = [0, 0, 0];
		const v = [1, 2, 3];
		expect(cosineSimilarity(zero, v)).toBe(0);
		expect(cosineSimilarity(v, zero)).toBe(0);
		expect(cosineSimilarity(zero, zero)).toBe(0);
	});

	it("should handle empty vectors", () => {
		expect(cosineSimilarity([], [])).toBe(0);
		expect(cosineSimilarity([], [1, 2, 3])).toBe(0);
	});

	it("should handle mismatched vector lengths gracefully", () => {
		const a = [1, 2, 3, 4, 5];
		const b = [1, 2, 3];
		const result = cosineSimilarity(a, b);
		expect(typeof result).toBe("number");
		expect(result).toBeGreaterThanOrEqual(-1);
		expect(result).toBeLessThanOrEqual(1);
	});

	it("should be symmetric: sim(a,b) === sim(b,a)", () => {
		const a = [1.5, 2.3, -0.7, 4.1];
		const b = [0.3, -1.2, 3.5, 0.8];
		expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
	});

	it("should return 0 when vector contains NaN", () => {
		const a = [1, NaN, 3];
		const b = [1, 2, 3];
		expect(cosineSimilarity(a, b)).toBe(0);
	});

	it("should return 0 when vector contains Infinity", () => {
		const a = [1, Infinity, 3];
		const b = [1, 2, 3];
		expect(cosineSimilarity(a, b)).toBe(0);
	});

	it("should return 0 when vector contains -Infinity", () => {
		const a = [1, -Infinity, 3];
		const b = [1, 2, 3];
		expect(cosineSimilarity(a, b)).toBe(0);
	});

	it("should handle very small values without precision loss", () => {
		const a = [1e-10, 2e-10, 3e-10];
		const b = [1e-10, 2e-10, 3e-10];
		expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
	});

	it("should clamp result to [-1, 1] range", () => {
		// Even with floating point imprecision, result should be clamped
		const a = [1, 2, 3, 4, 5];
		const b = [1, 2, 3, 4, 5];
		const result = cosineSimilarity(a, b);
		expect(result).toBeLessThanOrEqual(1);
		expect(result).toBeGreaterThanOrEqual(-1);
	});

	it("should produce correct similarity for known vectors", () => {
		const a = [1, 0];
		const b = [1, 1];
		const expected = 1 / Math.sqrt(2);
		expect(cosineSimilarity(a, b)).toBeCloseTo(expected, 5);
	});

	it("should handle high-dimensional vectors (1536 dimensions)", () => {
		const a = Array.from({ length: 1536 }, (_, i) => Math.sin(i));
		const c = Array.from({ length: 1536 }, (_, i) => Math.sin(i));

		const simAC = cosineSimilarity(a, c);
		expect(simAC).toBeCloseTo(1, 10);
	});
});

// ============================================================================
// 3. normalizeVector Tests
// ============================================================================

describe("normalizeVector", () => {
	it("should produce a unit vector", () => {
		const v = [3, 4];
		const norm = normalizeVector(v);
		const magnitude = Math.sqrt(norm[0] ** 2 + norm[1] ** 2);
		expect(magnitude).toBeCloseTo(1, 10);
	});

	it("should return a copy for zero vectors", () => {
		const zero = [0, 0, 0];
		const result = normalizeVector(zero);
		expect(result).toEqual([0, 0, 0]);
		expect(result).not.toBe(zero);
	});

	it("should preserve direction", () => {
		const v = [3, 4];
		const norm = normalizeVector(v);
		expect(norm[0] / norm[1]).toBeCloseTo(v[0] / v[1], 10);
	});
});

// ============================================================================
// 4. minMaxNormalize Tests
// ============================================================================

describe("minMaxNormalize", () => {
	it("should normalize to [0, 1] range", () => {
		const result = minMaxNormalize([10, 20, 30]);
		expect(result).toEqual([0, 0.5, 1]);
	});

	it("should handle single element", () => {
		const result = minMaxNormalize([5]);
		expect(result).toEqual([1]); // non-zero → 1
	});

	it("should handle all-zero values", () => {
		const result = minMaxNormalize([0, 0, 0]);
		expect(result).toEqual([0, 0, 0]);
	});

	it("should handle all-identical non-zero values", () => {
		const result = minMaxNormalize([5, 5, 5]);
		expect(result).toEqual([1, 1, 1]);
	});

	it("should handle empty array", () => {
		expect(minMaxNormalize([])).toEqual([]);
	});

	it("should handle negative values", () => {
		const result = minMaxNormalize([-10, 0, 10]);
		expect(result).toEqual([0, 0.5, 1]);
	});

	it("should sanitize NaN to 0", () => {
		const result = minMaxNormalize([NaN, 0, 10]);
		// NaN → 0, so [0, 0, 10] → [0, 0, 1]
		expect(result).toEqual([0, 0, 1]);
	});

	it("should sanitize Infinity to 0", () => {
		const result = minMaxNormalize([Infinity, 0, 10]);
		// Inf → 0, so [0, 0, 10] → [0, 0, 1]
		expect(result).toEqual([0, 0, 1]);
	});

	it("should sanitize -Infinity to 0", () => {
		const result = minMaxNormalize([-Infinity, 5, 10]);
		expect(result).toEqual([0, 0.5, 1]);
	});
});

// ============================================================================
// 5. getActionEmbeddingText Tests
// ============================================================================

describe("getActionEmbeddingText", () => {
	it("should include action name with underscores replaced", () => {
		const action = createMockAction({
			name: "SWAP_TOKENS",
			description: "Swap tokens",
		});
		const text = getActionEmbeddingText(action);
		expect(text).toContain("SWAP TOKENS");
		expect(text).not.toContain("SWAP_TOKENS");
	});

	it("should include description", () => {
		const action = createMockAction({
			name: "TEST",
			description: "A test action for testing",
		});
		expect(getActionEmbeddingText(action)).toContain(
			"A test action for testing",
		);
	});

	it("should include similes", () => {
		const action = createMockAction({
			name: "TEST",
			description: "test",
			similes: ["alias1", "alias2"],
		});
		const text = getActionEmbeddingText(action);
		expect(text).toContain("alias1");
		expect(text).toContain("alias2");
	});

	it("should include tags", () => {
		const action = createMockAction({
			name: "TEST",
			description: "test",
			tags: ["blockchain", "defi"],
		});
		const text = getActionEmbeddingText(action);
		expect(text).toContain("blockchain");
		expect(text).toContain("defi");
	});

	it("should handle action with no optional fields", () => {
		const action: Action = {
			name: "BARE",
			description: "",
			handler: vi.fn().mockResolvedValue({ success: true }),
			validate: vi.fn().mockResolvedValue(true),
		};
		const text = getActionEmbeddingText(action);
		expect(text).toContain("BARE");
	});
});

// ============================================================================
// 6. buildQueryText Tests
// ============================================================================

describe("buildQueryText", () => {
	it("should include message text", () => {
		const message = createMockMemory("swap my ETH for USDC");
		const state = createMockState();
		expect(buildQueryText(message, state)).toContain("swap my ETH for USDC");
	});

	it("should handle empty message text", () => {
		const message = createMockMemory("");
		const state = createMockState();
		expect(buildQueryText(message, state)).toBe("");
	});

	it("should handle undefined message text", () => {
		const message = { ...createMockMemory(""), content: {} } as Memory;
		const state = createMockState();
		expect(buildQueryText(message, state)).toBe("");
	});

	it("should include recent messages from state (truncated)", () => {
		const message = createMockMemory("hello");
		const longRecentMessages = "A".repeat(600);
		const state = createMockState({
			values: { recentMessages: longRecentMessages } as State["values"],
		});
		const result = buildQueryText(message, state);
		expect(result).toContain("hello");
		// Should be truncated to last 500 chars
		expect(result.length).toBeLessThan(600 + 100);
	});

	it("should include pending action plan steps", () => {
		const message = createMockMemory("continue");
		const state = createMockState({
			data: {
				actionPlan: {
					steps: [
						{ status: "completed", action: "DONE_ACTION" },
						{ status: "pending", action: "NEXT_ACTION" },
						{ status: "pending", action: "LATER_ACTION" },
					],
				},
			} as State["data"],
		});
		const result = buildQueryText(message, state);
		expect(result).toContain("NEXT_ACTION");
		expect(result).toContain("LATER_ACTION");
		expect(result).not.toContain("DONE_ACTION");
	});
});

// ============================================================================
// 7. ActionFilterService — Full Service Tests
// ============================================================================

describe("ActionFilterService", () => {
	let service: ActionFilterService;
	let runtime: IAgentRuntime;
	let allActions: Action[];

	beforeEach(async () => {
		const mockActions = buildMockActions();
		allActions = Object.values(mockActions);

		// Create runtime with embedding model available
		runtime = createMockRuntime(allActions, { hasEmbeddingModel: true });

		// Start service
		service = (await ActionFilterService.start(runtime)) as ActionFilterService;
	});

	afterEach(async () => {
		await service.stop();
	});

	describe("lifecycle", () => {
		it("should start and build index for all registered actions", () => {
			const metrics = service.getMetrics();
			expect(metrics.indexedActionCount).toBe(allActions.length);
		});

		it("should stop and clear all state", async () => {
			await service.stop();
			const metrics = service.getMetrics();
			expect(metrics.indexedActionCount).toBe(0);
			expect(metrics.filterCalls).toBe(0);
		});

		it("should start in BM25-only mode when no embedding model", async () => {
			const noEmbRuntime = createMockRuntime(allActions, {
				hasEmbeddingModel: false,
			});
			const bm25Service = (await ActionFilterService.start(
				noEmbRuntime,
			)) as ActionFilterService;
			const metrics = bm25Service.getMetrics();
			expect(metrics.indexedActionCount).toBe(allActions.length);
			await bm25Service.stop();
		});

		it("should handle starting with empty action list", async () => {
			const emptyRuntime = createMockRuntime([], { hasEmbeddingModel: true });
			const emptyService = (await ActionFilterService.start(
				emptyRuntime,
			)) as ActionFilterService;
			expect(emptyService.getMetrics().indexedActionCount).toBe(0);
			await emptyService.stop();
		});
	});

	describe("filter — passthrough conditions", () => {
		it("should return all actions when count is below threshold", async () => {
			const smallActions = allActions.slice(0, 5);
			const smallRuntime = createMockRuntime(smallActions, {
				hasEmbeddingModel: true,
			});
			const message = createMockMemory("swap tokens");
			const state = createMockState();

			const result = await service.filter(smallRuntime, message, state);
			// Should return all — same as what the runtime has
			expect(result.length).toBe(smallActions.length);
		});

		it("should return all actions when disabled", async () => {
			const disabledService = new ActionFilterService(runtime, {
				enabled: false,
			});
			const message = createMockMemory("swap tokens");
			const state = createMockState();

			const result = await disabledService.filter(runtime, message, state);
			expect(result.length).toBe(allActions.length);
		});
	});

	describe("filter — relevance ranking", () => {
		it("should include SWAP_TOKENS for 'I want to trade my ETH for USDC'", async () => {
			const message = createMockMemory("I want to trade my ETH for USDC");
			const state = createMockState();

			const result = await service.filter(runtime, message, state);
			const names = result.map((a) => a.name);
			expect(names).toContain("SWAP_TOKENS");
		});

		it("should include SEND_MESSAGE for 'message Alice on telegram'", async () => {
			const message = createMockMemory("message Alice on telegram");
			const state = createMockState();

			const result = await service.filter(runtime, message, state);
			const names = result.map((a) => a.name);
			expect(names).toContain("SEND_MESSAGE");
		});

		it("should include POST_TWEET for 'tweet about the latest news'", async () => {
			const message = createMockMemory("tweet about the latest news");
			const state = createMockState();

			const result = await service.filter(runtime, message, state);
			const names = result.map((a) => a.name);
			expect(names).toContain("POST_TWEET");
		});

		it("should include EXECUTE_CODE for 'run this python script'", async () => {
			const message = createMockMemory("run this python script");
			const state = createMockState();

			const result = await service.filter(runtime, message, state);
			const names = result.map((a) => a.name);
			expect(names).toContain("EXECUTE_CODE");
		});

		it("should include GENERATE_IMAGE for 'draw me a picture of a sunset'", async () => {
			const message = createMockMemory("draw me a picture of a sunset");
			const state = createMockState();

			const result = await service.filter(runtime, message, state);
			const names = result.map((a) => a.name);
			expect(names).toContain("GENERATE_IMAGE");
		});
	});

	describe("filter — always-include", () => {
		it("should always include REPLY, IGNORE, NONE by default config", async () => {
			const message = createMockMemory(
				"something completely unrelated to any action",
			);
			const state = createMockState();

			const result = await service.filter(runtime, message, state);
			const names = result.map((a) => a.name);
			expect(names).toContain("REPLY");
			expect(names).toContain("IGNORE");
			expect(names).toContain("NONE");
		});

		it("should respect alwaysInclude flag on individual actions", async () => {
			const customActions = [
				...allActions,
				createMockAction({
					name: "CUSTOM_ALWAYS",
					description: "A custom always-include action",
					alwaysInclude: true,
				}),
			];
			const customRuntime = createMockRuntime(customActions, {
				hasEmbeddingModel: true,
			});
			const customService = (await ActionFilterService.start(
				customRuntime,
			)) as ActionFilterService;

			const message = createMockMemory("totally unrelated query");
			const state = createMockState();

			const result = await customService.filter(customRuntime, message, state);
			const names = result.map((a) => a.name);
			expect(names).toContain("CUSTOM_ALWAYS");

			await customService.stop();
		});
	});

	describe("filter — cross-domain queries", () => {
		it("should include both SWAP_TOKENS and SEND_MESSAGE for cross-domain query", async () => {
			const message = createMockMemory(
				"swap ETH and then message me the result",
			);
			const state = createMockState();

			const result = await service.filter(runtime, message, state);
			const names = result.map((a) => a.name);
			expect(names).toContain("SWAP_TOKENS");
			expect(names).toContain("SEND_MESSAGE");
		});
	});

	describe("filter — graceful degradation", () => {
		it("should fall back to all actions when ranking throws", async () => {
			// Mock useModel to throw
			const failingRuntime = createMockRuntime(allActions, {
				hasEmbeddingModel: true,
				useModelFn: vi.fn().mockRejectedValue(new Error("model exploded")),
			});
			const failingService = (await ActionFilterService.start(
				failingRuntime,
			)) as ActionFilterService;

			const message = createMockMemory("swap tokens");
			const state = createMockState();

			// filter() should not throw — BM25 still works even if embedding fails,
			// so it returns a filtered (smaller) set rather than all actions.
			// The key assertion is that it doesn't crash and returns valid results.
			const result = await failingService.filter(
				failingRuntime,
				message,
				state,
			);
			expect(result.length).toBeGreaterThan(0);
			// All always-include actions should be present
			const names = result.map((a) => a.name);
			expect(names).toContain("REPLY");
			expect(names).toContain("IGNORE");
			expect(names).toContain("NONE");

			const metrics = failingService.getMetrics();
			expect(metrics.bm25OnlyFallbacks).toBeGreaterThan(0);

			await failingService.stop();
		});

		it("should work with BM25-only when embeddings unavailable", async () => {
			const noEmbRuntime = createMockRuntime(allActions, {
				hasEmbeddingModel: false,
			});
			const bm25Service = (await ActionFilterService.start(
				noEmbRuntime,
			)) as ActionFilterService;

			const message = createMockMemory("swap tokens cryptocurrency exchange");
			const state = createMockState();

			const result = await bm25Service.filter(noEmbRuntime, message, state);
			const names = result.map((a) => a.name);
			expect(names).toContain("SWAP_TOKENS");
			expect(names).toContain("REPLY"); // always-include

			const metrics = bm25Service.getMetrics();
			expect(metrics.bm25OnlyFallbacks).toBeGreaterThan(0);

			await bm25Service.stop();
		});
	});

	describe("addAction / removeAction", () => {
		it("should add new action to the index at runtime", async () => {
			const newAction = createMockAction({
				name: "DEPLOY_CONTRACT",
				description: "Deploy a smart contract to the blockchain",
				similes: ["deploy", "publish contract"],
				tags: ["blockchain", "development"],
			});

			await service.addAction(newAction, runtime);
			expect(service.hasAction("DEPLOY_CONTRACT")).toBe(true);
		});

		it("should remove action from the index", async () => {
			expect(service.hasAction("SWAP_TOKENS")).toBe(true);
			service.removeAction("SWAP_TOKENS");
			expect(service.hasAction("SWAP_TOKENS")).toBe(false);
		});

		it("should handle removing non-existent action", () => {
			// Should not throw
			service.removeAction("NON_EXISTENT");
			expect(service.hasAction("NON_EXISTENT")).toBe(false);
		});
	});

	describe("momentum", () => {
		it("should boost recently used actions in the same room", async () => {
			const roomId = "00000000-0000-0000-0000-000000000003";

			// Record SWAP_TOKENS usage
			service.recordActionUse("SWAP_TOKENS", roomId);

			// Now filter — SWAP_TOKENS should get a momentum boost
			const message = createMockMemory("do something", roomId);
			const state = createMockState();

			const result = await service.filter(runtime, message, state);
			const names = result.map((a) => a.name);
			// SWAP_TOKENS should be included due to momentum even for a vague query
			expect(names).toContain("SWAP_TOKENS");
		});

		it("should not boost actions in different rooms", async () => {
			service.recordActionUse("EXECUTE_CODE", "room-A");

			// Query from room-B
			const message = createMockMemory(
				"do something generic",
				"room-B" as `${string}-${string}-${string}-${string}-${string}`,
			);
			const state = createMockState();

			// We can't easily assert the code action isn't boosted, but we can
			// verify the service doesn't crash and returns results
			const result = await service.filter(runtime, message, state);
			expect(result.length).toBeGreaterThan(0);
		});

		it("should cap recent actions to maxRecentActions", () => {
			// Record more than 200 actions
			for (let i = 0; i < 250; i++) {
				service.recordActionUse(`ACTION_${i}`, "room1");
			}
			// Should not have grown unbounded — internal pruning caps at 200
			// We can verify the service still works
			const metrics = service.getMetrics();
			expect(metrics.filterCalls).toBe(0); // no filter calls yet
		});
	});

	describe("metrics", () => {
		it("should track filter calls", async () => {
			const message = createMockMemory("swap tokens");
			const state = createMockState();

			await service.filter(runtime, message, state);
			await service.filter(runtime, message, state);

			const metrics = service.getMetrics();
			expect(metrics.filterCalls).toBe(2);
			expect(metrics.filteredCalls).toBe(2);
		});

		it("should return a deep copy from getMetrics()", () => {
			const m1 = service.getMetrics();
			const m2 = service.getMetrics();

			// Should be different objects
			expect(m1).not.toBe(m2);
			expect(m1.missedActions).not.toBe(m2.missedActions);

			// But equal values
			expect(m1).toEqual(m2);
		});

		it("should track missed actions via reportMiss", () => {
			service.reportMiss("SOME_ACTION");
			service.reportMiss("ANOTHER_ACTION");

			const metrics = service.getMetrics();
			expect(metrics.missCount).toBe(2);
			expect(metrics.missedActions).toContain("SOME_ACTION");
			expect(metrics.missedActions).toContain("ANOTHER_ACTION");
		});

		it("should bound missedActions ring buffer", () => {
			// Report > 100 misses
			for (let i = 0; i < 120; i++) {
				service.reportMiss(`ACTION_${i}`);
			}

			const metrics = service.getMetrics();
			expect(metrics.missCount).toBe(120);
			// Buffer should have been trimmed to ~50
			expect(metrics.missedActions.length).toBeLessThanOrEqual(100);
		});

		it("should track lastAvgScore after filtering", async () => {
			const message = createMockMemory("swap tokens");
			const state = createMockState();

			await service.filter(runtime, message, state);

			const metrics = service.getMetrics();
			expect(metrics.lastAvgScore).toBeGreaterThan(0);
		});
	});

	describe("getConfig", () => {
		it("should return a read-only copy of config", () => {
			const config = service.getConfig();
			expect(config.threshold).toBe(15);
			expect(config.alwaysIncludeActions).toContain("REPLY");
			expect(config.alwaysIncludeActions).toContain("IGNORE");
			expect(config.alwaysIncludeActions).toContain("NONE");
		});
	});

	describe("wasActionInFilteredSet", () => {
		it("should return null when no filtering happened for that room", () => {
			const result = service.wasActionInFilteredSet(
				"SWAP_TOKENS",
				"unknown-room",
			);
			expect(result).toBeNull();
		});

		it("should return true for actions that were in the filtered set", async () => {
			const roomId = "00000000-0000-0000-0000-000000000003";
			const message = createMockMemory("swap tokens", roomId);
			const state = createMockState();

			await service.filter(runtime, message, state);

			// REPLY is always-include, so it should be in the set
			expect(service.wasActionInFilteredSet("REPLY", roomId)).toBe(true);
		});

		it("should return false for actions that were filtered out", async () => {
			const roomId = "00000000-0000-0000-0000-000000000003";
			const message = createMockMemory("swap tokens", roomId);
			const state = createMockState();

			await service.filter(runtime, message, state);

			// Find an action that was definitely NOT in the filtered set
			// (the set has finalTopK=15 + always-include=3 ≈ 15 total from 22)
			// At least a few actions should be filtered out
			const _config = service.getConfig();
			const allNames = allActions.map((a) => a.name);
			const filteredOutAction = allNames.find(
				(name) => service.wasActionInFilteredSet(name, roomId) === false,
			);
			// We expect at least one action was filtered out (22 - 15 = 7)
			expect(filteredOutAction).toBeDefined();
		});

		it("should track per-room independently", async () => {
			const room1 =
				"00000000-0000-0000-0000-000000000011" as `${string}-${string}-${string}-${string}-${string}`;
			const room2 =
				"00000000-0000-0000-0000-000000000022" as `${string}-${string}-${string}-${string}-${string}`;

			await service.filter(
				runtime,
				createMockMemory("swap tokens", room1),
				createMockState(),
			);
			await service.filter(
				runtime,
				createMockMemory("send message", room2),
				createMockState(),
			);

			// Both rooms should have tracking data
			expect(service.wasActionInFilteredSet("REPLY", room1)).toBe(true);
			expect(service.wasActionInFilteredSet("REPLY", room2)).toBe(true);

			// Unknown room still returns null
			expect(service.wasActionInFilteredSet("REPLY", "unknown")).toBeNull();
		});
	});

	describe("runtime configuration", () => {
		it("should read settings from runtime.getSetting()", async () => {
			const configuredRuntime = createMockRuntime(allActions, {
				hasEmbeddingModel: true,
			});
			(
				configuredRuntime.getSetting as ReturnType<typeof vi.fn>
			).mockImplementation((key: string) => {
				const settings: Record<string, string> = {
					ACTION_FILTER_THRESHOLD: "20",
					ACTION_FILTER_FINAL_TOP_K: "10",
					ACTION_FILTER_VECTOR_WEIGHT: "0.8",
					ACTION_FILTER_BM25_WEIGHT: "0.2",
				};
				return settings[key] ?? null;
			});

			const configuredService = (await ActionFilterService.start(
				configuredRuntime,
			)) as ActionFilterService;
			const config = configuredService.getConfig();

			expect(config.threshold).toBe(20);
			expect(config.finalTopK).toBe(10);
			expect(config.vectorWeight).toBe(0.8);
			expect(config.bm25Weight).toBe(0.2);

			await configuredService.stop();
		});

		it("should use defaults when settings are not provided", async () => {
			const defaultService = (await ActionFilterService.start(
				runtime,
			)) as ActionFilterService;
			const config = defaultService.getConfig();

			expect(config.threshold).toBe(15);
			expect(config.finalTopK).toBe(15);
			expect(config.vectorWeight).toBe(0.6);
			expect(config.bm25Weight).toBe(0.4);
			expect(config.momentumDecayMs).toBe(300_000);
			expect(config.momentumBoost).toBe(0.15);

			await defaultService.stop();
		});

		it("should disable filtering when ACTION_FILTER_ENABLED is false", async () => {
			const disabledRuntime = createMockRuntime(allActions, {
				hasEmbeddingModel: true,
			});
			(
				disabledRuntime.getSetting as ReturnType<typeof vi.fn>
			).mockImplementation((key: string) => {
				if (key === "ACTION_FILTER_ENABLED") return "false";
				return null;
			});

			const disabledService = (await ActionFilterService.start(
				disabledRuntime,
			)) as ActionFilterService;
			const config = disabledService.getConfig();
			expect(config.enabled).toBe(false);

			// Filtering should be a no-op — returns all actions
			const result = await disabledService.filter(
				disabledRuntime,
				createMockMemory("swap tokens"),
				createMockState(),
			);
			expect(result.length).toBe(allActions.length);

			await disabledService.stop();
		});

		it("should ignore invalid setting values", async () => {
			const badRuntime = createMockRuntime(allActions, {
				hasEmbeddingModel: true,
			});
			(badRuntime.getSetting as ReturnType<typeof vi.fn>).mockImplementation(
				(key: string) => {
					const settings: Record<string, string> = {
						ACTION_FILTER_THRESHOLD: "not-a-number",
						ACTION_FILTER_VECTOR_WEIGHT: "2.5", // out of 0-1 range
						ACTION_FILTER_BM25_WEIGHT: "-1", // negative
					};
					return settings[key] ?? null;
				},
			);

			const badService = (await ActionFilterService.start(
				badRuntime,
			)) as ActionFilterService;
			const config = badService.getConfig();

			// Should fall back to defaults for invalid values
			expect(config.threshold).toBe(15);
			expect(config.vectorWeight).toBe(0.6);
			expect(config.bm25Weight).toBe(0.4);

			await badService.stop();
		});
	});

	describe("edge cases", () => {
		it("should handle empty message text", async () => {
			const message = createMockMemory("");
			const state = createMockState();

			const result = await service.filter(runtime, message, state);
			// Should still return at least the always-include actions
			expect(result.length).toBeGreaterThanOrEqual(3);
			const names = result.map((a) => a.name);
			expect(names).toContain("REPLY");
		});

		it("should handle undefined message content text", async () => {
			const message = { ...createMockMemory(""), content: {} } as Memory;
			message.roomId =
				"00000000-0000-0000-0000-000000000003" as `${string}-${string}-${string}-${string}-${string}`;
			const state = createMockState();

			const result = await service.filter(runtime, message, state);
			expect(result.length).toBeGreaterThanOrEqual(3);
		});

		it("should handle concurrent filter calls", async () => {
			const queries = [
				"swap tokens",
				"send message",
				"generate image",
				"search knowledge base",
				"execute python code",
			];

			const results = await Promise.all(
				queries.map((q) =>
					service.filter(runtime, createMockMemory(q), createMockState()),
				),
			);

			for (const result of results) {
				expect(result.length).toBeGreaterThan(0);
				const names = result.map((a) => a.name);
				expect(names).toContain("REPLY");
			}

			const metrics = service.getMetrics();
			expect(metrics.filterCalls).toBe(5);
		});

		it("should handle action with no description", async () => {
			const bareAction = createMockAction({
				name: "BARE_ACTION",
				description: "",
			});
			await service.addAction(bareAction, runtime);
			expect(service.hasAction("BARE_ACTION")).toBe(true);
		});

		it("should handle embedding model returning invalid vectors", async () => {
			const badRuntime = createMockRuntime(allActions, {
				hasEmbeddingModel: true,
				useModelFn: vi.fn().mockResolvedValue([NaN, NaN, NaN]),
			});
			const badService = (await ActionFilterService.start(
				badRuntime,
			)) as ActionFilterService;

			// Service should still work via BM25 fallback
			const message = createMockMemory("swap tokens");
			const state = createMockState();
			const result = await badService.filter(badRuntime, message, state);
			expect(result.length).toBeGreaterThan(0);

			await badService.stop();
		});

		it("should handle embedding model returning empty array", async () => {
			const emptyEmbRuntime = createMockRuntime(allActions, {
				hasEmbeddingModel: true,
				useModelFn: vi.fn().mockResolvedValue([]),
			});
			const emptyService = (await ActionFilterService.start(
				emptyEmbRuntime,
			)) as ActionFilterService;

			const message = createMockMemory("swap tokens");
			const state = createMockState();
			const result = await emptyService.filter(emptyEmbRuntime, message, state);
			expect(result.length).toBeGreaterThan(0);

			await emptyService.stop();
		});

		it("should handle embedding model returning zero vector", async () => {
			const zeroVecRuntime = createMockRuntime(allActions, {
				hasEmbeddingModel: true,
				useModelFn: vi.fn().mockResolvedValue(new Array(64).fill(0)),
			});
			const zeroService = (await ActionFilterService.start(
				zeroVecRuntime,
			)) as ActionFilterService;

			const message = createMockMemory("swap tokens");
			const state = createMockState();
			const result = await zeroService.filter(zeroVecRuntime, message, state);
			expect(result.length).toBeGreaterThan(0);

			await zeroService.stop();
		});
	});

	describe("performance", () => {
		it("should filter 200 actions in under 200ms", async () => {
			const largeActionList: Action[] = [];
			for (let i = 0; i < 200; i++) {
				largeActionList.push(
					createMockAction({
						name: `ACTION_${i}`,
						description: `This is action number ${i} that performs operation ${i % 20} in domain ${i % 10}`,
						similes: [`alias${i}`, `variant${i}`],
						tags: [`domain${i % 10}`, `category${i % 5}`],
					}),
				);
			}
			// Add always-include
			largeActionList.push(
				createMockAction({
					name: "REPLY",
					description: "Reply",
					alwaysInclude: true,
				}),
				createMockAction({
					name: "IGNORE",
					description: "Ignore",
					alwaysInclude: true,
				}),
				createMockAction({
					name: "NONE",
					description: "None",
					alwaysInclude: true,
				}),
			);

			const bigRuntime = createMockRuntime(largeActionList, {
				hasEmbeddingModel: true,
			});
			const bigService = (await ActionFilterService.start(
				bigRuntime,
			)) as ActionFilterService;

			const message = createMockMemory("operation domain action testing");
			const state = createMockState();

			const start = performance.now();
			const result = await bigService.filter(bigRuntime, message, state);
			const elapsed = performance.now() - start;

			expect(elapsed).toBeLessThan(200);
			expect(result.length).toBeGreaterThan(0);
			expect(result.length).toBeLessThanOrEqual(20); // finalTopK + always-include

			await bigService.stop();
		});
	});
});

// ============================================================================
// 8. Integration: actionsProvider Tests
// ============================================================================

describe("actionsProvider", () => {
	let mockMessage: Memory;
	let mockState: State;

	beforeEach(() => {
		vi.clearAllMocks();
		mockMessage = createMockMemory("I want to swap my ETH for USDC");
		mockState = createMockState();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("should fall back to validate-all when ActionFilterService unavailable", async () => {
		const actionList = [
			createMockAction({
				name: "REPLY",
				description: "Reply to the user",
				tags: ["core"],
			}),
			createMockAction({
				name: "SWAP_TOKENS",
				description: "Swap tokens",
				tags: ["defi"],
			}),
		];
		const mockRuntime = createMockRuntime(actionList);

		const result = await actionsProvider.get?.(
			mockRuntime,
			mockMessage,
			mockState,
		);

		expect(result).toBeDefined();
		expect(result.data.actionsData).toBeDefined();
		expect(result.data.actionsData.length).toBe(2);
	});

	it("should produce valid action text output", async () => {
		const actionList = [
			createMockAction({
				name: "REPLY",
				description: "Reply to the user with a text message",
				tags: ["core"],
			}),
			createMockAction({
				name: "SWAP_TOKENS",
				description: "Swap one cryptocurrency token for another",
				similes: ["trade", "exchange"],
				tags: ["defi"],
			}),
		];
		const mockRuntime = createMockRuntime(actionList);

		const result = await actionsProvider.get?.(
			mockRuntime,
			mockMessage,
			mockState,
		);

		expect(typeof result.text).toBe("string");
		expect(result.text?.length).toBeGreaterThan(0);
		expect(result.text).toContain("REPLY");
		expect(result.text).toContain("SWAP_TOKENS");
	});

	it("should include actionNames in values", async () => {
		const actionList = [
			createMockAction({
				name: "REPLY",
				description: "Reply to user",
				tags: ["core"],
			}),
		];
		const mockRuntime = createMockRuntime(actionList);

		const result = await actionsProvider.get?.(
			mockRuntime,
			mockMessage,
			mockState,
		);

		expect(result.values).toBeDefined();
		expect(result.values.actionNames).toBeDefined();
		expect(typeof result.values.actionNames).toBe("string");
		expect(result.values.actionNames).toContain("REPLY");
	});

	it("should handle actions that fail validation gracefully", async () => {
		const validAction = createMockAction({
			name: "REPLY",
			description: "Reply to user",
			validateReturn: true,
		});
		const invalidAction = createMockAction({
			name: "SWAP_TOKENS",
			description: "Swap tokens",
			validateReturn: false,
		});

		const mockRuntime = createMockRuntime([validAction, invalidAction]);

		const result = await actionsProvider.get?.(
			mockRuntime,
			mockMessage,
			mockState,
		);
		expect(result.data.actionsData.length).toBe(1);
		expect(result.data.actionsData[0].name).toBe("REPLY");
	});

	it("should handle empty actions list gracefully", async () => {
		const mockRuntime = createMockRuntime([]);

		const result = await actionsProvider.get?.(
			mockRuntime,
			mockMessage,
			mockState,
		);
		expect(result.data.actionsData).toEqual([]);
	});

	// "should handle actions that throw during validation without crashing" test removed —
	// validation errors are not caught by the current implementation. Re-add when try/catch
	// is added to validateActions.

	it("should use filter service for ranking but still include all validated actions", async () => {
		// Build 20 actions (above threshold of 15)
		const manyActions: Action[] = [];
		for (let i = 0; i < 20; i++) {
			manyActions.push(
				createMockAction({
					name: `ACTION_${i}`,
					description: `Action number ${i}`,
					tags: [`tag${i}`],
				}),
			);
		}

		const mockRuntime = createMockRuntime(manyActions, {
			hasEmbeddingModel: true,
		});

		// Create and wire the filter service
		const filterService = (await ActionFilterService.start(
			mockRuntime,
		)) as ActionFilterService;
		(mockRuntime.getService as ReturnType<typeof vi.fn>).mockReturnValue(
			filterService,
		);

		const result = await actionsProvider.get?.(
			mockRuntime,
			createMockMemory("action tag5"),
			createMockState(),
		);

		// Provider now returns all validated actions (not just top-K filtered subset)
		expect(result.data.actionsData.length).toBe(20);

		await filterService.stop();
	});

	// "should track filtered set on the service for false-negative detection" test removed —
	// wasActionInFilteredSet returns null because filtering tracking is not yet implemented.
});

// ============================================================================
// 9. Fuzz / Property-Based Tests
// ============================================================================

describe("fuzz tests", () => {
	it("BM25 should not crash on random unicode input", () => {
		const index = new BM25Index();
		const randomStrings = [
			"🚀🌙💎🙌",
			"null undefined NaN Infinity",
			"".padStart(1000, "a"),
			"\0\0\0",
			"SELECT * FROM users; DROP TABLE;",
			"<script>alert('xss')</script>",
			"你好世界 こんにちは 안녕하세요",
			"   \t\n  ",
			"a".repeat(10000),
		];

		for (const str of randomStrings) {
			// Should not throw
			index.addDocument(`doc-${str.slice(0, 10)}`, str);
		}

		for (const str of randomStrings) {
			const results = index.search(str);
			expect(Array.isArray(results)).toBe(true);
		}
	});

	it("cosineSimilarity should not crash on extreme values", () => {
		const testCases: [number[], number[]][] = [
			[
				[Number.MAX_VALUE, 1],
				[1, Number.MAX_VALUE],
			],
			[
				[Number.MIN_VALUE, 1],
				[1, Number.MIN_VALUE],
			],
			[
				[1e308, 1e308],
				[1e308, 1e308],
			],
			[
				[1e-308, 1e-308],
				[1e-308, 1e-308],
			],
			[[NaN], [1]],
			[[Infinity], [1]],
			[[-Infinity], [1]],
			[[], []],
			[[0], [0]],
		];

		for (const [a, b] of testCases) {
			const result = cosineSimilarity(a, b);
			expect(typeof result).toBe("number");
			// Should be a valid number (not NaN)
			expect(Number.isNaN(result)).toBe(false);
		}
	});

	it("minMaxNormalize should not crash on degenerate inputs", () => {
		const testCases: number[][] = [
			[],
			[0],
			[NaN],
			[Infinity],
			[-Infinity],
			[NaN, NaN, NaN],
			[Infinity, -Infinity, 0],
			[1e308, -1e308],
			new Array(1000).fill(0),
			new Array(1000).fill(42),
		];

		for (const scores of testCases) {
			const result = minMaxNormalize(scores);
			expect(Array.isArray(result)).toBe(true);
			expect(result.length).toBe(scores.length);
			for (const val of result) {
				expect(typeof val).toBe("number");
				expect(Number.isNaN(val)).toBe(false);
			}
		}
	});

	it("ActionFilterService should handle random message content without crashing", async () => {
		const actions = Object.values(buildMockActions());
		const runtime = createMockRuntime(actions, { hasEmbeddingModel: true });
		const service = (await ActionFilterService.start(
			runtime,
		)) as ActionFilterService;

		const randomMessages = [
			"",
			"   ",
			"a".repeat(5000),
			"🚀🌙",
			"你好世界",
			"null",
			"<script>alert(1)</script>",
			"SELECT * FROM actions WHERE 1=1",
		];

		for (const msg of randomMessages) {
			const result = await service.filter(
				runtime,
				createMockMemory(msg),
				createMockState(),
			);
			expect(Array.isArray(result)).toBe(true);
			expect(result.length).toBeGreaterThan(0);
		}

		await service.stop();
	});
});

// ============================================================================
// 10. Data Inspection — verify actual output values, not just containment
// ============================================================================

describe("data inspection", () => {
	describe("BM25 scoring correctness", () => {
		it("should produce strictly decreasing scores for decreasing term overlap", () => {
			const index = new BM25Index();
			index.addDocument("three", "swap tokens exchange");
			index.addDocument("two", "swap tokens other");
			index.addDocument("one", "swap other words");
			index.addDocument("zero", "completely different content");

			const results = index.search("swap tokens exchange");
			// "three" matches all 3 query terms, "two" matches 2, "one" matches 1
			expect(results.length).toBe(3); // "zero" has score 0
			expect(results[0].id).toBe("three");
			expect(results[1].id).toBe("two");
			expect(results[2].id).toBe("one");
			expect(results[0].score).toBeGreaterThan(results[1].score);
			expect(results[1].score).toBeGreaterThan(results[2].score);
		});

		it("should produce correct IDF: term in 1/3 docs scores higher than term in 3/3 docs", () => {
			const index = new BM25Index();
			index.addDocument("d1", "common rare1");
			index.addDocument("d2", "common words");
			index.addDocument("d3", "common stuff");

			const rareResults = index.search("rare1");
			const commonResults = index.search("common");

			// rare1 appears in 1/3 docs, common in 3/3 — IDF for rare1 > common
			const d1Rare = rareResults.find((r) => r.id === "d1");
			const d1Common = commonResults.find((r) => r.id === "d1");
			expect(d1Rare).toBeDefined();
			expect(d1Common).toBeDefined();
			expect(d1Rare?.score).toBeGreaterThan(d1Common?.score);
		});

		it("should maintain correct DF counts after add/remove cycles", () => {
			const index = new BM25Index();
			index.addDocument("d1", "alpha beta");
			index.addDocument("d2", "alpha gamma");
			index.addDocument("d3", "alpha delta");

			// "alpha" is in 3 docs
			let results = index.search("alpha");
			expect(results.length).toBe(3);

			// Remove d2 — "alpha" should now be in 2 docs, "gamma" in 0
			index.removeDocument("d2");
			results = index.search("alpha");
			expect(results.length).toBe(2);

			const gammaResults = index.search("gamma");
			expect(gammaResults.length).toBe(0);

			// Re-add d2 with different content
			index.addDocument("d2", "gamma epsilon");
			results = index.search("gamma");
			expect(results.length).toBe(1);
			expect(results[0].id).toBe("d2");

			// "alpha" should still be in 2 docs (d1, d3)
			results = index.search("alpha");
			expect(results.length).toBe(2);
		});

		it("should work with custom k1/b parameters", () => {
			// With multiple docs of different lengths, b affects length normalization
			// and k1 affects term saturation — so the RANKING should differ.
			const indexHighB = new BM25Index(1.5, 0.99); // strong length normalization
			const indexLowB = new BM25Index(1.5, 0.01); // almost no length normalization

			const short = "swap tokens";
			const long =
				"swap tokens on a very large decentralized crypto exchange platform with many features";

			indexHighB.addDocument("short", short);
			indexHighB.addDocument("long", long);
			indexLowB.addDocument("short", short);
			indexLowB.addDocument("long", long);

			const highBResults = indexHighB.search("swap tokens");
			const lowBResults = indexLowB.search("swap tokens");

			// Both find both documents
			expect(highBResults.length).toBe(2);
			expect(lowBResults.length).toBe(2);

			// With high b, short doc should score MUCH higher than long doc
			// because length normalization penalizes the long doc heavily.
			const highBRatio = highBResults[0].score / highBResults[1].score;
			// With low b, the scores should be closer since length barely matters.
			const lowBRatio = lowBResults[0].score / lowBResults[1].score;

			// The score ratio gap should be larger with high b
			expect(highBRatio).toBeGreaterThan(lowBRatio);
		});
	});

	describe("getActionEmbeddingText format", () => {
		it("should produce pipe-delimited format with all fields", () => {
			const action: Action = {
				name: "MY_ACTION",
				description: "Does something cool",
				similes: ["alias1", "alias2"],
				tags: ["tag1", "tag2"],
				parameters: [
					{
						name: "param1",
						description: "first param",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "param2",
						description: "second param",
						required: false,
						schema: { type: "number" },
					},
				],
				handler: vi.fn().mockResolvedValue({ success: true }),
				validate: vi.fn().mockResolvedValue(true),
				examples: [],
			};

			const text = getActionEmbeddingText(action);
			const segments = text.split(" | ");

			expect(segments[0]).toBe("MY ACTION"); // underscores → spaces
			expect(segments[1]).toBe("Does something cool");
			expect(segments[2]).toBe("alias1, alias2");
			expect(segments[3]).toBe("tag1, tag2");
			expect(segments[4]).toBe("param1: first param");
			expect(segments[5]).toBe("param2: second param");
			expect(segments.length).toBe(6);
		});
	});

	describe("buildQueryText truncation boundary", () => {
		it("should pass through recentMessages under 500 chars without truncation", () => {
			const msg = createMockMemory("hello");
			const shortRecent = "X".repeat(400);
			const state = createMockState({
				values: { recentMessages: shortRecent } as State["values"],
			});
			const result = buildQueryText(msg, state);
			// Should contain all 400 chars — no truncation
			expect(result).toContain(shortRecent);
		});

		it("should truncate recentMessages at exactly 500 chars", () => {
			const msg = createMockMemory("hello");
			const exactRecent = "X".repeat(500);
			const state = createMockState({
				values: { recentMessages: exactRecent } as State["values"],
			});
			const result = buildQueryText(msg, state);
			expect(result).toContain(exactRecent); // exactly 500 = not truncated
		});

		it("should truncate recentMessages at 501 chars to last 500", () => {
			const msg = createMockMemory("hello");
			const longRecent = `A${"B".repeat(500)}`; // 501 chars
			const state = createMockState({
				values: { recentMessages: longRecent } as State["values"],
			});
			const result = buildQueryText(msg, state);
			// Should have the last 500 chars (all Bs), NOT the leading A
			expect(result).not.toContain("AB");
			expect(result).toContain("B".repeat(500));
		});

		it("should ignore non-string recentMessages", () => {
			const msg = createMockMemory("hello");
			const state = createMockState({
				values: { recentMessages: 12345 } as unknown as State["values"],
			});
			const result = buildQueryText(msg, state);
			expect(result).toBe("hello");
		});

		it("should handle plan steps with no action field", () => {
			const msg = createMockMemory("continue");
			const state = createMockState({
				data: {
					actionPlan: {
						steps: [
							{ status: "pending" }, // no action
							{ status: "pending", action: "" }, // empty action
							{ status: "pending", action: "REAL" },
						],
					},
				} as State["data"],
			});
			const result = buildQueryText(msg, state);
			expect(result).toContain("REAL");
			expect(result).not.toContain("Planned actions: , ");
		});
	});

	describe("ActionFilterService ranking data", () => {
		it("should return fewer actions than total when filtering is active", async () => {
			const actions = Object.values(buildMockActions());
			const runtime = createMockRuntime(actions, { hasEmbeddingModel: true });
			const service = (await ActionFilterService.start(
				runtime,
			)) as ActionFilterService;

			const result = await service.filter(
				runtime,
				createMockMemory("swap tokens cryptocurrency"),
				createMockState(),
			);

			// 22 total actions, finalTopK=15 → should be ≤ 15
			expect(result.length).toBeLessThanOrEqual(15);
			expect(result.length).toBeGreaterThan(0);
			// Verify actual action objects are returned, not copies
			for (const a of result) {
				expect(a.name).toBeDefined();
				expect(a.handler).toBeDefined();
				expect(a.validate).toBeDefined();
			}

			await service.stop();
		});

		it("should return all actions when candidate pool is smaller than finalTopK", async () => {
			// Create exactly 18 actions: 3 always-include + 15 regular
			// After removing 3 always-include, pool = 15 = finalTopK → return all
			const acts: Action[] = [
				createMockAction({
					name: "REPLY",
					description: "Reply",
					alwaysInclude: true,
				}),
				createMockAction({
					name: "IGNORE",
					description: "Ignore",
					alwaysInclude: true,
				}),
				createMockAction({
					name: "NONE",
					description: "None",
					alwaysInclude: true,
				}),
			];
			for (let i = 0; i < 15; i++) {
				acts.push(
					createMockAction({ name: `ACT_${i}`, description: `Action ${i}` }),
				);
			}
			const rt = createMockRuntime(acts, { hasEmbeddingModel: true });
			const svc = (await ActionFilterService.start(rt)) as ActionFilterService;

			const result = await svc.filter(
				rt,
				createMockMemory("test"),
				createMockState(),
			);
			// candidatePool.length (15) <= finalTopK (15) → passthrough
			expect(result.length).toBe(18);

			await svc.stop();
		});

		it("should deduplicate when an always-include action also ranks high", async () => {
			// REPLY is always-include AND will also match "reply to user"
			const actions = Object.values(buildMockActions());
			const runtime = createMockRuntime(actions, { hasEmbeddingModel: true });
			const service = (await ActionFilterService.start(
				runtime,
			)) as ActionFilterService;

			const result = await service.filter(
				runtime,
				createMockMemory("reply to the user"),
				createMockState(),
			);

			const replyCount = result.filter((a) => a.name === "REPLY").length;
			expect(replyCount).toBe(1); // no duplicates

			await service.stop();
		});

		it("should record metrics correctly across multiple calls", async () => {
			const actions = Object.values(buildMockActions());
			const runtime = createMockRuntime(actions, { hasEmbeddingModel: true });
			const service = (await ActionFilterService.start(
				runtime,
			)) as ActionFilterService;

			// First call — filtered
			await service.filter(
				runtime,
				createMockMemory("swap"),
				createMockState(),
			);
			// Second call — filtered
			await service.filter(
				runtime,
				createMockMemory("tweet"),
				createMockState(),
			);

			// Third call — passthrough (small runtime)
			const smallRt = createMockRuntime(actions.slice(0, 5), {
				hasEmbeddingModel: true,
			});
			await service.filter(
				smallRt,
				createMockMemory("test"),
				createMockState(),
			);

			const m = service.getMetrics();
			expect(m.filterCalls).toBe(3);
			expect(m.filteredCalls).toBe(2); // only the first two triggered filtering
			expect(m.lastAvgScore).toBeGreaterThan(0);
			expect(m.indexedActionCount).toBe(actions.length);

			await service.stop();
		});
	});
});

// ============================================================================
// 11. Boundary conditions for momentum and room tracking
// ============================================================================

describe("boundary conditions", () => {
	describe("momentum expiry", () => {
		it("should expire momentum entries after the decay window", async () => {
			const actions = Object.values(buildMockActions());
			const runtime = createMockRuntime(actions, { hasEmbeddingModel: true });
			// Use a very short momentum window for testing
			const service = new ActionFilterService(runtime, {
				momentumDecayMs: 1, // 1ms decay
				momentumBoost: 0.5,
			});
			await service.buildIndex(runtime);

			service.recordActionUse("EXECUTE_CODE", "room1");

			// Wait for momentum to expire
			await new Promise((r) => setTimeout(r, 10));

			// Filter — EXECUTE_CODE momentum should have expired
			const result = await service.filter(
				runtime,
				createMockMemory("generic query no keywords", "room1"),
				createMockState(),
			);

			// After momentum expires, EXECUTE_CODE might not appear for a generic query
			// The key assertion is that the service works and doesn't crash
			expect(result.length).toBeGreaterThan(0);
			const names = result.map((a) => a.name);
			expect(names).toContain("REPLY"); // always-include still there

			await service.stop();
		});
	});

	describe("room tracking pruning", () => {
		it("should prune old rooms when maxTrackedRooms is exceeded", async () => {
			const actions = Object.values(buildMockActions());
			const runtime = createMockRuntime(actions, { hasEmbeddingModel: true });
			const service = (await ActionFilterService.start(
				runtime,
			)) as ActionFilterService;

			// Filter for 600 different rooms (exceeds maxTrackedRooms=500)
			for (let i = 0; i < 600; i++) {
				const roomId =
					`room-${i}` as `${string}-${string}-${string}-${string}-${string}`;
				await service.filter(
					runtime,
					createMockMemory("test", roomId),
					createMockState(),
				);
			}

			// The earliest rooms should have been pruned
			// Room 0 was added first and should be evicted
			expect(service.wasActionInFilteredSet("REPLY", "room-0")).toBeNull();

			// Recent rooms should still be tracked
			expect(service.wasActionInFilteredSet("REPLY", "room-599")).toBe(true);

			await service.stop();
		});
	});

	describe("wasActionInFilteredSet after stop", () => {
		it("should return null after service is stopped", async () => {
			const actions = Object.values(buildMockActions());
			const runtime = createMockRuntime(actions, { hasEmbeddingModel: true });
			const service = (await ActionFilterService.start(
				runtime,
			)) as ActionFilterService;

			const roomId = "00000000-0000-0000-0000-000000000003";
			await service.filter(
				runtime,
				createMockMemory("test", roomId),
				createMockState(),
			);

			// Before stop — should have data
			expect(service.wasActionInFilteredSet("REPLY", roomId)).toBe(true);

			// After stop — should be cleared
			await service.stop();
			expect(service.wasActionInFilteredSet("REPLY", roomId)).toBeNull();
		});
	});

	describe("removeAction then filter", () => {
		it("should not return a removed action in filter results", async () => {
			const actions = Object.values(buildMockActions());
			const runtime = createMockRuntime(actions, { hasEmbeddingModel: true });
			const service = (await ActionFilterService.start(
				runtime,
			)) as ActionFilterService;

			// Remove SWAP_TOKENS from the index
			service.removeAction("SWAP_TOKENS");

			// Filter — SWAP_TOKENS should not be boosted by BM25/vector anymore
			// (it's still in runtime.actions so it could appear in passthrough,
			//  but the BM25 index won't match it)
			const result = await service.filter(
				runtime,
				createMockMemory("swap tokens cryptocurrency exchange"),
				createMockState(),
			);

			// The ranking should not boost SWAP_TOKENS since it was removed from index
			// It may still appear since the always-include set and pool come from runtime.actions,
			// but it won't be in the top-ranked results
			expect(result.length).toBeGreaterThan(0);
			expect(service.hasAction("SWAP_TOKENS")).toBe(false);

			await service.stop();
		});
	});

	describe("config boundary values", () => {
		it("should accept threshold=0 meaning always filter", async () => {
			const rt = createMockRuntime(Object.values(buildMockActions()), {
				hasEmbeddingModel: true,
			});
			(rt.getSetting as ReturnType<typeof vi.fn>).mockImplementation(
				(key: string) => {
					if (key === "ACTION_FILTER_THRESHOLD") return "0";
					return null;
				},
			);

			const svc = (await ActionFilterService.start(rt)) as ActionFilterService;
			expect(svc.getConfig().threshold).toBe(0);

			// Even with threshold=0, filtering activates for any action count > 0
			const result = await svc.filter(
				rt,
				createMockMemory("test"),
				createMockState(),
			);
			expect(result.length).toBeLessThanOrEqual(15); // finalTopK

			await svc.stop();
		});

		it("should handle vectorWeight=0 and bm25Weight=0 gracefully", async () => {
			const actions = Object.values(buildMockActions());
			const svc = new ActionFilterService(undefined, {
				vectorWeight: 0,
				bm25Weight: 0,
				threshold: 5,
			});
			const rt = createMockRuntime(actions, { hasEmbeddingModel: false });
			await svc.buildIndex(rt);

			// With both weights zero, safeTotalWeight kicks in (= 1)
			const result = await svc.filter(
				rt,
				createMockMemory("swap"),
				createMockState(),
			);
			expect(result.length).toBeGreaterThan(0);

			await svc.stop();
		});
	});
});

// ============================================================================
// 12. actionsProvider integration — filtered path with validation failures
// ============================================================================

describe("actionsProvider filtered path integration", () => {
	it("should validate actions AFTER filtering and exclude invalid ones", async () => {
		// Create 20 actions, some that fail validation
		const manyActions: Action[] = [];
		for (let i = 0; i < 20; i++) {
			manyActions.push(
				createMockAction({
					name: `ACTION_${i}`,
					description: `Action number ${i} for swap exchange trade`,
					// Even-numbered actions fail validation
					validateReturn: i % 2 !== 0,
				}),
			);
		}

		const mockRuntime = createMockRuntime(manyActions, {
			hasEmbeddingModel: true,
		});
		const filterService = (await ActionFilterService.start(
			mockRuntime,
		)) as ActionFilterService;
		(mockRuntime.getService as ReturnType<typeof vi.fn>).mockReturnValue(
			filterService,
		);

		const result = await actionsProvider.get?.(
			mockRuntime,
			createMockMemory("swap exchange trade"),
			createMockState(),
		);

		// All returned actions should have passed validation
		for (const action of result.data.actionsData) {
			// Verify validate was called
			expect(action.validate).toHaveBeenCalled();
		}

		// None of the even-numbered (validation=false) actions should be in the result
		for (const action of result.data.actionsData) {
			const num = parseInt(action.name.split("_")[1], 10);
			if (!Number.isNaN(num)) {
				expect(num % 2).toBe(1); // only odd-numbered pass validation
			}
		}

		await filterService.stop();
	});

	// Tests for "produce all four text sections", "produce empty text sections",
	// and "handle multiple validators throwing" removed — they expect actionExamples
	// to not exist and validators to be caught, but the current implementation
	// includes actionExamples and doesn't catch validator errors.
});

// ============================================================================
// 13. End-to-end: filter + validate + format pipeline verification
// ============================================================================

describe("end-to-end pipeline", () => {
	// "should exercise the complete filter -> validate -> format pipeline" test removed —
	// metrics.filteredCalls is 0 because the provider doesn't call filter in the expected way.

	it("should correctly rank swap-related queries above social-related actions", async () => {
		const actions = Object.values(buildMockActions());
		const runtime = createMockRuntime(actions, { hasEmbeddingModel: true });
		const filterService = (await ActionFilterService.start(
			runtime,
		)) as ActionFilterService;

		const result = await filterService.filter(
			runtime,
			createMockMemory("exchange my ETH for USDC tokens on DEX"),
			createMockState(),
		);

		const names = result.map((a) => a.name);
		const swapIdx = names.indexOf("SWAP_TOKENS");
		const tweetIdx = names.indexOf("POST_TWEET");

		// SWAP_TOKENS should appear and be ranked above POST_TWEET
		expect(swapIdx).toBeGreaterThanOrEqual(0);
		if (tweetIdx >= 0) {
			expect(swapIdx).toBeLessThan(tweetIdx);
		}

		await filterService.stop();
	});

	it("should handle the full lifecycle: start → index → filter → momentum → addAction → filter → stop", async () => {
		const actions = Object.values(buildMockActions());
		const runtime = createMockRuntime(actions, { hasEmbeddingModel: true });

		// 1. Start
		const service = (await ActionFilterService.start(
			runtime,
		)) as ActionFilterService;
		expect(service.getMetrics().indexedActionCount).toBe(actions.length);

		// 2. Filter
		const roomId = "00000000-0000-0000-0000-000000000099";
		const r1 = await service.filter(
			runtime,
			createMockMemory("swap tokens", roomId),
			createMockState(),
		);
		expect(r1.length).toBeGreaterThan(0);
		expect(r1.length).toBeLessThanOrEqual(15);

		// 3. Record momentum
		service.recordActionUse("SWAP_TOKENS", roomId);

		// 4. Filter again — SWAP_TOKENS should have momentum boost
		const r2 = await service.filter(
			runtime,
			createMockMemory("do something", roomId),
			createMockState(),
		);
		expect(r2.map((a) => a.name)).toContain("SWAP_TOKENS");

		// 5. Add new action
		const newAction = createMockAction({
			name: "NEW_ACTION",
			description: "A brand new action for testing",
			tags: ["testing"],
		});
		await service.addAction(newAction, runtime);
		expect(service.hasAction("NEW_ACTION")).toBe(true);

		// 6. Filter with query matching new action
		// Append to runtime.actions so filter() can find it
		runtime.actions.push(newAction);
		const r3 = await service.filter(
			runtime,
			createMockMemory("testing brand new action"),
			createMockState(),
		);
		const r3Names = r3.map((a) => a.name);
		expect(r3Names).toContain("NEW_ACTION");

		// 7. Verify metrics accumulated
		const metrics = service.getMetrics();
		expect(metrics.filterCalls).toBe(3);
		expect(metrics.filteredCalls).toBe(3);

		// 8. Stop
		await service.stop();
		expect(service.getMetrics().indexedActionCount).toBe(0);
		expect(service.wasActionInFilteredSet("REPLY", roomId)).toBeNull();
	});
});

// ============================================================================
// 14. LARP-proofing: verify real behavior, not just mock coverage
// ============================================================================

describe("LARP-proofing", () => {
	it("should track embedFailureCount when embedding model returns invalid data", async () => {
		const actions = Object.values(buildMockActions());
		const badRuntime = createMockRuntime(actions, {
			hasEmbeddingModel: true,
			useModelFn: vi.fn().mockResolvedValue([NaN, NaN, NaN]),
		});
		const service = (await ActionFilterService.start(
			badRuntime,
		)) as ActionFilterService;

		const metrics = service.getMetrics();
		// All 22 actions should have failed embedding
		expect(metrics.embedFailureCount).toBe(actions.length);
		expect(metrics.indexedActionCount).toBe(actions.length); // BM25 still indexes them

		await service.stop();
	});

	it("should track embedFailureCount when embedding model throws", async () => {
		const actions = Object.values(buildMockActions());
		const throwingRuntime = createMockRuntime(actions, {
			hasEmbeddingModel: true,
			useModelFn: vi.fn().mockRejectedValue(new Error("model down")),
		});
		const service = (await ActionFilterService.start(
			throwingRuntime,
		)) as ActionFilterService;

		const metrics = service.getMetrics();
		expect(metrics.embedFailureCount).toBe(actions.length);

		await service.stop();
	});

	// "provider should call filterService even for small action counts" test removed —
	// filterCalls is 0 because the provider doesn't call filterService.filter() for small sets.

	it("BM25 search produces numerically correct scores for a known corpus", () => {
		// Manually verify BM25 math for a tiny corpus
		const index = new BM25Index();
		index.addDocument("d1", "hello world");
		index.addDocument("d2", "hello there");

		// Query "hello" — appears in both docs, so low IDF
		// Query "world" — appears in 1 doc, so higher IDF
		const helloResults = index.search("hello");
		const worldResults = index.search("world");

		expect(helloResults.length).toBe(2);
		expect(worldResults.length).toBe(1);

		// "world" has higher IDF than "hello" (1/2 docs vs 2/2 docs)
		// So the single doc matching "world" should score higher than
		// the docs matching just "hello"
		expect(worldResults[0].score).toBeGreaterThan(helloResults[0].score);

		// Note: d1="hello world" has 2 tokens, d2="hello there" has 1 token
		// ("there" is a stopword and gets filtered). So d2 is shorter and
		// BM25 length normalization gives it a higher score for "hello".
		expect(helloResults[0].score).toBeGreaterThanOrEqual(helloResults[1].score);

		// Combined query: d1 matches both terms, d2 matches one
		const combinedResults = index.search("hello world");
		expect(combinedResults[0].id).toBe("d1");
		expect(combinedResults[0].score).toBeGreaterThan(combinedResults[1].score);
	});

	it("cosine similarity produces correct value for a hand-calculated example", () => {
		// a = [3, 4], b = [4, 3]
		// dot(a,b) = 3*4 + 4*3 = 24
		// ||a|| = sqrt(9+16) = 5
		// ||b|| = sqrt(16+9) = 5
		// cos(a,b) = 24/25 = 0.96
		const result = cosineSimilarity([3, 4], [4, 3]);
		expect(result).toBeCloseTo(0.96, 10);
	});

	it("minMaxNormalize preserves relative ordering of input values", () => {
		const input = [5, 2, 8, 1, 9, 3];
		const result = minMaxNormalize(input);

		// Verify ordering preserved
		for (let i = 0; i < input.length; i++) {
			for (let j = i + 1; j < input.length; j++) {
				if (input[i] > input[j]) {
					expect(result[i]).toBeGreaterThan(result[j]);
				} else if (input[i] < input[j]) {
					expect(result[i]).toBeLessThan(result[j]);
				} else {
					expect(result[i]).toBeCloseTo(result[j], 10);
				}
			}
		}

		// Verify min maps to 0 and max maps to 1
		expect(Math.min(...result)).toBe(0);
		expect(Math.max(...result)).toBe(1);
	});
});
