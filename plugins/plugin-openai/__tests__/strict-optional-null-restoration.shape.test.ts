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
    // Nothing needs inversion, so no transform is recorded for the tool.
    expect(normalized.recordArgTransformsByTool.NULLABLE).toBeUndefined();
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
