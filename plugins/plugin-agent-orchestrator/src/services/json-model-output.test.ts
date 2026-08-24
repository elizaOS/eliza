/**
 * Unit tests for json model output: validates JSON extraction from model replies.
 */
import { describe, expect, it } from "vitest";
import { parseJsonObjectResponse } from "./json-model-output.ts";

describe("json-model-output", () => {
  it("parses pure JSON string directly", () => {
    const raw = '{"status":"ok","score":42}';
    const parsed = parseJsonObjectResponse<{ status: string; score: number }>(
      raw,
    );
    expect(parsed).toEqual({ status: "ok", score: 42 });
  });

  it("extracts JSON object from markdown fences", () => {
    const raw =
      'Here is the response:\n\n```json\n{\n  "decision": "approve"\n}\n```\nDone.';
    const parsed = parseJsonObjectResponse<{ decision: string }>(raw);
    expect(parsed).toEqual({ decision: "approve" });
  });

  it("returns null for malformed or non-object JSON payloads", () => {
    expect(parseJsonObjectResponse("not a json")).toBeNull();
    expect(parseJsonObjectResponse("[1, 2, 3]")).toBeNull();
  });
});
