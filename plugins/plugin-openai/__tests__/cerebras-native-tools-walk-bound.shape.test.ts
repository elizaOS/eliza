/**
 * Production-boundary regressions for Shaw CR on #23159 (head after the
 * prior walker fix). The live Cerebras path is
 * `normalizeNativeToolsForCall` → `sanitizeJsonSchema` →
 * `normalizeSchemaForCerebras`. Tests call that real pipeline (and the
 * `handleTextSmall` model handler that owns it), not a local core wrapper.
 * A typed `CEREBRAS_SCHEMA_UNBOUNDED` throw is the fail-closed gate before
 * provider `generateText` dispatch.
 */
import {
  CEREBRAS_SCHEMA_UNBOUNDED,
  ElizaError,
  type IAgentRuntime,
  isCerebrasSchemaUnbounded,
  MAX_CEREBRAS_SCHEMA_WALK_DEPTH,
  MAX_CEREBRAS_SCHEMA_WALK_NODES,
  MAX_WELL_FORMED_DEPTH,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aiMocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

import {
  handleTextSmall,
  __INTERNAL_normalizeNativeToolsForCall as normalizeNativeToolsForCall,
  __INTERNAL_restoreRecordArgToolCalls as restoreRecordArgToolCalls,
} from "../models/text";

vi.mock("ai", () => ({
  generateText: aiMocks.generateText,
  streamText: aiMocks.streamText,
  jsonSchema: (schema: unknown) => ({ jsonSchema: schema }),
  Output: {
    object: () => ({ name: "object", responseFormat: Promise.resolve({ type: "json" }) }),
    json: () => ({ name: "json", responseFormat: Promise.resolve({ type: "json" }) }),
  },
}));

vi.mock("../providers", () => ({
  createOpenAIClient: () => ({
    chat: (modelName: string) => ({ modelName }),
    responses: (modelName: string) => ({ modelName }),
  }),
}));

function expectUnbounded(error: unknown): ElizaError {
  expect(error).toBeInstanceOf(ElizaError);
  expect(isCerebrasSchemaUnbounded(error)).toBe(true);
  expect((error as ElizaError).code).toBe(CEREBRAS_SCHEMA_UNBOUNDED);
  expect(error).not.toBeInstanceOf(TypeError);
  expect(error).not.toBeInstanceOf(RangeError);
  return error as ElizaError;
}

function callStrictCerebras(schema: unknown) {
  return normalizeNativeToolsForCall([{ name: "probe", strict: true, parameters: schema }], {
    cerebrasMode: true,
  });
}

function deepProperties(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < depth; i++) {
    node = { type: "object", properties: { x: node } };
  }
  return node;
}

function createRuntime(): IAgentRuntime {
  const runtime = {
    character: { name: "Ada", system: "system prompt" },
    emitEvent: vi.fn(),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
    getSetting: vi.fn(() => undefined),
  };
  return runtime as unknown as IAgentRuntime;
}

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("OPENAI_SMALL_MODEL", "gpt-oss-120b");
  vi.stubEnv("OPENAI_BASE_URL", "https://api.cerebras.ai/v1");
  vi.stubEnv("ELIZA_PROVIDER", undefined);
  vi.stubEnv("CEREBRAS_API_KEY", undefined);
  aiMocks.generateText.mockResolvedValue({
    text: "ok",
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("normalizeNativeToolsForCall Cerebras walk bound (real caller)", () => {
  it("still closes an honest nested object schema through the real pipeline", () => {
    const result = callStrictCerebras({
      type: "object",
      properties: {
        inner: { type: "object", properties: {}, additionalProperties: false },
      },
      required: ["inner"],
    });
    const tool = (
      result.tools as Record<string, { inputSchema: { jsonSchema: Record<string, unknown> } }>
    ).probe;
    const schema = tool.inputSchema.jsonSchema;
    const inner = (schema.properties as Record<string, Record<string, unknown>>).inner;
    expect(inner.properties).toEqual({});
    expect(inner.additionalProperties).toBe(false);
    expect(aiMocks.generateText).not.toHaveBeenCalled();
  });

  it("fails closed on a cyclic not graph instead of RangeError", () => {
    const cyclic: Record<string, unknown> = { type: "object", properties: {} };
    cyclic.not = cyclic;
    const started = Date.now();
    try {
      callStrictCerebras(cyclic);
      throw new Error("expected unbounded throw");
    } catch (error) {
      expect(Date.now() - started).toBeLessThan(250);
      const typed = expectUnbounded(error);
      expect(typed.context?.cycle).toBe(true);
      expect(aiMocks.generateText).not.toHaveBeenCalled();
    }
  });

  it("fails closed on a JSON.parse-legal over-deep properties nest", () => {
    const depth = 8000;
    let raw = '{"type":"string"}';
    for (let i = 0; i < depth; i++) {
      raw = `{"type":"object","properties":{"x":${raw}}}`;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const started = Date.now();
    try {
      callStrictCerebras(parsed);
      throw new Error("expected unbounded throw");
    } catch (error) {
      expect(Date.now() - started).toBeLessThan(250);
      const typed = expectUnbounded(error);
      // The bounded transport clone runs first and uses the same schema-level
      // depth accounting as the normalizer, so the budget reported is the same.
      expect(typed.context?.max).toBe(MAX_CEREBRAS_SCHEMA_WALK_DEPTH);
      expect(typed.context?.clone).toBe(true);
      expect(aiMocks.generateText).not.toHaveBeenCalled();
    }
  });

  it("fails closed on an enumerable getter instead of invoking it", () => {
    const hostile: Record<string, unknown> = { type: "object" };
    Object.defineProperty(hostile, "properties", {
      enumerable: true,
      get() {
        throw new Error("getter invoked");
      },
    });
    try {
      callStrictCerebras(hostile);
      throw new Error("expected unbounded throw");
    } catch (error) {
      const typed = expectUnbounded(error);
      expect(typed.context?.accessor).toBe(true);
      expect((typed as Error).message).not.toContain("getter invoked");
      expect(aiMocks.generateText).not.toHaveBeenCalled();
    }
  });

  it("wraps a revoked Array Proxy as typed unbounded instead of TypeError", () => {
    const { proxy, revoke } = Proxy.revocable([] as unknown[], {});
    revoke();
    try {
      callStrictCerebras(proxy);
      throw new Error("expected unbounded throw");
    } catch (error) {
      const typed = expectUnbounded(error);
      expect(typed.cause).toBeInstanceOf(TypeError);
      expect(aiMocks.generateText).not.toHaveBeenCalled();
    }
  });

  it("does not execute get/has/prototype traps on an honest object Proxy", () => {
    const target = {
      type: "object",
      properties: { x: { type: "string" } },
    };
    let getHits = 0;
    let hasHits = 0;
    let protoHits = 0;
    const proxy = new Proxy(target, {
      get(t, prop, r) {
        getHits += 1;
        return Reflect.get(t, prop, r);
      },
      has(t, prop) {
        hasHits += 1;
        return Reflect.has(t, prop);
      },
      getPrototypeOf(t) {
        protoHits += 1;
        return Reflect.getPrototypeOf(t);
      },
    });
    const result = callStrictCerebras(proxy);
    const tool = (
      result.tools as Record<string, { inputSchema: { jsonSchema: Record<string, unknown> } }>
    ).probe;
    expect(tool.inputSchema.jsonSchema.type).toBe("object");
    expect(getHits).toBe(0);
    expect(hasHits).toBe(0);
    expect(protoHits).toBe(0);
    expect(aiMocks.generateText).not.toHaveBeenCalled();
  });

  it("accepts an honest DAG that reuses the same schema object under two properties", () => {
    const shared = { type: "string" };
    const result = callStrictCerebras({
      type: "object",
      properties: { a: shared, b: shared },
    });
    const tool = (
      result.tools as Record<string, { inputSchema: { jsonSchema: Record<string, unknown> } }>
    ).probe;
    const props = tool.inputSchema.jsonSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.a.type).toBe("string");
    expect(props.b.type).toBe("string");
    expect(aiMocks.generateText).not.toHaveBeenCalled();
  });

  it("walks sparse arrays from own length/index descriptors only", () => {
    const items: unknown[] = [];
    items[0] = { type: "string" };
    items[2] = { type: "number" };
    const result = callStrictCerebras({
      type: "object",
      properties: {
        t: { type: "array", prefixItems: items },
      },
    });
    const tool = (
      result.tools as Record<string, { inputSchema: { jsonSchema: Record<string, unknown> } }>
    ).probe;
    const t = (tool.inputSchema.jsonSchema.properties as Record<string, Record<string, unknown>>).t;
    expect(t.prefixItems).toHaveLength(3);
    expect((t.prefixItems as unknown[])[0]).toMatchObject({ type: "string" });
    expect((t.prefixItems as unknown[])[1]).toBeUndefined();
    expect(1 in (t.prefixItems as unknown[])).toBe(false);
    expect((t.prefixItems as unknown[])[2]).toMatchObject({ type: "number" });
    expect(aiMocks.generateText).not.toHaveBeenCalled();
  });

  it("accepts a schema at the exact depth budget and rejects one step past", () => {
    const atBudget = callStrictCerebras(deepProperties(MAX_CEREBRAS_SCHEMA_WALK_DEPTH));
    const tool = (
      atBudget.tools as Record<string, { inputSchema: { jsonSchema: Record<string, unknown> } }>
    ).probe;
    expect(tool.inputSchema.jsonSchema.type).toBe("object");

    try {
      callStrictCerebras(deepProperties(MAX_CEREBRAS_SCHEMA_WALK_DEPTH + 1));
      throw new Error("expected unbounded throw");
    } catch (error) {
      const typed = expectUnbounded(error);
      // The bounded transport clone runs first and uses the same schema-level
      // depth accounting as the normalizer, so the budget reported is the same.
      expect(typed.context?.max).toBe(MAX_CEREBRAS_SCHEMA_WALK_DEPTH);
      expect(typed.context?.clone).toBe(true);
      expect(aiMocks.generateText).not.toHaveBeenCalled();
    }
  });

  it("fails closed on an over-wide own-key node before cloning", () => {
    const wide: Record<string, unknown> = { type: "object", properties: {} };
    for (let i = 0; i < MAX_CEREBRAS_SCHEMA_WALK_NODES + 1; i++) {
      wide[`k${i}`] = true;
    }
    const started = Date.now();
    try {
      callStrictCerebras(wide);
      throw new Error("expected unbounded throw");
    } catch (error) {
      expect(Date.now() - started).toBeLessThan(2000);
      const typed = expectUnbounded(error);
      expect(typed.context?.maxNodes).toBe(MAX_CEREBRAS_SCHEMA_WALK_NODES);
      expect(aiMocks.generateText).not.toHaveBeenCalled();
    }
  });
});

describe("handleTextSmall Cerebras path never dispatches on unbounded schema", () => {
  it("throws typed unbounded and does not call generateText", async () => {
    const cyclic: Record<string, unknown> = { type: "object", properties: {} };
    cyclic.not = cyclic;
    await expect(
      handleTextSmall(createRuntime(), {
        prompt: "probe",
        tools: [{ name: "probe", strict: true, parameters: cyclic }],
      } as never)
    ).rejects.toSatisfy((error) => {
      expectUnbounded(error);
      return true;
    });
    expect(aiMocks.generateText).not.toHaveBeenCalled();
    expect(aiMocks.streamText).not.toHaveBeenCalled();
  });

  it("throws typed unbounded for revoked proxy and does not call generateText", async () => {
    const { proxy, revoke } = Proxy.revocable({ type: "object", properties: {} }, {});
    revoke();
    await expect(
      handleTextSmall(createRuntime(), {
        prompt: "probe",
        tools: [{ name: "probe", strict: true, parameters: proxy }],
      } as never)
    ).rejects.toSatisfy((error) => {
      expectUnbounded(error);
      return true;
    });
    expect(aiMocks.generateText).not.toHaveBeenCalled();
  });

  it("still reaches generateText for an honest closed schema", async () => {
    await handleTextSmall(createRuntime(), {
      prompt: "probe",
      tools: [
        {
          name: "probe",
          strict: true,
          parameters: {
            type: "object",
            properties: { x: { type: "string" } },
            required: ["x"],
            additionalProperties: false,
          },
        },
      ],
    } as never);
    expect(aiMocks.generateText).toHaveBeenCalledTimes(1);
  });
});

/**
 * Shaw CR at 4854c203: the bounded pre-pass must NOT apply Cerebras closure
 * before `sanitizeJsonSchema` runs, or every declared open map is rewritten to
 * `additionalProperties: false` and the `__eliza_record_entries` reverse
 * transform (#11249) is never built — the model then sees a closed empty
 * object and the argument always arrives empty.
 */
describe("Cerebras mode preserves declared open-map semantics (#11249)", () => {
  it("emits __eliza_record_entries and records the transform for a schema-valued map", () => {
    const result = normalizeNativeToolsForCall(
      [
        {
          name: "probe",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              customFields: { type: "object", additionalProperties: { type: "string" } },
            },
            required: ["customFields"],
          },
        },
      ],
      { cerebrasMode: true }
    );

    const tool = (
      result.tools as Record<string, { inputSchema: { jsonSchema: Record<string, unknown> } }>
    ).probe;
    const customFields = (
      tool.inputSchema.jsonSchema.properties as Record<string, Record<string, unknown>>
    ).customFields;
    const entries = (customFields.properties as Record<string, Record<string, unknown>>)
      .__eliza_record_entries;
    expect(entries).toBeDefined();
    expect(entries.type).toBe("array");
    const entryItem = entries.items as Record<string, Record<string, unknown>>;
    expect(entryItem.properties.key).toMatchObject({ type: "string" });
    expect(entryItem.properties.value).toMatchObject({ type: "string" });
    // Wire contract still closed for the grammar compiler.
    expect(customFields.additionalProperties).toBe(false);
    expect(typeof customFields.description).toBe("string");

    const transforms = result.recordArgTransformsByTool.probe;
    expect(transforms).toEqual([
      { path: "$.customFields", entriesKey: "__eliza_record_entries", valueMode: "schema" },
    ]);
    expect(aiMocks.generateText).not.toHaveBeenCalled();
  });

  it("uses json-string entry values for additionalProperties: true", () => {
    const result = normalizeNativeToolsForCall(
      [
        {
          name: "probe",
          strict: true,
          parameters: {
            type: "object",
            properties: { bag: { type: "object", additionalProperties: true } },
          },
        },
      ],
      { cerebrasMode: true }
    );
    expect(result.recordArgTransformsByTool.probe).toEqual([
      { path: "$.bag", entriesKey: "__eliza_record_entries", valueMode: "json-string" },
    ]);
    expect(aiMocks.generateText).not.toHaveBeenCalled();
  });

  it("restores returned tool-call args through the recorded transform", () => {
    const result = normalizeNativeToolsForCall(
      [
        {
          name: "probe",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              customFields: { type: "object", additionalProperties: { type: "string" } },
            },
          },
        },
      ],
      { cerebrasMode: true }
    );
    const restored = restoreRecordArgToolCalls(
      [
        {
          toolName: "probe",
          input: {
            customFields: {
              __eliza_record_entries: [
                { key: "team", value: "core" },
                { key: "tier", value: "gold" },
              ],
            },
          },
        },
      ],
      result.recordArgTransformsByTool
    ) as Array<{ input: { customFields: Record<string, unknown> } }>;
    expect(restored[0].input.customFields).toEqual({ team: "core", tier: "gold" });
  });

  it("carries the open map all the way to the provider request in handleTextSmall", async () => {
    await handleTextSmall(createRuntime(), {
      prompt: "probe",
      tools: [
        {
          name: "probe",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              customFields: { type: "object", additionalProperties: { type: "string" } },
            },
          },
        },
      ],
    } as never);
    expect(aiMocks.generateText).toHaveBeenCalledTimes(1);
    const call = aiMocks.generateText.mock.calls[0][0] as {
      tools: Record<string, { inputSchema: { jsonSchema: Record<string, unknown> } }>;
    };
    const customFields = (
      call.tools.probe.inputSchema.jsonSchema.properties as Record<string, Record<string, unknown>>
    ).customFields;
    expect(
      (customFields.properties as Record<string, unknown>).__eliza_record_entries
    ).toBeDefined();
  });
});

/**
 * Shaw CR at fb67e329: the pre-pass counted raw object nesting, so a legal
 * `default`/`examples`/extension annotation nested past that raw budget was
 * rejected even though `normalizeSchemaForCerebras` and `sanitizeJsonSchema`
 * never descend into annotation data and accept it. The provider path must
 * keep accepting those schemas.
 */
describe("Cerebras mode accepts deep legal annotation data (real caller)", () => {
  function deepAnnotation(depth: number): Record<string, unknown> {
    let node: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < depth; i++) {
      node = { nested: node };
    }
    return node;
  }

  it("accepts a default annotation nested far past the schema depth budget", () => {
    const annotation = deepAnnotation(MAX_CEREBRAS_SCHEMA_WALK_DEPTH * 2 + 1);
    const result = callStrictCerebras({
      type: "object",
      properties: { x: { type: "string" } },
      default: annotation,
    });
    const tool = (
      result.tools as Record<string, { inputSchema: { jsonSchema: Record<string, unknown> } }>
    ).probe;
    const schema = tool.inputSchema.jsonSchema;
    expect(schema.type).toBe("object");
    // Annotation data survives to the wire unchanged (it is not a stripped
    // strict-unsupported constraint keyword).
    expect(schema.default).toEqual(annotation);
    expect(aiMocks.generateText).not.toHaveBeenCalled();
  });

  it("accepts 20k-deep examples and x- extension annotations", () => {
    const annotation = deepAnnotation(20_000);
    const result = callStrictCerebras({
      type: "object",
      properties: { x: { type: "string" } },
      examples: [annotation],
      "x-vendor": annotation,
    });
    const tool = (
      result.tools as Record<string, { inputSchema: { jsonSchema: Record<string, unknown> } }>
    ).probe;
    expect(tool.inputSchema.jsonSchema["x-vendor"]).toBe(annotation);
    expect(aiMocks.generateText).not.toHaveBeenCalled();
  });

  it("keeps a deep annotation on a nested property and still dispatches", async () => {
    // `handleTextSmall` runs the params through `deepToWellFormedUnicode`,
    // whose own independent MAX_WELL_FORMED_DEPTH cap governs the whole
    // payload. Stay inside it so this test measures the schema pre-pass.
    const annotation = deepAnnotation(MAX_WELL_FORMED_DEPTH - 8);
    await handleTextSmall(createRuntime(), {
      prompt: "probe",
      tools: [
        {
          name: "probe",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              x: { type: "string", default: annotation },
            },
            required: ["x"],
            additionalProperties: false,
          },
        },
      ],
    } as never);
    expect(aiMocks.generateText).toHaveBeenCalledTimes(1);
    const call = aiMocks.generateText.mock.calls[0][0] as {
      tools: Record<string, { inputSchema: { jsonSchema: Record<string, unknown> } }>;
    };
    const x = (
      call.tools.probe.inputSchema.jsonSchema.properties as Record<string, Record<string, unknown>>
    ).x;
    expect(x.default).toEqual(annotation);
  });

  it("leaves the deeper handler ceiling to the pre-existing well-formed cap", async () => {
    // Past MAX_WELL_FORMED_DEPTH the request is rejected by the payload
    // unicode walk that already existed on origin develop, NOT by the Cerebras
    // schema pre-pass. Asserting the code proves the pre-pass is not the party
    // narrowing annotation depth.
    const annotation = deepAnnotation(MAX_WELL_FORMED_DEPTH * 4);
    await expect(
      handleTextSmall(createRuntime(), {
        prompt: "probe",
        tools: [
          {
            name: "probe",
            strict: true,
            parameters: { type: "object", properties: {}, default: annotation },
          },
        ],
      } as never)
    ).rejects.toSatisfy((error) => {
      expect(isCerebrasSchemaUnbounded(error)).toBe(false);
      expect((error as ElizaError).code).not.toBe(CEREBRAS_SCHEMA_UNBOUNDED);
      return true;
    });
    expect(aiMocks.generateText).not.toHaveBeenCalled();
  });
});
