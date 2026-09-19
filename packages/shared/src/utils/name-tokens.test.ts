/**
 * Exercises real reverse name tokenization for character renames, including
 * Unicode word boundaries, case sensitivity, and repeated application.
 * Forward replacement belongs to the canonical core name-token suite.
 */
import { describe, expect, it } from "vitest";
import { tokenizeNameOccurrences } from "./name-tokens";

describe("tokenizeNameOccurrences", () => {
  it("tokenizes whole-word occurrences only, case-sensitively", () => {
    expect(tokenizeNameOccurrences("Momo says Momos love Momo.", "Momo")).toBe(
      "{{name}} says Momos love {{name}}.",
    );
    expect(tokenizeNameOccurrences("momo stays", "Momo")).toBe("momo stays");
  });

  it("is idempotent and non-destructive on empty/short names", () => {
    expect(tokenizeNameOccurrences("{{name}} waves", "Momo")).toBe(
      "{{name}} waves",
    );
    expect(tokenizeNameOccurrences("A big cat", "A")).toBe("A big cat");
    expect(tokenizeNameOccurrences("", "Momo")).toBe("");
  });

  it("tokenizes non-ASCII names (\\b is ASCII-only and must not be relied on)", () => {
    expect(tokenizeNameOccurrences("小美 loves tea. Ask 小美!", "小美")).toBe(
      "{{name}} loves tea. Ask {{name}}!",
    );
    expect(tokenizeNameOccurrences("Émile said hi", "Émile")).toBe(
      "{{name}} said hi",
    );
    // Still whole-word for non-ASCII: no match inside a longer CJK run.
    expect(tokenizeNameOccurrences("小美人 is different", "小美")).toBe(
      "小美人 is different",
    );
    expect(tokenizeNameOccurrences("Émilee is different", "Émile")).toBe(
      "Émilee is different",
    );
  });
});
