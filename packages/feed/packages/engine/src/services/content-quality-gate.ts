/**
 * Content Quality Gate
 *
 * Validates LLM-generated content before it's written to the database.
 * Sits at the write boundary for parodyHeadlines, worldFacts, and articles —
 * content that propagates into every generation prompt via
 * {{worldFactsContext}} in shared-sections.ts.
 *
 * Three checks, cheapest first:
 *  1. Structure — degenerate output (empty, too short/long, verbatim copy)
 *  2. Entity   — invented proper nouns not in StaticDataRegistry
 *  3. Grounding — source-relative validation (does output relate to input?)
 *
 * Replaces the previous ban-list approach (content-contamination-filter.ts)
 * with source-grounding checks that catch ANY hallucination, not just
 * previously-seen contamination terms.
 */

import { logger } from '@babylon/shared';
import {
  clearKnownNamesCache,
  getKnownNames,
  validateCoherence,
  validateGrounding,
} from './content-grounding-validator';

// Re-export for convenience — the canonical implementation is in content-grounding-validator.ts
export { clearKnownNamesCache };

export interface ContentQualityResult {
  passed: boolean;
  score: number; // 0–1 composite
  reasons: string[]; // failure reasons (empty if passed)
}

/**
 * Content Quality Gate — stateless validation service.
 *
 * Methods are static because the gate has no per-instance state.
 * All data comes from StaticDataRegistry (in-memory) and the
 * embedding client (lazy-init singleton).
 */
export class ContentQualityGate {
  // ─── Public API ──────────────────────────────────────────────

  /**
   * Validate a parody headline before inserting into parodyHeadlines.
   * Has source text (originalTitle) → runs grounding check.
   */
  static async validateParody(
    originalTitle: string,
    parodyTitle: string,
    parodyContent?: string
  ): Promise<ContentQualityResult> {
    const reasons: string[] = [];
    const scores: number[] = [];

    // 1. Structure
    const structure = this.checkStructure(parodyTitle, {
      minLength: 10,
      maxLength: 500,
      original: originalTitle,
    });
    scores.push(structure.score);
    if (!structure.passed) reasons.push(...structure.reasons);

    // 2. Entity allowlist
    const entity = this.checkEntityAllowlist(parodyTitle);
    scores.push(entity.score);
    if (!entity.passed) reasons.push(...entity.reasons);

    // 3. Grounding: parody should stay topically related to original
    const grounding = await validateGrounding(originalTitle, parodyTitle);
    scores.push(grounding.confidence);
    if (!grounding.grounded) reasons.push(...grounding.reasons);

    // If parody has content body, check its coherence too
    if (parodyContent) {
      const contentCoherence = validateCoherence(parodyContent);
      scores.push(contentCoherence.confidence);
      if (!contentCoherence.grounded) reasons.push(...contentCoherence.reasons);
    }

    const compositeScore =
      scores.length > 0
        ? scores.reduce((sum, s) => sum + s, 0) / scores.length
        : 0;

    const passed = reasons.length === 0;

    logger[passed ? 'debug' : 'warn'](
      `Parody ${passed ? 'passed' : 'failed'} quality gate`,
      {
        originalTitle,
        parodyTitle,
        score: compositeScore.toFixed(2),
        ...(reasons.length > 0 && { reasons }),
      },
      'ContentQualityGate'
    );

    return { passed, score: compositeScore, reasons };
  }

  /**
   * Validate a world fact before inserting into worldFacts.
   *
   * With sourceContext: runs grounding check (fact should relate to source).
   * Without sourceContext: runs coherence check (catches hallucination signals).
   */
  static async validateWorldFact(
    factText: string,
    sourceContext?: string
  ): Promise<ContentQualityResult> {
    const reasons: string[] = [];
    const scores: number[] = [];

    // 1. Structure
    const structure = this.checkStructure(factText, {
      minLength: 15,
      maxLength: 1000,
    });
    scores.push(structure.score);
    if (!structure.passed) reasons.push(...structure.reasons);

    // 2. Entity allowlist
    const entity = this.checkEntityAllowlist(factText);
    scores.push(entity.score);
    if (!entity.passed) reasons.push(...entity.reasons);

    // 3. Source-relative or coherence check
    if (sourceContext) {
      const grounding = await validateGrounding(sourceContext, factText);
      scores.push(grounding.confidence);
      if (!grounding.grounded) reasons.push(...grounding.reasons);
    } else {
      const coherence = validateCoherence(factText);
      scores.push(coherence.confidence);
      if (!coherence.grounded) reasons.push(...coherence.reasons);
    }

    const compositeScore =
      scores.length > 0
        ? scores.reduce((sum, s) => sum + s, 0) / scores.length
        : 0;

    const passed = reasons.length === 0;

    logger[passed ? 'debug' : 'warn'](
      `World fact ${passed ? 'passed' : 'failed'} quality gate`,
      {
        factText: factText.substring(0, 100),
        score: compositeScore.toFixed(2),
        ...(reasons.length > 0 && { reasons }),
      },
      'ContentQualityGate'
    );

    return { passed, score: compositeScore, reasons };
  }

  /**
   * Validate an article before publishing.
   * Has source context (worldContext, event descriptions) → runs grounding check.
   */
  static async validateArticle(
    articleText: string,
    sourceContext: string
  ): Promise<ContentQualityResult> {
    const reasons: string[] = [];
    const scores: number[] = [];

    // 1. Structure
    const structure = this.checkStructure(articleText, {
      minLength: 100,
      maxLength: 15000,
    });
    scores.push(structure.score);
    if (!structure.passed) reasons.push(...structure.reasons);

    // 2. Entity allowlist
    const entity = this.checkEntityAllowlist(articleText);
    scores.push(entity.score);
    if (!entity.passed) reasons.push(...entity.reasons);

    // 3. Grounding: article should relate to its source context
    const grounding = await validateGrounding(sourceContext, articleText);
    scores.push(grounding.confidence);
    if (!grounding.grounded) reasons.push(...grounding.reasons);

    const compositeScore =
      scores.length > 0
        ? scores.reduce((sum, s) => sum + s, 0) / scores.length
        : 0;

    const passed = reasons.length === 0;

    logger[passed ? 'debug' : 'warn'](
      `Article ${passed ? 'passed' : 'failed'} quality gate`,
      {
        articlePreview: articleText.substring(0, 100),
        score: compositeScore.toFixed(2),
        ...(reasons.length > 0 && { reasons }),
      },
      'ContentQualityGate'
    );

    return { passed, score: compositeScore, reasons };
  }

  // ─── Individual Checks ───────────────────────────────────────

  /**
   * Check structural validity — catches degenerate LLM output.
   */
  private static checkStructure(
    text: string,
    opts: { minLength: number; maxLength: number; original?: string }
  ): { passed: boolean; score: number; reasons: string[] } {
    const reasons: string[] = [];

    const trimmed = text.trim();
    if (trimmed.length < opts.minLength) {
      reasons.push(`Too short (${trimmed.length} < ${opts.minLength})`);
    }
    if (trimmed.length > opts.maxLength) {
      reasons.push(`Too long (${trimmed.length} > ${opts.maxLength})`);
    }

    // Verbatim copy detection
    if (opts.original) {
      const normalizedOriginal = opts.original.toLowerCase().trim();
      const normalizedText = trimmed.toLowerCase();
      if (normalizedText === normalizedOriginal) {
        reasons.push('Verbatim copy of original');
      }
    }

    const score = reasons.length === 0 ? 1 : 0;
    return { passed: reasons.length === 0, score, reasons };
  }

  /**
   * Maximum unknown entities allowed before failing validation.
   * Matches MAX_UNKNOWN_ENTITIES in content-grounding-validator.ts.
   * Value of 1 means: allow up to 1 unknown proper noun (could be a real-world
   * reference), but 2+ suggests the LLM is inventing entities.
   */
  private static readonly MAX_UNKNOWN_ENTITIES = 1;

  /**
   * Check that capitalized multi-word proper nouns exist in StaticDataRegistry.
   *
   * Extracts capitalized phrases (2+ words starting with uppercase) that look
   * like proper nouns and checks them against known actor names and org names.
   * Single unknown proper nouns are allowed (common in news), but 2+ unknown
   * multi-word proper nouns suggest the LLM invented entities.
   *
   * Uses the shared cache from content-grounding-validator to avoid
   * duplicate caches and ensure consistent invalidation.
   */
  private static checkEntityAllowlist(text: string): {
    passed: boolean;
    score: number;
    reasons: string[];
  } {
    // Use shared cache from content-grounding-validator
    const knownNames = getKnownNames();

    const properNounPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
    const matches = text.match(properNounPattern) ?? [];

    const unknownEntities: string[] = [];
    for (const match of matches) {
      const lower = match.toLowerCase();
      if (!knownNames.has(lower)) {
        unknownEntities.push(match);
      }
    }

    // Allow up to MAX_UNKNOWN_ENTITIES unknown proper nouns (could be real-world references),
    // but more suggests the LLM is inventing entities
    const passed = unknownEntities.length <= this.MAX_UNKNOWN_ENTITIES;
    const score = passed ? 1 : 0;
    const reasons =
      unknownEntities.length > this.MAX_UNKNOWN_ENTITIES
        ? [
            `${unknownEntities.length} unknown entities: ${unknownEntities.slice(0, 3).join(', ')}`,
          ]
        : [];

    return { passed, score, reasons };
  }
}
