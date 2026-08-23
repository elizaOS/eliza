/**
 * Unit tests for agent activity and trajectory plaintext summarization.
 */

import { describe, expect, it } from "vitest";
import {
	activityEventToPlaintext,
	trajectoryToPlaintext,
} from "./activity-plaintext.js";

describe("activityEventToPlaintext", () => {
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

	it("formats PTY task events", () => {
		const ptyEvent = {
			eventType: "task_registered",
			data: {
				label: "Build project",
			},
		};
		expect(activityEventToPlaintext(ptyEvent)).toEqual({
			eventType: "task_registered",
			plaintext: "Task started: Build project",
		});
	});

	it("returns null for malformed or unrecognized events", () => {
		expect(activityEventToPlaintext(null)).toBeNull();
		expect(activityEventToPlaintext({})).toBeNull();
		expect(
			activityEventToPlaintext({ stream: "unknown_stream_xyz" }),
		).toBeNull();
	});
});

describe("trajectoryToPlaintext", () => {
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
