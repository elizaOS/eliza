/** Native transport preserves original values and rejects malformed encoding before effects. */
import { type Action, validateToolArgs } from "@elizaos/core";
import { jsonSchema, type ModelMessage, type ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  encodeToolStringSchema,
  mapToolStrings,
  prepareCerebrasToolStringCodec,
  usesCerebrasToolStringCodec,
} from "../utils/cerebras-tool-string-codec";

it.each(["", "plain", "  leading", "trailing ", "LF\n", "CRLF\r\n", "CR\r", '"quoted"', "雪\t "])(
  "roundtrips %j once without changing canonical input",
  (text) => {
    const original = {
      nested: [text, { record: { value: text } }],
      number: 2,
      boolean: true,
      nil: null,
    };
    const before = structuredClone(original);
    expect(mapToolStrings(mapToolStrings(original, "encode"), "decode")).toEqual(original);
    expect(original).toEqual(before);
  }
);

it.each(["plain", "123", "null", '["x"]', '"unterminated'])(
  "rejects malformed/nonstring literal %j",
  (value) => {
    expect(() => mapToolStrings({ value }, "decode")).toThrow(/Native tool string transport/);
  }
);

it("keeps nested union, enum, const and record schemas canonical", () => {
  const original = {
    type: "object" as const,
    properties: {
      value: {
        anyOf: [
          { type: "string" as const, enum: ["a\n", ""], minLength: 0, pattern: "^a" },
          { type: "null" as const },
        ],
      },
      array: { type: "array" as const, items: { type: "string" as const } },
      map: { type: "object" as const, additionalProperties: { type: "string" as const } },
      quoted: { type: "string" as const, const: '"x"' },
    },
    required: ["value"],
  };
  const before = structuredClone(original);
  const wire = encodeToolStringSchema(original);
  expect(original).toEqual(before);
  expect(wire).toMatchObject({
    properties: {
      value: {
        anyOf: [
          { enum: ['"a\\n"', '""'], description: expect.stringContaining('"minLength":0') },
          { type: "null" },
        ],
      },
      quoted: { const: '"\\"x\\""' },
    },
  });
});

it("scopes transport to the exact observed model and official endpoint", () => {
  expect(usesCerebrasToolStringCodec("https://api.cerebras.ai/v1", "qwen-3.8-27b")).toBe(true);
  for (const [endpoint, model] of [
    ["https://api.openai.com/v1", "qwen-3.8-27b"],
    ["https://proxy.example/v1", "qwen-3.8-27b"],
    ["https://api.cerebras.ai/v1", "gpt-oss-120b"],
    ["http://api.cerebras.ai/v1", "qwen-3.8-27b"],
  ])
    expect(usesCerebrasToolStringCodec(endpoint, model)).toBe(false);
});

describe("original validation and effects", () => {
  it("decodes before approval/execution and preserves original constraints", async () => {
    const execute = vi.fn((input: unknown) => input);
    const needsApproval = vi.fn(() => true);
    const tools = {
      SAVE: {
        inputSchema: jsonSchema<{ content: string }>(
          {
            type: "object",
            properties: {
              content: { type: "string", enum: ["x\n"], minLength: 2, pattern: "\\n$" },
            },
            required: ["content"],
          },
          {
            validate(value) {
              const content = (value as { content?: unknown }).content;
              return content === "x\n"
                ? { success: true, value: { content } }
                : { success: false, error: new Error("original constraints") };
            },
          }
        ),
        execute,
        needsApproval,
      },
    } as ToolSet;
    const codec = await prepareCerebrasToolStringCodec(tools, true);
    const tool = codec.tools?.SAVE;
    if (!tool?.execute) throw new Error("Missing prepared tool");
    const schema = tool.inputSchema as ReturnType<typeof jsonSchema>;
    if (!schema.validate) throw new Error("Missing codec validator");
    const valid = await schema.validate({ content: JSON.stringify("x\n") });
    expect(valid.success).toBe(true);
    if (!valid.success) throw valid.error;
    expect(
      await (tool.needsApproval as (input: unknown, options: unknown) => boolean)(valid.value, {})
    ).toBe(true);
    expect(needsApproval).toHaveBeenCalledWith({ content: "x\n" }, {});
    expect(await tool.execute(valid.value, {} as never)).toEqual({ content: "x\n" });
    expect((await schema.validate({ content: "unquoted" })).success).toBe(false);
    expect((await schema.validate({ content: JSON.stringify("wrong ") })).success).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(() =>
      codec.decodeCalls([{ toolName: "SAVE", input: { content: "unquoted" } }])
    ).toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await prepareCerebrasToolStringCodec(tools, false)).tools).toBe(tools);
  });

  it("refuses an executable schema without original validation", async () => {
    const execute = vi.fn();
    await expect(
      prepareCerebrasToolStringCodec(
        { UNSAFE: { inputSchema: jsonSchema({ type: "object" }), execute } },
        true
      )
    ).rejects.toThrow(/original-schema validation/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("encodes native call history without rewriting canonical evidence", async () => {
    const codec = await prepareCerebrasToolStringCodec(
      {
        SAVE: {
          inputSchema: jsonSchema({ type: "object", properties: { content: { type: "string" } } }),
        },
      },
      true
    );
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c", toolName: "SAVE", input: { content: "x\n" } },
        ],
      },
    ];
    const before = structuredClone(messages);
    expect(codec.encodeMessages(messages)).toMatchObject([
      { content: [{ input: { content: JSON.stringify("x\n") } }] },
    ]);
    expect(messages).toEqual(before);
    expect(
      codec.decodeCalls([{ toolName: "SAVE", input: { content: JSON.stringify("x\n") } }])
    ).toEqual([{ toolName: "SAVE", input: { content: "x\n" } }]);
  });
});

it("leaves property-name constraints intact and translates untyped string constraints", () => {
  const schema = {
    type: "object" as const,
    propertyNames: { enum: ["literal key "], pattern: " $" },
    dependencies: {
      key: ["other"],
      value: {
        properties: {
          text: { anyOf: [{ pattern: "\\n$", minLength: 2 }, { type: "null" as const }] },
        },
      },
    },
  };
  const wire = encodeToolStringSchema(schema);
  expect(wire.propertyNames).toEqual(schema.propertyNames);
  expect(wire.dependencies).toMatchObject({
    key: ["other"],
    value: {
      properties: {
        text: {
          anyOf: [{ description: expect.stringContaining('"minLength":2') }, { type: "null" }],
        },
      },
    },
  });
  expect(JSON.stringify(wire.dependencies)).not.toContain('"pattern":');
});

it("defers SDK input callbacks until canonical input validates", async () => {
  const events: unknown[] = [];
  const codec = await prepareCerebrasToolStringCodec(
    {
      SAVE: {
        inputSchema: jsonSchema(
          { type: "object" },
          { validate: (value) => ({ success: true, value }) }
        ),
        onInputStart: (options) => {
          events.push(["start", options.toolCallId]);
        },
        onInputDelta: (options) => {
          events.push(["delta", options.inputTextDelta]);
        },
        onInputAvailable: (options) => {
          events.push(["available", options.input]);
        },
      },
    },
    true
  );
  const tool = codec.tools?.SAVE;
  if (!tool) throw new Error("Missing tool");
  const options = { toolCallId: "c", messages: [], abortSignal: new AbortController().signal };
  await tool.onInputStart?.(options);
  await tool.onInputDelta?.({ ...options, inputTextDelta: "encoded partial" });
  expect(events).toEqual([]);
  await tool.onInputAvailable?.({ ...options, input: { content: JSON.stringify("x\n") } });
  expect(events).toEqual([
    ["start", "c"],
    ["delta", JSON.stringify({ content: "x\n" })],
    ["available", { content: "x\n" }],
  ]);
  events.length = 0;
  await tool.onInputStart?.(options);
  await expect(
    tool.onInputAvailable?.({ ...options, input: { content: "malformed" } })
  ).rejects.toThrow();
  expect(events).toEqual([]);
});

it.each([
  [{ enum: ["x\n"] }, "wrong", "x\n"],
  [{ minLength: 2 }, "x", "x\n"],
  [{ pattern: "\\n$" }, "xx", "x\n"],
])(
  "restores arguments before core validates the original constraint %j",
  async (constraint, rejected, accepted) => {
    const originalSchema = { type: "string" as const, ...constraint };
    const action = {
      name: "SAVE",
      description: "Save",
      similes: [],
      examples: [],
      validate: async () => true,
      handler: async () => ({ success: true }),
      parameters: [
        { name: "content", description: "Exact content", required: true, schema: originalSchema },
      ],
    } as Action;
    const source = {
      type: "object" as const,
      properties: { content: originalSchema },
      required: ["content"],
    };
    const before = structuredClone(source);
    const codec = await prepareCerebrasToolStringCodec(
      { SAVE: { inputSchema: jsonSchema(source) } },
      true
    );
    const restore = (content: unknown) => {
      const calls = codec.decodeCalls([
        { toolName: "SAVE", input: { content: JSON.stringify(content) } },
      ]) as Array<{ input: unknown }>;
      return validateToolArgs(action, calls[0].input);
    };
    expect(restore(rejected).valid).toBe(false);
    expect(restore(accepted).valid).toBe(true);
    expect(source).toEqual(before);
  }
);

it.each(["execute", "needsApproval", "onInputAvailable"] as const)(
  "honors abort during validation before %s",
  async (hook) => {
    const controller = new AbortController();
    const effect = vi.fn();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const codec = await prepareCerebrasToolStringCodec(
      {
        SAVE: {
          inputSchema: jsonSchema(
            { type: "object" },
            {
              validate: async (value) => {
                entered();
                await wait;
                return { success: true, value };
              },
            }
          ),
          [hook]: effect,
        },
      },
      true
    );
    const tool = codec.tools?.SAVE;
    if (!tool) throw new Error("Missing tool");
    const options = { toolCallId: "c", messages: [], abortSignal: controller.signal };
    const input = { content: JSON.stringify("x\n") };
    const pending =
      hook === "onInputAvailable"
        ? tool.onInputAvailable?.({ ...options, input })
        : (tool[hook] as (input: unknown, options: unknown) => Promise<unknown>)(input, options);
    await started;
    controller.abort();
    release();
    await expect(pending).rejects.toThrow();
    expect(effect).not.toHaveBeenCalled();
  }
);

it.each([new Date(0), new Map([["key", "value"]]), new Set(["value"]), NaN, Infinity])(
  "rejects non-JSON transformed values %j instead of erasing them",
  (value) => {
    expect(() => mapToolStrings({ value }, "encode")).toThrow(/Native tool string transport/);
  }
);
