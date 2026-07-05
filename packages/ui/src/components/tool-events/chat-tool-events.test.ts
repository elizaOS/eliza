/**
 * Behaviour coverage for `mergeChatToolEvent`: folding the chat SSE `tool`
 * frames (`ChatToolCallEvent`) into the `NativeToolCallEvent` rows the thread
 * renders, matching a `call` to its later `result`/`error` by `callId` so one
 * row flips running → settled in place. Pure function; no harness.
 */

import { describe, expect, it } from "vitest";

import type { ChatToolCallEvent } from "../../api/client-types-chat";
import { mergeChatToolEvent } from "./chat-tool-events";

describe("mergeChatToolEvent", () => {
  it("appends a running row for a `call` frame carrying args", () => {
    const call: ChatToolCallEvent = {
      phase: "call",
      callId: "c1",
      toolName: "WEB_SEARCH",
      args: { query: "elizaOS" },
    };
    const next = mergeChatToolEvent([], call);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      callId: "c1",
      toolName: "WEB_SEARCH",
      type: "tool_call",
      status: "running",
      args: { query: "elizaOS" },
    });
    // NativeToolCallEvent requires an `id`; callId doubles as it.
    expect(next[0].id).toBe("c1");
  });

  it("flips the same row to success on a `result`, preserving the call args", () => {
    const call: ChatToolCallEvent = {
      phase: "call",
      callId: "c1",
      toolName: "WEB_SEARCH",
      args: { query: "elizaOS" },
    };
    const result: ChatToolCallEvent = {
      phase: "result",
      callId: "c1",
      toolName: "WEB_SEARCH",
      result: { hits: 3 },
    };
    const afterCall = mergeChatToolEvent([], call);
    const afterResult = mergeChatToolEvent(afterCall, result);
    // Same row updated in place — not a second appended row.
    expect(afterResult).toHaveLength(1);
    expect(afterResult[0]).toMatchObject({
      callId: "c1",
      type: "tool_result",
      status: "completed",
      result: { hits: 3 },
      // The call's args survive the merge onto the settled row.
      args: { query: "elizaOS" },
    });
  });

  it("flips the same row to failure on an `error`", () => {
    const call: ChatToolCallEvent = {
      phase: "call",
      callId: "c9",
      toolName: "FETCH",
    };
    const error: ChatToolCallEvent = {
      phase: "error",
      callId: "c9",
      toolName: "FETCH",
      error: "network down",
    };
    const next = mergeChatToolEvent(mergeChatToolEvent([], call), error);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      callId: "c9",
      type: "tool_error",
      status: "failed",
      error: "network down",
    });
  });

  it("keeps concurrent tool calls as distinct rows", () => {
    const a: ChatToolCallEvent = { phase: "call", callId: "a", toolName: "A" };
    const b: ChatToolCallEvent = { phase: "call", callId: "b", toolName: "B" };
    const next = mergeChatToolEvent(mergeChatToolEvent([], a), b);
    expect(next).toHaveLength(2);
    expect(next.map((e) => e.callId)).toEqual(["a", "b"]);
  });
});
