/**
 * Verifies parseJsonObjectResponse.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import { parseJsonObjectResponse } from "../../src/services/json-model-output.js";

// #9146 — the orchestrator parses JSON objects out of messy LLM output (markdown
// fences, surrounding prose). Pin the extraction + the fail-to-null contract so
// a malformed model reply degrades cleanly instead of throwing.
describe("parseJsonObjectResponse", () => {
  it("parses a bare JSON object", () => {
    expect(parseJsonObjectResponse('{"a":1,"b":"x"}')).toEqual({
      a: 1,
      b: "x",
    });
  });

  it("unwraps a ```json fenced block (and a bare fence)", () => {
    expect(parseJsonObjectResponse('```json\n{"ok":true}\n```')).toEqual({
      ok: true,
    });
    expect(parseJsonObjectResponse('```\n{"n":2}\n```')).toEqual({ n: 2 });
  });

  it("extracts the object from surrounding prose", () => {
    expect(
      parseJsonObjectResponse('Here is the verdict: {"pass":true} — done.'),
    ).toEqual({ pass: true });
  });

  it("returns null for non-object payloads and junk", () => {
    expect(parseJsonObjectResponse('["x","y"]')).toBeNull(); // array, no brace
    expect(parseJsonObjectResponse("no json here")).toBeNull();
    expect(parseJsonObjectResponse("{not valid json}")).toBeNull();
    expect(parseJsonObjectResponse("")).toBeNull();
  });
});
