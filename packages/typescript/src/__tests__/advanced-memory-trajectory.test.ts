import { describe, expect, it, vi } from "vitest";
import { longTermExtractionEvaluator } from "../advanced-memory/evaluators/long-term-extraction.ts";
import { summarizationEvaluator } from "../advanced-memory/evaluators/summarization.ts";
import { contextSummaryProvider } from "../advanced-memory/providers/context-summary.ts";
import { longTermMemoryProvider } from "../advanced-memory/providers/long-term-memory.ts";
import { logger } from "../logger.ts";
import type { Memory, UUID } from "../types/index.ts";

const message = {
	id: "55555555-5555-5555-5555-555555555555" as UUID,
	agentId: "66666666-6666-6666-6666-666666666666" as UUID,
	entityId: "77777777-7777-7777-7777-777777777777" as UUID,
	roomId: "88888888-8888-8888-8888-888888888888" as UUID,
	content: { text: "We shipped the rollout and Chris wants the ETA." },
	metadata: { trajectoryStepId: "trajectory-step-1", type: "user_message" },
	createdAt: Date.now(),
} as Memory;

describe("advanced-memory trajectory logging", () => {
	it("logs provider access for context summaries", async () => {
		const logProviderAccess = vi.fn();
		const runtime = {
			getService(serviceType: string) {
				if (serviceType === "memory") {
					return {
						getCurrentSessionSummary: vi.fn(async () => ({
							id: "99999999-9999-9999-9999-999999999999" as UUID,
							agentId: message.agentId,
							roomId: message.roomId,
							summary: "Chris asked for a rollout ETA and benchmark recap.",
							messageCount: 12,
							lastMessageOffset: 12,
							startTime: new Date("2026-04-08T10:00:00.000Z"),
							endTime: new Date("2026-04-08T10:15:00.000Z"),
							topics: ["rollout", "benchmarks"],
							createdAt: new Date("2026-04-08T10:00:00.000Z"),
							updatedAt: new Date("2026-04-08T10:15:00.000Z"),
						})),
					};
				}
				if (serviceType === "trajectories") {
					return { logProviderAccess };
				}
				return null;
			},
		};

		const result = await contextSummaryProvider.get(
			runtime as never,
			message,
			{} as never,
		);

		expect(result.text).toContain("Conversation Summary");
		expect(logProviderAccess).toHaveBeenCalledWith(
			expect.objectContaining({
				stepId: "trajectory-step-1",
				providerName: "SUMMARIZED_CONTEXT",
				purpose: "session_summary",
			}),
		);
	});

	it("logs provider access for long-term memories", async () => {
		const logProviderAccess = vi.fn();
		const runtime = {
			agentId: message.agentId,
			getService(serviceType: string) {
				if (serviceType === "memory") {
					return {
						getLongTermMemories: vi.fn(async () => [
							{
								id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID,
								agentId: message.agentId,
								entityId: message.entityId,
								category: "semantic",
								content: "Chris prefers concise email subject lines.",
								confidence: 0.96,
								createdAt: new Date("2026-04-08T10:00:00.000Z"),
								updatedAt: new Date("2026-04-08T10:10:00.000Z"),
							},
						]),
						getFormattedLongTermMemories: vi.fn(
							async () =>
								"**Semantic**:\n- Chris prefers concise email subject lines.",
						),
					};
				}
				if (serviceType === "trajectories") {
					return { logProviderAccess };
				}
				return null;
			},
		};

		const result = await longTermMemoryProvider.get(
			runtime as never,
			message,
			{} as never,
		);

		expect(result.text).toContain("What I Know About You");
		expect(logProviderAccess).toHaveBeenCalledWith(
			expect.objectContaining({
				stepId: "trajectory-step-1",
				providerName: "LONG_TERM_MEMORY",
				purpose: "long_term_memory",
			}),
		);
	});

	it("logs evaluator activity for summarization", async () => {
		const logProviderAccess = vi.fn();
		const runtime = {
			agentId: message.agentId,
			character: { name: "Milady" },
			getService(serviceType: string) {
				if (serviceType === "memory") {
					return {
						getConfig: () => ({
							summaryModelType: "TEXT_SMALL",
							summaryMaxTokens: 512,
							shortTermSummarizationThreshold: 4,
							shortTermSummarizationInterval: 2,
						}),
						getCurrentSessionSummary: vi.fn(async () => null),
						storeSessionSummary: vi.fn(async () => null),
					};
				}
				if (serviceType === "trajectories") {
					return { logProviderAccess };
				}
				return null;
			},
			getMemories: vi.fn(async () => [
				{
					...message,
					id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" as UUID,
					content: { text: "Chris asked for the rollout status." },
					metadata: { type: "user_message" },
					createdAt: Date.parse("2026-04-08T10:00:00.000Z"),
				},
				{
					...message,
					id: "cccccccc-cccc-cccc-cccc-cccccccccccc" as UUID,
					entityId: message.agentId,
					content: {
						text: "We shipped phase one and are monitoring benchmarks.",
					},
					metadata: { type: "agent_response_message" },
					createdAt: Date.parse("2026-04-08T10:02:00.000Z"),
				},
			]),
			composeState: vi.fn(async () => ({})),
			useModel: vi.fn(
				async () =>
					"<text>Chris asked for rollout status and benchmark updates.</text><topics>rollout,benchmarks</topics><point>needs ETA</point>",
			),
		};

		await summarizationEvaluator.handler(runtime as never, message);

		expect(logProviderAccess).toHaveBeenCalledWith(
			expect.objectContaining({
				stepId: "trajectory-step-1",
				providerName: "MEMORY_SUMMARIZATION",
				purpose: "evaluate",
			}),
		);
	});

	it("logs evaluator activity for long-term extraction", async () => {
		const logProviderAccess = vi.fn();
		const storeLongTermMemory = vi.fn(async () => null);
		const runtime = {
			agentId: message.agentId,
			character: { name: "Milady" },
			getService(serviceType: string) {
				if (serviceType === "memory") {
					return {
						getConfig: () => ({
							summaryModelType: "TEXT_SMALL",
							longTermConfidenceThreshold: 0.85,
						}),
						getLongTermMemories: vi.fn(async () => []),
						storeLongTermMemory,
						setLastExtractionCheckpoint: vi.fn(async () => undefined),
					};
				}
				if (serviceType === "trajectories") {
					return { logProviderAccess };
				}
				return null;
			},
			countMemories: vi.fn(async () => 40),
			getMemories: vi.fn(async () => [
				{
					...message,
					id: "dddddddd-dddd-dddd-dddd-dddddddddddd" as UUID,
					content: { text: "My preferred contact is email." },
					metadata: { type: "user_message" },
				},
			]),
			composeState: vi.fn(async () => ({})),
			useModel: vi.fn(
				async () =>
					"<memory><category>semantic</category><content>Chris prefers email for status updates.</content><confidence>0.94</confidence></memory>",
			),
		};

		await longTermExtractionEvaluator.handler(runtime as never, message);

		expect(storeLongTermMemory).toHaveBeenCalledTimes(1);
		expect(logProviderAccess).toHaveBeenCalledWith(
			expect.objectContaining({
				stepId: "trajectory-step-1",
				providerName: "LONG_TERM_MEMORY_EXTRACTION",
				purpose: "evaluate",
			}),
		);
	});

	it("downgrades transient long-term extraction model outages to warnings", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		const runtime = {
			agentId: message.agentId,
			character: { name: "Milady" },
			getService(serviceType: string) {
				if (serviceType === "memory") {
					return {
						getConfig: () => ({
							summaryModelType: "TEXT_SMALL",
							longTermConfidenceThreshold: 0.85,
						}),
						getLongTermMemories: vi.fn(async () => []),
						storeLongTermMemory: vi.fn(async () => null),
						setLastExtractionCheckpoint: vi.fn(async () => undefined),
					};
				}
				return null;
			},
			countMemories: vi.fn(async () => 40),
			getMemories: vi.fn(async () => [message]),
			composeState: vi.fn(async () => ({})),
			useModel: vi.fn(async () => {
				throw new Error(
					"Service temporarily unavailable. Please try again shortly.",
				);
			}),
		};

		await longTermExtractionEvaluator.handler(runtime as never, message);

		expect(warnSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				src: "evaluator:memory",
				err: "Service temporarily unavailable. Please try again shortly.",
			}),
			"Skipped long-term memory extraction due to transient model availability issue",
		);
		expect(errorSpy).not.toHaveBeenCalledWith(
			expect.objectContaining({ src: "evaluator:memory" }),
			"Error during long-term memory extraction",
		);
	});
});
