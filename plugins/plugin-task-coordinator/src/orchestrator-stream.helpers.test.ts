/**
 * Unit tests for orchestrator stream helpers and safe NaN sort handling.
 */
import type { CodingAgentTaskMessageRecord } from "@elizaos/ui/api/client-types-cloud";
import { describe, expect, it } from "vitest";
import { buildConversation } from "./orchestrator-stream.helpers";

describe("orchestrator stream helpers safe sort", () => {
  it("buildConversation handles NaN timestamps safely and preserves deterministic message block order", () => {
    const messages: CodingAgentTaskMessageRecord[] = [
      {
        id: "msg-1",
        taskId: "task-1",
        senderKind: "user",
        senderId: "u1",
        content: "nan message",
        timestamp: Number.NaN,
      },
      {
        id: "msg-2",
        taskId: "task-1",
        senderKind: "agent",
        senderId: "a1",
        content: "100 message",
        timestamp: 100,
      },
      {
        id: "msg-3",
        taskId: "task-1",
        senderKind: "user",
        senderId: "u1",
        content: "50 message",
        timestamp: 50,
      },
    ];

    const blocks = buildConversation([], messages);
    expect(blocks.length).toBe(3);
    // Ordered by at (NaN -> 0, then 50, then 100)
    expect(blocks[0].key).toBe("evt-msg-1");
    expect(blocks[1].key).toBe("evt-msg-3");
    expect(blocks[2].key).toBe("evt-msg-2");
    expect(blocks[2].at).toBe(100);
  });
});
