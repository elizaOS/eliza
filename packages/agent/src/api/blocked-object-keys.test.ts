/**
 * Deterministic tests for the blocked-object-key walk: prototype-pollution
 * key stripping plus the depth/node/cycle bound that fails closed instead of
 * RangeErroring OpenAI-compat chat JSON. No live model.
 */

import type http from "node:http";
import { ElizaError } from "@elizaos/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  BLOCKED_OBJECT_GRAPH_UNBOUNDED,
  cloneWithoutBlockedObjectKeys,
  hasBlockedObjectKeyDeep,
  MAX_BLOCKED_OBJECT_DEPTH,
  MAX_BLOCKED_OBJECT_NODES,
} from "./blocked-object-keys";
import { type ChatRouteContext, handleChatRoutes } from "./chat-routes";

function nestArray(depth: number): unknown {
  let value: unknown = "leaf";
  for (let index = 0; index < depth; index += 1) {
    value = [value];
  }
  return value;
}

describe("blocked object key sanitization", () => {
  it("detects and removes nested prototype-pollution keys without mutating safe data", () => {
    const hostile = JSON.parse(
      '{"safe":{"value":1},"items":[{"constructor":{"prototype":{"polluted":true}}}],"prototype":"x"}',
    ) as Record<string, unknown>;

    expect(hasBlockedObjectKeyDeep(hostile)).toBe(true);

    const clean = cloneWithoutBlockedObjectKeys(hostile);

    expect(clean).toEqual({
      safe: { value: 1 },
      items: [{}],
    });
    expect(hasBlockedObjectKeyDeep(clean)).toBe(false);
    expect(hostile).toHaveProperty("prototype", "x");
  });

  it("drops or redacts keys per the caller policy while still bounding the walk", () => {
    const parsed = JSON.parse(
      '{"keep":"yes","access_token":"sk-live","nested":{"drop_me":1,"keep":2},"__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;

    const cleaned = cloneWithoutBlockedObjectKeys(parsed, {
      keyAction: (key) =>
        key === "access_token" || key === "drop_me" ? "drop" : "keep",
    });
    expect(cleaned).toEqual({ keep: "yes", nested: { keep: 2 } });

    const redacted = cloneWithoutBlockedObjectKeys(parsed, {
      keyAction: (key) => (key === "access_token" ? "redact" : "keep"),
      redactedValue: "[REDACTED]",
    });
    expect(redacted).toEqual({
      keep: "yes",
      access_token: "[REDACTED]",
      nested: { drop_me: 1, keep: 2 },
    });

    // The policy does not relax the bound.
    let overDeep: unknown = "leaf";
    for (let index = 0; index <= MAX_BLOCKED_OBJECT_DEPTH + 1; index += 1) {
      overDeep = { a: overDeep };
    }
    expect(() =>
      cloneWithoutBlockedObjectKeys(overDeep, { keyAction: () => "keep" }),
    ).toThrowError(
      expect.objectContaining({ code: BLOCKED_OBJECT_GRAPH_UNBOUNDED }),
    );
  });

  it("does not assign __proto__ while cloning hostile parsed JSON", () => {
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":true},"nested":{"ok":true}}',
    ) as Record<string, unknown>;

    const clean = cloneWithoutBlockedObjectKeys(hostile) as Record<
      string,
      unknown
    >;

    expect(Object.hasOwn(clean, "__proto__")).toBe(false);
    expect(clean).toEqual({ nested: { ok: true } });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("fuzzes JSON-compatible values with blocked keys injected at arbitrary leaves", () => {
    fc.assert(
      fc.property(
        // The "legit" value must not itself contain blocked keys, otherwise the
        // sanitizer correctly strips them and clean !== the original value.
        fc.jsonValue().filter((v) => !hasBlockedObjectKeyDeep(v)),
        fc.constantFrom("__proto__", "constructor", "prototype"),
        (value, blockedKey) => {
          const payload = {
            value,
            wrapper: [{ [blockedKey]: { value: "drop me" } }],
          };

          expect(hasBlockedObjectKeyDeep(payload)).toBe(true);
          const clean = cloneWithoutBlockedObjectKeys(payload);
          const cleanValue = cloneWithoutBlockedObjectKeys(value);
          expect(hasBlockedObjectKeyDeep(clean)).toBe(false);
          expect(clean).toEqual({
            value: cleanValue,
            wrapper: [{}],
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  it(`accepts a ${MAX_BLOCKED_OBJECT_DEPTH}-deep nest without blocked keys`, () => {
    const honest = nestArray(MAX_BLOCKED_OBJECT_DEPTH);
    expect(hasBlockedObjectKeyDeep(honest)).toBe(false);
    expect(cloneWithoutBlockedObjectKeys(honest)).toEqual(honest);
  });

  it(`rejects one past depth ${MAX_BLOCKED_OBJECT_DEPTH} without RangeError`, () => {
    const hostile = nestArray(MAX_BLOCKED_OBJECT_DEPTH + 1);
    expect(hasBlockedObjectKeyDeep(hostile)).toBe(true);
    try {
      cloneWithoutBlockedObjectKeys(hostile);
      expect.unreachable("clone should fail closed on over-budget depth");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(BLOCKED_OBJECT_GRAPH_UNBOUNDED);
    }
  });

  it(`rejects a sparse array past ${MAX_BLOCKED_OBJECT_NODES} holes`, () => {
    const sparse: unknown[] = [];
    sparse[MAX_BLOCKED_OBJECT_NODES] = "x";
    expect(hasBlockedObjectKeyDeep(sparse)).toBe(true);
    try {
      cloneWithoutBlockedObjectKeys(sparse);
      expect.unreachable(
        "clone should fail closed on over-budget sparse length",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(BLOCKED_OBJECT_GRAPH_UNBOUNDED);
    }
  });

  it("rejects a cyclic object without hanging", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(hasBlockedObjectKeyDeep(cyclic)).toBe(true);
    try {
      cloneWithoutBlockedObjectKeys(cyclic);
      expect.unreachable("clone should fail closed on a cycle");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(BLOCKED_OBJECT_GRAPH_UNBOUNDED);
    }
  });

  it("does not invoke accessors while walking", () => {
    let invoked = 0;
    const hostile = {
      safe: 1,
      get trap() {
        invoked += 1;
        return { constructor: { prototype: { polluted: true } } };
      },
    };
    expect(hasBlockedObjectKeyDeep(hostile)).toBe(false);
    const clean = cloneWithoutBlockedObjectKeys(hostile);
    expect(invoked).toBe(0);
    expect(clean).toEqual({ safe: 1 });
  });

  it("fails closed without invoking numeric array accessors", () => {
    let invoked = 0;
    const array = ["safe"];
    Object.defineProperty(array, "1", {
      enumerable: true,
      get() {
        invoked += 1;
        return { constructor: { prototype: { polluted: true } } };
      },
    });

    expect(hasBlockedObjectKeyDeep(array)).toBe(true);
    expect(() => cloneWithoutBlockedObjectKeys(array)).toThrowError(
      expect.objectContaining({ code: BLOCKED_OBJECT_GRAPH_UNBOUNDED }),
    );
    expect(invoked).toBe(0);
  });

  it("does not invoke ordinary property traps while walking array elements", () => {
    let invoked = 0;
    const hostile = new Proxy(["safe"], {
      get() {
        invoked += 1;
        throw new Error("ordinary array reads must not run");
      },
      has() {
        invoked += 1;
        throw new Error("array membership checks must not run");
      },
    });

    expect(hasBlockedObjectKeyDeep(hostile)).toBe(false);
    expect(cloneWithoutBlockedObjectKeys(hostile)).toEqual(["safe"]);
    expect(invoked).toBe(0);
  });

  it("accepts a realistic broad chat history", () => {
    const payload = {
      model: "gpt-4.1",
      messages: Array.from({ length: 1_000 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message ${index}`,
      })),
    };

    expect(hasBlockedObjectKeyDeep(payload)).toBe(false);
    expect(cloneWithoutBlockedObjectKeys(payload)).toEqual(payload);
  });

  it("fails closed on a 20k nest instead of throwing RangeError", () => {
    const hostile = nestArray(20_000);
    expect(hasBlockedObjectKeyDeep(hostile)).toBe(true);

    try {
      cloneWithoutBlockedObjectKeys(hostile);
      expect.unreachable("clone should fail closed on a 20k nest");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(BLOCKED_OBJECT_GRAPH_UNBOUNDED);
      expect((error as Error).name).not.toBe("RangeError");
    }
  });

  it("returns the existing OpenAI-compat 400 for a parsed 20k nest", async () => {
    const body = JSON.parse(
      `${"[".repeat(20_000)}${"]".repeat(20_000)}`,
    ) as unknown;
    const responses: Array<{ data: unknown; status?: number }> = [];
    const req = { headers: {} } as http.IncomingMessage;
    const res = {} as http.ServerResponse;

    const handled = await handleChatRoutes({
      req,
      res,
      method: "POST",
      pathname: "/v1/chat/completions",
      readJsonBody: async <T extends object>() => body as T,
      json: (_response, data, status) => responses.push({ data, status }),
      error: () => expect.unreachable("blocked input uses the JSON responder"),
      state: {} as ChatRouteContext["state"],
    });

    expect(handled).toBe(true);
    expect(responses).toEqual([
      {
        data: {
          error: {
            message: "Request body contains a blocked object key",
            type: "invalid_request_error",
          },
        },
        status: 400,
      },
    ]);
  });
});
