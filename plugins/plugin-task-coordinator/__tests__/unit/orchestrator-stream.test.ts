import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  MarkdownText,
  sanitizeMarkdownUrl,
} from "../../src/orchestrator-markdown";
import {
  buildConversation,
  type ConversationBlock,
} from "../../src/orchestrator-stream";

type MessageRecord = Parameters<typeof buildConversation>[0][number];
type EventRecord = Parameters<typeof buildConversation>[1][number];

const baseMessage = (overrides: Partial<MessageRecord>): MessageRecord => ({
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

const baseEvent = (overrides: Partial<EventRecord>): EventRecord => ({
  id: "event-1",
  threadId: "task-1",
  sessionId: null,
  eventType: "notice",
  timestamp: 1,
  summary: "notice",
  data: {},
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
        messageIds: ["user-stdin"],
        sessionId: null,
      },
      expect.objectContaining({
        kind: "agent",
        key: "msg-agent-stdout",
        content: "Visible sub-agent response.",
        messageIds: ["agent-stdout"],
        sessionId: "session-codex",
      }),
    ]);
  });

  it("preserves message identity when adjacent chunks merge", () => {
    const blocks = buildConversation(
      [
        baseMessage({
          id: "chunk-1",
          sessionId: "session-codex",
          content: "First",
          timestamp: 10,
        }),
        baseMessage({
          id: "chunk-2",
          sessionId: "session-codex",
          content: "second.",
          timestamp: 11,
        }),
      ],
      [] satisfies EventRecord[],
      (message) => message.senderKind,
      new Set(),
    );

    expect(blocks).toEqual([
      expect.objectContaining({
        kind: "agent",
        key: "msg-chunk-1",
        content: "Firstsecond.",
        messageIds: ["chunk-1", "chunk-2"],
        sessionId: "session-codex",
      }),
    ]);
  });

  it("does not merge unrelated session-less agent output", () => {
    const blocks = buildConversation(
      [
        baseMessage({
          id: "orchestrator-a",
          sessionId: null,
          content: "Task A",
          timestamp: 10,
        }),
        baseMessage({
          id: "orchestrator-b",
          sessionId: null,
          content: "Task B",
          timestamp: 11,
        }),
      ],
      [] satisfies EventRecord[],
      (message) => message.senderKind,
      new Set(),
    );

    expect(blocks).toEqual([
      expect.objectContaining({
        kind: "agent",
        key: "msg-orchestrator-a",
        content: "Task A",
        messageIds: ["orchestrator-a"],
        sessionId: null,
      }),
      expect.objectContaining({
        kind: "agent",
        key: "msg-orchestrator-b",
        content: "Task B",
        messageIds: ["orchestrator-b"],
        sessionId: null,
      }),
    ]);
  });

  it("preserves event identity for merged tool calls and notices", () => {
    const blocks = buildConversation(
      [] satisfies MessageRecord[],
      [
        baseEvent({
          id: "tool-start",
          sessionId: "session-codex",
          eventType: "tool_running",
          timestamp: 10,
          summary: "running",
          data: {
            toolCall: {
              id: "call-1",
              title: "bash",
              kind: "execute",
              status: "in_progress",
              rawInput: { command: "bun test" },
            },
          },
        }),
        baseEvent({
          id: "tool-end",
          sessionId: "session-codex",
          eventType: "tool_running",
          timestamp: 11,
          summary: "done",
          data: {
            toolCall: {
              id: "call-1",
              title: "bash",
              kind: "execute",
              status: "completed",
              output: "passed",
            },
          },
        }),
        baseEvent({
          id: "blocked-event",
          sessionId: "session-codex",
          eventType: "blocked",
          timestamp: 12,
          summary: "Needs input",
        }),
      ],
      (message) => message.senderKind,
      new Set(),
    );

    expect(blocks).toEqual([
      expect.objectContaining({
        kind: "tool",
        key: "tool-session-codex:call-1",
        tool: expect.objectContaining({
          eventIds: ["tool-start", "tool-end"],
          sessionId: "session-codex",
        }),
      }),
      expect.objectContaining({
        kind: "notice",
        key: "evt-blocked-event",
        eventId: "blocked-event",
        eventType: "blocked",
        sessionId: "session-codex",
      }),
    ]);
  });

  it("keeps duplicate tool call ids separate across sessions", () => {
    const blocks = buildConversation(
      [] satisfies MessageRecord[],
      [
        baseEvent({
          id: "session-a-tool",
          sessionId: "session-a",
          eventType: "tool_running",
          timestamp: 10,
          summary: "session a",
          data: {
            toolCall: {
              id: "call-1",
              title: "bash",
              kind: "execute",
              status: "completed",
              rawInput: { command: "bun test:a" },
            },
          },
        }),
        baseEvent({
          id: "session-b-tool",
          sessionId: "session-b",
          eventType: "tool_running",
          timestamp: 11,
          summary: "session b",
          data: {
            toolCall: {
              id: "call-1",
              title: "bash",
              kind: "execute",
              status: "completed",
              rawInput: { command: "bun test:b" },
            },
          },
        }),
      ],
      (message) => message.senderKind,
      new Set(),
    );

    const toolBlocks = blocks.filter(
      (block): block is Extract<ConversationBlock, { kind: "tool" }> =>
        block.kind === "tool",
    );

    expect(toolBlocks).toHaveLength(2);
    expect(toolBlocks.map((block) => block.key)).toEqual([
      "tool-session-a:call-1",
      "tool-session-b:call-1",
    ]);
    expect(toolBlocks.map((block) => block.tool.id)).toEqual([
      "call-1",
      "call-1",
    ]);
    expect(toolBlocks.map((block) => block.tool.eventIds)).toEqual([
      ["session-a-tool"],
      ["session-b-tool"],
    ]);
    expect(toolBlocks.map((block) => block.tool.command)).toEqual([
      "bun test:a",
      "bun test:b",
    ]);
  });
});

describe("MarkdownText", () => {
  it("allows only safe markdown link protocols", () => {
    expect(sanitizeMarkdownUrl("https://example.com")).toBe(
      "https://example.com",
    );
    expect(sanitizeMarkdownUrl("mailto:ops@example.com")).toBe(
      "mailto:ops@example.com",
    );
    expect(sanitizeMarkdownUrl("/relative/path")).toBe("/relative/path");
    expect(sanitizeMarkdownUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeMarkdownUrl("data:text/html,<svg>")).toBeNull();
  });

  it("renders unsafe markdown links without href attributes", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownText, {
        text:
          "[safe](https://example.com) [bad](javascript:alert) " +
          "[relative](/task/1)",
      }),
    );

    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="/task/1"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("bad");
  });
});
