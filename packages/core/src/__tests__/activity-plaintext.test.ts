/**
 * Covers the plaintext serializers that flatten PTY task lifecycle events,
 * typed agent-event streams, and trajectory summaries into bounded
 * human-readable lines. Deterministic: pure functions over synthetic event
 * objects, no model or database.
 */
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

	it("summarizes typed agent event streams instead of dropping rich runtime work", () => {
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "action",
				sessionKey: "room-1",
				payload: {
					type: "complete",
					actionName: "BRIEF",
					duration: 1250,
					output: { briefingId: "brief-1" },
				},
			}),
		).toEqual({
			eventType: "action_complete",
			plaintext: 'Action completed: BRIEF (1.3s): {"briefingId":"brief-1"}',
			stream: "action",
			sessionId: "room-1",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "tool",
				payload: {
					type: "tool_error",
					toolName: "web_fetch",
					error: "Request blocked",
				},
			}),
		)?.toMatchObject({
			eventType: "tool_error",
			plaintext: "Tool failed: web_fetch: Request blocked",
			stream: "tool",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "message",
				payload: {
					type: "received",
					channel: "discord",
					content: "Can you check this?",
					hasAttachments: true,
				},
			}),
		)?.toMatchObject({
			eventType: "message_received",
			plaintext:
				"Message received on discord with attachments: Can you check this?",
		});
	});

	it("summarizes lifecycle, evaluator, provider, memory, assistant, and error streams", () => {
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "lifecycle",
				payload: { type: "run_end", success: true, duration: 2000 },
			}),
		)?.toMatchObject({
			eventType: "run_end",
			plaintext: "Run completed (2.0s)",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "evaluator",
				payload: {
					type: "complete",
					evaluatorName: "fact-check",
					validated: false,
					result: { reason: "missing source" },
				},
			}),
		)?.toMatchObject({
			eventType: "evaluator_complete",
			plaintext:
				'Evaluator completed without validation: fact-check: {"reason":"missing source"}',
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "provider",
				payload: {
					type: "complete",
					providerName: "calendar",
					fromCache: true,
					data: { count: 3 },
				},
			}),
		)?.toMatchObject({
			eventType: "provider_cached",
			plaintext: 'Provider served from cache: calendar: {"count":3}',
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "memory",
				payload: {
					type: "search",
					tableName: "memories",
					count: 2,
					duration: 30,
				},
			}),
		)?.toMatchObject({
			eventType: "memory_search",
			plaintext: "Memory searched in memories (2 results) (30ms)",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "assistant",
				payload: {
					type: "plan",
					content: "Check inbox, then draft reply.",
				},
			}),
		)?.toMatchObject({
			eventType: "assistant_plan",
			plaintext: "Assistant plan: Check inbox, then draft reply.",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "error",
				payload: {
					type: "warning",
					code: "LISTENER_ERROR",
					message: "One listener failed",
				},
			}),
		)?.toMatchObject({
			eventType: "warning",
			plaintext: "Warning LISTENER_ERROR: One listener failed",
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
