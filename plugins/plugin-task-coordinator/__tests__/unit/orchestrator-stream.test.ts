import { describe, expect, it } from "vitest";
import { buildConversation } from "../../src/orchestrator-stream";

type MessageRecord = Parameters<typeof buildConversation>[0][number];
type EventRecord = Parameters<typeof buildConversation>[1][number];

const baseMessage = (
  overrides: Partial<MessageRecord>,
): MessageRecord => ({
  id: "message-1",
  threadId: "task-1",
  sessionId: null,
  senderKind: "orchestrator",
  direction: "stdout",
  content: "hello",
  timestamp: 1,
  metadata: {},
  createdAt: "2026-05-30T18:00:00.000Z",
  ...overrides,
});

describe("buildConversation", () => {
  it("renders user stdin while filtering agent stdin", () => {
    const blocks = buildConversation(
      [
        baseMessage({
          id: "user-stdin",
          senderKind: "user",
          direction: "stdin",
          content: "Please run browser smoke and report visible notes.",
          timestamp: 10,
        }),
        baseMessage({
          id: "agent-stdin",
          senderKind: "sub_agent",
          sessionId: "session-codex",
          direction: "stdin",
          content: "Hidden prompt forwarded to the sub-agent.",
          timestamp: 11,
        }),
        baseMessage({
          id: "agent-stdout",
          senderKind: "sub_agent",
          sessionId: "session-codex",
          direction: "stdout",
          content: "Visible sub-agent response.",
          timestamp: 12,
        }),
      ],
      [] satisfies EventRecord[],
      (message) => message.senderKind,
      new Set(),
    );

    expect(blocks).toEqual([
      {
        kind: "user",
        key: "msg-user-stdin",
        at: 10,
        content: "Please run browser smoke and report visible notes.",
      },
      expect.objectContaining({
        kind: "agent",
        key: "msg-agent-stdout",
        content: "Visible sub-agent response.",
      }),
    ]);
  });
});
