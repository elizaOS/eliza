import { describe, expect, test } from "bun:test";
import {
  fieldExistsInSchema,
  formatSchemaForPrompt,
  getAllFieldPaths,
  getAvailableOperations,
  getAvailableResources,
  getTopLevelFields,
  hasOutputSchema,
  loadOutputSchema,
  loadTriggerOutputSchema,
  parseExpressions,
} from "../../src/utils/outputSchema";
import type { SchemaContent } from "../../src/types/index";

const mockMessageSchema: SchemaContent = {
  type: "object",
  properties: {
    id: { type: "string" },
    subject: { type: "string" },
    from: {
      type: "object",
      properties: {
        text: { type: "string" },
        value: {
          type: "array",
          items: {
            type: "object",
            properties: {
              address: { type: "string" },
              name: { type: "string" },
            },
          },
        },
      },
    },
    labelIds: {
      type: "array",
      items: { type: "string" },
    },
  },
};

describe("catalog-backed schema lookup", () => {
  test("returns no schemas when the trimmed embedded catalog has no captured schema files", () => {
    expect(hasOutputSchema("p1p3s-nodes-base.httpRequest")).toBe(false);
    expect(loadOutputSchema("p1p3s-nodes-base.httpRequest", "request", "send")).toBeNull();
    expect(loadTriggerOutputSchema("p1p3s-nodes-base.scheduleTrigger")).toBeNull();
    expect(getAvailableResources("p1p3s-nodes-base.httpRequest")).toEqual([]);
    expect(getAvailableOperations("p1p3s-nodes-base.httpRequest", "request")).toEqual([]);
  });

  test("returns null for simple=false trigger schemas before checking catalog data", () => {
    expect(loadTriggerOutputSchema("p1p3s-nodes-base.webhook", { simple: false })).toBeNull();
  });
});

describe("schema helpers", () => {
  test("extracts top-level field names", () => {
    const fields = getTopLevelFields(mockMessageSchema);
    expect(fields).toContain("id");
    expect(fields).toContain("subject");
    expect(fields).toContain("from");
    expect(fields).toContain("labelIds");
  });

  test("returns empty array for schema without properties", () => {
    expect(getTopLevelFields({ type: "string" })).toEqual([]);
  });

  test("includes top-level and nested paths", () => {
    const paths = getAllFieldPaths(mockMessageSchema);
    expect(paths).toContain("id");
    expect(paths).toContain("from.value[0].address");
  });

  test("validates nested object and array paths", () => {
    expect(fieldExistsInSchema(["subject"], mockMessageSchema)).toBe(true);
    expect(fieldExistsInSchema(["from", "text"], mockMessageSchema)).toBe(true);
    expect(fieldExistsInSchema(["from", "value", "0", "address"], mockMessageSchema)).toBe(true);
    expect(fieldExistsInSchema(["from", "email"], mockMessageSchema)).toBe(false);
    expect(fieldExistsInSchema([], mockMessageSchema)).toBe(false);
  });

  test("formats schema as prompt-safe field list", () => {
    const formatted = formatSchemaForPrompt(mockMessageSchema);
    expect(formatted).toContain("id: string");
    expect(formatted).toContain("from: object");
    expect(formatted).toContain("from.value: array of objects");
  });

  test("respects maxDepth", () => {
    const formatted = formatSchemaForPrompt(mockMessageSchema, 1);
    expect(formatted).toContain("from: object");
    expect(formatted).not.toContain("from.value[0].address");
  });
});

describe("parseExpressions", () => {
  test("extracts simple $json references", () => {
    const refs = parseExpressions({ message: "{{ $json.subject }}" });
    expect(refs).toHaveLength(1);
    expect(refs[0].field).toBe("subject");
    expect(refs[0].path).toEqual(["subject"]);
  });

  test("extracts nested, named-node, and compound references", () => {
    const refs = parseExpressions({
      to: "{{ $json.from.value[0].address }}",
      named: "{{ $('Source').item.json.subject }}",
      body: "{{ $json.textHtml || $json.textPlain }}",
    });

    expect(refs.map((r) => r.field)).toEqual([
      "from.value[0].address",
      "subject",
      "textHtml",
      "textPlain",
    ]);
  });

  test("extracts from nested parameter objects and arrays", () => {
    const refs = parseExpressions({
      options: {
        fields: ["{{ $json.id }}", { nested: "{{ $json.subject }}" }],
      },
    });

    expect(refs.map((r) => r.paramPath)).toEqual(["options.fields[0]", "options.fields[1].nested"]);
  });

  test("returns empty array for parameters without expressions", () => {
    expect(parseExpressions({ message: "Hello world" })).toEqual([]);
  });
});
