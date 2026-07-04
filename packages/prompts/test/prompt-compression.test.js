/**
 * Guards `compressPromptDescription` (a deterministic string transform, no
 * model). The load-bearing invariant: only whitespace *around* punctuation is
 * collapsed, never punctuation inside a token — so decimals ("2.5"), thousands
 * separators ("10,000"), and dotted identifiers ("Node.js") in model-facing
 * action docs survive verbatim rather than being split ("2. 5", "Node. js").
 */
import { describe, expect, it } from "vitest";
import { compressPromptDescription } from "../src/prompt-compression.js";

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
