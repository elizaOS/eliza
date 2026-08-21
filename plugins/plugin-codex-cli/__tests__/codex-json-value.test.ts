/**
 * Deterministic tests for the Codex SSE tool-call JSON type-guard. No live
 * model: the walker is the production isJsonRecord used after JSON.parse of
 * function-call arguments.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  CODEX_JSON_UNBOUNDED,
  isJsonRecord,
  isJsonValue,
  MAX_CODEX_JSON_DEPTH,
  MAX_CODEX_JSON_NODES,
} from "../src/codex-json-value";

function nestArray(depth: number): unknown {
  let value: unknown = "x";
  for (let index = 0; index < depth; index += 1) {
    value = [value];
  }
  return value;
}

function nestJson(depth: number): string {
  let value = '"x"';
  for (let index = 0; index < depth; index += 1) {
    value = `[${value}]`;
  }
  return value;
}

describe("isJsonValue / isJsonRecord", () => {
  it("accepts honest scalars, lists, and nested records", () => {
    expect(isJsonValue("ok")).toBe(true);
    expect(isJsonValue(3)).toBe(true);
    expect(isJsonValue(true)).toBe(true);
    expect(isJsonValue(null)).toBe(true);
    expect(isJsonValue(["1", { b: true }])).toBe(true);
    expect(isJsonRecord({ q: "x" })).toBe(true);
    expect(isJsonRecord(null)).toBe(false);
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(() => "x")).toBe(false);
  });

  it(`accepts a ${MAX_CODEX_JSON_DEPTH}-deep array nest`, () => {
    expect(isJsonValue(nestArray(MAX_CODEX_JSON_DEPTH))).toBe(true);
  });

  it(`throws ${CODEX_JSON_UNBOUNDED} one past depth ${MAX_CODEX_JSON_DEPTH}`, () => {
    try {
      isJsonValue(nestArray(MAX_CODEX_JSON_DEPTH + 1));
      expect.unreachable("parse should fail closed on over-budget depth");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(CODEX_JSON_UNBOUNDED);
    }
  });

  it(`throws ${CODEX_JSON_UNBOUNDED} past ${MAX_CODEX_JSON_NODES} sparse holes`, () => {
    const sparse: unknown[] = [];
    sparse[MAX_CODEX_JSON_NODES] = "x";
    try {
      isJsonValue(sparse);
      expect.unreachable("parse should fail closed on over-budget sparse length");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(CODEX_JSON_UNBOUNDED);
    }
  });

  it("throws on a cyclic record without hanging", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const started = performance.now();
    try {
      isJsonRecord(cyclic);
      expect.unreachable("parse should fail closed on a cycle");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(CODEX_JSON_UNBOUNDED);
    }
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("does not invoke accessors while checking", () => {
    let invoked = 0;
    const hostile = {
      get trap() {
        invoked += 1;
        return "x";
      },
    };
    try {
      isJsonRecord(hostile);
      expect.unreachable("parse should fail closed on enumerable accessors");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(CODEX_JSON_UNBOUNDED);
    }
    expect(invoked).toBe(0);
  });

  it("fails closed on a JSON.parse 8k nest instead of RangeError", () => {
    const parsed = JSON.parse(nestJson(8_000)) as unknown;
    const started = performance.now();
    try {
      isJsonRecord(parsed);
      expect.unreachable("parse should fail closed on an 8k nest");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(CODEX_JSON_UNBOUNDED);
      expect((error as Error).name).not.toBe("RangeError");
    }
    expect(performance.now() - started).toBeLessThan(50);
  });
});
