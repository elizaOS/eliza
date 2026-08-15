/**
 * Unit tests for `usesWebsearchSyntax`, the classifier that decides whether a
 * message-search query carries `websearch_to_tsquery` structural operators
 * (quoted phrases, leading-minus exclusions, standalone OR) and therefore must
 * not receive the literal/trigram lexical fallback OR-ed into it. Pure
 * function, no database. Re-homes the ten structural-versus-lexical rows that
 * previously lived in the deleted `__tests__/base-adapter.harness.test.ts`
 * composite lane (#17003 / #17012 sweep).
 */
import { describe, expect, it } from "vitest";
import { usesWebsearchSyntax } from "../../message-search";

describe("structured websearch query classification", () => {
  it.each(['"alpha beta"', "alpha -far", "-excluded", "alpha OR zephyr", "alpha\tor\tzephyr"])(
    "preserves structural semantics for %s",
    (query) => {
      expect(usesWebsearchSyntax(query)).toBe(true);
    }
  );

  it.each(["alpha beta", "quarterly-budget", "word-or-word", "orphan", "-"])(
    "keeps lexical fallback for %s",
    (query) => {
      expect(usesWebsearchSyntax(query)).toBe(false);
    }
  );
});
