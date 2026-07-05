/**
 * Covers `toSwarmActivity`, the boundary that narrows a raw `SwarmEvent`
 * (wire-typed `data: unknown`) into the typed discriminated inline-activity
 * envelope the chat pipeline consumes. Pure function over synthetic events.
 */
import { describe, expect, it } from "vitest";
import { type SwarmEvent, toSwarmActivity } from "../types/swarm-coordinator";

function ev(partial: Partial<SwarmEvent> & { type: string }): SwarmEvent {
	return {
		sessionId: "s1",
		timestamp: 1000,
		data: {},
		...partial,
	};
}

describe("toSwarmActivity", () => {
	it("narrows a message event and carries seq/taskId/parent", () => {
		expect(
			toSwarmActivity(
				ev({
					type: "message",
					seq: 7,
					taskId: "task-abc",
					parentSessionId: "root",
					data: { text: "hello" },
				}),
			),
		).toEqual({
			kind: "message",
			sessionId: "s1",
			seq: 7,
			timestamp: 1000,
			taskId: "task-abc",
			parentSessionId: "root",
			text: "hello",
		});
	});

	it("falls back to timestamp when no seq is present", () => {
		const out = toSwarmActivity(
			ev({ type: "reasoning", data: { text: "hm" } }),
		);
		expect(out).toMatchObject({ kind: "reasoning", seq: 1000, text: "hm" });
	});

	it("narrows a plan event, dropping blank entries", () => {
		const out = toSwarmActivity(
			ev({
				type: "plan",
				data: {
					entries: [
						{ content: "step one", status: "completed", priority: "high" },
						{ content: "", status: "pending" },
						{ content: "step two", status: "in_progress" },
					],
				},
			}),
		);
		expect(out).toMatchObject({
			kind: "plan",
			entries: [
				{ content: "step one", status: "completed", priority: "high" },
				{ content: "step two", status: "in_progress" },
			],
		});
	});

	it("narrows a tool_running event and maps the status", () => {
		const out = toSwarmActivity(
			ev({
				type: "tool_running",
				data: {
					toolCall: {
						id: "t1",
						title: "Bash",
						kind: "execute",
						status: "completed",
						rawInput: { command: "git status" },
						output: "clean",
						locations: [{ path: "a.ts", line: 3 }],
					},
				},
			}),
		);
		expect(out).toEqual({
			kind: "tool",
			sessionId: "s1",
			seq: 1000,
			timestamp: 1000,
			tool: {
				id: "t1",
				title: "Bash",
				kind: "execute",
				status: "success",
				rawInput: { command: "git status" },
				output: "clean",
				locations: [{ path: "a.ts", line: 3 }],
			},
		});
	});

	it("defaults a tool without status to running", () => {
		const out = toSwarmActivity(
			ev({ type: "tool_running", data: { toolCall: { title: "Read" } } }),
		);
		expect(out).toMatchObject({ kind: "tool", tool: { status: "running" } });
	});

	it("maps lifecycle events to a coarse status", () => {
		expect(
			toSwarmActivity(ev({ type: "task_complete", data: {} })),
		).toMatchObject({
			kind: "lifecycle",
			event: "task_complete",
			status: "success",
		});
		expect(
			toSwarmActivity(ev({ type: "error", data: { message: "boom" } })),
		).toMatchObject({ kind: "lifecycle", status: "failure", text: "boom" });
		expect(toSwarmActivity(ev({ type: "blocked", data: {} }))).toMatchObject({
			kind: "lifecycle",
			status: "waiting",
		});
		expect(toSwarmActivity(ev({ type: "ready", data: {} }))).toMatchObject({
			kind: "lifecycle",
			status: "idle",
		});
	});

	it("returns null for non-renderable / empty events", () => {
		expect(
			toSwarmActivity(ev({ type: "message", data: { text: "" } })),
		).toBeNull();
		expect(
			toSwarmActivity(ev({ type: "plan", data: { entries: [] } })),
		).toBeNull();
		expect(toSwarmActivity(ev({ type: "agent_event", data: {} }))).toBeNull();
		expect(
			toSwarmActivity(ev({ type: "totally_unknown", data: {} })),
		).toBeNull();
	});
});
