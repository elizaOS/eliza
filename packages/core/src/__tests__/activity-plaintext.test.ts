import { describe, expect, it } from "vitest";
import {
	activityEventToPlaintext,
	trajectoryEventToPlaintext,
	trajectoryToPlaintext,
} from "../activity-plaintext";

describe("activityEventToPlaintext", () => {
	it("summarizes pty task lifecycle events without trusting malformed fields", () => {
		expect(
			activityEventToPlaintext({
				eventType: "task_registered",
				sessionId: "session-1",
				data: { label: "Ship serializer tests" },
			}),
		).toEqual({
			eventType: "task_registered",
			plaintext: "Task started: Ship serializer tests",
			sessionId: "session-1",
		});

		expect(
			activityEventToPlaintext({
				eventType: "tool_running",
				data: { description: "bun test packages/core" },
			}),
		)?.toMatchObject({
			eventType: "tool_running",
			plaintext: "Running bun test packages/core",
		});

		expect(
			activityEventToPlaintext({
				eventType: "tool_running",
				data: {
					toolCall: {
						title: "Terminal",
						kind: "shell",
						rawInput: { command: "bun run typecheck" },
					},
				},
			}),
		)?.toMatchObject({
			eventType: "tool_running",
			plaintext: "Running Terminal: bun run typecheck",
		});
	});

	it("keeps the assistant activity stream mapped to canonical event types", () => {
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "assistant",
				payload: {
					source: "proactive-goal-check-in",
					text: "Review the stalled weekly goal.",
				},
			}),
		).toEqual({
			eventType: "check-in",
			plaintext: "Review the stalled weekly goal.",
			stream: "assistant",
			source: "proactive-goal-check-in",
		});
	});

	it("does not surface unknown assistant sources unless explicitly requested", () => {
		const event = {
			type: "agent_event",
			stream: "assistant",
			payload: {
				source: "experimental-source",
				text: "A raw assistant event",
			},
		};

		expect(activityEventToPlaintext(event)).toBeNull();
		expect(
			activityEventToPlaintext(event, { includeUnknownAssistantText: true }),
		)?.toMatchObject({
			eventType: "experimental-source",
			plaintext: "A raw assistant event",
		});
	});
});

describe("trajectory plaintext serializers", () => {
	it("renders a bounded trajectory summary with LLM calls and provider accesses", () => {
		const text = trajectoryToPlaintext(
			{
				trajectory: {
					id: "traj-1",
					agentId: "agent-1",
					source: "scenario",
					status: "completed",
					startTime: 1000,
					endTime: 2500,
					durationMs: 1500,
					llmCallCount: 1,
					providerAccessCount: 1,
					totalPromptTokens: 42,
					totalCompletionTokens: 7,
					createdAt: "2026-06-24T18:00:00.000Z",
				},
				llmCalls: [
					{
						stepId: "step-1",
						provider: "openai",
						model: "gpt-test",
						purpose: "planner",
						response: "Call the tool.",
					},
				],
				providerAccesses: [
					{
						stepId: "step-1",
						providerName: "goals",
						purpose: "context",
						query: { owner: "self" },
					},
				],
			},
			{ maxItems: 2 },
		);

		expect(text).toContain("Trajectory traj-1 (completed)");
		expect(text).toContain("source: scenario; duration: 1.5s");
		expect(text).toContain("tokens: 42 prompt / 7 completion");
		expect(text).toContain("- planner openai/gpt-test: Call the tool.");
		expect(text).toContain('- goals context: {"owner":"self"}');
	});

	it("summarizes trajectory events with stable plain text", () => {
		expect(
			trajectoryEventToPlaintext({
				id: "tool-1",
				type: "tool_error",
				actionName: "WEB_FETCH",
				error: "Request blocked",
			}),
		).toBe("WEB_FETCH failed: Request blocked");

		expect(
			trajectoryEventToPlaintext({
				id: "cache-1",
				type: "cache_observation",
				cacheName: "prompt",
				hit: true,
				key: "segment-a",
			}),
		).toBe("prompt hit: segment-a");
	});
});
