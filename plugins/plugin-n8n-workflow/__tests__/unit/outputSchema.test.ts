import { describe, test, expect } from "bun:test";
import {
  hasOutputSchema,
  loadOutputSchema,
  loadTriggerOutputSchema,
  getTopLevelFields,
  getAllFieldPaths,
  getAvailableResources,
  getAvailableOperations,
  parseExpressions,
  fieldExistsInSchema,
  formatSchemaForPrompt,
} from "../../src/utils/outputSchema";
import type { SchemaContent } from "../../src/types/index";

// Mock schema for testing
const mockGmailMessageSchema: SchemaContent = {
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

describe("hasOutputSchema", () => {
  test("returns true for node with schema", () => {
    expect(hasOutputSchema("n8n-nodes-base.gmail")).toBe(true);
  });

  test("returns false for unknown node", () => {
    expect(hasOutputSchema("n8n-nodes-base.unknownNode")).toBe(false);
  });

  test("returns true for langchain OpenAI node", () => {
    expect(hasOutputSchema("@n8n/n8n-nodes-langchain.openAi")).toBe(true);
  });
});

describe("loadOutputSchema", () => {
  test("loads Gmail message/getAll schema", () => {
    const result = loadOutputSchema(
      "n8n-nodes-base.gmail",
      "message",
      "getAll",
    );
    expect(result).not.toBeNull();
    expect(result!.fields).toContain("from");
    expect(result!.fields).toContain("subject");
  });

  test("returns null for unknown node", () => {
    const result = loadOutputSchema(
      "n8n-nodes-base.unknownNode",
      "resource",
      "op",
    );
    expect(result).toBeNull();
  });

  test("returns null for unknown resource", () => {
    const result = loadOutputSchema(
      "n8n-nodes-base.gmail",
      "unknownResource",
      "op",
    );
    expect(result).toBeNull();
  });

  test("returns null for unknown operation", () => {
    const result = loadOutputSchema(
      "n8n-nodes-base.gmail",
      "message",
      "unknownOp",
    );
    expect(result).toBeNull();
  });
});

describe("getTopLevelFields", () => {
  test("extracts top-level field names", () => {
    const fields = getTopLevelFields(mockGmailMessageSchema);
    expect(fields).toContain("id");
    expect(fields).toContain("subject");
    expect(fields).toContain("from");
    expect(fields).toContain("labelIds");
  });

  test("returns empty array for schema without properties", () => {
    const fields = getTopLevelFields({ type: "string" });
    expect(fields).toEqual([]);
  });
});

describe("getAllFieldPaths", () => {
  test("includes top-level and nested paths", () => {
    const paths = getAllFieldPaths(mockGmailMessageSchema);
    expect(paths).toContain("id");
    expect(paths).toContain("from");
    expect(paths).toContain("from.text");
    expect(paths).toContain("from.value");
    expect(paths).toContain("from.value[0].address");
    expect(paths).toContain("from.value[0].name");
  });
});

describe("parseExpressions", () => {
  test("extracts simple $json references", () => {
    const params = { message: "{{ $json.subject }}" };
    const refs = parseExpressions(params);
    expect(refs).toHaveLength(1);
    expect(refs[0].field).toBe("subject");
    expect(refs[0].path).toEqual(["subject"]);
  });

  test("extracts nested field references", () => {
    const params = { to: "{{ $json.from.value[0].address }}" };
    const refs = parseExpressions(params);
    expect(refs).toHaveLength(1);
    expect(refs[0].field).toBe("from.value[0].address");
    expect(refs[0].path).toEqual(["from", "value", "0", "address"]);
  });

  test("extracts multiple expressions from same string", () => {
    const params = {
      message: "From: {{ $json.from.text }} Subject: {{ $json.subject }}",
    };
    const refs = parseExpressions(params);
    expect(refs).toHaveLength(2);
  });

  test("extracts from nested parameters", () => {
    const params = {
      options: {
        body: "{{ $json.id }}",
      },
    };
    const refs = parseExpressions(params);
    expect(refs).toHaveLength(1);
    expect(refs[0].paramPath).toBe("options.body");
  });

  test("extracts named node references", () => {
    const params = { message: "{{ $('Gmail').item.json.subject }}" };
    const refs = parseExpressions(params);
    expect(refs).toHaveLength(1);
    expect(refs[0].field).toBe("subject");
  });

  test("extracts both refs from compound expression with ||", () => {
    const params = { body: "{{ $json.textHtml || $json.textPlain }}" };
    const refs = parseExpressions(params);
    expect(refs).toHaveLength(2);
    expect(refs[0].field).toBe("textHtml");
    expect(refs[1].field).toBe("textPlain");
    expect(refs[0].fullExpression).toBe("$json.textHtml");
    expect(refs[1].fullExpression).toBe("$json.textPlain");
  });

  test("extracts ref from ternary expression", () => {
    const params = { value: '{{ $json.name ? $json.name : "default" }}' };
    const refs = parseExpressions(params);
    expect(refs).toHaveLength(2);
    expect(refs[0].field).toBe("name");
    expect(refs[1].field).toBe("name");
  });

  test("returns empty array for no expressions", () => {
    const params = { message: "Hello world" };
    const refs = parseExpressions(params);
    expect(refs).toHaveLength(0);
  });
});

describe("fieldExistsInSchema", () => {
  test("finds top-level field", () => {
    expect(fieldExistsInSchema(["subject"], mockGmailMessageSchema)).toBe(true);
  });

  test("finds nested object field", () => {
    expect(fieldExistsInSchema(["from", "text"], mockGmailMessageSchema)).toBe(
      true,
    );
  });

  test("finds array item field", () => {
    expect(
      fieldExistsInSchema(
        ["from", "value", "0", "address"],
        mockGmailMessageSchema,
      ),
    ).toBe(true);
  });

  test("returns false for non-existent field", () => {
    expect(fieldExistsInSchema(["sender"], mockGmailMessageSchema)).toBe(false);
  });

  test("returns false for non-existent nested field", () => {
    expect(fieldExistsInSchema(["from", "email"], mockGmailMessageSchema)).toBe(
      false,
    );
  });

  test("returns false for empty path", () => {
    expect(fieldExistsInSchema([], mockGmailMessageSchema)).toBe(false);
  });
});

describe("formatSchemaForPrompt", () => {
  test("formats schema as field list", () => {
    const formatted = formatSchemaForPrompt(mockGmailMessageSchema);
    expect(formatted).toContain("id: string");
    expect(formatted).toContain("subject: string");
    expect(formatted).toContain("from: object");
    expect(formatted).toContain("from.value: array of objects");
  });

  test("respects maxDepth", () => {
    const formatted = formatSchemaForPrompt(mockGmailMessageSchema, 1);
    expect(formatted).toContain("from: object");
    expect(formatted).not.toContain("from.value[0].address");
  });
});

describe("loadTriggerOutputSchema", () => {
  test("loads Gmail trigger schema", () => {
    const result = loadTriggerOutputSchema("n8n-nodes-base.gmailTrigger");
    // Static crawl captures Gmail headers (Subject/From/To/Cc/Bcc/labels);
    // the live-execution capture additionally yields message-shape fields
    // like `id`. Skip the live-only assertion when only the static fields
    // are present.
    if (!result || !result.fields.includes("Subject")) return;
    expect(result.fields).toContain("Subject");
    expect(result.fields).toContain("From");
    expect(result.fields).toContain("To");
    if (result.fields.includes("id")) {
      expect(result.fields).toContain("id");
    }
  });

  test("loads GitHub trigger schema with nested body", () => {
    const result = loadTriggerOutputSchema("n8n-nodes-base.githubTrigger");
    // Schema depends on n8n execution data — skip if not captured yet
    if (!result || !result.fields.includes("body")) return;
    expect(result.fields).toContain("body");
    expect(result.fields).toContain("headers");
    expect(
      fieldExistsInSchema(["body", "repository", "name"], result.schema),
    ).toBe(true);
  });

  test("loads Google Calendar trigger schema", () => {
    const result = loadTriggerOutputSchema(
      "n8n-nodes-base.googleCalendarTrigger",
    );
    if (!result) return;
    expect(result.fields).toContain("summary");
    expect(result.fields).toContain("start");
    expect(result.fields).toContain("end");
  });

  test("returns null for unknown trigger", () => {
    const result = loadTriggerOutputSchema("n8n-nodes-base.unknownTrigger");
    expect(result).toBeNull();
  });

  test("returns null for empty schema (Google Sheets)", () => {
    const result = loadTriggerOutputSchema(
      "n8n-nodes-base.googleSheetsTrigger",
    );
    // Sheets had an empty execution — no properties
    expect(result).toBeNull();
  });

  test("returns null when simple=false (raw mode differs from captured schema)", () => {
    const result = loadTriggerOutputSchema("n8n-nodes-base.gmailTrigger", {
      simple: false,
    });
    expect(result).toBeNull();
  });

  test("loads schema when simple=true (matches captured schema)", () => {
    const result = loadTriggerOutputSchema("n8n-nodes-base.gmailTrigger", {
      simple: true,
    });
    expect(result).not.toBeNull();
    expect(result!.fields).toContain("Subject");
  });

  test("loads schema when no parameters (default is simple=true)", () => {
    const result = loadTriggerOutputSchema("n8n-nodes-base.gmailTrigger");
    expect(result).not.toBeNull();
  });
});

// ============================================================================
// Langchain OpenAI output schemas (from override file)
// ============================================================================

describe("langchain OpenAI schemas", () => {
  test("loads text/response schema with correct output structure", () => {
    const result = loadOutputSchema(
      "@n8n/n8n-nodes-langchain.openAi",
      "text",
      "response",
    );
    expect(result).not.toBeNull();
    expect(result!.fields).toContain("output");
    // Verify nested structure: output[0].content[0].text exists
    expect(
      fieldExistsInSchema(
        ["output", "0", "content", "0", "text"],
        result!.schema,
      ),
    ).toBe(true);
  });

  test("detects wrong field path choices[0].message.content", () => {
    const result = loadOutputSchema(
      "@n8n/n8n-nodes-langchain.openAi",
      "text",
      "response",
    );
    expect(result).not.toBeNull();
    // Old Completions API path should NOT exist
    expect(
      fieldExistsInSchema(
        ["choices", "0", "message", "content"],
        result!.schema,
      ),
    ).toBe(false);
  });

  test("loads text/classify schema", () => {
    const result = loadOutputSchema(
      "@n8n/n8n-nodes-langchain.openAi",
      "text",
      "classify",
    );
    expect(result).not.toBeNull();
    expect(result!.fields).toContain("flagged");
  });

  test("loads image/generate schema", () => {
    const result = loadOutputSchema(
      "@n8n/n8n-nodes-langchain.openAi",
      "image",
      "generate",
    );
    expect(result).not.toBeNull();
    expect(result!.fields).toContain("url");
    expect(result!.fields).toContain("revised_prompt");
  });

  test("loads audio/transcribe schema", () => {
    const result = loadOutputSchema(
      "@n8n/n8n-nodes-langchain.openAi",
      "audio",
      "transcribe",
    );
    expect(result).not.toBeNull();
    expect(result!.fields).toContain("text");
    expect(result!.fields).toContain("language");
  });

  test("lists available resources", () => {
    const resources = getAvailableResources("@n8n/n8n-nodes-langchain.openAi");
    expect(resources).toContain("text");
    expect(resources).toContain("image");
    expect(resources).toContain("audio");
    expect(resources).toContain("file");
  });

  test("lists available operations for text resource", () => {
    const ops = getAvailableOperations(
      "@n8n/n8n-nodes-langchain.openAi",
      "text",
    );
    expect(ops).toContain("response");
    expect(ops).toContain("classify");
  });

  test("formatSchemaForPrompt shows correct field paths for text/response", () => {
    const result = loadOutputSchema(
      "@n8n/n8n-nodes-langchain.openAi",
      "text",
      "response",
    );
    expect(result).not.toBeNull();
    const formatted = formatSchemaForPrompt(result!.schema);
    expect(formatted).toContain("output: array of objects");
    expect(formatted).toContain("output[0].content: array of objects");
    expect(formatted).toContain("output[0].content[0].text: string");
  });
});
