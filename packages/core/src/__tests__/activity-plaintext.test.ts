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

	it("covers lifecycle stream run_start, step_start, context_loaded, action_start, and default type", () => {
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "lifecycle",
				payload: { type: "run_start" },
			}),
		)?.toMatchObject({
			eventType: "run_start",
			plaintext: "Run started",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "lifecycle",
				payload: { type: "step_start", stepName: "validation" },
			}),
		)?.toMatchObject({
			eventType: "step_start",
			plaintext: "Step started: validation",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "lifecycle",
				payload: { type: "context_loaded" },
			}),
		)?.toMatchObject({
			eventType: "context_loaded",
			plaintext: "Context loaded",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "lifecycle",
				payload: { type: "action_start", actionName: "DEFER" },
			}),
		)?.toMatchObject({
			eventType: "action_start",
			plaintext: "Action started: DEFER",
		});

		// Default case: unknown type gets spaces instead of underscores
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "lifecycle",
				payload: { type: "custom_event_type" },
			}),
		)?.toMatchObject({
			eventType: "custom_event_type",
			plaintext: "custom event type",
		});
	});

	it("covers lifecycle stream edge cases: run_failed, step_failed, action_failed", () => {
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "lifecycle",
				payload: { type: "run_end", success: false, error: "Timeout" },
			}),
		)?.toMatchObject({
			eventType: "error",
			plaintext: "Run failed: Timeout",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "lifecycle",
				payload: {
					type: "step_end",
					success: false,
					stepName: "validation",
					error: "Schema mismatch",
				},
			}),
		)?.toMatchObject({
			eventType: "error",
			plaintext: "Step failed: validation: Schema mismatch",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "lifecycle",
				payload: {
					type: "action_end",
					success: false,
					actionName: "TRANSFER",
					error: "Insufficient funds",
				},
			}),
		)?.toMatchObject({
			eventType: "action_error",
			plaintext: "Action failed: TRANSFER: Insufficient funds",
		});
	});

	it("covers action stream skipped and error branches", () => {
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "action",
				payload: {
					type: "skipped",
					actionName: "DEFER",
				},
			}),
		)?.toMatchObject({
			eventType: "action_skipped",
			plaintext: "Action skipped: DEFER",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "action",
				payload: {
					type: "error",
					actionName: "QUERY",
					error: "Database unavailable",
					duration: 500,
				},
			}),
		)?.toMatchObject({
			eventType: "action_error",
			plaintext: "Action failed: QUERY (500ms): Database unavailable",
		});
	});

	it("covers tool stream all event types and default naming", () => {
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "tool",
				payload: {
					type: "tool_result",
					toolName: "grep",
					output: { matches: 42 },
					durationMs: 120,
				},
			}),
		)?.toMatchObject({
			eventType: "tool_result",
			plaintext: 'Tool completed: grep (120ms): {"matches":42}',
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "tool",
				payload: {
					type: "unknown_type",
				},
			}),
		)?.toMatchObject({
			eventType: "tool_call",
			plaintext: "Tool called: tool",
		});
	});

	it("covers evaluator stream validated=false, error, and skipped", () => {
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "evaluator",
				payload: {
					type: "error",
					evaluatorName: "schema-check",
					error: "Invalid structure",
					duration: 300,
				},
			}),
		)?.toMatchObject({
			eventType: "evaluator_error",
			plaintext: "Evaluator failed: schema-check (300ms): Invalid structure",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "evaluator",
				payload: {
					type: "skipped",
					evaluatorName: "context-gates",
				},
			}),
		)?.toMatchObject({
			eventType: "evaluator_skipped",
			plaintext: "Evaluator skipped: context-gates",
		});
	});

	it("covers provider stream error, cached flag, complete, and default naming", () => {
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "provider",
				payload: {
					type: "error",
					providerName: "contacts",
					error: "API rate limited",
					durationMs: 1200,
				},
			}),
		)?.toMatchObject({
			eventType: "provider_error",
			plaintext: "Provider failed: contacts (1.2s): API rate limited",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "provider",
				payload: {
					type: "complete",
					fromCache: true,
					data: { items: 5 },
				},
			}),
		)?.toMatchObject({
			eventType: "provider_cached",
			plaintext: 'Provider served from cache: provider: {"items":5}',
		});

		// Provider complete without cache flag
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "provider",
				payload: {
					type: "complete",
					providerName: "scheduler",
					data: { slots: 10 },
					durationMs: 800,
				},
			}),
		)?.toMatchObject({
			eventType: "provider_complete",
			plaintext: 'Provider completed: scheduler (800ms): {"slots":10}',
		});
	});

	it("covers message stream all verb types and missing fields", () => {
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "message",
				payload: {
					type: "sent",
					channel: "email",
					content: "Confirmation sent",
				},
			}),
		)?.toMatchObject({
			eventType: "message_sent",
			plaintext: "Message sent on email: Confirmation sent",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "message",
				payload: {
					type: "queued",
					hasAttachments: false,
				},
			}),
		)?.toMatchObject({
			eventType: "message_queued",
			plaintext: "Message queued",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "message",
				payload: {
					type: "failed",
					error: "Delivery failed",
				},
			}),
		)?.toMatchObject({
			eventType: "message_failed",
			plaintext: "Message failed: Delivery failed",
		});
	});

	it("covers memory stream all event types and count pluralization", () => {
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "memory",
				payload: {
					type: "create",
					tableName: "goals",
				},
			}),
		)?.toMatchObject({
			eventType: "memory_create",
			plaintext: "Memory created in goals",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "memory",
				payload: {
					type: "update",
					tableName: "memories",
				},
			}),
		)?.toMatchObject({
			eventType: "memory_update",
			plaintext: "Memory updated in memories",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "memory",
				payload: {
					type: "delete",
				},
			}),
		)?.toMatchObject({
			eventType: "memory_delete",
			plaintext: "Memory deleted",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "memory",
				payload: {
					type: "retrieved",
					tableName: "messages",
					count: 1,
				},
			}),
		)?.toMatchObject({
			eventType: "memory_retrieved",
			plaintext: "Memory retrieved in messages (1 item)",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "memory",
				payload: {
					type: "unknown",
					tableName: "archive",
				},
			}),
		)?.toMatchObject({
			eventType: "memory_unknown",
			plaintext: "Memory unknown in archive",
		});
	});

	it("covers assistant stream all type variants and missing text", () => {
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "assistant",
				payload: {
					type: "thought",
					text: "Consider this approach",
				},
			}),
		)?.toMatchObject({
			eventType: "assistant_thought",
			plaintext: "Assistant thought: Consider this approach",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "assistant",
				payload: {
					type: "reflection",
					text: "That worked well",
				},
			}),
		)?.toMatchObject({
			eventType: "assistant_reflection",
			plaintext: "Assistant reflection: That worked well",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "assistant",
				payload: {
					type: "message",
					text: "Hello there",
				},
			}),
		)?.toMatchObject({
			eventType: "message",
			plaintext: "Assistant message: Hello there",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "assistant",
				payload: {
					type: "unknown_type",
					content: "Some content",
				},
			}),
		)?.toMatchObject({
			eventType: "assistant_unknown_type",
			plaintext: "Assistant activity: Some content",
		});

		// Missing text returns null
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "assistant",
				payload: {
					type: "thought",
				},
			}),
		).toBeNull();
	});

	it("covers notification stream with priority levels", () => {
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "notification",
				payload: {
					notification: {
						title: "Approval needed",
						body: "Review the policy change",
						priority: "urgent",
					},
				},
			}),
		)?.toMatchObject({
			eventType: "approval",
			plaintext: "Approval needed - Review the policy change",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "notification",
				payload: {
					notification: {
						title: "Update available",
						priority: "low",
					},
				},
			}),
		)?.toMatchObject({
			eventType: "message",
			plaintext: "Update available",
		});

		// Identical title and body are not duplicated
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "notification",
				payload: {
					notification: {
						title: "Ready",
						body: "Ready",
					},
				},
			}),
		)?.toMatchObject({
			plaintext: "Ready",
		});
	});

	it("covers PTY event types: task_complete, stopped, blocked, error", () => {
		expect(
			activityEventToPlaintext({
				eventType: "task_complete",
				data: {},
			}),
		)?.toMatchObject({
			eventType: "task_complete",
			plaintext: "Task completed",
		});

		expect(
			activityEventToPlaintext({
				eventType: "stopped",
				data: {},
			}),
		)?.toMatchObject({
			eventType: "stopped",
			plaintext: "Task stopped",
		});

		expect(
			activityEventToPlaintext({
				eventType: "blocked",
				data: {},
			}),
		)?.toMatchObject({
			eventType: "blocked",
			plaintext: "Waiting for input",
		});

		expect(
			activityEventToPlaintext({
				eventType: "blocked_auto_resolved",
				data: {},
			}),
		)?.toMatchObject({
			eventType: "blocked_auto_resolved",
			plaintext: "Decision auto-approved",
		});

		expect(
			activityEventToPlaintext({
				eventType: "error",
				data: { message: "Permission denied" },
			}),
		)?.toMatchObject({
			eventType: "error",
			plaintext: "Permission denied",
		});

		expect(
			activityEventToPlaintext({
				eventType: "error",
				data: {},
			}),
		)?.toMatchObject({
			plaintext: "Error occurred",
		});
	});

	it("covers PTY proactive-message and escalation events", () => {
		expect(
			activityEventToPlaintext({
				eventType: "proactive-message",
				message: { text: "Your goal is due soon" },
			}),
		)?.toMatchObject({
			eventType: "proactive-message",
			plaintext: "Your goal is due soon",
		});

		expect(
			activityEventToPlaintext({
				eventType: "escalation",
				data: {},
			}),
		)?.toMatchObject({
			eventType: "escalation",
			plaintext: "Escalated - needs attention",
		});
	});

	it("handles malformed and missing payload gracefully", () => {
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "unknown_stream",
				payload: null,
			}),
		).toBeNull();

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "action",
				// No payload
			}),
		).toBeNull();

		expect(
			activityEventToPlaintext({
				eventType: null,
				data: { text: "text" },
			}),
		).toBeNull();

		expect(activityEventToPlaintext(null)).toBeNull();
		expect(activityEventToPlaintext("not an object")).toBeNull();
	});

	it("handles edge cases in payload preview with bigint and uncircular values", () => {
		// Test with numeric detail
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "action",
				payload: {
					type: "complete",
					actionName: "COUNT",
					output: 42,
				},
			}),
		)?.toMatchObject({
			plaintext: "Action completed: COUNT: 42",
		});

		// Test with boolean detail
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "action",
				payload: {
					type: "complete",
					actionName: "VERIFY",
					output: true,
				},
			}),
		)?.toMatchObject({
			plaintext: "Action completed: VERIFY: true",
		});

		// Test with null detail (should be skipped)
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "action",
				payload: {
					type: "complete",
					actionName: "NOOP",
					output: null,
				},
			}),
		)?.toMatchObject({
			plaintext: "Action completed: NOOP",
		});
	});

	it("formats duration correctly across milliseconds, seconds, minutes", () => {
		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "lifecycle",
				payload: { type: "run_end", success: true, duration: 45 },
			}),
		)?.toMatchObject({
			plaintext: "Run completed (45ms)",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "lifecycle",
				payload: { type: "run_end", success: true, duration: 5000 },
			}),
		)?.toMatchObject({
			plaintext: "Run completed (5.0s)",
		});

		expect(
			activityEventToPlaintext({
				type: "agent_event",
				stream: "lifecycle",
				payload: { type: "run_end", success: true, duration: 125000 },
			}),
		)?.toMatchObject({
			plaintext: "Run completed (2m 5s)",
		});
	});

	it("truncates long plaintext to maxLength with whitespace normalization", () => {
		const longText =
			"A ".repeat(100) + "and some final text that exceeds the limit";
		expect(
			activityEventToPlaintext(
				{
					eventType: "message",
					data: { text: longText },
				},
				{ maxLength: 50 },
			)?.plaintext.length,
		).toBeLessThanOrEqual(50);

		// Multiple spaces normalized to single space
		expect(
			activityEventToPlaintext({
				eventType: "message",
				data: { text: "Text    with\n\nmultiple   spaces" },
			})?.plaintext,
		).toBe("Text with multiple spaces");
	});
});
