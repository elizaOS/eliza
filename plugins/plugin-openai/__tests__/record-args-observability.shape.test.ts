/**
 * #12150 option C: the strict-safe schema policy forces `additionalProperties:
 * false` on every tool-parameter object (strict-grammar backends 400 on open
 * maps and strictness is proxy-blind — #11123/#11156), which means a tool that
 * declares a free-form record/map arg (`additionalProperties: true` or a value
 * schema) can no longer emit map keys and the arg arrives empty. That drop used
 * to be SILENT. These tests lock the observability stopgap: behavior is
 * unchanged (still forced to `false`), but the tool path now emits ONE
 * structured warning per offending tool. response_format is intentionally out
 * of scope and must NOT warn.
 */

import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __INTERNAL_normalizeNativeTools as normalizeNativeTools,
  __INTERNAL_sanitizeJsonSchema as sanitizeJsonSchema,
} from "../models/text";

/** Read the closed schema back out of the AI SDK `jsonSchema()` wrapper. */
function schemaOf(toolSet: unknown, name: string): Record<string, unknown> {
  const entry = (toolSet as Record<string, { inputSchema: { jsonSchema: unknown } }>)[name];
  return entry.inputSchema.jsonSchema as Record<string, unknown>;
}

function propOf(schema: Record<string, unknown>, key: string): Record<string, unknown> {
  return (schema.properties as Record<string, Record<string, unknown>>)[key];
}

/** The single argument passed to the last `logger.warn(context, message)` call. */
type WarnContext = {
  tool: string;
  droppedRecordArgs: { path: string; additionalProperties: string }[];
};

describe("#12150 option C — dropped free-form record tool args are observable", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("closes additionalProperties:true AND warns once with structured context", () => {
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

    // (a) No behavior regression: the open map is still closed on the wire.
    const attributes = propOf(schemaOf(toolSet, "save_contact"), "attributes");
    expect(attributes.additionalProperties).toBe(false);

    // (b) The drop is now observable: exactly one structured warning per tool.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [context, message] = warnSpy.mock.calls[0] as [WarnContext, string];
    expect(context.tool).toBe("save_contact");
    expect(context.droppedRecordArgs).toEqual([
      { path: "$.attributes", additionalProperties: "true" },
    ]);
    expect(message).toContain("[OpenAI]");
    expect(message).toContain("save_contact");
    expect(message).toContain("#12150");
  });

  it("closes a schema-valued additionalProperties AND warns (kind: schema)", () => {
    const toolSet = normalizeNativeTools([
      {
        name: "update_fields",
        parameters: {
          type: "object",
          properties: {
            customFields: { type: "object", additionalProperties: { type: "string" } },
          },
          required: ["customFields"],
        },
      },
    ]);

    const customFields = propOf(schemaOf(toolSet, "update_fields"), "customFields");
    expect(customFields.additionalProperties).toBe(false);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [context] = warnSpy.mock.calls[0] as [WarnContext, string];
    expect(context.droppedRecordArgs).toEqual([
      { path: "$.customFields", additionalProperties: "schema" },
    ]);
  });

  it("does NOT warn for a plain object that never declared additionalProperties", () => {
    const toolSet = normalizeNativeTools([
      {
        name: "plain_tool",
        parameters: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      },
    ]);

    // Still closed as before — but no spurious open-map warning.
    expect(schemaOf(toolSet, "plain_tool").additionalProperties).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does NOT warn when additionalProperties is explicitly false", () => {
    normalizeNativeTools([
      {
        name: "closed_tool",
        parameters: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
          additionalProperties: false,
        },
      },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns once per tool listing every offending path (deep + nested), not once per node", () => {
    const toolSet = normalizeNativeTools([
      {
        name: "deep_tool",
        parameters: {
          type: "object",
          properties: {
            top: { type: "object", additionalProperties: true },
            list: {
              type: "array",
              items: { type: "object", additionalProperties: { type: "number" } },
            },
          },
          required: ["top", "list"],
        },
      },
    ]);

    // No open map survives to the wire at any depth (behavior unchanged).
    expect(JSON.stringify(schemaOf(toolSet, "deep_tool"))).not.toContain(
      '"additionalProperties":true'
    );

    // ONE warning for the whole tool, enumerating both offending locations.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [context] = warnSpy.mock.calls[0] as [WarnContext, string];
    const paths = context.droppedRecordArgs.map((d) => d.path).sort();
    expect(paths).toEqual(["$.list.items", "$.top"]);
  });

  it("emits one warning per offending tool across multiple tools", () => {
    normalizeNativeTools([
      {
        name: "a",
        parameters: {
          type: "object",
          properties: { m: { type: "object", additionalProperties: true } },
          required: ["m"],
        },
      },
      {
        name: "b",
        parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
      },
      {
        name: "c",
        parameters: {
          type: "object",
          properties: { m: { type: "object", additionalProperties: { type: "string" } } },
          required: ["m"],
        },
      },
    ]);
    // Tools a and c have record args; b does not.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const names = warnSpy.mock.calls.map((c) => (c[0] as WarnContext).tool).sort();
    expect(names).toEqual(["a", "c"]);
  });
});

/**
 * The warning is scoped to TOOL parameters. `sanitizeJsonSchema` runs
 * unconditionally for response_format too, but only the tool path passes a drop
 * collector — a direct call without one must still close the map and must not
 * populate any collector (guards the response_format exclusion in #12150).
 */
describe("#12150 option C — response_format path stays silent", () => {
  it("still closes the map with no collector (response_format shape)", () => {
    const out = sanitizeJsonSchema({
      type: "object",
      properties: { meta: { type: "object", additionalProperties: true } },
      required: ["meta"],
    });
    const meta = (out.properties as Record<string, Record<string, unknown>>).meta;
    expect(meta.additionalProperties).toBe(false);
  });
});
