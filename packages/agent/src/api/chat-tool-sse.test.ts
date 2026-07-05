/**
 * Unit tests for the inline tool-call bridge (#13535): the real
 * `chatEventsFromStructuredStreamPayload` projection turns the runtime's native
 * planner/tool stream payloads (tool_call / tool_result / tool_error /
 * evaluation) into the chat working-indicator status + inline tool-row events,
 * and `writeChatToolSse` renders one additive `type: tool` SSE frame. The
 * payload shapes are the exact ones the message service forwards through
 * `onStreamChunk` (services/message.ts). Deterministic; no live model.
 */
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";

import {
  chatEventsFromStructuredStreamPayload,
  writeChatToolSse,
} from "./chat-routes.ts";

function makeRes(): { res: http.ServerResponse; writes: string[] } {
  const writes: string[] = [];
  const res = {
    writableEnded: false,
    destroyed: false,
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
  } as unknown as http.ServerResponse;
  return { res, writes };
}

describe("chatEventsFromStructuredStreamPayload (#13535)", () => {
  it("projects a tool_call into a running_tool status + a `call` tool row", () => {
    const events = chatEventsFromStructuredStreamPayload({
      type: "tool_call",
      toolCall: {
        id: "call_1",
        name: "WEB_SEARCH",
        arguments: { query: "elizaOS" },
      },
      messageId: "msg-1",
    });
    expect(events?.status).toEqual({
      kind: "running_tool",
      toolName: "WEB_SEARCH",
    });
    expect(events?.toolEvent).toEqual({
      phase: "call",
      callId: "call_1",
      toolName: "WEB_SEARCH",
      args: { query: "elizaOS" },
    });
  });

  it("parses stringified JSON arguments into a record", () => {
    const events = chatEventsFromStructuredStreamPayload({
      type: "tool_call",
      toolCall: {
        toolName: "FILE",
        args: '{"path":"/tmp/x"}',
      },
    });
    expect(events?.toolEvent?.args).toEqual({ path: "/tmp/x" });
    // callId falls back to the tool name when no id is present.
    expect(events?.toolEvent?.callId).toBe("FILE");
  });

  it("keeps a non-JSON args string verbatim under `raw`", () => {
    const events = chatEventsFromStructuredStreamPayload({
      type: "tool_call",
      toolCall: { name: "BASH", input: "ls -la" },
    });
    expect(events?.toolEvent?.args).toEqual({ raw: "ls -la" });
  });

  it("projects a tool_result into a `result` tool row correlated by callId", () => {
    const events = chatEventsFromStructuredStreamPayload({
      type: "tool_result",
      toolCallId: "call_1",
      toolCall: { name: "WEB_SEARCH" },
      result: { hits: 3 },
      status: "completed",
    });
    expect(events?.status).toBeUndefined();
    expect(events?.toolEvent).toEqual({
      phase: "result",
      callId: "call_1",
      toolName: "WEB_SEARCH",
      result: { hits: 3 },
    });
  });

  it("projects a failed tool into an `error` tool row (tool_error type)", () => {
    const events = chatEventsFromStructuredStreamPayload({
      type: "tool_error",
      toolCallId: "call_2",
      toolCall: { name: "FILE" },
      result: "permission denied",
    });
    expect(events?.toolEvent).toEqual({
      phase: "error",
      callId: "call_2",
      toolName: "FILE",
      error: "permission denied",
    });
  });

  it("treats a completed result with status 'failed' as an error row", () => {
    const events = chatEventsFromStructuredStreamPayload({
      type: "tool_result",
      toolCall: { name: "FILE", status: "failed", result: "nope" },
    });
    expect(events?.toolEvent?.phase).toBe("error");
    expect(events?.toolEvent?.error).toBe("nope");
  });

  it("projects an evaluation payload into an `evaluating` status (no tool row)", () => {
    const events = chatEventsFromStructuredStreamPayload({
      type: "evaluation",
      evaluation: { evaluator: "reflection", success: true },
    });
    expect(events?.status).toEqual({ kind: "evaluating" });
    expect(events?.toolEvent).toBeUndefined();
  });

  it("returns null for payloads with no chat-visible signal", () => {
    expect(
      chatEventsFromStructuredStreamPayload({
        type: "context_event",
        event: {},
      }),
    ).toBeNull();
    expect(chatEventsFromStructuredStreamPayload("nope")).toBeNull();
    expect(
      chatEventsFromStructuredStreamPayload({ type: "tool_call" }),
    ).toBeNull();
  });
});

describe("writeChatToolSse (#13535)", () => {
  it("emits a single additive `type: tool` SSE frame carrying the event", () => {
    const { res, writes } = makeRes();
    writeChatToolSse(res, {
      phase: "call",
      callId: "call_1",
      toolName: "WEB_SEARCH",
      args: { query: "hi" },
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].startsWith("data: ")).toBe(true);
    expect(writes[0].endsWith("\n\n")).toBe(true);
    const payload = JSON.parse(writes[0].slice("data: ".length).trim());
    expect(payload).toEqual({
      type: "tool",
      phase: "call",
      callId: "call_1",
      toolName: "WEB_SEARCH",
      args: { query: "hi" },
    });
  });

  it("does not write once the response is ended", () => {
    const { res, writes } = makeRes();
    (res as { writableEnded: boolean }).writableEnded = true;
    writeChatToolSse(res, { phase: "result", callId: "c", toolName: "t" });
    expect(writes).toHaveLength(0);
  });
});
