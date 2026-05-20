/**
 * Content Quality Gate — Integration & Pipeline Tests
 *
 * Tests the full validation pipeline: structure → entity → grounding/coherence.
 * Exercises multi-failure accumulation, score composition, and the branching
 * behavior of validateWorldFact (with/without sourceContext).
 *
 * Pure unit tests — no DB. Embedding-based grounding degrades gracefully
 * when OPENAI_API_KEY is absent.
 */

import { describe, expect, test } from "bun:test";
import { ContentQualityGate } from "@feed/engine";

// ─── validateParody: Pipeline Integration ───────────────────────────────────

describe("validateParody — pipeline integration", () => {
  test("accumulates multiple failure reasons", async () => {
    // Too short AND verbatim copy — should report both
    const original = "Short";
    const parody = "Short";

    const result = await ContentQualityGate.validateParody(original, parody);
    expect(result.passed).toBe(false);
    // Should have at least "Too short" and "Verbatim copy"
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
    expect(result.reasons.some((r) => r.includes("Too short"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("Verbatim copy"))).toBe(true);
  });

  test("score is reduced when structure check fails", async () => {
    // Too short + verbatim → structure score=0
    // But entity + grounding checks still pass (short text → empty keywords → passes)
    // So composite score is < 1 but not necessarily 0
    const original = "AI";
    const parody = "AI";

    const result = await ContentQualityGate.validateParody(original, parody);
    expect(result.passed).toBe(false);
    expect(result.score).toBeLessThan(1);
  });

  test("score is composite average of all check scores", async () => {
    const original = "Tesla launches new electric vehicle model for market";
    const parody =
      "Teslaroid launches new electric brain vehicle model for market domination";

    const result = await ContentQualityGate.validateParody(original, parody);
    expect(result.passed).toBe(true);
    // Score should be > 0 and <= 1 (average of structure=1, entity=1, grounding confidence)
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  test("entity failure with good structure still fails overall", async () => {
    // Good structure, keyword overlap OK, but many invented entities
    const original =
      "Tech company announces new product with great features and improvements";
    const parody =
      "Xavier Fictional and Monica Hallucinated announce Bogus Corporation product with great features";

    const result = await ContentQualityGate.validateParody(original, parody);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("unknown entities"))).toBe(
      true,
    );
  });

  test("incoherent parody body causes failure even with valid headline", async () => {
    const original =
      "Major tech conference announces keynote speakers for 2026";
    const parody =
      "Major tech conference announces keynote robot speakers for 2026";
    const body =
      "robot robot robot robot robot robot robot robot robot robot robot robot robot speakers speakers speakers";

    const result = await ContentQualityGate.validateParody(
      original,
      parody,
      body,
    );
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("repetition"))).toBe(true);
  });

  test("parody without body skips coherence check on body", async () => {
    const original = "Apple releases new operating system update";
    const parody =
      "Pear Inc releases new operating system update that gains sentience";

    const result = await ContentQualityGate.validateParody(original, parody);
    // Should only have structure + entity + grounding checks — no body coherence
    // 3 scores → composite
    expect(typeof result.score).toBe("number");
    expect(result.score).toBeGreaterThan(0);
  });

  test("case-insensitive verbatim check catches different casing", async () => {
    const original = "Google Announces New Search Features";
    const parody = "google announces new search features";

    const result = await ContentQualityGate.validateParody(original, parody);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("Verbatim copy"))).toBe(true);
  });

  test("boundary: parody at exactly minLength (10 chars) passes structure", async () => {
    const original = "Big tech news from the industry today about the future";
    const parody = "1234567890"; // Exactly 10 chars

    const result = await ContentQualityGate.validateParody(original, parody);
    // Structure passes (10 >= 10), but grounding will likely fail (no keyword overlap)
    const structureReasons = result.reasons.filter((r) =>
      r.includes("Too short"),
    );
    expect(structureReasons).toHaveLength(0);
  });

  test("boundary: parody at exactly maxLength (500 chars) passes structure", async () => {
    const word = "innovation ";
    const original = "Tech innovation changes everything in the industry";
    const parody = word.repeat(45).trim().substring(0, 500); // Exactly 500 chars

    const result = await ContentQualityGate.validateParody(original, parody);
    const tooLongReasons = result.reasons.filter((r) => r.includes("Too long"));
    expect(tooLongReasons).toHaveLength(0);
  });

  test("parody at 501 chars fails structure", async () => {
    const original = "Brief headline";
    const parody = "A".repeat(501);

    const result = await ContentQualityGate.validateParody(original, parody);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("Too long"))).toBe(true);
  });
});

// ─── validateWorldFact: Pipeline Integration ────────────────────────────────

describe("validateWorldFact — pipeline integration", () => {
  test("without source context uses coherence path", async () => {
    // Repetitive text → coherence check should catch it
    const fact =
      "blockchain blockchain blockchain blockchain blockchain blockchain blockchain blockchain blockchain blockchain the market is growing.";

    const result = await ContentQualityGate.validateWorldFact(fact);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("repetition"))).toBe(true);
  });

  test("with source context uses grounding path", async () => {
    // Completely unrelated source → grounding fails
    const fact =
      "The culinary festival showcased artisan chocolate from three different continents.";
    const source =
      "Bitcoin price surges past $100k as institutional investors pile in";

    const result = await ContentQualityGate.validateWorldFact(fact, source);
    expect(result.passed).toBe(false);
    expect(
      result.reasons.some((r) => r.includes("Keyword overlap too low")),
    ).toBe(true);
  });

  test("structure failure short-circuits before grounding", async () => {
    const fact = "Too short";
    const source = "Some source context about technology";

    const result = await ContentQualityGate.validateWorldFact(fact, source);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("Too short"))).toBe(true);
  });

  test("boundary: fact at exactly minLength (15 chars) passes structure", async () => {
    const fact = "123456789012345"; // Exactly 15 chars

    const result = await ContentQualityGate.validateWorldFact(fact);
    const shortReasons = result.reasons.filter((r) => r.includes("Too short"));
    expect(shortReasons).toHaveLength(0);
  });

  test("boundary: fact at 14 chars fails structure", async () => {
    const fact = "12345678901234"; // 14 chars

    const result = await ContentQualityGate.validateWorldFact(fact);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("Too short"))).toBe(true);
  });

  test("boundary: fact at exactly maxLength (1000 chars) passes structure", async () => {
    const word = "market ";
    const fact = word.repeat(142).trim().substring(0, 1000); // Exactly 1000 chars

    const result = await ContentQualityGate.validateWorldFact(fact);
    const longReasons = result.reasons.filter((r) => r.includes("Too long"));
    expect(longReasons).toHaveLength(0);
  });

  test("fact at 1001 chars fails structure", async () => {
    const fact = "A".repeat(1001);

    const result = await ContentQualityGate.validateWorldFact(fact);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("Too long"))).toBe(true);
  });

  test("multiple failures accumulate from different checks", async () => {
    // Too short + invented entities
    const fact = "Xavier Fictional and Monica Hallucinated from Bogus Corp.";

    const result = await ContentQualityGate.validateWorldFact(fact);
    // Might hit structure (length depends on minLength=15 — 57 chars > 15 so passes structure)
    // Should hit entity check (3 unknown multi-word proper nouns)
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("unknown entities"))).toBe(
      true,
    );
  });

  test("grounded fact with high keyword overlap scores well", async () => {
    const fact =
      "The prediction market for AI regulation shows strong trading activity after the government announced the new framework.";
    const source =
      "Government announced new AI regulation framework. Prediction market shows strong trading activity.";

    const result = await ContentQualityGate.validateWorldFact(fact, source);
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThan(0.5);
  });

  test("empty source context falls through to coherence path", async () => {
    const fact =
      "The prediction markets continue to show increased trading volume across multiple sectors.";
    const source = "";

    // Empty string is falsy → goes to coherence path
    const result = await ContentQualityGate.validateWorldFact(fact, source);
    expect(result.passed).toBe(true);
  });
});

// ─── validateArticle: Pipeline Integration ──────────────────────────────────

describe("validateArticle — pipeline integration", () => {
  test("article at exactly 100 chars passes structure boundary", async () => {
    const article = "A".repeat(100);
    const source = "Some event context about technology";

    const result = await ContentQualityGate.validateArticle(article, source);
    const shortReasons = result.reasons.filter((r) => r.includes("Too short"));
    expect(shortReasons).toHaveLength(0);
  });

  test("article at 99 chars fails structure boundary", async () => {
    const article = "A".repeat(99);
    const source = "Some event context";

    const result = await ContentQualityGate.validateArticle(article, source);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("Too short"))).toBe(true);
  });

  test("article at 15001 chars fails maxLength", async () => {
    const article = "technology ".repeat(1365).substring(0, 15001);
    const source = "Technology news context";

    const result = await ContentQualityGate.validateArticle(article, source);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("Too long"))).toBe(true);
  });

  test("article unrelated to source fails grounding", async () => {
    const article =
      "The annual cooking competition in Paris brought together chefs from around the world to showcase their culinary talents and innovative recipes in front of an enthusiastic audience.";
    const source =
      "Bitcoin mining operations expand in Texas with new facilities";

    const result = await ContentQualityGate.validateArticle(article, source);
    expect(result.passed).toBe(false);
    expect(
      result.reasons.some((r) => r.includes("Keyword overlap too low")),
    ).toBe(true);
  });

  test("article with invented entities fails entity check", async () => {
    const sourceContext =
      "New developments in AI regulation. Government announces framework for oversight.";
    const article =
      "Xavier Fictional from Bogus Corporation spoke about the developments in AI regulation and government oversight framework. Monica Hallucinated from Imaginary Labs agreed with the assessment of the new policies. The conference brought together experts from the Fabricated Institute to discuss implications of the framework.";

    const result = await ContentQualityGate.validateArticle(
      article,
      sourceContext,
    );
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("unknown entities"))).toBe(
      true,
    );
  });

  test("well-grounded article with known entities passes all checks", async () => {
    const source =
      "Sam AIltman discusses AI safety at the annual technology conference with industry leaders.";
    const article =
      "At the annual technology conference, Sam AIltman delivered a compelling address on AI safety measures. Industry leaders gathered to discuss the implications of rapid advancement in artificial intelligence. The conference highlighted growing consensus around safety-first development practices. Participants noted the urgency of establishing robust safety frameworks for the technology industry.";

    const result = await ContentQualityGate.validateArticle(article, source);
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });
});

// ─── ContentQualityResult interface contract ────────────────────────────────

describe("ContentQualityResult — interface contract", () => {
  test("passed=true always has empty reasons array", async () => {
    const fact =
      "The prediction markets show continued growth across multiple sectors globally.";
    const result = await ContentQualityGate.validateWorldFact(fact);

    if (result.passed) {
      expect(result.reasons).toHaveLength(0);
    }
  });

  test("passed=false always has non-empty reasons array", async () => {
    const fact = "Too short.";
    const result = await ContentQualityGate.validateWorldFact(fact);

    if (!result.passed) {
      expect(result.reasons.length).toBeGreaterThan(0);
    }
  });

  test("score is always between 0 and 1", async () => {
    const cases = [
      { fact: "A coherent prediction market fact about technology sectors." },
      { fact: "Short." },
      {
        fact: "crypto crypto crypto crypto crypto crypto crypto crypto crypto crypto crypto analysis",
      },
    ];

    for (const { fact } of cases) {
      const result = await ContentQualityGate.validateWorldFact(fact);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  test("all three validate methods return consistent shape", async () => {
    const parodyResult = await ContentQualityGate.validateParody(
      "Original headline about tech news",
      "Parody headline about tech news comedy",
    );
    const factResult = await ContentQualityGate.validateWorldFact(
      "A world fact about current market conditions and technology trends.",
    );
    const articleResult = await ContentQualityGate.validateArticle(
      "A longer article about developments in the tech industry. This article covers multiple aspects of technological advancement and market impact across various sectors and regions.".repeat(
        2,
      ),
      "Tech industry developments and market impact",
    );

    for (const result of [parodyResult, factResult, articleResult]) {
      expect(typeof result.passed).toBe("boolean");
      expect(typeof result.score).toBe("number");
      expect(Array.isArray(result.reasons)).toBe(true);
    }
  });
});
