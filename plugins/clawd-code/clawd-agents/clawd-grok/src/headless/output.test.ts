import { describe, expect, it } from "vitest";
import type { StreamChunk, ToolCall } from "../types";
import {
  createHeadlessJsonlEmitter,
  isHeadlessOutputFormat,
  renderHeadlessChunk,
  renderHeadlessPrelude,
} from "./output";

function toolCall(name: string): ToolCall {
  return {
    id: "tc-1",
    type: "function",
    function: {
      name,
      arguments: "{}",
    },
  };
}

function expectSessionAndTimestamp(e: { sessionID?: string; timestamp?: number }, sessionId?: string) {
  if (sessionId !== undefined) {
    expect(e.sessionID).toBe(sessionId);
  } else {
    expect(e.sessionID).toBeUndefined();
  }
  expect(typeof e.timestamp).toBe("number");
}

describe("headless output helpers", () => {
  it("recognizes supported output formats", () => {
    expect(isHeadlessOutputFormat("text")).toBe(true);
    expect(isHeadlessOutputFormat("json")).toBe(true);
    expect(isHeadlessOutputFormat("xml")).toBe(false);
  });

  it("renders the text prelude with session metadata", () => {
    expect(renderHeadlessPrelude("text", "session-123")).toEqual({
      stdout: "\u001b[36m⏳ Processing...\u001b[0m\n",
      stderr: "\u001b[2mSession: session-123\u001b[0m\n",
    });
  });

  it("suppresses the prelude in json mode", () => {
    expect(renderHeadlessPrelude("json", "session-123")).toEqual({});
  });

  it("renders tool calls for text mode", () => {
    const chunk: StreamChunk = {
      type: "tool_calls",
      toolCalls: [toolCall("bash"), toolCall("read_file")],
    };

    expect(renderHeadlessChunk(chunk)).toEqual({
      stderr: "\u001b[33m▸ bash\u001b[0m\n\u001b[33m▸ read_file\u001b[0m\n",
    });
  });

  it("renders tool results for text mode", () => {
    const chunk: StreamChunk = {
      type: "tool_result",
      toolCall: toolCall("bash"),
      toolResult: {
        success: false,
        output: "failed",
      },
    };

    expect(renderHeadlessChunk(chunk)).toEqual({
      stderr: "\u001b[31m✗ bash\u001b[0m\n",
    });
  });

  it("renders generated media paths in text mode tool results", () => {
    const chunk: StreamChunk = {
      type: "tool_result",
      toolCall: toolCall("generate_image"),
      toolResult: {
        success: true,
        output: "Generated 1 image.",
        media: [{ kind: "image", path: "/tmp/generated.png", url: "https://example.com/generated.png" }],
      },
    };

    expect(renderHeadlessChunk(chunk)).toEqual({
      stderr: "\u001b[32m▸ generate_image\u001b[0m\n  /tmp/generated.png (https://example.com/generated.png)\n",
    });
  });

  it("emits semantic JSONL for a single step with text and tool (json emitter)", () => {
    const sessionId = "jsonl-test-session";
    const tc = toolCall("bash");
    const { observer, consumeChunk, flush } = createHeadlessJsonlEmitter(sessionId);
    let combined = "";

    observer.onStepStart?.({ stepNumber: 1, timestamp: 100 });
    combined += consumeChunk({ type: "content", content: "hello" }).stdout ?? "";
    observer.onToolStart?.({ toolCall: tc, timestamp: 110 });
    combined +=
      consumeChunk({
        type: "tool_calls",
        toolCalls: [tc],
      }).stdout ?? "";
    observer.onToolFinish?.({
      toolCall: tc,
      toolResult: { success: true, output: "ok" },
      timestamp: 130,
    });
    combined +=
      consumeChunk({
        type: "tool_result",
        toolCall: tc,
        toolResult: { success: true, output: "ok" },
      }).stdout ?? "";
    observer.onStepFinish?.({
      stepNumber: 1,
      timestamp: 200,
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
    combined += flush().stdout ?? "";

    const events = combined
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.map((e) => e.type)).toEqual(["step_start", "text", "tool_use", "step_finish"]);
    expectSessionAndTimestamp(events[0], sessionId);
    expect(events[0]).toMatchObject({ type: "step_start", stepNumber: 1, timestamp: 100 });

    expectSessionAndTimestamp(events[1], sessionId);
    expect(events[1]).toMatchObject({ type: "text", stepNumber: 1, text: "hello" });

    expectSessionAndTimestamp(events[2], sessionId);
    expect(events[2]).toMatchObject({
      type: "tool_use",
      stepNumber: 1,
      timestamp: 130,
      timing: { startedAt: 110, finishedAt: 130, durationMs: 20 },
    });

    expectSessionAndTimestamp(events[3], sessionId);
    expect(events[3]).toMatchObject({
      type: "step_finish",
      stepNumber: 1,
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      timestamp: 200,
    });
  });

  it("does not emit empty text events at step_finish when tools already flushed assistant text", () => {
    const sessionId = "sess-2";
    const tc = toolCall("bash");
    const { observer, consumeChunk, flush } = createHeadlessJsonlEmitter(sessionId);
    let combined = "";
    observer.onStepStart?.({ stepNumber: 0, timestamp: 1 });
    combined += consumeChunk({ type: "content", content: "x" }).stdout ?? "";
    observer.onToolStart?.({ toolCall: tc, timestamp: 5 });
    combined += consumeChunk({ type: "tool_calls", toolCalls: [tc] }).stdout ?? "";
    observer.onToolFinish?.({
      toolCall: tc,
      toolResult: { success: true, output: "y" },
      timestamp: 8,
    });
    combined +=
      consumeChunk({
        type: "tool_result",
        toolCall: tc,
        toolResult: { success: true, output: "y" },
      }).stdout ?? "";
    observer.onStepFinish?.({
      stepNumber: 0,
      timestamp: 2,
      finishReason: "tool-calls",
      usage: {},
    });
    combined += flush().stdout ?? "";
    const events = combined
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.filter((e) => e.type === "text").every((e) => e.text.length > 0)).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["step_start", "text", "tool_use", "step_finish"]);
    for (const e of events) {
      expectSessionAndTimestamp(e, sessionId);
    }
  });

  it("emits error events from stream chunks", () => {
    const sessionId = "err-session";
    const { consumeChunk } = createHeadlessJsonlEmitter(sessionId);
    const w = consumeChunk({ type: "error", content: "boom" });
    const parsed = JSON.parse(w.stdout?.trim() ?? "{}");
    expect(parsed).toMatchObject({
      type: "error",
      message: "boom",
    });
    expectSessionAndTimestamp(parsed, sessionId);
  });
});
