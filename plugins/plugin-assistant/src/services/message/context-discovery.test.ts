/** Verifies enumerable reference schemas match discovery validation without
 * changing custom field contracts or the original registry schema. */
import { describe, expect, it } from "vitest";
import type {
  GenerateTextResult,
  JSONSchema,
} from "../../../../../packages/core/src/types/model.ts";
import {
  createContextReadTool,
  extractContextRead,
  readContextRequests,
  withAvailableContextRequests,
} from "./context-discovery.ts";

describe("native context reads", () => {
  it("preserves the existing response schema and only offers nonempty legal reads", () => {
    const original = withAvailableContextRequests(schema(), new Set(["FACTS"]));
    const before = structuredClone(original);
    expect(createContextReadTool(original)?.parameters).toMatchObject({
      additionalProperties: false,
      properties: {
        contextRequests: {
          minItems: 1,
          items: { type: "string", enum: ["FACTS"] },
        },
      },
      required: ["contextRequests"],
    });
    expect(original).toEqual(before);
    expect(
      createContextReadTool(withAvailableContextRequests(schema(), new Set())),
    ).toBeUndefined();
  });
  it("extracts a read without treating accompanying prose as a reply", () => {
    const raw = {
      text: "This must not be delivered",
      toolCalls: [
        {
          id: "read-context",
          name: "READ_CONTEXT",
          arguments: { contextRequests: ["FACTS"] },
        },
      ],
    } as GenerateTextResult;
    expect(extractContextRead(raw, true)).toEqual({
      contextRequests: ["FACTS"],
    });
    expect(() => extractContextRead(raw, false)).toThrow();
    expect(
      extractContextRead('{"contextRequests":["FACTS"]}', true),
    ).toBeUndefined();
  });
  it.each([
    {},
    { contextRequests: [] },
    { contextRequests: [42] },
    { contextRequests: ["FACTS"], replyText: "Unaccepted draft" },
  ])(
    "rejects malformed read arguments without producing a ready decision: %j",
    (input) => {
      expect(() =>
        extractContextRead(
          {
            toolCalls: [
              { id: "read-context", name: "READ_CONTEXT", arguments: input },
            ],
          } as GenerateTextResult,
          true,
        ),
      ).toThrow();
    },
  );
});

function schema(): JSONSchema & { properties: Record<string, JSONSchema> } {
  return {
    type: "object",
    required: ["contextRequests", "replyText"],
    properties: {
      contextRequests: {
        type: "array",
        items: { type: "string" },
        description: "Read complete authorized references.",
      },
      replyText: { type: "string" },
    },
  };
}

describe("enumerable context request schema", () => {
  it("keeps every current reference and excludes unavailable or loaded names", () => {
    const original = schema();
    const before = structuredClone(original);
    const available = new Set(["FACTS", "CONTEXT_CATALOG", "custom:provider"]);
    const projected = withAvailableContextRequests(original, available);
    expect(projected.properties?.contextRequests?.items).toEqual({
      type: "string",
      enum: [...available],
    });
    expect(
      readContextRequests({ contextRequests: [...available] }, available),
    ).toEqual([...available]);
    for (const invalid of ["history:search:Rowan", "history:all", "loaded"])
      expect(() =>
        readContextRequests({ contextRequests: [invalid] }, available),
      ).toThrow();
    expect(original).toEqual(before);
    expect(projected.properties?.replyText).toBe(
      original.properties?.replyText,
    );
    expect(projected.required).toBe(original.required);
  });

  it("permits only the empty read list when no references remain", () => {
    const projected = withAvailableContextRequests(schema(), new Set());
    expect(projected.properties?.contextRequests).toEqual({
      type: "array",
      items: { type: "string" },
      description: "Read complete authorized references.",
      maxItems: 0,
    });
    expect(readContextRequests({ contextRequests: [] }, new Set())).toEqual([]);
    expect(() =>
      readContextRequests({ contextRequests: ["unknown"] }, new Set()),
    ).toThrow();
  });

  it("intersects an authored item enum without broadening it", () => {
    const original = schema();
    original.properties.contextRequests.items = {
      type: "string",
      enum: ["FACTS", "loaded"],
      pattern: "^[A-Z]+$",
    };
    expect(
      withAvailableContextRequests(original, new Set(["FACTS", "OTHER"]))
        .properties?.contextRequests?.items,
    ).toEqual({
      type: "string",
      enum: ["FACTS"],
      pattern: "^[A-Z]+$",
    });
  });

  it.each([
    { type: "string" },
    { type: "array", items: { type: "object" } },
    { type: "array", items: { type: "string" }, enum: [["custom"]] },
  ])("retains custom nonstandard reference contracts: %j", (field) => {
    const original = schema();
    original.properties.contextRequests = field;
    expect(withAvailableContextRequests(original, new Set())).toBe(original);
  });
});
