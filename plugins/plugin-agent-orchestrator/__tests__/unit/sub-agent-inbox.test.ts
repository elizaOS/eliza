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

  it("drops the oldest entries past the cap", () => {
    const inbox = new SubAgentInbox(2);
    inbox.enqueue("s", "1");
    inbox.enqueue("s", "2");
    inbox.enqueue("s", "3");
    expect(inbox.drain("s")).toBe("2\n3");
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
