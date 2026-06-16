import { describe, expect, it } from "vitest";
import type {
	EvaluatorRunOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types";
import { type SummaryPrepared, summaryEvaluator } from "./memory-items";

const runtime = {
	agentId: "agent-1",
	character: { name: "Agent" },
	getService: () => null,
} as unknown as IAgentRuntime;

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
