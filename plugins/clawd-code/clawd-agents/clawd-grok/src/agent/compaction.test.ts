import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { buildEffectiveTranscript, type PersistedCompaction } from "../storage/transcript-view";
import {
  COMPACTION_SUMMARY_HEADER,
  createCompactionSummaryMessage,
  findCutPoint,
  prepareCompaction,
  serializeConversation,
  shouldCompactContext,
} from "./compaction";

function user(text: string): ModelMessage {
  return { role: "user", content: text } as ModelMessage;
}

function assistantText(text: string): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as ModelMessage;
}

function assistantToolCall(toolCallId: string, toolName: string, input: Record<string, unknown> = {}): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId, toolName, input }],
  } as ModelMessage;
}

function toolResult(toolCallId: string, toolName: string, output: unknown): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId, toolName, output }],
  } as ModelMessage;
}

describe("compaction helpers", () => {
  it("triggers when context exceeds reserved headroom", () => {
    const settings = { reserveTokens: 100, keepRecentTokens: 40 };

    expect(shouldCompactContext(901, 1000, settings)).toBe(true);
    expect(shouldCompactContext(900, 1000, settings)).toBe(false);
  });

  it("never selects a tool-result message as the cut point", () => {
    const messages = [
      user("inspect this file"),
      assistantToolCall("call-1", "read_file", { path: "src/index.ts" }),
      toolResult("call-1", "read_file", "x".repeat(400)),
      assistantText("I found the relevant section."),
      user("continue"),
    ];

    const cutPoint = findCutPoint(messages, 0, 130);

    expect(cutPoint.firstKeptIndex).not.toBe(2);
    expect(messages[cutPoint.firstKeptIndex]?.role).not.toBe("tool");
  });

  it("detects split turns and captures the turn prefix for summarization", () => {
    const messages = [
      user("Refactor the session loader."),
      assistantText("a".repeat(320)),
      assistantText("recent status update"),
    ];

    const preparation = prepareCompaction(messages, "system prompt", {
      reserveTokens: 100,
      keepRecentTokens: 5,
    });

    expect(preparation).not.toBeNull();
    expect(preparation?.isSplitTurn).toBe(true);
    expect(preparation?.messagesToSummarize).toHaveLength(0);
    expect(preparation?.turnPrefixMessages).toHaveLength(2);
    expect(preparation?.keptMessages).toHaveLength(1);
  });

  it("excludes the previous summary message from new compaction input", () => {
    const messages = [
      createCompactionSummaryMessage("Earlier work"),
      user("Handle migration edge cases"),
      assistantText("I added the table and loader changes."),
      user("Now wire the retry path"),
    ];

    const preparation = prepareCompaction(messages, "system prompt", {
      reserveTokens: 100,
      keepRecentTokens: 4,
    });

    expect(preparation).not.toBeNull();
    expect(preparation?.previousSummary).toBe("Earlier work");
    expect(preparation?.messagesToSummarize[0]).toEqual(user("Handle migration edge cases"));
    expect(preparation?.messagesToSummarize.some((message) => message.role === "system")).toBe(false);
  });

  it("serializes tool results with truncation markers", () => {
    const transcript = serializeConversation([user("Read the output"), toolResult("call-1", "bash", "x".repeat(2105))]);

    expect(transcript).toContain("[Tool result]:");
    expect(transcript).toContain("more characters truncated");
  });

  it("builds the effective transcript from the latest persisted checkpoint", () => {
    const rawMessages = [
      user("old request"),
      assistantText("old answer"),
      user("new request"),
      assistantText("new answer"),
      user("latest request"),
    ];
    const seqs = [1, 2, 3, 4, 5];
    const timestamps = seqs.map((seq) => new Date(`2026-03-20T00:00:0${seq}.000Z`));
    const checkpoint: PersistedCompaction = {
      firstKeptSeq: 4,
      summary: "Summarized old work",
      tokensBefore: 1234,
      createdAt: new Date("2026-03-20T00:00:10.000Z"),
    };

    const transcript = buildEffectiveTranscript(rawMessages, seqs, timestamps, checkpoint);

    expect(transcript.messages).toHaveLength(3);
    expect(transcript.seqs).toEqual([null, 4, 5]);
    expect(transcript.messages[0]).toEqual(createCompactionSummaryMessage("Summarized old work"));
    expect(
      transcript.messages[0]?.role === "system" && typeof transcript.messages[0].content === "string"
        ? transcript.messages[0].content
        : "",
    ).toContain(COMPACTION_SUMMARY_HEADER);
  });
});
