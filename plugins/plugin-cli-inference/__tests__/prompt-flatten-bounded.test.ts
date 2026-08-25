/**
 * Load-bearing regression pins for lossless tool-payload flattening in
 * `src/prompt-flatten.ts`.
 *
 * These import the REAL production symbols (`contentToText`, `flattenPrompt`
 * and the exported error) — no copy of the implementation lives in this file,
 * so deleting or weakening any guard turns the suite red.
 *
 * Two halves:
 *  1. Payloads that cannot be represented losslessly fail with a typed error.
 *  2. Every valid payload, including large and wide values, remains complete.
 */

import { runInNewContext } from "node:vm";
import type { ChatMessage, ChatMessageContentPart } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  contentToText,
  flattenPrompt,
  PromptPayloadSerializationError,
} from "../src/prompt-flatten";

const toolResult = (output: unknown): ChatMessageContentPart =>
  ({ type: "tool-result", toolName: "WEB_FETCH", output }) as unknown as ChatMessageContentPart;
const toolCall = (input: unknown): ChatMessageContentPart =>
  ({ type: "tool-call", toolName: "WEB_FETCH", input }) as unknown as ChatMessageContentPart;

/** Deep enough that the old recursive walk blew the stack. */
const DEEP = 60_000;

describe("toolOutputToText — unsafe payloads fail explicitly", () => {
  it("rejects a stack-exhausting deep array without substituting a marker", () => {
    const deepArray = JSON.parse(`${"[".repeat(DEEP)}1${"]".repeat(DEEP)}`);
    expect(() => contentToText([toolResult(deepArray)])).toThrow(PromptPayloadSerializationError);
  });

  it("rejects a stack-exhausting deep content chain", () => {
    let nested: unknown = { text: "leaf" };
    for (let i = 0; i < DEEP; i += 1) nested = { content: nested };
    expect(() => contentToText([toolResult(nested)])).toThrow(PromptPayloadSerializationError);
  });

  it("rejects a self-referential content back-edge", () => {
    const selfReferential: Record<string, unknown> = {};
    selfReferential.content = selfReferential;
    expect(() => contentToText([toolResult(selfReferential)])).toThrow(
      PromptPayloadSerializationError
    );
  });

  it("rejects a cyclic tool output", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => contentToText([toolResult(cyclic)])).toThrow(PromptPayloadSerializationError);
  });

  it("rejects a stack-exhausting AI-SDK `{type:'json',value}` payload", () => {
    // The shape emitted by plugins/plugin-openai/models/text.ts and
    // plugins/plugin-zerollama/utils/ai-sdk-wire.ts: `value` is parsed remote
    // JSON of arbitrary depth, with no string fast-path in the walk.
    const deepJson = JSON.parse(`${'{"a":'.repeat(DEEP)}1${"}".repeat(DEEP)}`);
    expect(() => contentToText([toolResult({ type: "json", value: deepJson })])).toThrow(
      PromptPayloadSerializationError
    );
  });

  it("rejects cyclic tool-call arguments carried in the content array", () => {
    const cyclic: Record<string, unknown> = { q: 1 };
    cyclic.self = cyclic;
    expect(() => contentToText([toolCall(cyclic)])).toThrow(PromptPayloadSerializationError);
  });

  it("rejects cyclic arguments carried on `message.toolCalls`", () => {
    const cyclic: Record<string, unknown> = { q: 1 };
    cyclic.self = cyclic;
    expect(() =>
      flattenPrompt({
        messages: [
          {
            role: "assistant",
            content: "narrating",
            toolCalls: [{ name: "WEB_FETCH", arguments: cyclic }],
          } as unknown as ChatMessage,
        ],
      })
    ).toThrow(PromptPayloadSerializationError);
  });

  it("preserves a very wide payload", () => {
    const wide = { rows: Array.from({ length: 200_000 }, (_, i) => i) };
    const text = contentToText([toolResult(wide)]);
    expect(text).toBe(`[tool_result WEB_FETCH: ${JSON.stringify(wide)}]`);
  });

  it("rejects the whole turn before dispatch when one part is not lossless", () => {
    const selfReferential: Record<string, unknown> = {};
    selfReferential.content = selfReferential;
    expect(() =>
      flattenPrompt({
        system: "ROOT",
        messages: [
          { role: "user", content: "turn 1" },
          { role: "tool", content: [toolResult(selfReferential)] } as unknown as ChatMessage,
          { role: "user", content: "turn 2" },
        ],
      })
    ).toThrow(PromptPayloadSerializationError);
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
    expect(() => contentToText([toolResult(trap)])).toThrow(PromptPayloadSerializationError);
    expect(invoked).toBe(0);
  });

  it("rejects array accessors without invoking them", () => {
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
    expect(() => contentToText([toolResult({ payload })])).toThrow(PromptPayloadSerializationError);
    expect(() => contentToText([toolResult(payload)])).toThrow(PromptPayloadSerializationError);
    expect(invoked).toBe(0);
  });

  it("rejects Proxy payloads without invoking direct or prototype traps", () => {
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

    for (const payload of [proxy, revocable.proxy, bufferWithProxyPrototype]) {
      expect(() => contentToText([toolResult(payload)])).toThrow(PromptPayloadSerializationError);
    }
    expect(() => contentToText([toolResult({ proxy })])).toThrow(PromptPayloadSerializationError);
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

  it("keeps an honestly deep payload whole", () => {
    let nested: unknown = { leaf: true };
    for (let i = 0; i < 40; i += 1) nested = { child: nested };
    expect(contentToText([toolResult(nested)])).toBe(
      `[tool_result WEB_FETCH: ${JSON.stringify(nested)}]`
    );
  });

  const MiB = 1024 * 1024;

  it("preserves all strings nested in a large JSON object", () => {
    const payload = {
      a: "a".repeat(3 * MiB),
      b: "b".repeat(3 * MiB),
      c: "c".repeat(3 * MiB),
    };
    expect(contentToText([toolResult(payload)])).toBe(
      `[tool_result WEB_FETCH: ${JSON.stringify(payload)}]`
    );
  });

  it("preserves huge property names", () => {
    const bigKey = (char: string): Record<string, number> => {
      const object: Record<string, number> = {};
      object[char.repeat(3 * MiB)] = 1;
      return object;
    };
    const payload = [bigKey("a"), bigKey("b"), bigKey("c")];
    expect(contentToText([toolResult(payload)])).toBe(
      `[tool_result WEB_FETCH: ${payload.map((entry) => JSON.stringify(entry)).join("\n")}]`
    );
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

  it("preserves Buffer and URL shape, including a large Buffer", () => {
    expect(contentToText([toolResult(Buffer.from("hi"))])).toBe(
      '[tool_result WEB_FETCH: {"type":"Buffer","data":[104,105]}]'
    );
    expect(contentToText([toolResult(new URL("https://e.com/x"))])).toBe(
      '[tool_result WEB_FETCH: "https://e.com/x"]'
    );
    const large = Buffer.alloc(200_000);
    expect(contentToText([toolResult(large)])).toBe(
      `[tool_result WEB_FETCH: ${JSON.stringify(large)}]`
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
    // The complete value must hold identically whether it arrives as a bare
    // string or inside an object.
    const body = "x".repeat(10 * MiB);
    const bare = contentToText([toolResult(body)]);
    const wrapped = contentToText([toolResult({ body })]);
    expect(bare).toContain(body);
    expect(wrapped).toBe(`[tool_result WEB_FETCH: ${JSON.stringify({ body })}]`);
  });
});
