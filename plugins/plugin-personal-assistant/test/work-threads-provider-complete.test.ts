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

  it("sorts threads safely when lastActivityAt contains invalid date strings", () => {
    const threadInvalid = thread(1);
    threadInvalid.lastActivityAt = "invalid-date-string";
    const threadValid = thread(2);
    threadValid.lastActivityAt = "2026-08-20T12:00:00.000Z";

    const threads = [threadInvalid, threadValid].sort((a, b) => {
      const bTime =
        typeof b.lastActivityAt === "string" &&
        Number.isFinite(Date.parse(b.lastActivityAt))
          ? Date.parse(b.lastActivityAt)
          : 0;
      const aTime =
        typeof a.lastActivityAt === "string" &&
        Number.isFinite(Date.parse(a.lastActivityAt))
          ? Date.parse(a.lastActivityAt)
          : 0;
      return bTime - aTime || a.id.localeCompare(b.id);
    });

    expect(threads[0]?.id).toBe(threadValid.id);
    expect(threads[1]?.id).toBe(threadInvalid.id);
  });
});
