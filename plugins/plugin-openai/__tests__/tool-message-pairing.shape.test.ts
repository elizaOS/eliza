/**
 * Guards the request-time tool/tool_calls pairing invariant OpenAI-strict
 * providers (Cerebras) enforce: a `role: "tool"` message must immediately
 * follow an assistant message carrying the matching `tool-call` id, or the
 * provider rejects the whole request with HTTP 400. `normalizeNativeMessages`
 * repairs orphaned tool messages (history compaction can drop the assistant
 * half) by demoting them to plain user messages so content survives without
 * breaking the wire contract. Well-formed pairs must pass through untouched.
 */
import { describe, expect, it } from "vitest";
import { __INTERNAL_normalizeNativeMessages } from "../models/text.ts";

describe("normalizeNativeMessages tool pairing", () => {
  it("passes a well-formed assistant/tool pair through untouched", () => {
    const out = __INTERNAL_normalizeNativeMessages([
      { role: "system", content: "eval" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc-1", toolName: "CAL", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-1",
            toolName: "CAL",
            output: { type: "text", value: "done" },
          },
        ],
      },
    ]);
    expect(out?.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
  });

  it("demotes an orphaned tool message to a user message, preserving content", () => {
    const out = __INTERNAL_normalizeNativeMessages([
      { role: "system", content: "eval" },
      { role: "user", content: "hi" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "missing",
            toolName: "CAL",
            output: { type: "text", value: "created event" },
          },
        ],
      },
    ]);
    expect(out?.map((m) => m.role)).toEqual(["system", "user", "user"]);
    expect(JSON.stringify(out?.[2]?.content)).toContain("created event");
    // No orphaned tool message may reach the wire.
    expect(out?.some((m) => m.role === "tool")).toBe(false);
  });

  it("keeps a paired tool message even when an unrelated orphan is also present", () => {
    const out = __INTERNAL_normalizeNativeMessages([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc-2", toolName: "CAL", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-2",
            toolName: "CAL",
            output: { type: "text", value: "paired" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "orphan",
            toolName: "CAL",
            output: { type: "text", value: "orphan" },
          },
        ],
      },
    ]);
    expect(out?.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
  });
});
