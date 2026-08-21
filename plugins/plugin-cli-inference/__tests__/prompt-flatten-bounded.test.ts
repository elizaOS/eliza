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
  TOOL_PAYLOAD_PROXY_MARKER,
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

  it("never invokes array accessors and preserves their positions as null", () => {
    let invoked = 0;
    const payload: unknown[] = [];
    Object.defineProperty(payload, 0, {
      enumerable: true,
      get() {
        invoked += 1;
        return "pwned";
      },
    });
    payload.length = 2;
    expect(contentToText([toolResult({ payload })])).toBe(
      '[tool_result WEB_FETCH: {"payload":[null,null]}]'
    );
    expect(contentToText([toolResult(payload)])).toBe("");
    expect(invoked).toBe(0);
  });

  it("rejects Proxy payloads without invoking traps, including revoked proxies", () => {
    let invoked = 0;
    const proxy = new Proxy(Buffer.from("x"), {
      getPrototypeOf() {
        invoked += 1;
        throw new Error("proxy trap ran");
      },
      ownKeys() {
        invoked += 1;
        throw new Error("proxy trap ran");
      },
    });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const proxyPrototype = new Proxy(Buffer.prototype, {
      getPrototypeOf() {
        invoked += 1;
        throw new Error("prototype-chain trap ran");
      },
    });
    const bufferWithProxyPrototype = Buffer.from("y");
    Object.setPrototypeOf(bufferWithProxyPrototype, proxyPrototype);
    expect(contentToText([toolResult(proxy)])).toContain(TOOL_PAYLOAD_PROXY_MARKER);
    expect(contentToText([toolResult(revocable.proxy)])).toContain(TOOL_PAYLOAD_PROXY_MARKER);
    expect(contentToText([toolResult(bufferWithProxyPrototype)])).toContain(
      TOOL_PAYLOAD_PROXY_MARKER
    );
    expect(contentToText([toolResult({ proxy, revoked: revocable.proxy })])).toContain(
      TOOL_PAYLOAD_PROXY_MARKER
    );
    expect(invoked).toBe(0);
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

  it("pins the depth ceiling at its documented boundary", () => {
    // Without a boundary case the constant is free to drift: raising
    // MAX_TOOL_PAYLOAD_DEPTH from 64 to 1024 left the whole suite green.
    const nest = (levels: number): unknown => {
      let value: unknown = "leaf";
      for (let index = 0; index < levels; index += 1) value = [value];
      return value;
    };
    expect(contentToText([toolResult(nest(64))])).not.toContain(TOOL_PAYLOAD_DEPTH_MARKER);
    expect(contentToText([toolResult(nest(65))])).toContain(TOOL_PAYLOAD_DEPTH_MARKER);
  });

  it("pins the character ceiling on a payload only chargeChars can bound", () => {
    // Array elements carry no property names, so chargeKeyChars cannot mark
    // this one - only the chargeChars check can. Deleting that check used to
    // leave the whole suite green.
    const out = contentToText([
      toolResult(["a".repeat(3 * MiB), "b".repeat(3 * MiB), "c".repeat(3 * MiB)]),
    ]);
    expect(out).toContain(TOOL_PAYLOAD_BUDGET_MARKER);
    expect(out.length).toBeLessThan(9 * MiB);
  });

  it("charges property names, so sibling objects with huge keys are bounded", () => {
    // #23891 charged nested values and dropped the terminal charge that used to
    // account for keys and serialization syntax, which made property names free
    // forever. Reported on that PR by @lalalune; this pins the fix.
    const bigKey = (char: string): Record<string, number> => {
      const object: Record<string, number> = {};
      object[char.repeat(3 * MiB)] = 1;
      return object;
    };
    const out = contentToText([toolResult([bigKey("a"), bigKey("b"), bigKey("c")])]);
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

  it("copies Buffer bytes without consulting payload length or @@iterator", () => {
    let invoked = 0;
    const payload = Buffer.from("hi");
    Object.defineProperties(payload, {
      length: {
        get() {
          invoked += 1;
          throw new Error("length getter ran");
        },
      },
      [Symbol.iterator]: {
        value() {
          invoked += 1;
          throw new Error("iterator ran");
        },
      },
    });
    expect(contentToText([toolResult(payload)])).toBe(
      '[tool_result WEB_FETCH: {"type":"Buffer","data":[104,105]}]'
    );
    expect(invoked).toBe(0);
  });

  it("never consults an attacker-controlled Symbol.toStringTag", () => {
    // `Object.prototype.toString` performs Get(value, @@toStringTag), so brand
    // sniffing on untrusted input could run an attacker getter, or let a plain
    // object claim to be a Date/URL and make the builtin call throw. Reported
    // by @lalalune on #23925; detection now probes the internal slot instead.
    const throwingTag = {};
    Object.defineProperty(throwingTag, Symbol.toStringTag, {
      get() {
        throw new Error("tag getter ran");
      },
    });
    expect(() => contentToText([toolResult({ x: throwingTag })])).not.toThrow();
    expect(() =>
      contentToText([toolResult({ x: { [Symbol.toStringTag]: "Date" } })])
    ).not.toThrow();
    expect(() => contentToText([toolResult({ x: { [Symbol.toStringTag]: "URL" } })])).not.toThrow();
    // An impostor is just a plain object, so it renders as one.
    expect(contentToText([toolResult({ x: { [Symbol.toStringTag]: "Date" } })])).toBe(
      '[tool_result WEB_FETCH: {"x":{}}]'
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
