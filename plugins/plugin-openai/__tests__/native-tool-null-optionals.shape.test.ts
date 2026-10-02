/**
 * Strict non-Cerebras native tools require every property on the wire, so
 * lenient providers answer an origin-optional argument with null. Covers the
 * reverse mapping that drops exactly those provider-null "omitted" spellings
 * before the original action schema is re-checked, while preserving null for
 * required-at-origin and nullable-at-origin arguments. Deterministic unit
 * harness over the internal normalize/restore boundary.
 */
import { describe, expect, it } from "vitest";
import {
  __INTERNAL_normalizeNativeToolsForCall as normalizeNativeToolsForCall,
  __INTERNAL_restoreRecordArgToolCalls as restoreRecordArgToolCalls,
} from "../models/text";

function restoreWith(
  parameters: Record<string, unknown>,
  input: unknown,
  options: { cerebrasMode?: boolean } = {}
): Record<string, unknown> {
  const normalized = normalizeNativeToolsForCall(
    [
      {
        name: "PROBE",
        strict: true,
        parameters,
      },
    ],
    options
  );
  const restored = restoreRecordArgToolCalls(
    [
      {
        type: "tool-call",
        toolCallId: "probe-1",
        toolName: "PROBE",
        input,
      },
    ],
    normalized.recordArgTransformsByTool
  );
  if (!restored) throw new Error("expected restored tool calls");
  return restored[0].arguments as Record<string, unknown>;
}

describe("strict-wire provider null for origin-optional arguments", () => {
  it("drops provider null for an origin-optional property", () => {
    const restored = restoreWith(
      {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      { query: "hi", limit: null }
    );
    expect(restored).toEqual({ query: "hi" });
  });

  it("preserves provider null for a required-at-origin property", () => {
    const restored = restoreWith(
      {
        type: "object",
        properties: {
          query: { type: "string" },
          mode: { type: "string" },
        },
        required: ["query", "mode"],
        additionalProperties: false,
      },
      { query: "hi", mode: null }
    );
    expect(restored).toEqual({ query: "hi", mode: null });
  });

  it("preserves provider null for a nullable-at-origin property", () => {
    const restored = restoreWith(
      {
        type: "object",
        properties: {
          query: { type: "string" },
          cursor: { type: ["string", "null"] },
        },
        required: ["query"],
        additionalProperties: false,
      },
      { query: "hi", cursor: null }
    );
    expect(restored).toEqual({ query: "hi", cursor: null });
  });

  it("preserves provider null for a null anyOf branch", () => {
    const restored = restoreWith(
      {
        type: "object",
        properties: {
          query: { type: "string" },
          cursor: {
            anyOf: [{ type: "string" }, { type: "null" }],
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      { query: "hi", cursor: null }
    );
    expect(restored).toEqual({ query: "hi", cursor: null });
  });

  it("strips nulls inside array-item objects alongside the record carrier", () => {
    const restored = restoreWith(
      {
        type: "object",
        properties: {
          operations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string" },
                workThreadId: { type: "string" },
                note: { type: "string" },
              },
              required: ["type"],
              additionalProperties: true,
            },
          },
        },
        required: ["operations"],
        additionalProperties: false,
      },
      {
        operations: [
          {
            type: "create",
            workThreadId: null,
            note: null,
            __eliza_record_entries: [],
          },
        ],
      }
    );
    expect(restored).toEqual({
      operations: [{ type: "create" }],
    });
  });

  it("keeps a nullable-origin null that shares a node with stripped optionals", () => {
    const restored = restoreWith(
      {
        type: "object",
        properties: {
          cursor: { type: ["string", "null"] },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
      { cursor: null, limit: null }
    );
    expect(restored).toEqual({ cursor: null });
  });

  it("registers no null-strip transforms in Cerebras mode", () => {
    const normalized = normalizeNativeToolsForCall(
      [
        {
          name: "PROBE",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              limit: { type: "number" },
            },
            required: ["query"],
          },
        },
      ],
      { cerebrasMode: true }
    );
    expect(normalized.recordArgTransformsByTool.PROBE).toBeUndefined();
  });

  it("does not strip null values restored from record entries", () => {
    const restored = restoreWith(
      {
        type: "object",
        properties: {
          query: { type: "string" },
          bag: { type: "object", additionalProperties: true },
        },
        required: ["query"],
        additionalProperties: false,
      },
      {
        query: "hi",
        bag: { __eliza_record_entries: [{ key: "flags", value: null }] },
      }
    );
    // Entry values are record data, not the all-required wire's "omitted"
    // spelling, so a null entry value survives restore.
    expect(restored).toEqual({
      query: "hi",
      bag: { flags: null },
    });
  });
});
