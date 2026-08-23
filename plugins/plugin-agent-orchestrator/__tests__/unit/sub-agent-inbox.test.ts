/**
 * Verifies SubAgentInbox.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import { SubAgentInbox } from "../../src/services/sub-agent-inbox.js";

describe("SubAgentInbox", () => {
  it("drains queued messages newline-joined, then is empty", () => {
    const inbox = new SubAgentInbox();
    inbox.enqueue("s1", "first");
    inbox.enqueue("s1", "second");
    expect(inbox.size("s1")).toBe(2);
    expect(inbox.drain("s1")).toBe("first\nsecond");
    expect(inbox.size("s1")).toBe(0);
    expect(inbox.drain("s1")).toBeNull();
  });

  it("ignores blank enqueues and isolates sessions", () => {
    const inbox = new SubAgentInbox();
    inbox.enqueue("s1", "   ");
    expect(inbox.size("s1")).toBe(0);
    inbox.enqueue("s1", "a");
    inbox.enqueue("s2", "b");
    expect(inbox.drain("s1")).toBe("a");
    expect(inbox.drain("s2")).toBe("b");
  });

  it("preserves all entries past the former cap", () => {
    const inbox = new SubAgentInbox(2);
    inbox.enqueue("s", "1");
    inbox.enqueue("s", "2");
    inbox.enqueue("s", "3");
    expect(inbox.drain("s")).toBe("1\n2\n3");
  });

  it("keeps the compatibility overflow observer silent for a lossless queue", () => {
    const inbox = new SubAgentInbox(2);
    const seen: Array<{ sessionId: string; now: number; total: number }> = [];
    inbox.setOverflowObserver((sessionId, now, total) =>
      seen.push({ sessionId, now, total }),
    );
    inbox.enqueue("s", "1");
    inbox.enqueue("s", "2");
    expect(seen).toEqual([]);
    expect(inbox.droppedCount("s")).toBe(0);

    inbox.enqueue("s", "3");
    inbox.enqueue("s", "4");
    expect(seen).toEqual([]);
    expect(inbox.droppedCount("s")).toBe(0);
    expect(inbox.drain("s")).toBe("1\n2\n3\n4");
    inbox.enqueue("s", "5");
    inbox.clear("s");
    expect(inbox.droppedCount("s")).toBe(0);
  });

  it("does not drop entries when no observer is attached", () => {
    const inbox = new SubAgentInbox(1);
    inbox.enqueue("s", "a");
    inbox.enqueue("s", "b");
    expect(inbox.droppedCount("s")).toBe(0);
    expect(inbox.drain("s")).toBe("a\nb");
  });

  it("clears one session and all sessions", () => {
    const inbox = new SubAgentInbox();
    inbox.enqueue("a", "x");
    inbox.enqueue("b", "y");
    inbox.clear("a");
    expect(inbox.size("a")).toBe(0);
    expect(inbox.size("b")).toBe(1);
    inbox.clearAll();
    expect(inbox.size("b")).toBe(0);
  });
});
