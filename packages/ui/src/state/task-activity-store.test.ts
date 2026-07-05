/**
 * Behavior of the live task-activity reducer: grouping a flat SwarmEvent stream
 * into task -> sub-agent -> ordered steps, collapsing a tool call from running
 * to result in place, tracking the live plan checklist, and moving a sub-agent
 * to a terminal status. Pure reducer — no socket, driven via test internals.
 */
import type { SwarmEvent } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { __taskActivityInternals } from "./task-activity-store";

const { applyEvent, getSnapshot, reset } = __taskActivityInternals;

function ev(p: Partial<SwarmEvent> & { type: string; sessionId: string }): SwarmEvent {
	return { timestamp: p.seq ?? 1, data: {}, ...p };
}

describe("task-activity-store reducer", () => {
	beforeEach(() => reset());

	it("groups sub-agents under a task ordered by first-seen seq", () => {
		applyEvent(ev({ type: "message", sessionId: "b", taskId: "T", seq: 2, data: { text: "b1" } }));
		applyEvent(ev({ type: "message", sessionId: "a", taskId: "T", seq: 1, data: { text: "a1" } }));
		const snap = getSnapshot("T");
		expect(snap.subagents.map((s) => s.sessionId)).toEqual(["a", "b"]);
		expect(snap.subagents[0].currentText).toBe("a1");
	});

	it("collapses a tool call from running to success in place", () => {
		applyEvent(
			ev({
				type: "tool_running",
				sessionId: "a",
				taskId: "T",
				seq: 1,
				data: { toolCall: { id: "t1", title: "Bash", status: "running" } },
			}),
		);
		applyEvent(
			ev({
				type: "tool_running",
				sessionId: "a",
				taskId: "T",
				seq: 2,
				data: { toolCall: { id: "t1", title: "Bash", status: "completed", output: "ok" } },
			}),
		);
		const agent = getSnapshot("T").subagents[0];
		expect(agent.steps).toHaveLength(1);
		expect(agent.steps[0].tool.status).toBe("success");
		expect(agent.steps[0].tool.output).toBe("ok");
	});

	it("tracks the live plan checklist as it mutates", () => {
		applyEvent(
			ev({
				type: "plan",
				sessionId: "a",
				taskId: "T",
				seq: 1,
				data: { entries: [{ content: "x", status: "pending" }] },
			}),
		);
		applyEvent(
			ev({
				type: "plan",
				sessionId: "a",
				taskId: "T",
				seq: 2,
				data: {
					entries: [
						{ content: "x", status: "completed" },
						{ content: "y", status: "in_progress" },
					],
				},
			}),
		);
		const snap = getSnapshot("T");
		expect(snap.plan.map((p) => p.status)).toEqual(["completed", "in_progress"]);
		expect(snap.subagents[0].plan).toHaveLength(2);
	});

	it("moves a sub-agent to a terminal status on lifecycle events", () => {
		applyEvent(ev({ type: "tool_running", sessionId: "a", taskId: "T", seq: 1, data: { toolCall: { id: "t", status: "running" } } }));
		expect(getSnapshot("T").subagents[0].status).toBe("running");
		applyEvent(ev({ type: "task_complete", sessionId: "a", taskId: "T", seq: 2, data: {} }));
		expect(getSnapshot("T").subagents[0].status).toBe("success");
		applyEvent(ev({ type: "error", sessionId: "a", taskId: "T", seq: 3, data: { message: "boom" } }));
		expect(getSnapshot("T").subagents[0].status).toBe("failure");
	});

	it("nests a child session under its parent via parentSessionId", () => {
		applyEvent(ev({ type: "message", sessionId: "parent", taskId: "T", seq: 1, data: { text: "p" } }));
		applyEvent(
			ev({
				type: "message",
				sessionId: "child",
				taskId: "T",
				parentSessionId: "parent",
				seq: 2,
				data: { text: "c" },
			}),
		);
		const child = getSnapshot("T").subagents.find((s) => s.sessionId === "child");
		expect(child?.parentSessionId).toBe("parent");
	});
});
