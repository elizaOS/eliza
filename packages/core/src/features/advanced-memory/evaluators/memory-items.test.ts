/**
 * Deterministic regression tests for `summaryEvaluator`: the bounded
 * first-summary prompt window, the first-store `lastMessageOffset` advancing by
 * the summarized slice (not the full backlog), and `shouldRun` dialogue counting
 * matching canonical `MemoryType.MESSAGE`. Uses an in-memory `createMockRuntime`
 * and a stub `MemoryService` — no live model or database.
 */
import { describe, expect, it } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime";
import type { EvaluatorRunOptions, Memory, State } from "../../../types";
import { type SummaryPrepared, summaryEvaluator } from "./memory-items";

const runtime = createMockRuntime({
	agentId: "agent-1",
	character: { name: "Agent" },
	getService: () => null,
});

function msg(id: string, text: string): Memory {
	return {
		id,
		entityId: "user-1",
		content: { text, senderName: "User" },
		createdAt: 1,
	} as unknown as Memory;
}

function preparedWith(over: Partial<SummaryPrepared>): SummaryPrepared {
	return {
		memoryService: {} as SummaryPrepared["memoryService"],
		summarizationMessages: [],
		existingSummary: null,
		lastOffset: 0,
		totalDialogueCount: 0,
		canSummarize: false,
		...over,
	};
}

function promptFor(prepared: SummaryPrepared): string {
	return summaryEvaluator.prompt({
		runtime,
		message: msg("trigger", "trigger"),
		state: {} as State,
		options: {} as EvaluatorRunOptions,
		prepared,
	});
}

describe("summaryEvaluator.prompt — bounded message window (regression)", () => {
	// Regression for the unbounded first-summary prompt: the no-existing-summary
	// branch used to render the full allDialogueMessages (up to 1000 fetched), which
	// over-sent — context_length_exceeded in busy rooms, so the summary never stored
	// and the same oversized request retried forever — and double-counted messages on
	// the next run (the stored lastMessageOffset only advances by summarizationMessages).
	// The prompt must always reflect the bounded summarizationMessages slice.

	it("renders only the bounded summarizationMessages when there is no existing summary", () => {
		const text = promptFor(
			preparedWith({
				existingSummary: null,
				summarizationMessages: [msg("1", "alpha"), msg("2", "bravo")],
			}),
		);
		expect(text).toContain("alpha");
		expect(text).toContain("bravo");
		expect(text).toContain("Existing summary:\nNone");
		// exactly one rendered line per bounded message — never the full history
		expect((text.match(/^User: /gm) || []).length).toBe(2);
	});

	it("merges the bounded slice into an existing summary", () => {
		const text = promptFor(
			preparedWith({
				existingSummary: {
					summary: "prior context",
					topics: ["t1"],
				} as SummaryPrepared["existingSummary"],
				summarizationMessages: [msg("3", "charlie")],
			}),
		);
		expect(text).toContain("charlie");
		expect(text).toContain("prior context");
		expect((text.match(/^User: /gm) || []).length).toBe(1);
	});
});

describe("summaryEvaluator storeSummary processor — first-store offset (regression)", () => {
	// Regression: the first store (no existing summary) set
	// lastMessageOffset = totalDialogueCount (the full backlog) while only the
	// bounded slice was actually summarized, silently skipping every message past
	// the slice on subsequent runs. It must advance by the summarized slice, the
	// same way the existing-summary branch does.
	it("advances lastMessageOffset by the bounded slice, not the full backlog", async () => {
		const stored: Array<Record<string, unknown>> = [];
		const memoryService = {
			storeSessionSummary: async (rec: Record<string, unknown>) => {
				stored.push(rec);
			},
			updateSessionSummary: async () => {},
		} as unknown as SummaryPrepared["memoryService"];

		const prepared = preparedWith({
			memoryService,
			existingSummary: null,
			summarizationMessages: [msg("1", "alpha"), msg("2", "bravo")],
			lastOffset: 0,
			totalDialogueCount: 1000,
			canSummarize: true,
		});

		const processor = summaryEvaluator.processors?.[0];
		expect(processor).toBeDefined();
		await processor?.process({
			runtime,
			message: msg("trigger", "trigger"),
			state: {} as State,
			options: {} as EvaluatorRunOptions,
			prepared,
			output: { text: "rolling summary", topics: [], keyPoints: [] },
			evaluatorName: "summary",
		});

		expect(stored).toHaveLength(1);
		expect(stored[0].lastMessageOffset).toBe(2); // slice length, NOT 1000
		expect(stored[0].messageCount).toBe(2);
	});
});

describe("summaryEvaluator.shouldRun — dialogue count matches canonical MESSAGE memories (#11250)", () => {
	function messageMemory(
		id: string,
		metadataType: string,
		contentType = "text",
	): Memory {
		return {
			id,
			entityId: "user-1",
			roomId: "room-1",
			content: { text: `line ${id}`, type: contentType },
			metadata: { type: metadataType },
			createdAt: 1,
		} as unknown as Memory;
	}

	function runtimeWithMessages(
		metadataType: string,
		count: number,
		extraMemories: Memory[] = [],
	) {
		const memories = [
			...Array.from({ length: count }, (_v, i) =>
				messageMemory(`m-${i}`, metadataType),
			),
			...extraMemories,
		];
		const memoryService = {
			getConfig: () => ({
				shortTermSummarizationThreshold: 16,
				shortTermSummarizationInterval: 8,
			}),
			getCurrentSessionSummary: async () => null,
		};
		return createMockRuntime({
			agentId: "agent-1",
			character: { name: "Agent" },
			getService: (name: string) =>
				name === "memory" ? (memoryService as never) : null,
			getMemories: async () => memories,
		} as never);
	}

	const trigger = {
		id: "trigger",
		roomId: "room-1",
		content: { text: "hello", type: "text" },
		metadata: { type: "message" },
		createdAt: 2,
	} as unknown as Memory;

	it("fires at threshold for canonical MemoryType.MESSAGE ('message') memories", async () => {
		const rt = runtimeWithMessages("message", 16);
		const run = await summaryEvaluator.shouldRun?.({
			runtime: rt,
			message: trigger,
			state: {} as State,
			options: {} as EvaluatorRunOptions,
		});
		expect(run).toBe(true);
	});

	it("still counts the legacy metadata types (back-compat)", async () => {
		const rt = runtimeWithMessages("user_message", 16);
		const run = await summaryEvaluator.shouldRun?.({
			runtime: rt,
			message: trigger,
			state: {} as State,
			options: {} as EvaluatorRunOptions,
		});
		expect(run).toBe(true);
	});

	it("does not fire below threshold", async () => {
		const rt = runtimeWithMessages("message", 4);
		const run = await summaryEvaluator.shouldRun?.({
			runtime: rt,
			message: trigger,
			state: {} as State,
			options: {} as EvaluatorRunOptions,
		});
		expect(run).toBe(false);
	});

	it("does not count action_result rows stamped metadata.type 'message' as dialogue", async () => {
		// The real action_result writers (advanced-capabilities message/post
		// actions) stamp content.type "action_result" with metadata.type
		// "message". Those rows must be excluded on content.type alone — the
		// old predicate also required metadata.type === "action_result", so
		// they inflated the dialogue count past the threshold.
		const actionResults = Array.from({ length: 8 }, (_v, i) =>
			messageMemory(`ar-${i}`, "message", "action_result"),
		);
		const rt = runtimeWithMessages("message", 12, actionResults);
		const run = await summaryEvaluator.shouldRun?.({
			runtime: rt,
			message: trigger,
			state: {} as State,
			options: {} as EvaluatorRunOptions,
		});
		// 12 real dialogue rows < 16 threshold; the 8 action_result rows must
		// not push the count over.
		expect(run).toBe(false);
	});
});
