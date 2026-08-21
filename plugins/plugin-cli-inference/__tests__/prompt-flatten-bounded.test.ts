/**
 * Load-bearing regression pins for the bounded tool-payload walk in
 * `src/prompt-flatten.ts`.
 *
 * These import the REAL production symbols (`contentToText`, `flattenPrompt`
 * and the exported markers) — no copy of the implementation lives in this file,
 * so deleting or weakening any guard turns the suite red.
 *
 * Two halves:
 *  1. Hostile payloads that threw uncaught out of `flattenPrompt` before the
 *     fix (`RangeError: Maximum call stack size exceeded` on a deep array, a
 *     deep `.content` chain and a self-referential `.content`; `TypeError:
 *     Converting circular structure to JSON` on a cyclic object and on cyclic
 *     tool-call arguments) now flatten to a bounded marker.
 *  2. Ordinary payloads still flatten byte-identically — the guard must not
 *     reject anything the live path accepts today.
 */

import { runInNewContext } from "node:vm";
import type { ChatMessage, ChatMessageContentPart } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  contentToText,
  flattenPrompt,
  TOOL_PAYLOAD_BUDGET_MARKER,
  TOOL_PAYLOAD_CYCLE_MARKER,
  TOOL_PAYLOAD_DEPTH_MARKER,
} from "../src/prompt-flatten";

const toolResult = (output: unknown): ChatMessageContentPart =>
  ({ type: "tool-result", toolName: "WEB_FETCH", output }) as unknown as ChatMessageContentPart;
const toolCall = (input: unknown): ChatMessageContentPart =>
  ({ type: "tool-call", toolName: "WEB_FETCH", input }) as unknown as ChatMessageContentPart;

/** Deep enough that the old recursive walk blew the stack. */
const DEEP = 60_000;

describe("toolOutputToText — hostile tool payloads no longer throw", () => {
  it("bounds a deep array tool output instead of overflowing the stack", () => {
    const deepArray = JSON.parse(`${"[".repeat(DEEP)}1${"]".repeat(DEEP)}`);
    const text = contentToText([toolResult(deepArray)]);
    expect(text).toContain(TOOL_PAYLOAD_DEPTH_MARKER);
  });

  it("bounds a deep `.content` chain instead of overflowing the stack", () => {
    let nested: unknown = { text: "leaf" };
    for (let i = 0; i < DEEP; i += 1) nested = { content: nested };
    const text = contentToText([toolResult(nested)]);
    expect(text).toContain(TOOL_PAYLOAD_DEPTH_MARKER);
  });

  it("cuts a self-referential `.content` back-edge instead of recursing forever", () => {
    const selfReferential: Record<string, unknown> = {};
    selfReferential.content = selfReferential;
    const text = contentToText([toolResult(selfReferential)]);
    expect(text).toContain(TOOL_PAYLOAD_CYCLE_MARKER);
  });

  it("serializes a cyclic tool output instead of throwing from JSON.stringify", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const text = contentToText([toolResult(cyclic)]);
    expect(text).toContain('"a":1');
    expect(text).toContain(TOOL_PAYLOAD_CYCLE_MARKER);
  });

  it("bounds the AI-SDK `{type:'json',value}` tool-result shape", () => {
    // The shape emitted by plugins/plugin-openai/models/text.ts and
    // plugins/plugin-zerollama/utils/ai-sdk-wire.ts: `value` is parsed remote
    // JSON of arbitrary depth, with no string fast-path in the walk.
    const deepJson = JSON.parse(`${'{"a":'.repeat(DEEP)}1${"}".repeat(DEEP)}`);
    const text = contentToText([toolResult({ type: "json", value: deepJson })]);
    expect(text).toContain(TOOL_PAYLOAD_DEPTH_MARKER);
  });

  it("bounds cyclic tool-call arguments carried in the content array", () => {
    const cyclic: Record<string, unknown> = { q: 1 };
    cyclic.self = cyclic;
    const text = contentToText([toolCall(cyclic)]);
    expect(text).toContain(TOOL_PAYLOAD_CYCLE_MARKER);
  });

  it("bounds cyclic arguments carried on `message.toolCalls`", () => {
    const cyclic: Record<string, unknown> = { q: 1 };
    cyclic.self = cyclic;
    const { body } = flattenPrompt({
      messages: [
        {
          role: "assistant",
          content: "narrating",
          toolCalls: [{ name: "WEB_FETCH", arguments: cyclic }],
        } as unknown as ChatMessage,
      ],
    });
    expect(body).toContain(TOOL_PAYLOAD_CYCLE_MARKER);
  });

  it("charges container width so a very wide payload cannot exhaust the walk", () => {
    const wide = { rows: Array.from({ length: 200_000 }, (_, i) => i) };
    const text = contentToText([toolResult(wide)]);
    expect(text).toContain(TOOL_PAYLOAD_BUDGET_MARKER);
  });

  it("keeps the rest of the turn alive when one part is poisoned", () => {
    // The whole point: a poisoned part is replayed on every later generation of
    // the turn, so it must degrade to a marker rather than kill the flatten.
    const selfReferential: Record<string, unknown> = {};
    selfReferential.content = selfReferential;
    const { system, body } = flattenPrompt({
      system: "ROOT",
      messages: [
        { role: "user", content: "turn 1" },
        { role: "tool", content: [toolResult(selfReferential)] } as unknown as ChatMessage,
        { role: "user", content: "turn 2" },
      ],
    });
    expect(system).toContain("ROOT");
    expect(body).toContain("turn 1");
    expect(body).toContain("turn 2");
    expect(body).toContain(TOOL_PAYLOAD_CYCLE_MARKER);
  });

  it("never invokes an accessor on an untrusted payload", () => {
    let invoked = 0;
    const trap = {};
    Object.defineProperty(trap, "value", {
      enumerable: true,
      get() {
        invoked += 1;
        return "pwned";
      },
    });
    const text = contentToText([toolResult(trap)]);
    expect(invoked).toBe(0);
    expect(text).not.toContain("pwned");
  });
});

describe("toolOutputToText — no over-rejection of ordinary payloads", () => {
  it("passes through the shapes the live path already accepts, unchanged", () => {
    expect(contentToText([toolResult("plain fetched text")])).toBe(
      "[tool_result WEB_FETCH: plain fetched text]"
    );
    expect(contentToText([toolResult({ type: "text", value: "hello" })])).toBe(
      "[tool_result WEB_FETCH: hello]"
    );
    expect(contentToText([toolResult({ text: "from .text" })])).toBe(
      "[tool_result WEB_FETCH: from .text]"
    );
    expect(contentToText([toolResult([{ type: "text", value: "a" }, "b"])])).toBe(
      "[tool_result WEB_FETCH: a\nb]"
    );
    expect(contentToText([toolResult({ content: [{ type: "text", value: "n" }] })])).toBe(
      "[tool_result WEB_FETCH: n]"
    );
    expect(contentToText([toolResult({ status: 200, items: ["x", "y"] })])).toBe(
      '[tool_result WEB_FETCH: {"status":200,"items":["x","y"]}]'
    );
    expect(contentToText([toolCall({ url: "https://e.com" })])).toBe(
      '[tool_call WEB_FETCH {"url":"https://e.com"}]'
    );
  });

  it("renders scalars, dates and dropped members exactly as JSON.stringify does", () => {
    const payload = {
      a: null,
      b: true,
      c: 1.5,
      d: -0,
      e: 1e21,
      f: undefined,
      g: new Date("2026-08-21T12:00:00.000Z"),
      h: [1, undefined, 3],
      i: "héllo 🚀 世界",
    };
    expect(contentToText([toolResult(payload)])).toBe(
      `[tool_result WEB_FETCH: ${JSON.stringify(payload)}]`
    );
  });

  it("preserves an honest DAG rather than reporting the second reference as a cycle", () => {
    const shared = { id: "u1", tier: "pro" };
    expect(contentToText([toolResult({ a: shared, b: shared })])).toBe(
      '[tool_result WEB_FETCH: {"a":{"id":"u1","tier":"pro"},"b":{"id":"u1","tier":"pro"}}]'
    );
  });

  it("keeps a large single tool output whole", () => {
    const body = "x".repeat(2 * 1024 * 1024);
    expect(contentToText([toolResult({ type: "text", value: body })])).toBe(
      `[tool_result WEB_FETCH: ${body}]`
    );
  });

  it("keeps an honestly deep (but in-budget) payload whole", () => {
    let nested: unknown = { leaf: true };
    for (let i = 0; i < 40; i += 1) nested = { child: nested };
    expect(contentToText([toolResult(nested)])).toBe(
      `[tool_result WEB_FETCH: ${JSON.stringify(nested)}]`
    );
  });

  const MiB = 1024 * 1024;

  it("charges strings nested in a JSON object against the character budget", () => {
    // Every string on the JSON projection path used to be handed back free, so
    // an object could carry unlimited large fields past the declared char cap
    // while the node budget counted only one node per field.
    const out = contentToText([
      toolResult({ a: "a".repeat(3 * MiB), b: "b".repeat(3 * MiB), c: "c".repeat(3 * MiB) }),
    ]);
    expect(out).toContain(TOOL_PAYLOAD_BUDGET_MARKER);
    expect(out.length).toBeLessThan(9 * MiB);
  });

  it("cannot be made to throw by a getTime override on a Date-shaped payload", () => {
    // `JSON.stringify` reaches the internal slot via the builtin `valueOf`, so
    // the parent path survived this. Direct `object.getTime()` dispatch made it
    // an uncaught throw out of contentToText -> flattenPrompt.
    class EvilTime extends Date {
      getTime(): number {
        throw new Error("attacker code ran");
      }
      toISOString(): string {
        throw new Error("attacker code ran");
      }
    }
    expect(() => contentToText([toolResult({ when: new EvilTime(0) })])).not.toThrow();
    expect(contentToText([toolResult({ when: new EvilTime(0) })])).toBe(
      `[tool_result WEB_FETCH: ${JSON.stringify({ when: new Date(0) })}]`
    );
  });

  it("renders an own __proto__ data property instead of silently dropping it", () => {
    // JSON.parse produces a real own "__proto__" key; plain assignment into the
    // projection hit the Object.prototype setter and the member vanished with
    // no marker.
    const payload = JSON.parse('{"__proto__":{"polluted":1},"keep":2}');
    expect(Object.getOwnPropertyNames(payload)).toContain("__proto__");
    const out = contentToText([toolResult(payload)]);
    expect(out).toBe(`[tool_result WEB_FETCH: ${JSON.stringify(payload)}]`);
    expect(out).toContain("polluted");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("preserves Buffer and URL shape, and still bounds a large Buffer", () => {
    expect(contentToText([toolResult(Buffer.from("hi"))])).toBe(
      '[tool_result WEB_FETCH: {"type":"Buffer","data":[104,105]}]'
    );
    expect(contentToText([toolResult(new URL("https://e.com/x"))])).toBe(
      '[tool_result WEB_FETCH: "https://e.com/x"]'
    );
    // Byte count is charged, so a buffer wider than the node budget is marked
    // rather than materialized into a multi-megabyte index array.
    expect(contentToText([toolResult(Buffer.alloc(200_000))])).toContain(
      TOOL_PAYLOAD_BUDGET_MARKER
    );
  });

  it("renders a cross-realm Date rather than an empty object", () => {
    const CrossRealmDate = runInNewContext("Date") as DateConstructor;
    const value = new CrossRealmDate(0);
    expect(value instanceof Date).toBe(false);
    expect(contentToText([toolResult({ at: value })])).toBe(
      `[tool_result WEB_FETCH: ${JSON.stringify({ at: new Date(0) })}]`
    );
  });

  it("still returns a single oversized body whole, nested or bare", () => {
    // `chargeChars` checks before it charges, so the first oversized body comes
    // back untouched. That contract must hold identically whether the body
    // arrives as a bare string or inside an object.
    const body = "x".repeat(10 * MiB);
    const bare = contentToText([toolResult(body)]);
    const wrapped = contentToText([toolResult({ body })]);
    expect(bare).not.toContain(TOOL_PAYLOAD_BUDGET_MARKER);
    expect(bare).toContain(body);
    expect(wrapped).not.toContain(TOOL_PAYLOAD_BUDGET_MARKER);
    expect(wrapped).toBe(`[tool_result WEB_FETCH: ${JSON.stringify({ body })}]`);
  });
});
