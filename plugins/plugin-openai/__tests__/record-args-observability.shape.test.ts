/**
 * #13111 selected the strict-safe full fix for free-form record/map tool args:
 * model-facing tool schemas expose declared additionalProperties through a
 * strict key/value entries array, and returned tool-call args are reverse-mapped
 * back to the original object shape before runtime validation.
 */

import { describe, expect, it } from "vitest";
import {
  __INTERNAL_normalizeNativeTools as normalizeNativeTools,
  __INTERNAL_normalizeNativeToolsForCall as normalizeNativeToolsForCall,
  __INTERNAL_restoreRecordArgToolCalls as restoreRecordArgToolCalls,
  __INTERNAL_sanitizeJsonSchema as sanitizeJsonSchema,
} from "../models/text";

const ENTRIES_KEY = "__eliza_record_entries";

/** Read the closed schema back out of the AI SDK `jsonSchema()` wrapper. */
function schemaOf(toolSet: unknown, name: string): Record<string, unknown> {
  const entry = (toolSet as Record<string, { inputSchema: { jsonSchema: unknown } }>)[name];
  return entry.inputSchema.jsonSchema as Record<string, unknown>;
}

function propOf(schema: Record<string, unknown>, key: string): Record<string, unknown> {
  return (schema.properties as Record<string, Record<string, unknown>>)[key];
}

function entriesValueSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const entries = propOf(schema, ENTRIES_KEY);
  const item = entries.items as Record<string, unknown>;
  return propOf(item, "value");
}

describe("#13111 strict-safe record/map tool args", () => {
  it("turns additionalProperties:true into a strict entries array", () => {
    const toolSet = normalizeNativeTools([
      {
        name: "save_contact",
        parameters: {
          type: "object",
          properties: { attributes: { type: "object", additionalProperties: true } },
          required: ["attributes"],
        },
      },
    ]);

    const attributes = propOf(schemaOf(toolSet, "save_contact"), "attributes");
    expect(attributes.additionalProperties).toBe(false);
    expect(attributes.required).toContain(ENTRIES_KEY);
    expect(propOf(attributes, ENTRIES_KEY).type).toBe("array");
    expect(entriesValueSchema(attributes).type).toBe("string");
  });

  it("turns schema-valued additionalProperties into typed entries", () => {
    const toolSet = normalizeNativeTools([
      {
        name: "update_fields",
        parameters: {
          type: "object",
          properties: {
            customFields: { type: "object", additionalProperties: { type: "number" } },
          },
          required: ["customFields"],
        },
      },
    ]);

    const customFields = propOf(schemaOf(toolSet, "update_fields"), "customFields");
    expect(customFields.additionalProperties).toBe(false);
    expect(entriesValueSchema(customFields).type).toBe("number");
  });

  it("leaves plain objects and explicitly closed objects as normal strict objects", () => {
    const toolSet = normalizeNativeTools([
      {
        name: "plain_tool",
        parameters: {
          type: "object",
          properties: {
            plain: { type: "object", properties: { a: { type: "string" } } },
            closed: {
              type: "object",
              properties: { b: { type: "number" } },
              additionalProperties: false,
            },
          },
          required: ["plain", "closed"],
        },
      },
    ]);

    const schema = schemaOf(toolSet, "plain_tool");
    expect(propOf(propOf(schema, "plain"), ENTRIES_KEY)).toBeUndefined();
    expect(propOf(propOf(schema, "closed"), ENTRIES_KEY)).toBeUndefined();
  });

  it("reverse-maps returned entries back to object args before validation", () => {
    const { recordArgTransformsByTool } = normalizeNativeToolsForCall([
      {
        name: "save_contact",
        parameters: {
          type: "object",
          properties: {
            attributes: { type: "object", additionalProperties: true },
            customFields: { type: "object", additionalProperties: { type: "number" } },
          },
          required: ["attributes", "customFields"],
        },
      },
    ]);

    expect(
      restoreRecordArgToolCalls(
        [
          {
            toolName: "save_contact",
            input: {
              attributes: {
                [ENTRIES_KEY]: [
                  { key: "nickname", value: "ally" },
                  { key: "score", value: "42" },
                  { key: "flags", value: '{"vip":true}' },
                ],
              },
              customFields: {
                [ENTRIES_KEY]: [{ key: "weight", value: 12 }],
              },
            },
          },
        ],
        recordArgTransformsByTool
      )
    ).toEqual([
      {
        toolName: "save_contact",
        input: {
          attributes: {
            nickname: "ally",
            score: 42,
            flags: { vip: true },
          },
          customFields: {
            weight: 12,
          },
        },
      },
    ]);
  });

  it("reverse-maps nested record args inside arrays", () => {
    const { recordArgTransformsByTool } = normalizeNativeToolsForCall([
      {
        name: "save_batches",
        parameters: {
          type: "object",
          properties: {
            batches: {
              type: "array",
              items: { type: "object", additionalProperties: { type: "string" } },
            },
          },
          required: ["batches"],
        },
      },
    ]);

    expect(
      restoreRecordArgToolCalls(
        [
          {
            toolName: "save_batches",
            input: {
              batches: [
                { [ENTRIES_KEY]: [{ key: "a", value: "one" }] },
                { [ENTRIES_KEY]: [{ key: "b", value: "two" }] },
              ],
            },
          },
        ],
        recordArgTransformsByTool
      )
    ).toEqual([
      {
        toolName: "save_batches",
        input: {
          batches: [{ a: "one" }, { b: "two" }],
        },
      },
    ]);
  });

  it("reverse-maps a record property literally named items", () => {
    const { recordArgTransformsByTool } = normalizeNativeToolsForCall([
      {
        name: "save_inventory",
        parameters: {
          type: "object",
          properties: {
            items: { type: "object", additionalProperties: { type: "string" } },
          },
          required: ["items"],
        },
      },
    ]);

    expect(
      restoreRecordArgToolCalls(
        [
          {
            toolName: "save_inventory",
            input: {
              items: {
                [ENTRIES_KEY]: [{ key: "sku-1", value: "in-stock" }],
              },
            },
          },
        ],
        recordArgTransformsByTool
      )
    ).toEqual([
      {
        toolName: "save_inventory",
        input: {
          items: {
            "sku-1": "in-stock",
          },
        },
      },
    ]);
  });
});

/**
 * response_format still uses plain schema sanitization: it is not a tool-call
 * contract and has no returned arguments to reverse-map.
 */
describe("response_format schema sanitization stays closed", () => {
  it("still closes a map with no tool transform", () => {
    const out = sanitizeJsonSchema({
      type: "object",
      properties: { meta: { type: "object", additionalProperties: true } },
      required: ["meta"],
    });
    const meta = (out.properties as Record<string, Record<string, unknown>>).meta;
    expect(meta.additionalProperties).toBe(false);
    expect((meta.properties as Record<string, unknown> | undefined)?.[ENTRIES_KEY]).toBeUndefined();
  });
});
