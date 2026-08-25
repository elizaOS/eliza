/**
 * Unit tests for agent activity and trajectory plaintext summarization.
 */

import { describe, expect, it } from "vitest";
import {
	activityEventToPlaintext,
	trajectoryEventToPlaintext,
	trajectoryToPlaintext,
} from "./activity-plaintext.js";

describe("activityEventToPlaintext", () => {
	it("summarizes pty task lifecycle events without trusting malformed fields", () => {
		expect(
			activityEventToPlaintext({
				eventType: "task_registered",
				data: { label: "Build project" },
			}),
		).toEqual({
			eventType: "task_registered",
			plaintext: "Task started: Build project",
		});

		expect(
			activityEventToPlaintext({
				eventType: "task_complete",
				data: {},
			}),
		).toEqual({
			eventType: "task_complete",
			plaintext: "Task completed",
		});

		expect(
			activityEventToPlaintext({
				eventType: "stopped",
				data: {},
			}),
		).toEqual({
			eventType: "stopped",
			plaintext: "Task stopped",
		});

		expect(
			activityEventToPlaintext({
				eventType: "tool_running",
				data: { description: "bun test packages/core" },
			}),
		).toEqual({
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

	it("surfaces streamed message/reasoning/plan/lifecycle events as text", () => {
		expect(
			activityEventToPlaintext({
				eventType: "message",
				sessionId: "s1",
				data: { text: "Applying the patch now" },
			}),
		)?.toMatchObject({
			eventType: "message",
			plaintext: "Applying the patch now",
		});

		expect(
			activityEventToPlaintext({
				eventType: "reasoning",
				data: { text: "The failing import is stale" },
			}),
		)?.toMatchObject({
			eventType: "reasoning",
			plaintext: "Thinking: The failing import is stale",
		});

		expect(
			activityEventToPlaintext({
				eventType: "plan",
				data: {
					entries: [
						{ content: "read file", status: "completed" },
						{ content: "edit", status: "in_progress" },
						{ content: "test", status: "pending" },
					],
				},
			}),
		)?.toMatchObject({
			eventType: "plan",
			plaintext: "Plan updated (1/3 done)",
		});

		expect(
			activityEventToPlaintext({ eventType: "ready", data: {} }),
		)?.toMatchObject({ plaintext: "Agent ready" });
		expect(
			activityEventToPlaintext({ eventType: "login_required", data: {} }),
		)?.toMatchObject({ plaintext: "Login required" });
		expect(
			activityEventToPlaintext({ eventType: "reconnected", data: {} }),
		)?.toMatchObject({ plaintext: "Agent reconnected" });
	});

	it("drops empty streamed chunks rather than echoing the event name", () => {
		expect(
			activityEventToPlaintext({ eventType: "message", data: { text: "" } }),
		).toBeNull();
		expect(
			activityEventToPlaintext({ eventType: "plan", data: { entries: [] } }),
		).toBeNull();
	});

	it("formats assistant stream message events", () => {
		const event = {
			stream: "assistant",
			payload: {
				type: "message",
				text: "I found the answer.",
			},
		};

		const summary = activityEventToPlaintext(event);
		expect(summary).toEqual({
			eventType: "message",
			plaintext: "Assistant message: I found the answer.",
			stream: "assistant",
		});
	});

	it("formats lifecycle stream events for run start and completion", () => {
		const startEvent = {
			stream: "lifecycle",
			payload: {
				type: "run_start",
			},
		};
		expect(activityEventToPlaintext(startEvent)).toEqual({
			eventType: "run_start",
			plaintext: "Run started",
			stream: "lifecycle",
		});

		const endEvent = {
			stream: "lifecycle",
			payload: {
				type: "run_end",
				success: true,
				durationMs: 1500,
			},
		};
		expect(activityEventToPlaintext(endEvent)).toEqual({
			eventType: "run_end",
			plaintext: "Run completed (1.5s)",
			stream: "lifecycle",
		});
	});

	it("formats action and tool stream events", () => {
		const actionEvent = {
			stream: "action",
			payload: {
				type: "complete",
				actionName: "SEARCH_WEB",
				output: "results found",
			},
		};
		const actionSummary = activityEventToPlaintext(actionEvent);
		expect(actionSummary?.eventType).toBe("action_complete");
		expect(actionSummary?.plaintext).toContain("Action completed: SEARCH_WEB");

		const toolEvent = {
			stream: "tool",
			payload: {
				type: "tool_call",
				toolName: "read_file",
			},
		};
		const toolSummary = activityEventToPlaintext(toolEvent);
		expect(toolSummary?.eventType).toBe("tool_call");
		expect(toolSummary?.plaintext).toBe("Tool called: read_file");
	});

	it("returns null for malformed or unrecognized events", () => {
		expect(activityEventToPlaintext(null)).toBeNull();
		expect(activityEventToPlaintext({})).toBeNull();
		expect(
			activityEventToPlaintext({ stream: "unknown_stream_xyz" }),
		).toBeNull();
	});
});

describe("trajectory plaintext serializers", () => {
	it("marks malformed persisted steps as unavailable instead of empty", () => {
		const text = trajectoryToPlaintext({
			trajectoryId: "traj-corrupt",
			stepsJson: "not-json{",
		});
		expect(text).toContain(
			"Trajectory steps unavailable: persisted data is malformed.",
		);
	});

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

	it("formats trajectory record overview, LLM calls, and events", () => {
		const text = trajectoryToPlaintext({
			trajectory: {
				id: "traj-123",
				status: "completed",
				source: "agent",
				durationMs: 2500,
				llmCallCount: 1,
				providerAccessCount: 1,
			},
			llmCalls: [
				{
					callId: "call-1",
					provider: "anthropic",
					model: "claude-3-5-sonnet",
					purpose: "plan_actions",
					response: "Planned 2 steps",
				},
			],
			providerAccesses: [
				{
					providerName: "character",
					purpose: "get_personality",
				},
			],
			events: [
				{
					type: "action",
					actionName: "EXECUTE_COMMAND",
					success: true,
				},
			],
		});

		expect(text).toContain("Trajectory traj-123 (completed)");
		expect(text).toContain(
			"source: agent; duration: 2.5s; llm calls: 1; provider accesses: 1",
		);
		expect(text).toContain("LLM calls:");
		expect(text).toContain(
			"- LLM call call-1: plan_actions anthropic/claude-3-5-sonnet: Planned 2 steps",
		);
		expect(text).toContain("Provider accesses:");
		expect(text).toContain("- character get_personality");
		expect(text).toContain("Events:");
	});
});
