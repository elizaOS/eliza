/** Tests `compressPromptDescription` — filler removal plus protected-span (code/URL/path/SCREAMING_CASE) preservation; vitest, deterministic. */

import { describe, expect, it } from "vitest";
import { compressPromptDescription } from "../src/prompt-compression.js";

/**
 * Punctuation normalization must not split compound tokens: it used to rewrite
 * `\s*[.,]\s*` to "<punct> ", inserting a space into decimals ("2.5" ->
 * "2. 5"), thousands separators ("10,000" -> "10, 000"), and dotted
 * identifiers ("Node.js" -> "Node. js"), corrupting numeric/technical content
 * in model-facing action docs. Only whitespace AROUND punctuation may be
 * normalized; punctuation embedded inside a token must pass through verbatim.
 */
describe("compressPromptDescription punctuation normalization", () => {
  it("preserves decimal numbers", () => {
    expect(compressPromptDescription("Retrieves up to 2.5 MB of data")).toBe(
      "Get up to 2.5 MB of data",
    );
  });

  it("preserves thousands separators", () => {
    expect(compressPromptDescription("Handles up to 10,000 items")).toBe(
      "Handles up to 10,000 items",
    );
  });

  it("preserves dotted identifiers outside protected spans", () => {
    expect(compressPromptDescription("Runs Node.js scripts")).toBe(
      "Runs Node.js scripts",
    );
  });

  it("still normalizes whitespace around sentence punctuation", () => {
    expect(compressPromptDescription("Fetch data , then reply .")).toBe(
      "Fetch data, then reply.",
    );
    expect(compressPromptDescription("First part .  Second part")).toBe(
      "First part. Second part",
    );
  });
});
