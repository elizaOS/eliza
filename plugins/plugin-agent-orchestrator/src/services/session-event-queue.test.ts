/**
 * Unit tests for session event queue: validates per-session FIFO order
 * and pending counts.
 */
import { describe, expect, it } from "vitest";
import { type QueuedEvent, SessionEventQueue } from "./session-event-queue.ts";

describe("session-event-queue", () => {
  it("enqueues and processes events in FIFO order for a session", async () => {
    const processed: string[] = [];
    const queue = new SessionEventQueue(async (ev: QueuedEvent) => {
      processed.push(ev.data as string);
    });

    queue.enqueue({
      sessionId: "s1",
      type: "blocked",
      data: "first",
      enqueuedAt: Date.now(),
    });
    queue.enqueue({
      sessionId: "s1",
      type: "turn_complete",
      data: "second",
      enqueuedAt: Date.now(),
    });

    // Allow microtasks to settle
    await new Promise((r) => setTimeout(r, 20));

    expect(processed).toEqual(["first", "second"]);
  });

  it("clears pending queues correctly", () => {
    const queue = new SessionEventQueue(async () => {});
    queue.clear("s1");
    expect(queue.pendingCount("s1")).toBe(0);
  });
});
