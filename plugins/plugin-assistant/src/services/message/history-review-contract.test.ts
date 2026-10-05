/** Source-review certification must not claim completion of future domain effects. */
import type { JSONSchema } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { withReviewedHistorySelection } from "./history-discovery.ts";

describe("history review completion contract", () => {
  it.each([false, true])(
    "preserves source authorization for nativeRead=%s",
    (nativeRead) => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          completionContext: {
            type: "object",
            properties: {
              complete: { type: "boolean" },
              mode: { type: "string" },
              relevantSourceIds: { type: "array", items: { type: "string" } },
            },
          },
        },
      };
      const original = structuredClone(schema);
      const result = withReviewedHistorySelection(schema, nativeRead, [
        "source:authorized",
      ]);
      const fields = result.properties?.completionContext?.properties;
      expect(fields?.complete?.description).toContain(
        "not completion of future tool work",
      );
      expect(fields?.complete?.description).toContain(
        "never certify unseen content",
      );
      expect(fields?.complete?.enum).toEqual(nativeRead ? [true] : undefined);
      if (nativeRead)
        expect(fields?.relevantSourceIds?.items).toEqual({
          type: "string",
          enum: ["source:authorized"],
        });
      expect(schema).toEqual(original);
    },
  );
});
