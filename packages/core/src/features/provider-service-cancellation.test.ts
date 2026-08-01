/**
 * Verifies that service-backed providers forward turn cancellation and do not
 * translate an aborted read into optional empty context.
 */
import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, State, UUID } from "../types/index.ts";
import { experienceProvider } from "./advanced-capabilities/experience/providers/experienceProvider.ts";
import type { ExperienceQuery } from "./advanced-capabilities/experience/types.ts";
import { contextSummaryProvider } from "./advanced-memory/providers/context-summary.ts";
import { longTermMemoryProvider } from "./advanced-memory/providers/long-term-memory.ts";

const agentId = "10000000-0000-0000-0000-000000000001" as UUID;
const entityId = "10000000-0000-0000-0000-000000000002" as UUID;
const roomId = "10000000-0000-0000-0000-000000000003" as UUID;
const message: Memory = {
	id: "10000000-0000-0000-0000-000000000004" as UUID,
	agentId,
	entityId,
	roomId,
	content: { text: "What did we learn from the previous project?" },
};
const state: State = { values: {}, data: {}, text: "" };

describe("service-backed provider cancellation", () => {
	it("forwards cancellation to experience recall and rethrows it", async () => {
		const controller = new AbortController();
		const reason = new DOMException("turn cancelled", "AbortError");
		const queryExperiences = vi.fn(
			async (_query: ExperienceQuery, signal?: AbortSignal) => {
				expect(signal).toBe(controller.signal);
				controller.abort(reason);
				throw new Error("experience recall interrupted");
			},
		);
		const runtime = {
			agentId,
			getService: vi.fn(() => ({
				queryExperiences,
				listExperiences: vi.fn(),
			})),
		} as unknown as IAgentRuntime;

		await expect(
			experienceProvider.get(runtime, message, state, {
				signal: controller.signal,
			}),
		).rejects.toBe(reason);
	});

	it("forwards cancellation to session-summary reads and rethrows it", async () => {
		const controller = new AbortController();
		const reason = new DOMException("turn cancelled", "AbortError");
		const getCurrentSessionSummary = vi.fn(
			async (_roomId: UUID, signal?: AbortSignal) => {
				expect(signal).toBe(controller.signal);
				controller.abort(reason);
				throw new Error("summary read interrupted");
			},
		);
		const runtime = {
			agentId,
			getService: vi.fn(() => ({ getCurrentSessionSummary })),
		} as unknown as IAgentRuntime;

		await expect(
			contextSummaryProvider.get(runtime, message, state, {
				signal: controller.signal,
			}),
		).rejects.toBe(reason);
	});

	it("forwards cancellation to long-term-memory reads and rethrows it", async () => {
		const controller = new AbortController();
		const reason = new DOMException("turn cancelled", "AbortError");
		const getLongTermMemories = vi.fn(
			async (
				_entityId: UUID,
				_category: undefined,
				_limit: number,
				signal?: AbortSignal,
			) => {
				expect(signal).toBe(controller.signal);
				controller.abort(reason);
				throw new Error("long-term-memory read interrupted");
			},
		);
		const runtime = {
			agentId,
			getService: vi.fn(() => ({ getLongTermMemories })),
		} as unknown as IAgentRuntime;

		await expect(
			longTermMemoryProvider.get(runtime, message, state, {
				signal: controller.signal,
			}),
		).rejects.toBe(reason);
	});
});
