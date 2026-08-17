/**
 * Per-turn memory-search budget (live sol-dev 2026-08-17): the planner
 * re-invoked MEMORY_SEARCH 3-5x per turn with reformulated queries, each round
 * costing a full planner prompt round-trip (30-117s tail turns). These tests
 * pin the budget contract: near-duplicate queries are skipped, executed rounds
 * are capped, non-search calls pass through untouched, and a model that keeps
 * emitting fresh-phrase searches past the budget is forced into a terminal
 * synthesis instead of looping. Deterministic — no live model or DB.
 */
import { describe, expect, it, vi } from "vitest";
import {
	isMemoryRecallSearchCall,
	normalizedRecallQueryKey,
	partitionMemorySearchBudget,
	runPlannerLoop,
} from "../planner-loop";

const emptyTrajectory = () => ({
	context: { id: "ctx" },
	steps: [],
	archivedSteps: [],
	plannedQueue: [],
	evaluatorOutputs: [],
});

describe("isMemoryRecallSearchCall", () => {
	it("matches MEMORY_SEARCH, SEARCH_KNOWLEDGE, and MEMORY with a search op", () => {
		expect(
			isMemoryRecallSearchCall({ name: "MEMORY_SEARCH", params: {} }),
		).toBe(true);
		expect(
			isMemoryRecallSearchCall({ name: "SEARCH_KNOWLEDGE", params: {} }),
		).toBe(true);
		expect(
			isMemoryRecallSearchCall({
				name: "MEMORY",
				params: { action: "search", query: "x" },
			}),
		).toBe(true);
		expect(
			isMemoryRecallSearchCall({
				name: "MEMORY",
				params: { op: "search" },
			}),
		).toBe(true);
		for (const alias of ["operation", "verb", "subAction", "__subaction"]) {
			expect(
				isMemoryRecallSearchCall({
					name: "MEMORY",
					params: { [alias]: "search" },
				}),
			).toBe(true);
		}
	});

	it("does NOT match non-recall tools or non-search MEMORY ops", () => {
		expect(isMemoryRecallSearchCall({ name: "WEB_SEARCH", params: {} })).toBe(
			false,
		);
		expect(
			isMemoryRecallSearchCall({ name: "MESSAGE_SEARCH", params: {} }),
		).toBe(false);
		expect(
			isMemoryRecallSearchCall({
				name: "MEMORY",
				params: { action: "create", text: "note" },
			}),
		).toBe(false);
		expect(
			isMemoryRecallSearchCall({ name: "MEMORY_CREATE", params: {} }),
		).toBe(false);
	});
});

describe("normalizedRecallQueryKey", () => {
	it("maps reformulations of the same query to one key", () => {
		const a = normalizedRecallQueryKey({
			name: "MEMORY_SEARCH",
			params: { query: "alexis gym signup" },
		});
		const b = normalizedRecallQueryKey({
			name: "MEMORY_SEARCH",
			params: { query: "Gym signup: Alexis?" },
		});
		expect(a).toBe(b);
		expect(a).toBe("alexis gym signup");
	});

	it("returns null without usable query text", () => {
		expect(
			normalizedRecallQueryKey({ name: "MEMORY_SEARCH", params: {} }),
		).toBeNull();
		expect(
			normalizedRecallQueryKey({
				name: "MEMORY_SEARCH",
				params: { query: "  " },
			}),
		).toBeNull();
	});
});

describe("partitionMemorySearchBudget", () => {
	it("passes non-search calls through and allows searches within budget", () => {
		const calls = [
			{ name: "WEB_FETCH", params: { url: "https://x" } },
			{ name: "MEMORY_SEARCH", params: { query: "strata deal fee" } },
		];
		const out = partitionMemorySearchBudget(calls, emptyTrajectory(), 2);
		expect(out.allowed).toEqual(calls);
		expect(out.skippedOverBudget).toEqual([]);
		expect(out.skippedNearDuplicate).toEqual([]);
	});

	it("skips a near-duplicate of a query already executed this turn", () => {
		const trajectory = {
			...emptyTrajectory(),
			steps: [
				{
					toolCall: {
						name: "MEMORY_SEARCH",
						params: { query: "alexis gym signup" },
					},
					result: { success: true, text: "3 matches" },
				},
			],
		};
		const reformulated = {
			name: "MEMORY_SEARCH",
			params: { query: "gym signup alexis" },
		};
		const out = partitionMemorySearchBudget([reformulated], trajectory, 5);
		expect(out.allowed).toEqual([]);
		expect(out.skippedNearDuplicate).toEqual([reformulated]);
	});

	it("allows a rephrased query after a successful search returned no matches", () => {
		const trajectory = {
			...emptyTrajectory(),
			steps: [
				{
					toolCall: {
						name: "SEARCH_KNOWLEDGE",
						params: { query: "alexis gym signup" },
					},
					result: {
						success: true,
						text: "No knowledge items match that query.",
						data: { count: 0, items: [] },
					},
				},
			],
		};
		const reformulated = {
			name: "SEARCH_KNOWLEDGE",
			params: { query: "gym signup alexis" },
		};
		const out = partitionMemorySearchBudget([reformulated], trajectory, 5);
		expect(out.allowed).toEqual([reformulated]);
		expect(out.skippedNearDuplicate).toEqual([]);
	});

	it("counts executed rounds from archived (compacted) steps too", () => {
		const trajectory = {
			...emptyTrajectory(),
			archivedSteps: [
				{
					toolCall: { name: "MEMORY_SEARCH", params: { query: "q one" } },
					result: { success: true, text: "" },
				},
				{
					toolCall: { name: "SEARCH_KNOWLEDGE", params: { query: "q two" } },
					result: { success: false, text: "no matches" },
				},
			],
		};
		const fresh = { name: "MEMORY_SEARCH", params: { query: "brand new" } };
		const out = partitionMemorySearchBudget([fresh], trajectory, 2);
		expect(out.allowed).toEqual([]);
		expect(out.skippedOverBudget).toEqual([fresh]);
	});

	it("caps multiple fresh searches planned in the same batch", () => {
		const q1 = { name: "MEMORY_SEARCH", params: { query: "one" } };
		const q2 = { name: "MEMORY_SEARCH", params: { query: "two" } };
		const q3 = { name: "MEMORY_SEARCH", params: { query: "three" } };
		const out = partitionMemorySearchBudget([q1, q2, q3], emptyTrajectory(), 2);
		expect(out.allowed).toEqual([q1, q2]);
		expect(out.skippedOverBudget).toEqual([q3]);
	});

	it("skips an in-batch near-duplicate without spending extra budget", () => {
		const q1 = { name: "MEMORY_SEARCH", params: { query: "echo lake circle" } };
		const dup = {
			name: "MEMORY_SEARCH",
			params: { query: "circle echo lake" },
		};
		const q2 = { name: "MEMORY_SEARCH", params: { query: "hape ceremony" } };
		const out = partitionMemorySearchBudget(
			[q1, dup, q2],
			emptyTrajectory(),
			2,
		);
		expect(out.allowed).toEqual([q1, q2]);
		expect(out.skippedNearDuplicate).toEqual([dup]);
	});

	it("failed searches still consume budget (each cost a full planner round)", () => {
		const trajectory = {
			...emptyTrajectory(),
			steps: [
				{
					toolCall: { name: "MEMORY_SEARCH", params: { query: "first try" } },
					result: { success: false, text: "backend error" },
				},
				{
					toolCall: {
						name: "MEMORY_SEARCH",
						params: { query: "second try" },
					},
					result: { success: false, text: "backend error" },
				},
			],
		};
		const next = { name: "MEMORY_SEARCH", params: { query: "third try" } };
		const out = partitionMemorySearchBudget([next], trajectory, 2);
		expect(out.skippedOverBudget).toEqual([next]);
	});
});

describe("runPlannerLoop memory-search budget integration", () => {
	it("executes up to the budget, then forces a terminal synthesis instead of looping on fresh-phrase searches", async () => {
		// Simulates the live pathology: the model keeps re-searching memory with
		// NEW phrasings every round (so the byte-identical redundant breaker never
		// trips). The budget executes 2 rounds, skips the rest, and after the
		// dead-round bound forces one tool-less synthesis.
		const searchCall = (id: string, query: string) => ({
			id,
			name: "MEMORY_SEARCH",
			arguments: { query },
		});
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [searchCall("s1", "alexis gym signup")],
					usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
				})
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [searchCall("s2", "gym membership alexis details")],
					usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
				})
				// Budget (2) now spent; these fresh-phrase searches are skipped.
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [searchCall("s3", "alexis fitness registration")],
					usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
				})
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [searchCall("s4", "signup record gym")],
					usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
				})
				// Forced synthesis (no tools) → terminal answer.
				.mockResolvedValueOnce({
					text: '{"thought":"Answering from gathered results.","messageToUser":"Alexis signed up at the Breck rec center.","toolCalls":[]}',
					usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
				}),
			logger: { debug: vi.fn(), warn: vi.fn() },
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "match: breck rec center signup",
		}));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "CONTINUE" as const,
			thought: "Maybe search again.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [{ name: "MEMORY_SEARCH", description: "Search stored memory." }],
			config: { maxMemorySearchRounds: 2, maxRepeatedToolCalls: 1 },
			executeToolCall,
			evaluate,
		});

		// Exactly the budgeted number of searches ran.
		expect(executeToolCall).toHaveBeenCalledTimes(2);
		expect(result.status).toBe("finished");
		expect(result.finalMessage).toContain("Breck");
		// The synthesis prompt carried the gathered results forward.
		const synthesisParams = runtime.useModel.mock.calls.at(-1)?.[1];
		expect(JSON.stringify(synthesisParams)).toContain("breck rec center");
	});

	it("skips a near-duplicate reformulation but still executes a genuinely different follow-up search", async () => {
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "s1",
							name: "MEMORY_SEARCH",
							arguments: { query: "strata deal fee" },
						},
					],
					usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
				})
				// Near-duplicate (same tokens, new order) + a genuinely new query.
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "s2",
							name: "MEMORY_SEARCH",
							arguments: { query: "fee deal strata" },
						},
						{
							id: "s3",
							name: "MEMORY_SEARCH",
							arguments: { query: "initiation fee percentage" },
						},
					],
					usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
				})
				.mockResolvedValue({
					text: '{"thought":"Done.","messageToUser":"The initiation fee is about 5 percent.","toolCalls":[]}',
					usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
				}),
			logger: { debug: vi.fn(), warn: vi.fn() },
		};
		const executed: string[] = [];
		const executeToolCall = vi.fn(
			async (toolCall: { params?: Record<string, unknown> }) => {
				executed.push(String(toolCall.params?.query));
				return { success: true, text: "match: 5% initiation fee" };
			},
		);
		// CONTINUE after each executed search; FINISH once the terminal reply
		// arrives (mirrors the live evaluator contract).
		const evaluate = vi
			.fn()
			.mockResolvedValueOnce({
				success: true,
				decision: "CONTINUE" as const,
				thought: "Search once more.",
			})
			.mockResolvedValue({
				success: true,
				decision: "FINISH" as const,
				thought: "Answer is gathered.",
			});

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [{ name: "MEMORY_SEARCH", description: "Search stored memory." }],
			config: { maxMemorySearchRounds: 2 },
			executeToolCall,
			evaluate,
		});

		expect(executed).toEqual(["strata deal fee", "initiation fee percentage"]);
		expect(result.status).toBe("finished");
		expect(result.finalMessage).toContain("5 percent");
	});
});
