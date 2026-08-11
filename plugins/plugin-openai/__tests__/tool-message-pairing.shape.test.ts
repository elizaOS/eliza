/**
 * Guards the request-time tool/tool_calls pairing invariant OpenAI-strict
 * providers (Cerebras) enforce: a `role: "tool"` message must immediately
 * follow an assistant message carrying the matching `tool-call` id, or the
 * provider rejects the whole request with HTTP 400. `normalizeNativeMessages`
 * repairs orphaned tool messages (history compaction can drop the assistant
 * half) by demoting them to plain user messages, and re-seats paired tool
 * messages that drifted away from their assistant partner, so content survives
 * without breaking the wire contract. Well-formed pairs must pass through
 * untouched — pinned below with the exact (sanitized) evaluator request shape
 * Cerebras spuriously 400'd on 2026-08-07/08.
 */
import { describe, expect, it } from "vitest";
import { __INTERNAL_normalizeNativeMessages } from "../models/text.ts";

/**
 * Asserts the strict-adjacency wire contract: every `role: "tool"` message
 * directly follows either the assistant message announcing all of its
 * tool-call ids or another tool message in the same response block.
 */
function expectStrictToolAdjacency(messages: ReadonlyArray<Record<string, unknown>>): void {
  const announced = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "tool-call" && typeof part.toolCallId === "string") {
          announced.set(part.toolCallId, index);
        }
      }
    }
  });
  messages.forEach((message, index) => {
    if (message.role !== "tool") return;
    const content = message.content as Array<{ toolCallId?: string }>;
    for (const part of content) {
      const announcerIndex = announced.get(part.toolCallId ?? "");
      expect(announcerIndex, `tool_call_id ${part.toolCallId} has an announcer`).toBeDefined();
      // Between the announcer and this tool message only tool messages of the
      // same block may appear.
      for (let i = (announcerIndex ?? 0) + 1; i < index; i++) {
        expect(messages[i]?.role, `message ${i} inside the response block`).toBe("tool");
      }
    }
  });
}

describe("normalizeNativeMessages tool pairing", () => {
  it("passes a well-formed assistant/tool pair through untouched", () => {
    const out = __INTERNAL_normalizeNativeMessages([
      { role: "system", content: "eval" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "tc-1", toolName: "CAL", input: {} }],
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
    expect(out?.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
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

  it("passes the incident-shaped evaluator request through unchanged with strict adjacency", () => {
    // The exact structural shape of the live evaluator request Cerebras
    // intermittently 400'd on 2026-08-07/08 ("Messages with role 'tool' must
    // be a response to a preceeding message with 'tool_calls'"), sanitized:
    // system + user strings, one assistant tool-call part (`tool-1-0`), one
    // matching tool-result part. The request already satisfies the wire
    // contract, so the normalizer must not touch it — the 400 is provider-side
    // and handled by the transient-retry classifier instead.
    const incident = [
      { role: "system", content: "# agent\npersona and evaluator instructions" },
      { role: "user", content: "evaluator context: user asked to remember a fact" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tool-1-0",
            toolName: "MESSAGE",
            input: { action: "list_inbox", folder: "inbox", limit: 1, source: "gmail" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tool-1-0",
            toolName: "MESSAGE",
            output: { type: "text", value: "text: tool completed\ndata: {}" },
          },
        ],
      },
    ];
    const out = __INTERNAL_normalizeNativeMessages(incident);
    expect(out).toEqual(incident);
    expect(out?.some((m) => m.role === "tool")).toBe(true);
    expectStrictToolAdjacency(out as Array<Record<string, unknown>>);
  });

  it("re-seats a paired tool message separated from its assistant partner", () => {
    const out = __INTERNAL_normalizeNativeMessages([
      { role: "system", content: "eval" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "tc-1", toolName: "CAL", input: {} }],
      },
      { role: "user", content: "interleaved compaction note" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-1",
            toolName: "CAL",
            output: { type: "text", value: "created" },
          },
        ],
      },
    ]);
    expect(out?.map((m) => m.role)).toEqual(["system", "assistant", "tool", "user"]);
    expectStrictToolAdjacency(out as Array<Record<string, unknown>>);
  });

  it("re-seats multiple response blocks and demotes the true orphan in one pass", () => {
    const out = __INTERNAL_normalizeNativeMessages([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "tc-1", toolName: "A", input: {} }],
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "tc-2", toolName: "B", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-2",
            toolName: "B",
            output: { type: "text", value: "b" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-1",
            toolName: "A",
            output: { type: "text", value: "a" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "orphan",
            toolName: "C",
            output: { type: "text", value: "orphan result" },
          },
        ],
      },
    ]);
    expect(out?.map((m) => m.role)).toEqual(["assistant", "tool", "assistant", "tool", "user"]);
    expectStrictToolAdjacency(out as Array<Record<string, unknown>>);
    expect(JSON.stringify(out?.[4]?.content)).toContain("orphan result");
  });

  it("demotes a tool message whose ids span two different assistants", () => {
    const out = __INTERNAL_normalizeNativeMessages([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "tc-1", toolName: "A", input: {} }],
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "tc-2", toolName: "B", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-1",
            toolName: "A",
            output: { type: "text", value: "a" },
          },
          {
            type: "tool-result",
            toolCallId: "tc-2",
            toolName: "B",
            output: { type: "text", value: "b" },
          },
        ],
      },
    ]);
    // No single announcing assistant — the split result cannot satisfy strict
    // adjacency for both ids, so it survives as user content instead.
    expect(out?.map((m) => m.role)).toEqual(["assistant", "assistant", "user"]);
    expect(JSON.stringify(out?.[2]?.content)).toContain("a");
    expect(JSON.stringify(out?.[2]?.content)).toContain("b");
  });

  it("keeps a paired tool message even when an unrelated orphan is also present", () => {
    const out = __INTERNAL_normalizeNativeMessages([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "tc-2", toolName: "CAL", input: {} }],
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
