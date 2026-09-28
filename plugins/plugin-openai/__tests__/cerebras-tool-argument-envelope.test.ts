/** Native transport preserves canonical JSON arguments, validation, and effect boundaries. */
import { type Action, validateToolArgs } from "@elizaos/core";
import { jsonSchema, type ModelMessage, type ToolSet } from "ai";
import { expect, it, vi } from "vitest";
import {
  decodeToolArguments,
  encodeToolArguments,
  envelopeToolSchema,
  prepareCerebrasToolArgumentEnvelope,
  usesCerebrasToolArgumentEnvelope,
} from "../utils/cerebras-tool-argument-envelope";

it.each(["", "plain", "  leading", "trailing ", "LF\n", "CRLF\r\n", "CR\r", '"quoted"', "雪\t "])(
  "roundtrips %j without changing canonical input",
  (text) => {
    const original = {
      nested: [text, { record: { value: text } }],
      arguments: { existing: text },
      number: 2,
      boolean: true,
      nil: null,
    };
    const before = structuredClone(original);
    expect(encodeToolArguments(original)).toEqual({ arguments: original });
    expect(decodeToolArguments(encodeToolArguments(original))).toEqual(original);
    expect(original).toEqual(before);
  }
);

it.each([
  null,
  [],
  {},
  { content: "unwrapped" },
  { arguments: null },
  { arguments: [] },
  { arguments: "{}" },
  { arguments: {}, extra: true },
])("rejects malformed envelope %j", (value) => {
  expect(() => decodeToolArguments(value)).toThrow(/Native tool argument envelope/);
});
it.each([new Date(0), new Map([["key", "value"]]), new Set(["value"]), NaN, Infinity])(
  "rejects non-JSON transformed values %j",
  (value) => {
    expect(() => encodeToolArguments({ value })).toThrow(/Native tool argument envelope/);
  }
);
it("rejects accessors without invoking them", () => {
  const getter = vi.fn();
  expect(() =>
    decodeToolArguments(Object.defineProperty({}, "arguments", { enumerable: true, get: getter }))
  ).toThrow();
  expect(() =>
    encodeToolArguments(Object.defineProperty({}, "content", { enumerable: true, get: getter }))
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("rejects array accessors without invoking them", () => {
  const getter = vi.fn(() => "hidden");
  const values = Object.defineProperty([], "0", { enumerable: true, get: getter });
  expect(() => encodeToolArguments({ values })).toThrow(/accessor array/);
  expect(getter).not.toHaveBeenCalled();
});
it.each([
  { values: Array(1) },
  { values: [undefined] },
  { values: Object.assign(["value"], { extra: true }) },
])("rejects sparse or non-JSON arrays %j", ({ values }) => {
  expect(() => encodeToolArguments({ values })).toThrow(/Native tool argument envelope/);
});
it("retains the entire original schema natively, including unions and key constraints", () => {
  const original = {
    type: "object" as const,
    propertyNames: { pattern: " $" },
    properties: {
      content: {
        anyOf: [
          { type: "string" as const, enum: ["x\n"], pattern: "\\n$", minLength: 2 },
          { type: "null" as const },
        ],
      },
      values: { type: "array" as const, items: { type: "string" as const } },
    },
    additionalProperties: { type: "string" as const },
    required: ["content"],
  };
  const before = structuredClone(original);
  expect(envelopeToolSchema(original)).toEqual({
    type: "object",
    properties: { arguments: original },
    required: ["arguments"],
    additionalProperties: false,
  });
  expect(original).toEqual(before);
});
it("scopes the envelope to the exact observed model and official endpoint", () => {
  expect(usesCerebrasToolArgumentEnvelope("https://api.cerebras.ai/v1", "qwen-3.8-27b")).toBe(true);
  for (const [endpoint, model] of [
    ["https://api.openai.com/v1", "qwen-3.8-27b"],
    ["https://proxy.example/v1", "qwen-3.8-27b"],
    ["https://api.cerebras.ai/v1", "gpt-oss-120b"],
    ["http://api.cerebras.ai/v1", "qwen-3.8-27b"],
  ])
    expect(usesCerebrasToolArgumentEnvelope(endpoint, model)).toBe(false);
});
it("validates canonical arguments before approval and execution, including direct hook calls", async () => {
  const execute = vi.fn((input: unknown) => input);
  const needsApproval = vi.fn(() => true);
  const tools = {
    SAVE: {
      inputSchema: jsonSchema(
        {
          type: "object",
          properties: { content: { type: "string", enum: ["x\n"], minLength: 2, pattern: "\\n$" } },
        },
        {
          validate: (value) =>
            (value as { content?: unknown }).content === "x\n"
              ? { success: true, value }
              : { success: false, error: new Error("original constraints") },
        }
      ),
      execute,
      needsApproval,
    },
  } as ToolSet;
  const codec = await prepareCerebrasToolArgumentEnvelope(tools, true);
  const tool = codec.tools?.SAVE;
  if (!tool?.execute) throw new Error("Missing tool");
  const schema = tool.inputSchema as ReturnType<typeof jsonSchema>;
  if (!schema.validate) throw new Error("Missing validator");
  const valid = await schema.validate(encodeToolArguments({ content: "x\n" }));
  if (!valid.success) throw valid.error;
  await (tool.needsApproval as (input: unknown, options: unknown) => Promise<boolean>)(
    valid.value,
    {}
  );
  expect(needsApproval).toHaveBeenCalledWith({ content: "x\n" }, {});
  expect(await tool.execute(valid.value, {} as never)).toEqual({ content: "x\n" });
  expect((await schema.validate({ arguments: { content: "wrong" } })).success).toBe(false);
  await expect(tool.execute({ arguments: { content: "wrong" } }, {} as never)).rejects.toThrow(
    "original constraints"
  );
  expect(execute).toHaveBeenCalledTimes(1);
  expect((await prepareCerebrasToolArgumentEnvelope(tools, false)).tools).toBe(tools);
});
it("rejects executable schemas without original validation", async () => {
  const execute = vi.fn();
  await expect(
    prepareCerebrasToolArgumentEnvelope(
      { SAVE: { inputSchema: jsonSchema({ type: "object" }), execute } },
      true
    )
  ).rejects.toThrow(/original-schema validation/);
  expect(execute).not.toHaveBeenCalled();
});
it("wraps historical native arguments while preserving canonical evidence and tool results", async () => {
  const codec = await prepareCerebrasToolArgumentEnvelope(
    { SAVE: { inputSchema: jsonSchema({ type: "object" }) } },
    true
  );
  const messages: ModelMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "c", toolName: "SAVE", input: { content: "x\n" } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c",
          toolName: "SAVE",
          output: { type: "text", value: "Saved x\n" },
        },
      ],
    },
  ];
  const before = structuredClone(messages);
  expect(codec.encodeMessages(messages)).toEqual([
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "c",
          toolName: "SAVE",
          input: { arguments: { content: "x\n" } },
        },
      ],
    },
    before[1],
  ]);
  expect(messages).toEqual(before);
  expect(
    codec.decodeCalls([{ toolName: "SAVE", input: { arguments: { content: "x\n" } } }])
  ).toEqual([{ toolName: "SAVE", input: { content: "x\n" } }]);
  expect(() => codec.decodeCalls([null])).toThrow(/Native tool argument envelope/);
});
it("defers SDK callbacks until a complete canonical object validates", async () => {
  const events: unknown[] = [];
  const codec = await prepareCerebrasToolArgumentEnvelope(
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
  await tool.onInputDelta?.({ ...options, inputTextDelta: "partial wrapper" });
  expect(events).toEqual([]);
  await tool.onInputAvailable?.({ ...options, input: { arguments: { content: "x\n" } } });
  expect(events).toEqual([
    ["start", "c"],
    ["delta", JSON.stringify({ content: "x\n" })],
    ["available", { content: "x\n" }],
  ]);
  events.length = 0;
  await expect(
    tool.onInputAvailable?.({ ...options, input: { arguments: {}, extra: true } })
  ).rejects.toThrow();
  expect(events).toEqual([]);
});
it.each([
  [{ enum: ["x\n"] }, "wrong", "x\n"],
  [{ minLength: 2 }, "x", "x\n"],
  [{ pattern: "\\n$" }, "xx", "x\n"],
])("core enforces original canonical constraints %j", async (constraint, rejected, accepted) => {
  const schema = { type: "string" as const, ...constraint };
  const action = {
    name: "SAVE",
    parameters: [{ name: "content", description: "Exact", required: true, schema }],
  } as Action;
  const codec = await prepareCerebrasToolArgumentEnvelope(
    { SAVE: { inputSchema: jsonSchema({ type: "object", properties: { content: schema } }) } },
    true
  );
  const check = (content: unknown) => {
    const calls = codec.decodeCalls([
      { toolName: "SAVE", input: { arguments: { content } } },
    ]) as Array<{ input: unknown }>;
    return validateToolArgs(action, calls[0].input);
  };
  expect(check(rejected).valid).toBe(false);
  expect(check(accepted).valid).toBe(true);
});
it.each(["execute", "needsApproval", "onInputAvailable"] as const)(
  "honors cancellation during validation before %s",
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
    const codec = await prepareCerebrasToolArgumentEnvelope(
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
      true,
      controller.signal
    );
    const tool = codec.tools?.SAVE;
    if (!tool) throw new Error("Missing tool");
    const options = { toolCallId: "c", messages: [], abortSignal: controller.signal };
    const input = { arguments: { content: "x\n" } };
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

it("rebases ordinary local pointers to their original targets without rewriting annotations", () => {
  const source = {
    type: "object" as const,
    $defs: { "a/b~c": { type: "string" as const, enum: ["x\n"] } },
    properties: { content: { $ref: "#/$defs/a~1b~0c" }, self: { $ref: "#" } },
    default: { $ref: "literal data" },
  };
  const before = structuredClone(source);
  const wire = envelopeToolSchema(source);
  const nested = wire.properties?.arguments as typeof source;
  const resolve = (pointer: string): unknown =>
    pointer
      .slice(2)
      .split("/")
      .reduce<unknown>(
        (value, segment) =>
          (value as Record<string, unknown>)[segment.replace(/~1/g, "/").replace(/~0/g, "~")],
        wire
      );
  expect(resolve(nested.properties.content.$ref)).toEqual(source.$defs["a/b~c"]);
  expect(resolve(nested.properties.self.$ref)).toBe(nested);
  expect(nested.default).toEqual(source.default);
  expect(source).toEqual(before);
});
it.each([
  { properties: { child: { $id: "nested", $ref: "#" } } },
  { properties: { child: { $ref: "https://example.invalid/schema" } } },
  { properties: { child: { $dynamicRef: "#node" } } },
])("rejects unsupported resource scopes before dispatch %j", async (source) => {
  await expect(
    prepareCerebrasToolArgumentEnvelope({ SAVE: { inputSchema: jsonSchema(source) } }, true)
  ).rejects.toThrow(/unsupported.*reference/);
});
it("does not interpret annotation values as schema references", () => {
  const schema = { type: "object" as const, default: { $ref: "literal data" } };
  expect(envelopeToolSchema(schema).properties?.arguments).toEqual(schema);
});
