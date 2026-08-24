/**
 * Unit tests for SubAgentInbox: validates lossless session message queueing.
 */
import { describe, expect, it } from "vitest";
import { SubAgentInbox } from "./sub-agent-inbox.ts";

describe("sub-agent-inbox", () => {
  it("enqueues and drains messages in FIFO order", () => {
    const inbox = new SubAgentInbox();
    expect(inbox.size("session-1")).toBe(0);
    expect(inbox.drain("session-1")).toBeNull();

    inbox.enqueue("session-1", "first message");
    inbox.enqueue("session-1", "second message");
    expect(inbox.size("session-1")).toBe(2);

    const drained = inbox.drain("session-1");
    expect(drained).toBe("first message\nsecond message");
    expect(inbox.size("session-1")).toBe(0);
  });

  it("ignores empty whitespace strings on enqueue", () => {
    const inbox = new SubAgentInbox();
    inbox.enqueue("session-1", "   ");
    expect(inbox.size("session-1")).toBe(0);
  });

  it("clears pending queue per session and all sessions", () => {
    const inbox = new SubAgentInbox();
    inbox.enqueue("session-1", "msg1");
    inbox.enqueue("session-2", "msg2");

    inbox.clear("session-1");
    expect(inbox.size("session-1")).toBe(0);
    expect(inbox.size("session-2")).toBe(1);

    inbox.clearAll();
    expect(inbox.size("session-2")).toBe(0);
  });
});
