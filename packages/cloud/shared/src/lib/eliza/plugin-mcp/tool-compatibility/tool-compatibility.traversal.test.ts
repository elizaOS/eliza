/** Adversarial coverage for bounded, prototype-safe JSON Schema traversal. */
import type { IAgentRuntime } from "@elizaos/core";
import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { createMcpToolCompatibilitySync } from "./index";

function compat() {
  const value = createMcpToolCompatibilitySync({
    model: "gemini-2.0-flash",
  } as unknown as IAgentRuntime);
  if (!value) throw new Error("missing compatibility layer");
  return value;
}

function openAiCompat() {
  const value = createMcpToolCompatibilitySync({
    model: "gpt-4o",
  } as unknown as IAgentRuntime);
  if (!value) throw new Error("missing OpenAI compatibility layer");
  return value;
}

function anthropicCompat() {
  const value = createMcpToolCompatibilitySync({
    model: "claude-sonnet-4-5",
  } as unknown as IAgentRuntime);
  if (!value) throw new Error("missing Anthropic compatibility layer");
  return value;
}

describe("schema compatibility traversal", () => {
  it("visits combinators independently of type and every schema container", () => {
    const constrained = { type: "string", minLength: 2 } as JSONSchema7;
    const out = compat().transformToolSchema({
      type: "object",
      allOf: [constrained],
      anyOf: [constrained],
      oneOf: [constrained],
      properties: { direct: constrained },
      definitions: { legacy: constrained },
      $defs: { modern: constrained },
      propertyNames: constrained,
    } as JSONSchema7) as JSONSchema7 & { $defs: Record<string, JSONSchema7> };
    const branches = [
      out.allOf?.[0],
      out.anyOf?.[0],
      out.oneOf?.[0],
      out.properties?.direct,
      out.definitions?.legacy,
      out.$defs.modern,
      out.propertyNames,
    ] as JSONSchema7[];
    for (const branch of branches) {
      expect(branch.minLength).toBeUndefined();
      expect(branch.description).toContain("at least 2 chars");
    }
  });

  it("visits a retained additionalProperties schema", () => {
    const out = openAiCompat().transformToolSchema({
      type: "object",
      additionalProperties: { type: "string", format: "email" },
    });
    const additional = out.additionalProperties as JSONSchema7;
    expect(additional.format).toBeUndefined();
    expect(additional.description).toContain("email");
  });

  it("processes tuple items and contains", () => {
    const out = compat().transformToolSchema({
      type: "array",
      items: [
        { type: "string", maxLength: 0 },
        { type: "number", minimum: 1 },
      ],
      contains: { type: "string", pattern: "x" },
    });
    expect((out.items as JSONSchema7[])[0]?.description).toContain("at most 0 chars");
    expect((out.items as JSONSchema7[])[1]?.description).toContain(">= 1");
    expect((out.contains as JSONSchema7).description).toContain("matches x");
  });

  it("does not invoke accessors while visiting schema arrays or maps", () => {
    let calls = 0;
    const tuple: JSONSchema7[] = [];
    Object.defineProperty(tuple, "0", {
      enumerable: true,
      get() {
        calls += 1;
        return { type: "string", minLength: 1 };
      },
    });
    tuple.length = 1;
    const properties = Object.create(null) as Record<string, JSONSchema7>;
    Object.defineProperty(properties, "secret", {
      enumerable: true,
      get() {
        calls += 1;
        return { type: "string", minLength: 1 };
      },
    });

    const out = compat().transformToolSchema({
      type: "object",
      properties,
      allOf: tuple,
    });

    expect(calls).toBe(0);
    expect(out.allOf).toEqual([]);
    expect(out.properties).toEqual({});
    expect(out.description).toContain("schema array accessor or hole omitted");
    expect(out.description).toContain("schema accessor omitted");
  });

  it("preserves an own __proto__ property without prototype mutation", () => {
    const properties = Object.create(null) as Record<string, JSONSchema7>;
    Object.defineProperty(properties, "__proto__", {
      value: { type: "string", minLength: 1 },
      enumerable: true,
    });
    const out = compat().transformToolSchema({ type: "object", properties });
    expect(Object.getPrototypeOf(out.properties)).toBeNull();
    expect(Object.hasOwn(out.properties ?? {}, "__proto__")).toBe(true);
    const protoSchema = Object.getOwnPropertyDescriptor(out.properties, "__proto__")?.value as
      | JSONSchema7
      | undefined;
    expect(protoSchema?.description).toContain("at least 1 chars");
  });

  it("preserves an own top-level __proto__ keyword as data", () => {
    const schema = Object.create(null) as JSONSchema7;
    Object.defineProperty(schema, "type", { value: "string", enumerable: true });
    Object.defineProperty(schema, "__proto__", {
      value: "sentinel",
      enumerable: true,
    });

    const out = compat().transformToolSchema(schema);
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toBe("sentinel");
  });

  it("cuts cycles into serializable diagnostics and reports a deterministic depth bound", () => {
    const cyclic: JSONSchema7 = { type: "object", properties: {} };
    cyclic.properties!.self = cyclic;
    const cycleOut = compat().transformToolSchema(cyclic);
    const cycleChild = cycleOut.properties?.self;
    expect(cycleChild).toBeDefined();
    expect((cycleChild as JSONSchema7).description).toContain("cyclic schema reference omitted");
    expect(() => JSON.stringify(cycleOut)).not.toThrow();

    let deep: JSONSchema7 = { type: "string", minLength: 1 };
    for (let index = 0; index < 40; index += 1) {
      deep = { allOf: [deep] };
    }
    const bounded = compat().transformToolSchema(deep);
    expect(bounded.description).toContain("traversal depth limit reached");
  });

  it("bounds wide schemas and emits one deterministic node diagnostic", () => {
    const out = compat().transformToolSchema({
      anyOf: Array.from({ length: 10_020 }, () => ({ type: "string" })),
    });
    expect(out.anyOf?.length).toBeLessThanOrEqual(10_000);
    expect(out.description).toBe("[schema compatibility: traversal node limit reached]");
  });

  it("serializes hostile diagnostic values without hooks, cycles, or order drift", () => {
    let getterCalls = 0;
    let toJsonCalls = 0;
    const hostile = Object.create(null) as Record<string, unknown>;
    hostile.z = 1n;
    hostile.a = Number.POSITIVE_INFINITY;
    Object.defineProperty(hostile, "getter", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "secret";
      },
    });
    hostile.toJSON = () => {
      toJsonCalls += 1;
      throw new Error("must not run");
    };
    hostile.self = hostile;

    const out = compat().transformToolSchema({
      type: "string",
      enum: [hostile],
    } as unknown as JSONSchema7);
    const description = String(out.description);

    expect(getterCalls).toBe(0);
    expect(toJsonCalls).toBe(0);
    expect(description).toContain('"a":"[non-finite number: Infinity]"');
    expect(description).toContain('"getter":"[accessor omitted]"');
    expect(description).toContain('"self":"[circular]"');
    expect(description).toContain('"z":"[bigint:1]"');
    expect(description.indexOf('"a"')).toBeLessThan(description.indexOf('"z"'));
  });

  it("bounds oversized diagnostic collections and strings", () => {
    const out = compat().transformToolSchema({
      type: "string",
      enum: Array.from({ length: 100 }, (_, index) => `${index}-${"x".repeat(1_000)}`),
    });
    const description = String(out.description);
    expect(description.length).toBeLessThan(4_200);
    expect(description).toContain("diagnostic serialization exceeded 4096 characters");
  });

  it("keeps Anthropic additional-property schema diagnostics hook-free", () => {
    let calls = 0;
    const additional = {
      type: "string",
      toJSON() {
        calls += 1;
        throw new Error("must not run");
      },
    };
    const out = anthropicCompat().transformToolSchema({
      type: "object",
      additionalProperties: additional,
    });

    expect(calls).toBe(0);
    expect(out.additionalProperties).toBeUndefined();
    expect(out.description).toContain('"additionalProperties":');
    expect(out.description).toContain('"toJSON":"[function]"');
  });
});
