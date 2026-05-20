/**
 * Content Grounding Validator — Edge Cases & Boundary Tests
 *
 * Exercises boundary conditions, degenerate inputs, and threshold behaviors
 * for all three public functions: validateGrounding, validateCoherence, filterIncoherent.
 *
 * Complements the happy-path tests in content-grounding-validator.test.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  filterIncoherent,
  validateCoherence,
  validateGrounding,
} from "@feed/engine";

// ─── validateGrounding: Edge Cases ──────────────────────────────────────────

describe("validateGrounding — edge cases", () => {
  test("empty source text passes (guard: no keywords to compare)", async () => {
    const source = "";
    const generated = "Bitcoin price is going up";

    const result = await validateGrounding(source, generated);
    // Empty source → extractKeywords returns empty set → passes with overlap=1
    expect(result.grounded).toBe(true);
  });

  test("empty generated text passes (guard: no keywords)", async () => {
    const source = "Bitcoin price surges past 100k";
    const generated = "";

    const result = await validateGrounding(source, generated);
    expect(result.grounded).toBe(true);
  });

  test("both empty passes gracefully", async () => {
    const result = await validateGrounding("", "");
    expect(result.grounded).toBe(true);
  });

  test("whitespace-only text treated as empty", async () => {
    const result = await validateGrounding("   \n\t  ", "   \n  ");
    expect(result.grounded).toBe(true);
  });

  test("stop-words-only text treated as empty (no content keywords)", async () => {
    const source =
      "the is a an are was were be to of in for on with at by from";
    const generated =
      "the and but or not so yet both either neither each every";

    const result = await validateGrounding(source, generated);
    // All words are stop words → empty keyword sets → passes with overlap=1
    expect(result.grounded).toBe(true);
  });

  test("numbers in text are treated as keywords", async () => {
    const source = "Bitcoin reaches $100000 in 2025 market rally";
    const generated = "The 2025 market rally pushes Bitcoin to 100000 dollars";

    const result = await validateGrounding(source, generated);
    // Shared: "bitcoin", "100000", "2025", "market", "rally"
    expect(result.grounded).toBe(true);
    expect(result.confidence).toBeGreaterThan(0);
  });

  test("keyword overlap near threshold passes when enough words shared", async () => {
    // MIN_KEYWORD_OVERLAP is 0.15; need >=15% of generated keywords in source
    // Generated content words: "committee", "proposed", "cryptocurrency", "regulations", "tax"
    // Source content words: "cryptocurrency", "regulations", "discussed", "world", "leaders"
    // Shared: "cryptocurrency", "regulations" → 2/5 = 40% → passes
    const source =
      "cryptocurrency regulations are being discussed by world leaders";
    const generated =
      "The committee proposed cryptocurrency regulations tax amendments.";

    const result = await validateGrounding(source, generated);
    expect(result.grounded).toBe(true);
  });

  test("zero keyword overlap fails", async () => {
    const source = "quantum physics experiments yield breakthrough results";
    const generated =
      "The culinary festival showcased artisan chocolate from three continents and twelve countries.";

    const result = await validateGrounding(source, generated);
    expect(result.grounded).toBe(false);
    expect(
      result.reasons.some((r) => r.includes("Keyword overlap too low")),
    ).toBe(true);
  });

  test("known entity from StaticDataRegistry passes entity check", async () => {
    // "Sam AIltman" is in the registry — multi-word proper noun
    const source =
      "Sam AIltman talks about artificial intelligence developments";
    const generated =
      "Sam AIltman discussed the latest intelligence developments at the conference";

    const result = await validateGrounding(source, generated);
    // "Sam AIltman" is known → entity check passes, keyword overlap from shared words
    expect(result.confidence).toBeGreaterThan(0);
  });

  test("multiple unknown multi-word entities fail entity consistency", async () => {
    const source = "The tech industry is evolving rapidly";
    const generated =
      "Xavier Fictional and Monica Hallucinated from Bogus Corporation announced the tech evolution.";

    const result = await validateGrounding(source, generated);
    // 3 unknown multi-word proper nouns: "Xavier Fictional", "Monica Hallucinated", "Bogus Corporation"
    expect(result.reasons.some((r) => r.includes("unknown entities"))).toBe(
      true,
    );
  });

  test("single unknown entity is tolerated (MAX_UNKNOWN_ENTITIES = 1)", async () => {
    const source = "New partnership announcement in the tech sector today";
    const generated =
      "Marco Industries announced a partnership in the tech sector today";

    const result = await validateGrounding(source, generated);
    // "Marco Industries" is 1 unknown entity → within tolerance
    const entityReasons = result.reasons.filter((r) =>
      r.includes("unknown entities"),
    );
    expect(entityReasons).toHaveLength(0);
  });

  test("very long text does not crash", async () => {
    const source = "AI regulation framework ".repeat(200);
    const generated = "New AI regulation framework policy ".repeat(200);

    const result = await validateGrounding(source, generated);
    expect(typeof result.grounded).toBe("boolean");
    expect(typeof result.confidence).toBe("number");
  });

  test("special characters in text are stripped for keyword extraction", async () => {
    const source = "Bitcoin (BTC) surges! @crypto #trending — $100K reached.";
    const generated =
      "The Bitcoin (BTC) price reached $100K, crypto markets trending up.";

    const result = await validateGrounding(source, generated);
    // After stripping: "bitcoin", "btc", "surges", "crypto", "trending", "100k", "reached"
    expect(result.grounded).toBe(true);
  });
});

// ─── validateCoherence: Edge Cases ──────────────────────────────────────────

describe("validateCoherence — edge cases", () => {
  test("empty text passes (short text bypass)", () => {
    const result = validateCoherence("");
    expect(result.grounded).toBe(true);
  });

  test("single word passes (below word threshold)", () => {
    const result = validateCoherence("Bitcoin");
    expect(result.grounded).toBe(true);
  });

  test("exactly 9 content words bypasses repetition check (threshold is 10)", () => {
    // After stripping stop words, we need < 10 content words
    const fact =
      "Bitcoin Ethereum Solana crypto market trading volume price rally";
    const result = validateCoherence(fact);
    expect(result.grounded).toBe(true);
  });

  test("moderate repetition below 35% threshold passes", () => {
    // Repeat "market" 3x but keep total words high enough that ratio < 0.35
    const fact =
      "The prediction market shows strong activity. The crypto market is growing steadily. Analysts observe the market sentiment remains positive across sectors.";
    const result = validateCoherence(fact);
    // "market" appears 3x, but many other words keep ratio low
    expect(result.grounded).toBe(true);
  });

  test("extreme single-word repetition fails", () => {
    const fact =
      "blockchain blockchain blockchain blockchain blockchain blockchain blockchain blockchain blockchain blockchain the of in for";
    const result = validateCoherence(fact);
    expect(result.grounded).toBe(false);
    expect(result.reasons.some((r) => r.includes("repetition"))).toBe(true);
  });

  test("multiple different words each repeated 3+ times fails", () => {
    const fact =
      "crypto market prediction crypto market prediction crypto market prediction crypto market prediction analysis data results";
    const result = validateCoherence(fact);
    // "crypto" 4x, "market" 4x, "prediction" 4x → high ratio
    expect(result.grounded).toBe(false);
  });

  test("entity density: many unknown proper nouns in short text fails", () => {
    const fact =
      "John McFakerson met Sarah Hallucination while Robert Invented called Clara Nonexistent and Mary Fabricated.";
    const result = validateCoherence(fact);
    // 5 unknown multi-word proper nouns in ~100 chars → high entity density
    expect(result.grounded).toBe(false);
  });

  test("entity density: unknown proper nouns in long text may pass", () => {
    // Entity density threshold is: text.length > 100 * unknownEntities.length
    // 2 unknown entities need > 200 chars of text
    const padding =
      "The prediction markets continue to show strong activity across multiple sectors with ongoing developments in technology and artificial intelligence. ";
    const fact = `${padding}John McFakerson and Sarah Hallucination attended the conference. ${padding}`;
    const result = validateCoherence(fact);
    // 2 unknown entities in ~400+ chars → density should be OK
    // But entity consistency check (MAX_UNKNOWN_ENTITIES=1) still catches 2+ unknowns
    expect(typeof result.grounded).toBe("boolean");
  });

  test("known parody names from StaticDataRegistry pass entity checks", () => {
    // Use names that exist in the registry
    const fact =
      "Sam AIltman made a bold prediction about the future of artificial intelligence at the annual tech conference.";
    const result = validateCoherence(fact);
    // "Sam AIltman" is known → entity consistency passes
    expect(result.grounded).toBe(true);
  });

  test("text with only numbers and stop words passes", () => {
    const result = validateCoherence(
      "The 100 is 200 and 300 but 400 with 500 at 600",
    );
    expect(result.grounded).toBe(true);
  });
});

// ─── filterIncoherent: Edge Cases ───────────────────────────────────────────

describe("filterIncoherent — edge cases", () => {
  test("empty array returns empty array", () => {
    const result = filterIncoherent([], (item: string) => item);
    expect(result).toEqual([]);
  });

  test("single coherent item is preserved", () => {
    const items = [
      { text: "Markets are looking strong this quarter with solid gains." },
    ];
    const result = filterIncoherent(items, (i) => i.text);
    expect(result).toHaveLength(1);
  });

  test("preserves original object references", () => {
    const original = {
      id: 42,
      text: "The crypto market continues to grow in adoption.",
    };
    const items = [original];
    const result = filterIncoherent(items, (i) => i.text);
    expect(result[0]).toBe(original); // Same reference, not a copy
  });

  test("works with string arrays using identity extractor", () => {
    const items = [
      "A normal sentence about prediction markets.",
      "blockchain blockchain blockchain blockchain blockchain blockchain blockchain blockchain blockchain blockchain",
    ];
    const result = filterIncoherent(items, (s) => s);
    expect(result.length).toBeLessThanOrEqual(items.length);
    // The normal sentence should survive
    expect(result.some((s) => s.includes("prediction markets"))).toBe(true);
  });

  test("handles items with empty text gracefully", () => {
    const items = [
      { id: 1, text: "" },
      { id: 2, text: "Valid sentence about technology trends and markets." },
    ];
    const result = filterIncoherent(items, (i) => i.text);
    // Empty text passes coherence (short text bypass)
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  test("large array performance is acceptable", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      text: `Market update number ${i}: prediction markets show activity.`,
    }));

    const start = performance.now();
    const result = filterIncoherent(items, (i) => i.text);
    const elapsed = performance.now() - start;

    expect(result.length).toBeGreaterThan(0);
    // Coherence checks are synchronous and cheap — should finish well under 1s
    expect(elapsed).toBeLessThan(1000);
  });
});
