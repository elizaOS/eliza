/**
 * Unit tests for the advanced-memory context summary provider's metadata,
 * empty states, complete summary rendering, topic projection, and explicit
 * unavailable result when the memory service fails.
 */
import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type {
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import type { MemoryService } from "../services/memory-service.ts";
import type { SessionSummary } from "../types.ts";
import { contextSummaryProvider } from "./context-summary.ts";

const ROOM_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;
const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const SUMMARY_ID = "00000000-0000-0000-0000-0000000000b1" as UUID;

const message = {
	roomId: ROOM_ID,
	content: { text: "What did we discuss?" },
} as Memory;
const state = {} as State;

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	const startTime = new Date("2026-04-05T12:00:00.000Z");
	return {
		id: SUMMARY_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		summary: "The user chose the launch date.",
		messageCount: 4,
		lastMessageOffset: 4,
		startTime,
		endTime: new Date("2026-04-05T12:30:00.000Z"),
		createdAt: startTime,
		updatedAt: startTime,
		...overrides,
	};
}

function runtimeWithSummary(result: SessionSummary | null) {
	const getCurrentSessionSummary = vi.fn(async () => result);
	const memoryService = { getCurrentSessionSummary } as MemoryService;
	const reportError = vi.fn<IAgentRuntime["reportError"]>();
	const runtime = createMockRuntime({
		getService: (name) => (name === "memory" ? memoryService : null),
		reportError,
	});
	return { getCurrentSessionSummary, reportError, runtime };
}

describe("contextSummaryProvider", () => {
	it("exposes the advanced-memory provider contract", () => {
		expect(contextSummaryProvider).toMatchObject({
			name: "SUMMARIZED_CONTEXT",
			description: "Provides summarized context from previous conversations",
			position: 96,
			contexts: ["general"],
			contextGate: { anyOf: ["general"] },
			cacheStable: false,
			cacheScope: "turn",
			roleGate: { minRole: "USER" },
		});
	});

	it("contributes empty values when the memory service is unavailable", async () => {
		const runtime = createMockRuntime({ getService: () => null });

		await expect(
			contextSummaryProvider.get(runtime, message, state),
		).resolves.toEqual({
			data: {},
			values: { sessionSummaries: "", sessionSummariesWithTopics: "" },
			text: "",
		});
	});

	it("contributes empty values when the room has no current summary", async () => {
		const { getCurrentSessionSummary, runtime } = runtimeWithSummary(null);

		await expect(
			contextSummaryProvider.get(runtime, message, state),
		).resolves.toEqual({
			data: {},
			values: { sessionSummaries: "", sessionSummariesWithTopics: "" },
			text: "",
		});
		expect(getCurrentSessionSummary).toHaveBeenCalledWith(ROOM_ID);
	});

	it("renders the complete summary without inventing absent topics", async () => {
		const currentSummary = summary({ topics: undefined });
		const { runtime } = runtimeWithSummary(currentSummary);
		const date = currentSummary.startTime.toLocaleDateString();
		const rendered =
			`# Conversation Summary\n**Previous Conversation** (4 messages, ${date})\n` +
			"The user chose the launch date.\n";

		const result = await contextSummaryProvider.get(runtime, message, state);

		expect(result).toEqual({
			data: {
				summaryText: "The user chose the launch date.",
				messageCount: 4,
				topics: "",
			},
			values: {
				sessionSummaries: rendered,
				sessionSummariesWithTopics: rendered,
			},
			text: rendered,
		});
	});

	it("appends every topic only to the topic-aware summary", async () => {
		const currentSummary = summary({
			topics: ["launch plan", "budget", "owners"],
		});
		const { runtime } = runtimeWithSummary(currentSummary);
		const date = currentSummary.startTime.toLocaleDateString();
		const summaryOnly =
			`# Conversation Summary\n**Previous Conversation** (4 messages, ${date})\n` +
			"The user chose the launch date.\n";
		const summaryWithTopics =
			`# Conversation Summary\n**Previous Conversation** (4 messages, ${date})\n` +
			"The user chose the launch date.\n" +
			"*Topics: launch plan, budget, owners*\n";

		const result = await contextSummaryProvider.get(runtime, message, state);

		expect(result.data.topics).toBe("launch plan, budget, owners");
		expect(result.values).toEqual({
			sessionSummaries: summaryOnly,
			sessionSummariesWithTopics: summaryWithTopics,
		});
		expect(result.text).toBe(summaryWithTopics);
	});

	it.each([
		[new Error("summary store offline"), "summary store offline"],
		["non-error rejection", "non-error rejection"],
	])(
		"reports %p and returns an explicit unavailable result",
		async (failure, error) => {
			const getCurrentSessionSummary = vi.fn(async () => {
				throw failure;
			});
			const memoryService = { getCurrentSessionSummary } as MemoryService;
			const reportError = vi.fn<IAgentRuntime["reportError"]>();
			const runtime = createMockRuntime({
				getService: () => memoryService,
				reportError,
			});

			await expect(
				contextSummaryProvider.get(runtime, message, state),
			).resolves.toEqual({
				data: { available: false, error },
				values: { sessionSummariesAvailable: false },
				text: "Session summaries are unavailable.",
			});
			expect(reportError).toHaveBeenCalledWith(
				"ContextSummaryProvider.get",
				failure,
				{ roomId: ROOM_ID },
			);
		},
	);
});
