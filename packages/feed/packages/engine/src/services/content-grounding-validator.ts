/**
 * Content Grounding Validator
 *
 * Validates that LLM-generated content stays grounded in its source material.
 * Replaces the reactive ban-list approach with source-relative checks that
 * catch ANY hallucination — not just previously-seen contamination terms.
 *
 * Two modes:
 *  - validateGrounding(source, generated): verifies output relates to input
 *  - validateCoherence(text): verifies text is internally consistent
 *    (for content without a single source, e.g. consolidated facts)
 */

import { logger } from "@feed/shared";
import { cosineSimilarity, getEmbedding } from "../llm/embedding-client";
import { StaticDataRegistry } from "./static-data-registry";

export interface GroundingResult {
  grounded: boolean;
  confidence: number; // 0–1
  reasons: string[]; // failure reasons (empty if grounded)
}

/**
 * Extract significant keywords from text — nouns, proper nouns, numbers.
 * Strips common stop words to focus on content-bearing terms.
 */
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "and",
  "but",
  "or",
  "nor",
  "not",
  "so",
  "yet",
  "both",
  "either",
  "neither",
  "each",
  "every",
  "all",
  "any",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "only",
  "own",
  "same",
  "than",
  "too",
  "very",
  "just",
  "because",
  "if",
  "when",
  "where",
  "how",
  "what",
  "which",
  "who",
  "whom",
  "this",
  "that",
  "these",
  "those",
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "you",
  "your",
  "he",
  "him",
  "his",
  "she",
  "her",
  "it",
  "its",
  "they",
  "them",
  "their",
  "about",
  "up",
  "out",
  "then",
  "here",
  "there",
  "also",
  "over",
  "new",
  "said",
  "says",
  "like",
  "well",
  "back",
  "even",
  "still",
  "way",
  "take",
  "make",
  "get",
]);

function extractKeywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  return new Set(words);
}

/**
 * Extract multi-word proper nouns (2+ capitalized words) from text.
 *
 * Case-sensitivity note: The regex requires Title Case (e.g. "Sam AIltman"
 * won't match as a single entity because "AI" is all-caps). This is
 * intentional — it reduces false positives from acronyms and all-caps
 * headlines. Known parody names in StaticDataRegistry use Title Case to
 * match this pattern. ALL-CAPS words (e.g. "NASA", "FBI") are not extracted
 * as proper nouns; they pass through unchecked rather than triggering
 * false entity-consistency failures.
 */
const PROPER_NOUN_PATTERN = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;

function extractProperNouns(text: string): string[] {
  return text.match(PROPER_NOUN_PATTERN) ?? [];
}

/**
 * Cached known names from StaticDataRegistry.
 * This is the single source of truth for known names caching.
 * Lazy-built on first access; call clearKnownNamesCache() to force rebuild.
 */
let knownNamesCache: Set<string> | null = null;

/**
 * Clear the known names cache — call when StaticDataRegistry updates.
 * This is the canonical cache clear function; also re-exported from
 * content-quality-gate.ts for convenience.
 */
export function clearKnownNamesCache(): void {
  knownNamesCache = null;
}

/**
 * Get the cached set of known names from StaticDataRegistry.
 * This is the single source of truth for known names — other modules
 * should import and use this function rather than building their own cache.
 *
 * Concurrency safety: Node.js is single-threaded, so the check-then-set
 * on knownNamesCache is atomic within a single event-loop tick. The only
 * race is two callers entering while cache is null — both build the same
 * Set from the same StaticDataRegistry snapshot, so the last write wins
 * with an identical result. No mutex needed.
 */
export function getKnownNames(): Set<string> {
  if (knownNamesCache) {
    return knownNamesCache;
  }

  const names = new Set<string>();

  for (const actor of StaticDataRegistry.getAllActors()) {
    names.add(actor.name.toLowerCase());
    if (actor.username) names.add(actor.username.toLowerCase());
    if (actor.realName) names.add(actor.realName.toLowerCase());
  }

  for (const org of StaticDataRegistry.getAllOrganizations()) {
    names.add(org.name.toLowerCase());
    if (org.originalName) names.add(org.originalName.toLowerCase());
  }

  knownNamesCache = names;
  return names;
}

// ─── Keyword Overlap ─────────────────────────────────────────────

const MIN_KEYWORD_OVERLAP = 0.15;

/**
 * Check that generated text shares enough topical keywords with source.
 * Source-relative: "mango" is fine if source mentions mangos.
 */
function checkKeywordOverlap(
  sourceText: string,
  generatedText: string,
): { passed: boolean; overlap: number; reasons: string[] } {
  const sourceKeywords = extractKeywords(sourceText);
  const generatedKeywords = extractKeywords(generatedText);

  if (sourceKeywords.size === 0 || generatedKeywords.size === 0) {
    return { passed: true, overlap: 1, reasons: [] };
  }

  let shared = 0;
  for (const word of generatedKeywords) {
    if (sourceKeywords.has(word)) shared++;
  }

  const overlap = shared / generatedKeywords.size;
  const passed = overlap >= MIN_KEYWORD_OVERLAP;

  return {
    passed,
    overlap,
    reasons: passed
      ? []
      : [
          `Keyword overlap too low (${(overlap * 100).toFixed(0)}% < ${MIN_KEYWORD_OVERLAP * 100}%) — generated text drifted from source topic`,
        ],
  };
}

// ─── Entity Consistency ──────────────────────────────────────────

const MAX_UNKNOWN_ENTITIES = 1;

/**
 * Check that generated text doesn't introduce entities absent from
 * both the source text and StaticDataRegistry.
 */
function checkEntityConsistency(
  generatedText: string,
  sourceText?: string,
): { passed: boolean; score: number; reasons: string[] } {
  const knownNames = getKnownNames();
  const generatedEntities = extractProperNouns(generatedText);

  // Build allowlist: known registry names + entities from source
  const allowed = new Set(knownNames);
  if (sourceText) {
    for (const entity of extractProperNouns(sourceText)) {
      allowed.add(entity.toLowerCase());
    }
  }

  const unknownEntities: string[] = [];
  for (const entity of generatedEntities) {
    if (!allowed.has(entity.toLowerCase())) {
      unknownEntities.push(entity);
    }
  }

  const passed = unknownEntities.length <= MAX_UNKNOWN_ENTITIES;
  return {
    passed,
    score: passed ? 1 : 0,
    reasons:
      unknownEntities.length > MAX_UNKNOWN_ENTITIES
        ? [
            `${unknownEntities.length} unknown entities: ${unknownEntities.slice(0, 3).join(", ")}`,
          ]
        : [],
  };
}

// ─── Embedding Grounding ─────────────────────────────────────────

const EMBEDDING_MIN_SIMILARITY = 0.3;
const EMBEDDING_MAX_SIMILARITY = 0.98;

/**
 * Check that generated text is semantically related to its source
 * via embedding cosine similarity. Uses relative thresholds rather
 * than absolute ones — the generated text should be topically aligned
 * without being a near-copy.
 *
 * Graceful degradation: returns passed=true if embeddings unavailable.
 */
async function checkEmbeddingGrounding(
  sourceText: string,
  generatedText: string,
): Promise<{ passed: boolean; score: number; reasons: string[] }> {
  // Empty/whitespace-only inputs produce meaningless embeddings — skip.
  if (!sourceText.trim() || !generatedText.trim()) {
    return { passed: true, score: 1, reasons: [] };
  }

  const [sourceEmb, generatedEmb] = await Promise.all([
    getEmbedding(sourceText),
    getEmbedding(generatedText),
  ]);

  if (!sourceEmb || !generatedEmb) {
    return { passed: true, score: 1, reasons: [] };
  }

  const similarity = cosineSimilarity(sourceEmb, generatedEmb);

  const reasons: string[] = [];
  if (similarity < EMBEDDING_MIN_SIMILARITY) {
    reasons.push(
      `Embedding similarity too low (${similarity.toFixed(3)}) — unrelated to source`,
    );
  }
  if (similarity > EMBEDDING_MAX_SIMILARITY) {
    reasons.push(
      `Embedding similarity too high (${similarity.toFixed(3)}) — near-verbatim copy`,
    );
  }

  const passed = reasons.length === 0;
  const score = passed ? similarity : 0;

  return { passed, score, reasons };
}

// ─── Coherence Checks (no source text available) ─────────────────

const MAX_REPETITION_RATIO = 0.35;
const MAX_UNKNOWN_ENTITY_DENSITY = 3;
const ENTITY_DENSITY_CHAR_THRESHOLD = 100;

/**
 * Check for unusual word repetition — a common hallucination signal.
 * Counts how many content words appear 3+ times in a short text.
 */
function checkRepetition(text: string): {
  passed: boolean;
  reasons: string[];
} {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  if (words.length < 10) return { passed: true, reasons: [] };

  const counts = new Map<string, number>();
  for (const word of words) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  let repeatedCount = 0;
  for (const count of counts.values()) {
    if (count >= 3) repeatedCount += count;
  }

  const ratio = repeatedCount / words.length;
  const passed = ratio <= MAX_REPETITION_RATIO;

  return {
    passed,
    reasons: passed
      ? []
      : [
          `Unusual word repetition (${(ratio * 100).toFixed(0)}% of content words repeat 3+ times)`,
        ],
  };
}

/**
 * Check for excessive unknown entity density — a sign the LLM
 * is inventing proper nouns at an unusual rate.
 */
function checkEntityDensity(text: string): {
  passed: boolean;
  reasons: string[];
} {
  const knownNames = getKnownNames();
  const entities = extractProperNouns(text);

  const unknownEntities = entities.filter(
    (e) => !knownNames.has(e.toLowerCase()),
  );

  const passed =
    unknownEntities.length <= MAX_UNKNOWN_ENTITY_DENSITY ||
    text.length > ENTITY_DENSITY_CHAR_THRESHOLD * unknownEntities.length;

  return {
    passed,
    reasons: passed
      ? []
      : [
          `High entity density: ${unknownEntities.length} unknown entities in ${text.length} chars`,
        ],
  };
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Validate that generated text stays grounded in its source material.
 *
 * Runs three checks (cheapest first):
 *  1. Keyword overlap — does the output share topic words with source?
 *  2. Entity consistency — does the output invent entities not in source?
 *  3. Embedding grounding — is the output semantically related to source?
 */
export async function validateGrounding(
  sourceText: string,
  generatedText: string,
): Promise<GroundingResult> {
  // Fast path: empty/whitespace-only inputs are trivially grounded
  const trimmedSource = sourceText.trim();
  const trimmedGenerated = generatedText.trim();
  if (!trimmedSource || !trimmedGenerated) {
    return { grounded: true, confidence: 1, reasons: [] };
  }

  const reasons: string[] = [];
  const scores: number[] = [];

  // 1. Keyword overlap (free, <1ms)
  const keywords = checkKeywordOverlap(sourceText, generatedText);
  scores.push(keywords.overlap);
  if (!keywords.passed) reasons.push(...keywords.reasons);

  // 2. Entity consistency (free, <1ms)
  const entities = checkEntityConsistency(generatedText, sourceText);
  scores.push(entities.score);
  if (!entities.passed) reasons.push(...entities.reasons);

  // 3. Embedding grounding (~100ms, ~$0.0002)
  const embedding = await checkEmbeddingGrounding(sourceText, generatedText);
  scores.push(embedding.score);
  if (!embedding.passed) reasons.push(...embedding.reasons);

  const confidence =
    scores.length > 0
      ? scores.reduce((sum, s) => sum + s, 0) / scores.length
      : 0;

  const grounded = reasons.length === 0;

  if (!grounded) {
    logger.warn(
      "Content failed grounding validation",
      {
        confidence: confidence.toFixed(2),
        reasons,
        sourcePreview: sourceText.substring(0, 80),
        generatedPreview: generatedText.substring(0, 80),
      },
      "GroundingValidator",
    );
  }

  return { grounded, confidence, reasons };
}

/**
 * Validate that text is internally coherent when no source is available.
 *
 * Used for content without a single source (e.g. consolidated facts,
 * facts derived from multiple inputs). Checks for hallucination signals:
 *  1. Unusual word repetition
 *  2. Excessive unknown entity density
 *  3. Entity allowlist (same as grounding path)
 */
export function validateCoherence(text: string): GroundingResult {
  const reasons: string[] = [];
  const scores: number[] = [];

  // 1. Repetition detection
  const repetition = checkRepetition(text);
  scores.push(repetition.passed ? 1 : 0);
  if (!repetition.passed) reasons.push(...repetition.reasons);

  // 2. Entity density
  const density = checkEntityDensity(text);
  scores.push(density.passed ? 1 : 0);
  if (!density.passed) reasons.push(...density.reasons);

  // 3. Entity allowlist (catches invented proper nouns)
  const entities = checkEntityConsistency(text);
  scores.push(entities.score);
  if (!entities.passed) reasons.push(...entities.reasons);

  const confidence =
    scores.length > 0
      ? scores.reduce((sum, s) => sum + s, 0) / scores.length
      : 0;

  const grounded = reasons.length === 0;

  if (!grounded) {
    logger.warn(
      "Content failed coherence validation",
      {
        confidence: confidence.toFixed(2),
        reasons,
        textPreview: text.substring(0, 80),
      },
      "GroundingValidator",
    );
  }

  return { grounded, confidence, reasons };
}

/**
 * Filter an array of items, removing any that fail coherence checks.
 * Drop-in replacement for the old filterContaminated().
 */
export function filterIncoherent<T>(
  items: T[],
  textExtractor: (item: T) => string,
): T[] {
  return items.filter((item) => {
    const result = validateCoherence(textExtractor(item));
    return result.grounded;
  });
}
