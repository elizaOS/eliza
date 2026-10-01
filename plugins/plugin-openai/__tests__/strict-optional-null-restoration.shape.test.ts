/**
 * Strict-tool wire encoding inverse for omitted optionals: forcing every
 * property into wire `required` makes strict providers carry each key, and the
 * model encodes "no value" as an explicit null there. Restoration must drop
 * that artifact before runtime validation, which since #32991 preserves
 * declared nulls instead of treating them as absent. Deterministic unit
 * harness over the exported normalization/restoration internals.
 */

import { validateSchema } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  __INTERNAL_normalizeNativeToolsForCall as normalizeNativeToolsForCall,
  __INTERNAL_restoreRecordArgToolCalls as restoreRecordArgToolCalls,
} from "../models/text";

function makeTool() {
  return [
    {
      type: "function" as const,
      function: {
        name: "MEMORY",
        description: "Manage memory",
        strict: true,
        parameters: {
          type: "object" as const,
          properties: {
            action: { type: "string" as const },
            snapshot: { type: "string" as const },
            marker: { type: "null" as const },
            detail: {
              type: "object" as const,
              properties: {
                label: { type: "string" as const },
                note: { type: "string" as const },
              },
              required: ["label"],
              additionalProperties: false,
            },
          },
          required: ["action"],
          additionalProperties: false as const,
        },
      },
    },
  ];
}

const originalSchema = makeTool()[0].function.parameters;

function restoreWith(input: unknown) {
  const normalized = normalizeNativeToolsForCall(makeTool(), {
    cerebrasMode: false,
  });
  return restoreRecordArgToolCalls(
    [
      {
        type: "tool-call",
        toolCallId: "strict-null-1",
        toolName: "MEMORY",
        input,
      },
    ],
    normalized.recordArgTransformsByTool
  );
}

describe("strict-tool omitted-optional null restoration", () => {
  it("drops explicit nulls at keys the strict wire forced but the caller left optional", () => {
    const restored = restoreWith({
      action: "remember",
      snapshot: null,
      marker: null,
      detail: { label: "fact", note: null },
    });
    // `snapshot` and `detail.note` are plain optionals: the nulls are strict
    // wire artifacts and are dropped. `marker` declares null as a legal value,
    // so its null is a real value and survives (#32991).
    expect(restored?.[0].arguments).toEqual({
      action: "remember",
      marker: null,
      detail: { label: "fact" },
    });
    // The restored args satisfy the ORIGINAL schema that rejected the nulls.
    const errors: string[] = [];
    validateSchema(originalSchema, restored?.[0].arguments, "", errors);
    expect(errors).toEqual([]);
  });

  it("preserves declared-nullable nulls and real values at forced-optional keys", () => {
    const restored = restoreWith({
      action: "remember",
      snapshot: "abc",
      marker: null,
    });
    // `marker` declares null as a legal value (#32991), so it survives;
    // `snapshot` carries a real value, so it is untouched.
    expect(restored?.[0].arguments).toEqual({
      action: "remember",
      snapshot: "abc",
      marker: null,
    });
  });

  it("records no omitted keys when every optional schema admits null", () => {
    const normalized = normalizeNativeToolsForCall(
      [
        {
          type: "function" as const,
          function: {
            name: "NULLABLE",
            strict: true,
            parameters: {
              type: "object" as const,
              properties: {
                action: { type: "string" as const },
                extra: {
                  anyOf: [{ type: "string" as const }, { type: "null" as const }],
                },
              },
              required: ["action"],
              additionalProperties: false as const,
            },
          },
        },
      ],
      { cerebrasMode: false }
    );
    // Nothing needs inversion, so no transform is recorded for the tool.
    expect(normalized.recordArgTransformsByTool.NULLABLE).toBeUndefined();

    const oneOfOnly = normalizeNativeToolsForCall(
      [
        {
          type: "function" as const,
          function: {
            name: "ONEOF_NULLABLE",
            strict: true,
            parameters: {
              type: "object" as const,
              properties: {
                action: { type: "string" as const },
                extra: {
                  oneOf: [{ type: "string" as const }, { type: "null" as const }],
                },
              },
              required: ["action"],
              additionalProperties: false as const,
            },
          },
        },
      ],
      { cerebrasMode: false }
    );
    expect(oneOfOnly.recordArgTransformsByTool.ONEOF_NULLABLE).toBeUndefined();
  });

  it("treats provider-nullable optionals as strict-wire artifacts because core never reads `nullable`", () => {
    // Core's validateSchema has no `nullable` handling, so a null at a
    // `{ nullable: true, type: "string" }` node is rejected at runtime. The
    // strict wire forced that null; restoration must drop it or every call
    // carrying it would fail validation.
    const normalized = normalizeNativeToolsForCall(
      [
        {
          type: "function" as const,
          function: {
            name: "PROVIDER_NULLABLE",
            strict: true,
            parameters: {
              type: "object" as const,
              properties: {
                action: { type: "string" as const },
                extra: { nullable: true, type: "string" as const },
              },
              required: ["action"],
              additionalProperties: false as const,
            },
          },
        },
      ],
      { cerebrasMode: false }
    );
    expect(normalized.recordArgTransformsByTool.PROVIDER_NULLABLE).toEqual([
      { path: "$", omittedKeys: ["extra"] },
    ]);

    const restored = restoreRecordArgToolCalls(
      [
        {
          type: "tool-call",
          toolCallId: "provider-nullable-1",
          toolName: "PROVIDER_NULLABLE",
          input: { action: "remember", extra: null },
        },
      ],
      normalized.recordArgTransformsByTool
    );
    expect(restored?.[0].arguments).toEqual({ action: "remember" });
  });

  it("preserves anyOf-declared nulls while stripping plain-optional artifact nulls", () => {
    // The exact shape core declares in nullable-schema.integration.test.ts:
    // an optional whose nullability is an anyOf branch. #32991 admits that
    // null, so the strict-wire artifact drop must not delete it.
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "SCHEDULE",
          description: "Schedule work",
          strict: true,
          parameters: {
            type: "object" as const,
            properties: {
              action: { type: "string" as const },
              recurrence: {
                anyOf: [
                  { type: "string" as const, enum: ["daily", "weekly"] },
                  { type: "null" as const },
                ],
              },
              note: { type: "string" as const },
            },
            required: ["action"],
            additionalProperties: false as const,
          },
        },
      },
    ];
    const normalized = normalizeNativeToolsForCall(tools, {
      cerebrasMode: false,
    });
    // Only the plain optional `note` is an artifact carrier; `recurrence`
    // admits null, so it is never recorded.
    expect(normalized.recordArgTransformsByTool.SCHEDULE).toEqual([
      { path: "$", omittedKeys: ["note"] },
    ]);

    const restored = restoreRecordArgToolCalls(
      [
        {
          type: "tool-call",
          toolCallId: "anyof-null-1",
          toolName: "SCHEDULE",
          input: { action: "create", recurrence: null, note: null },
        },
      ],
      normalized.recordArgTransformsByTool
    );
    expect(restored?.[0].arguments).toEqual({
      action: "create",
      recurrence: null,
    });
    const errors: string[] = [];
    validateSchema(tools[0].function.parameters, restored?.[0].arguments, "", errors);
    expect(errors).toEqual([]);
  });

  it("restores open-map entries after the omitted-null pass so entry nulls survive", () => {
    // Same-path transform collision: an open-map root records BOTH an
    // omittedKeys pass and an entriesKey restore at `$`. The stable sort keeps
    // push order — omitted nulls drop first, then entries fold in — so an
    // entry whose value is null (a legitimate open-map value) cannot be
    // deleted by the artifact pass even when its key matches an omitted key.
    const normalized = normalizeNativeToolsForCall(
      [
        {
          type: "function" as const,
          function: {
            name: "RECORD",
            description: "Record with arbitrary fields",
            strict: true,
            parameters: {
              type: "object" as const,
              properties: {
                action: { type: "string" as const },
                note: { type: "string" as const },
              },
              required: ["action"],
              additionalProperties: { type: "string" as const },
            },
          },
        },
      ],
      { cerebrasMode: false }
    );
    expect(normalized.recordArgTransformsByTool.RECORD).toEqual([
      { path: "$", omittedKeys: ["note"] },
      {
        path: "$",
        entriesKey: "__eliza_record_entries",
        valueMode: "schema",
      },
    ]);

    const restored = restoreRecordArgToolCalls(
      [
        {
          type: "tool-call",
          toolCallId: "same-path-1",
          toolName: "RECORD",
          input: {
            action: "create",
            note: null,
            __eliza_record_entries: [{ key: "note", value: null }],
          },
        },
      ],
      normalized.recordArgTransformsByTool
    );
    // The artifact null at the declared optional is dropped with the sibling,
    // and the entry (same key, null value) is folded back afterwards.
    expect(restored?.[0].arguments).toEqual({
      action: "create",
      note: null,
    });
  });

  it("leaves the Cerebras optional-preserving contract without forced-null transforms", () => {
    const normalized = normalizeNativeToolsForCall(makeTool(), {
      cerebrasMode: true,
    });
    // Cerebras mode keeps original optionality out of `required`, so the
    // provider omits keys instead of encoding nulls; no inversion exists.
    expect(normalized.recordArgTransformsByTool).toEqual({});
  });
});
