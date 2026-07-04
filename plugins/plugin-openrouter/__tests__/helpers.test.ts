import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { extractJsonFromText, handleObjectGenerationError } from "../utils/helpers";

/**
 * extractJsonFromText recovers a JSON object from a model's text completion (raw
 * JSON → ```json fenced block → generic fenced block that looks like an object →
 * first {...} span) and returns `null` on a total miss so an unparseable
 * completion is distinguishable from a legitimately empty `{}`. Deterministic
 * string fixtures — no model call. handleObjectGenerationError must rethrow a
 * typed ElizaError, never fabricate a success-shaped `{ error }`.
 */

describe("extractJsonFromText", () => {
  it("parses a raw JSON object", () => {
    expect(extractJsonFromText('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  it("extracts from a ```json fenced block", () => {
    const text = 'Here you go:\n```json\n{ "ok": true }\n```\nThanks!';
    expect(extractJsonFromText(text)).toEqual({ ok: true });
  });

  it("extracts from a generic fenced block when it looks like an object", () => {
    expect(extractJsonFromText('```\n{"n": 2}\n```')).toEqual({ n: 2 });
  });

  it("falls back to the first brace-delimited span in prose", () => {
    expect(extractJsonFromText('the result is {"value": 42} ok')).toEqual({ value: 42 });
  });

  it("returns null (not a fabricated {}) when no JSON can be recovered", () => {
    expect(extractJsonFromText("no json here at all")).toBeNull();
  });

  it("returns null when a brace span is present but unparseable", () => {
    expect(extractJsonFromText("almost {not: valid json,} really")).toBeNull();
  });
});

describe("handleObjectGenerationError", () => {
  it("rethrows a typed ElizaError preserving the cause, never a fake success", () => {
    const cause = new Error("boom");
    try {
      handleObjectGenerationError(cause);
      expect.unreachable("handleObjectGenerationError must throw");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(ElizaError);
      const err = thrown as ElizaError;
      expect(err.code).toBe("MODEL_OBJECT_GENERATION_FAILED");
      expect(err.message).toContain("boom");
      expect(err.cause).toBe(cause);
    }
  });

  it("wraps a non-Error thrown value", () => {
    expect(() => handleObjectGenerationError("plain")).toThrow(ElizaError);
  });
});
