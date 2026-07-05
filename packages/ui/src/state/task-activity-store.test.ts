/**
 * Behavior of the live task-activity reducer: grouping a flat SwarmEvent stream
 * into task -> sub-agent -> ordered steps, collapsing a tool call from running
 * to result in place, tracking the live plan checklist, and moving a sub-agent
 * to a terminal status. The reducer cases run via test internals; a final case
 * drives the REAL WS path — `useTaskActivity` subscribes (binding the socket
 * handler), then a genuine server `pty-session-event` frame is delivered through
 * the client fan-out so the on-wire reconstruction seam (`bindWs`) is exercised,
 * not bypassed.
 */
import type { SwarmEvent } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { client } from "../api/client";
import { __taskActivityInternals } from "./task-activity-store";

const { applyEvent, getSnapshot, limits, reset, subscribe } =
  __taskActivityInternals;

function ev(
  p: Partial<SwarmEvent> & { type: string; sessionId: string },
): SwarmEvent {
  return { timestamp: p.seq ?? 1, data: {}, ...p };
}

describe("task-activity-store reducer", () => {
  beforeEach(() => reset());

  it("groups sub-agents under a task ordered by first-seen seq", () => {
    applyEvent(
      ev({
        type: "message",
        sessionId: "b",
        taskId: "T",
        seq: 2,
        data: { text: "b1" },
      }),
    );
    applyEvent(
      ev({
        type: "message",
        sessionId: "a",
        taskId: "T",
        seq: 1,
        data: { text: "a1" },
      }),
    );
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
        data: {
          toolCall: {
            id: "t1",
            title: "Bash",
            status: "completed",
            output: "ok",
          },
        },
      }),
    );
    const agent = getSnapshot("T").subagents[0];
    expect(agent.steps).toHaveLength(1);
    expect(agent.steps[0].tool.status).toBe("success");
    expect(agent.steps[0].tool.output).toBe("ok");
  });

  it("ignores stale same-id tool updates after a newer result", () => {
    applyEvent(
      ev({
        type: "tool_running",
        sessionId: "a",
        taskId: "T",
        seq: 10,
        timestamp: 100,
        data: {
          toolCall: {
            id: "t1",
            title: "Bash",
            status: "completed",
            output: "ok",
          },
        },
      }),
    );
    applyEvent(
      ev({
        type: "tool_running",
        sessionId: "a",
        taskId: "T",
        seq: 9,
        timestamp: 90,
        data: {
          toolCall: {
            id: "t1",
            title: "Bash",
            status: "running",
          },
        },
      }),
    );

    const agent = getSnapshot("T").subagents[0];
    expect(agent.steps).toHaveLength(1);
    expect(agent.steps[0].seq).toBe(10);
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
    expect(snap.plan.map((p) => p.status)).toEqual([
      "completed",
      "in_progress",
    ]);
    expect(snap.subagents[0].plan).toHaveLength(2);
  });

  it("ignores stale and duplicate seq updates for latest fields", () => {
    applyEvent(
      ev({
        type: "message",
        sessionId: "a",
        taskId: "T",
        seq: 3,
        data: { text: "new text" },
      }),
    );
    applyEvent(
      ev({
        type: "message",
        sessionId: "a",
        taskId: "T",
        seq: 2,
        data: { text: "stale text" },
      }),
    );
    applyEvent(
      ev({
        type: "message",
        sessionId: "a",
        taskId: "T",
        seq: 3,
        data: { text: "duplicate text" },
      }),
    );
    applyEvent(
      ev({
        type: "reasoning",
        sessionId: "a",
        taskId: "T",
        seq: 5,
        data: { text: "new reasoning" },
      }),
    );
    applyEvent(
      ev({
        type: "reasoning",
        sessionId: "a",
        taskId: "T",
        seq: 4,
        data: { text: "stale reasoning" },
      }),
    );
    applyEvent(
      ev({
        type: "task_complete",
        sessionId: "a",
        taskId: "T",
        seq: 7,
        data: {},
      }),
    );
    applyEvent(
      ev({
        type: "tool_running",
        sessionId: "a",
        taskId: "T",
        seq: 6,
        data: { toolCall: { id: "late-tool", status: "running" } },
      }),
    );

    const agent = getSnapshot("T").subagents[0];
    expect(agent.currentText).toBe("new text");
    expect(agent.currentReasoning).toBe("new reasoning");
    expect(agent.status).toBe("success");
    expect(agent.steps.map((step) => step.id)).toEqual(["late-tool"]);
  });

  it("keeps task snapshots monotonic when stale events arrive", () => {
    applyEvent(
      ev({
        type: "message",
        sessionId: "a",
        taskId: "T",
        seq: 10,
        timestamp: 1000,
        data: { text: "new text" },
      }),
    );
    expect(getSnapshot("T").updatedAt).toBe(1000);

    applyEvent(
      ev({
        type: "message",
        sessionId: "a",
        taskId: "T",
        seq: 9,
        timestamp: 900,
        data: { text: "stale text" },
      }),
    );

    const snap = getSnapshot("T");
    expect(snap.updatedAt).toBe(1000);
    expect(snap.subagents[0].updatedAt).toBe(1000);
    expect(snap.subagents[0].currentText).toBe("new text");
  });

  it("moves a sub-agent to a terminal status on lifecycle events", () => {
    applyEvent(
      ev({
        type: "tool_running",
        sessionId: "a",
        taskId: "T",
        seq: 1,
        data: { toolCall: { id: "t", status: "running" } },
      }),
    );
    expect(getSnapshot("T").subagents[0].status).toBe("running");
    applyEvent(
      ev({
        type: "task_complete",
        sessionId: "a",
        taskId: "T",
        seq: 2,
        data: {},
      }),
    );
    expect(getSnapshot("T").subagents[0].status).toBe("success");
    applyEvent(
      ev({
        type: "error",
        sessionId: "a",
        taskId: "T",
        seq: 3,
        data: { message: "boom" },
      }),
    );
    expect(getSnapshot("T").subagents[0].status).toBe("failure");
  });

  it("nests a child session under its parent via parentSessionId", () => {
    applyEvent(
      ev({
        type: "message",
        sessionId: "parent",
        taskId: "T",
        seq: 1,
        data: { text: "p" },
      }),
    );
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
    const child = getSnapshot("T").subagents.find(
      (s) => s.sessionId === "child",
    );
    expect(child?.parentSessionId).toBe("parent");
  });

  it("groups an orphan child event under the known parent task", () => {
    applyEvent(
      ev({
        type: "message",
        sessionId: "parent",
        taskId: "T",
        seq: 1,
        data: { text: "p" },
      }),
    );
    applyEvent(
      ev({
        type: "message",
        sessionId: "child",
        parentSessionId: "parent",
        seq: 2,
        data: { text: "c" },
      }),
    );

    expect(getSnapshot("child").subagents).toHaveLength(0);
    const child = getSnapshot("T").subagents.find(
      (agent) => agent.sessionId === "child",
    );
    expect(child?.currentText).toBe("c");
    expect(child?.parentSessionId).toBe("parent");
  });

  it("bounds idle tasks and sub-agent rows", () => {
    const unsubscribe = subscribe("pinned", () => {});
    try {
      for (let i = 0; i <= limits.maxTasks; i += 1) {
        applyEvent(
          ev({
            type: "message",
            sessionId: `agent-${i}`,
            taskId: `task-${i}`,
            seq: i + 1,
            data: { text: `message-${i}` },
          }),
        );
      }
      expect(getSnapshot("task-0").subagents).toHaveLength(0);
      expect(getSnapshot("pinned").taskId).toBe("pinned");

      for (let i = 0; i <= limits.maxSubagentsPerTask; i += 1) {
        applyEvent(
          ev({
            type: "message",
            sessionId: `child-${i}`,
            taskId: "crowded",
            seq: i + 1,
            data: { text: `message-${i}` },
          }),
        );
      }
      const crowded = getSnapshot("crowded");
      expect(crowded.subagents).toHaveLength(limits.maxSubagentsPerTask);
      expect(
        crowded.subagents.some((agent) => agent.sessionId === "child-0"),
      ).toBe(false);
      expect(
        crowded.subagents.some(
          (agent) => agent.sessionId === `child-${limits.maxSubagentsPerTask}`,
        ),
      ).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it("reconstructs the SwarmEvent from a real server pty-session-event frame", () => {
    // The server rewrites `{ type, ...rest }` so the SwarmEvent `type` arrives
    // as `eventType`; `bindWs` must reconstruct the envelope before reducing.
    // Subscribe first so the store binds the socket handler, then deliver the
    // exact broadcast shape through the real client fan-out.
    const unsubscribe = subscribe("WIRE", () => {});
    try {
      expect(getSnapshot("WIRE").subagents).toHaveLength(0);
      client.deliverWsMessageForTest({
        type: "pty-session-event",
        eventType: "tool_running",
        sessionId: "a",
        timestamp: 10,
        seq: 1,
        taskId: "WIRE",
        data: { toolCall: { id: "t1", title: "Bash", status: "running" } },
      });
      const agent = getSnapshot("WIRE").subagents[0];
      expect(agent?.sessionId).toBe("a");
      expect(agent?.steps[0]?.tool.title).toBe("Bash");
      expect(agent?.steps[0]?.tool.status).toBe("running");
    } finally {
      unsubscribe();
    }
  });
});
