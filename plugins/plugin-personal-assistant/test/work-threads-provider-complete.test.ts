/**
 * Pins the planner-facing work-thread renderer to the complete inventory. The
 * store and provider integration are covered elsewhere; this regression keeps
 * a fixed display count from silently returning.
 */
import { describe, expect, it } from "vitest";
import type { WorkThread } from "../src/lifeops/work-threads/index.js";
import { renderWorkThreadsText } from "../src/providers/work-threads.js";

function thread(index: number): WorkThread {
  const timestamp = new Date(Date.UTC(2026, 7, 22, 0, 0, index)).toISOString();
  return {
    id: `thread-${index}`,
    agentId: "agent-1",
    ownerEntityId: "owner-1",
    status: "active",
    title: `Thread ${index}`,
    summary: `Summary ${index}`,
    currentPlanSummary: null,
    primarySourceRef: {
      connector: "telegram",
      roomId: `room-${index}`,
      canRead: true,
      canMutate: false,
    },
    sourceRefs: [],
    participantEntityIds: [],
    currentScheduledTaskId: null,
    workflowRunId: null,
    approvalId: null,
    lastMessageMemoryId: null,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastActivityAt: timestamp,
    metadata: {},
  };
}

describe("workThreads provider rendering", () => {
  it("renders every active thread instead of an eight-item prefix", () => {
    const threads = Array.from({ length: 12 }, (_, index) => thread(index + 1));

    const text = renderWorkThreadsText(threads, "room-1");

    for (const item of threads) expect(text).toContain(item.id);
    expect(text).not.toContain("(+");
  });
});
