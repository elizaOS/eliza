/**
 * Local distilbert-NER recognizer for the PII pseudonymization layer.
 *
 * Implements the `@elizaos/core` {@link PiiEntityRecognizer} seam with a
 * transformers.js (`@huggingface/transformers` v3) token-classification pipeline
 * running `dslim/distilbert-NER` on `onnxruntime-node` (native CPU). The model
 * emits CoNLL BIO labels (`PER` / `ORG` / `LOC` / `MISC`); we keep only
 * person / org / location — email / phone / address are owned by the core regex
 * recognizer, and `MISC` is too noisy for PII.
 *
 * ## Two things the pipeline does NOT do for us
 * 1. **No aggregation.** transformers.js v3's `token-classification` pipeline
 *    returns raw per-token BIO (`B-PER` / `I-ORG` / `##`-prefixed subwords) — its
 *    `TokenClassificationPipelineOptions` type has no `aggregation_strategy`, and
 *    passing one is a no-op for BERT tokenizers. So {@link stitchBioTokens}
 *    merges BIO runs and {@link joinWordPieces} reassembles subwords ourselves.
 * 2. **No reliable offsets (#359).** It reports `start` / `end` as `null` for
 *    BERT tokenizers, and the surface can carry `##` joins and stray spaces. So we
 *    never trust the pipeline's offsets or `word` for the emitted value:
 *    {@link relocateEntities} re-locates each entity in the SOURCE text with a
 *    forward-moving cursor and slices the exact substring — which is what lets the
 *    (value-based) pseudonymizer swap real text.
 */

import path from "node:path";
import type { EntitySpan, PiiEntityRecognizer } from "@elizaos/core";
import { canonicalKind, logger, resolveStateDir } from "@elizaos/core";

/** The default HuggingFace token-classification model this plugin loads. */
export const DEFAULT_NER_MODEL = "dslim/distilbert-NER";

/** Default minimum model confidence for an emitted span. */
export const DEFAULT_SCORE_THRESHOLD = 0.5;

/** Kinds the model produces that are meaningful PII for this layer. */
const KEPT_KINDS = new Set(["person", "org", "location"]);

/**
 * One result item from a transformers.js `token-classification` run. Two shapes
 * come through this same type:
 *
 * 1. **Grouped** — `entity_group` set (`"PER"` / `"ORG"` / `"LOC"`), `word` is the
 *    whole entity. A hypothetical aggregating pipeline yields this; we still
 *    accept it (via {@link relocateEntities}'s grouped path) for robustness.
 * 2. **Per-token BIO** — `entity` set (`"B-PER"` / `"I-PER"` / …), `word` is a
 *    single WordPiece token (with `##` continuations). This is what
 *    transformers.js v3 actually returns for `dslim/distilbert-NER`, so we stitch
 *    BIO runs ourselves ({@link stitchBioTokens}).
 *
 * Public transformers.js typings for the output are loose (`start` / `end` are
 * `number | null`); this is the exact subset we consume.
 */
export interface RawNerGroup {
  /** Aggregated label, e.g. `"PER"`, `"ORG"`, `"LOC"`, `"MISC"`. */
  readonly entity_group?: string;
  /** Per-token BIO label (`"B-PER"` / `"I-ORG"` / …) when not aggregated. */
  readonly entity?: string;
  /** The surface text — a whole entity when grouped, one WordPiece token when
   * per-token (`##`-prefixed for subword continuations). */
  readonly word: string;
  /** Confidence in `[0,1]`. */
  readonly score: number;
  /** Char start in source — often `null` for BERT tokenizers (#359). */
  readonly start?: number | null;
  /** Char end in source — often `null` for BERT tokenizers (#359). */
  readonly end?: number | null;
}

/** A BIO-stitched entity run, ready to be relocated in the source text. */
export interface StitchedEntity {
  /** Canonical kind (`person` / `org` / `location` / …) via {@link canonicalKind}. */
  readonly kind: string;
  /** Ordered WordPiece tokens; `##`-prefixed ones join the previous with no space. */
  readonly pieces: readonly string[];
  /** Mean token confidence across the run. */
  readonly score: number;
}

function baseLabel(entity: string): string {
  return entity.replace(/^[BI]-/, "");
}

/**
 * Stitch per-token BIO output into whole-entity runs. A `B-*` token opens a new
 * run; an `I-*` token (or any `##`-prefixed subword) continues the current run
 * when the base label matches; a mismatched base label closes the current run and
 * opens a new one. Non-entity (`O`) tokens close the current run. The kept-kind /
 * score filtering is applied later by {@link relocateEntities}.
 */
export function stitchBioTokens(
  tokens: readonly RawNerGroup[],
): StitchedEntity[] {
  const runs: StitchedEntity[] = [];
  let pieces: string[] = [];
  let scores: number[] = [];
  let base: string | null = null;

  const flush = () => {
    if (base !== null && pieces.length > 0) {
      runs.push({
        kind: canonicalKind(base),
        pieces: [...pieces],
        score: scores.reduce((a, b) => a + b, 0) / scores.length,
      });
    }
    pieces = [];
    scores = [];
    base = null;
  };

  for (const token of tokens) {
    const label = token.entity;
    if (!label || label === "O") {
      flush();
      continue;
    }
    const tokenBase = baseLabel(label);
    const isContinuation =
      token.word.startsWith("##") ||
      (label.startsWith("I-") && tokenBase === base);
    const isNewEntity = label.startsWith("B-") || tokenBase !== base;

    if (isContinuation && base !== null && tokenBase === base) {
      pieces.push(token.word);
      scores.push(token.score);
    } else if (isNewEntity) {
      flush();
      base = tokenBase;
      pieces.push(token.word);
      scores.push(token.score);
    } else {
      pieces.push(token.word);
      scores.push(token.score);
    }
  }
  flush();
  return runs;
}

/**
 * Reconstruct an entity's surface string from its WordPiece tokens: `##`
 * continuations join with no space, everything else joins with a single space.
 * `["North", "##wind", "Labs"]` → `"Northwind Labs"`.
 */
export function joinWordPieces(pieces: readonly string[]): string {
  let out = "";
  for (const piece of pieces) {
    if (piece.startsWith("##")) out += piece.slice(2);
    else out = out ? `${out} ${piece}` : piece;
  }
  return out.trim();
}

/** True when the results are already whole-entity groups (not per-token BIO). */
function isGrouped(results: readonly RawNerGroup[]): boolean {
  return results.some(
    (r) => typeof r.entity_group === "string" && r.entity_group.length > 0,
  );
}

/**
 * The pipeline callable this recognizer depends on: text in, raw NER results out.
 * The real one wraps `@huggingface/transformers`'
 * `pipeline('token-classification', model)`; tests inject a fake with the same
 * signature (no model download). We deliberately do NOT pass
 * `aggregation_strategy` — transformers.js v3's `TokenClassificationPipelineOptions`
 * doesn't support it, so the pipeline returns per-token BIO regardless and we
 * stitch it ourselves ({@link stitchBioTokens}).
 */
export type TokenClassifier = (text: string) => Promise<RawNerGroup[]>;

/** Builds (loads) the underlying token classifier. */
export type ClassifierFactory = (modelId: string) => Promise<TokenClassifier>;

export interface NerRecognizerOptions {
  /** Model id to load. Default {@link DEFAULT_NER_MODEL}. */
  readonly modelId?: string;
  /** Drop spans below this confidence. Default {@link DEFAULT_SCORE_THRESHOLD}. */
  readonly scoreThreshold?: number;
  /**
   * Factory that loads the token classifier. Default: the real
   * `@huggingface/transformers` pipeline. Injected in tests to avoid a download.
   */
  readonly classifierFactory?: ClassifierFactory;
}

/**
 * Strip `##` subword joins and normalize whitespace in a grouped `word` so it can
 * be located in the source text. `"New ##ark"` and `"Newark"` both normalize to
 * `"Newark"`; `"New York"` stays `"New York"`.
 */
export function normalizeGroupedWord(word: string): string {
  return word.replace(/\s*##/g, "").replace(/\s+/g, " ").trim();
}

/** Collapse all runs of whitespace to a single space (for fuzzy matching). */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

/**
 * Locate `needle` in `haystack` starting at `from`, ignoring differences in the
 * amount/kind of whitespace. Returns `[start, end)` of the matched region in the
 * ORIGINAL string (spanning any internal whitespace), or `null`.
 */
function whitespaceInsensitiveIndexOf(
  haystack: string,
  needle: string,
  from: number,
): { start: number; end: number } | null {
  const tokens = collapseWhitespace(needle).trim().split(" ").filter(Boolean);
  if (tokens.length === 0) return null;
  // Build a regex that matches the tokens separated by arbitrary whitespace.
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(escaped.join("\\s+"), "g");
  re.lastIndex = Math.max(0, from);
  const match = re.exec(haystack);
  if (!match) return null;
  return { start: match.index, end: match.index + match[0].length };
}

/**
 * Turn raw pipeline results (either whole-entity groups OR per-token BIO) into
 * {@link EntitySpan}s whose `value` is the EXACT source substring.
 *
 * Per-token BIO output is stitched into whole-entity runs first
 * ({@link stitchBioTokens}); grouped output is used directly. Either way each
 * entity's surface is reconstructed ({@link joinWordPieces} / {@link
 * normalizeGroupedWord}) and re-located against the source with a forward-moving
 * cursor — so repeated entities ("Dana" twice) map to successive occurrences
 * rather than collapsing onto the first, and the emitted offsets bracket the real
 * text (spanning intervening whitespace). Entities that cannot be located are
 * dropped (never emitted with a guessed offset). Kind mapping uses core's {@link
 * canonicalKind}; only person / org / location survive; sub-threshold and
 * too-short values are dropped.
 */
export function relocateEntities(
  text: string,
  results: readonly RawNerGroup[],
  options: { scoreThreshold?: number } = {},
): EntitySpan[] {
  const threshold = options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const spans: EntitySpan[] = [];
  if (!text) return spans;

  // Normalize both pipeline shapes to a common {kind, surface, score} list.
  const entities: {
    kind: string;
    surface: string;
    score: number;
    raw: string;
  }[] = isGrouped(results)
    ? results
        .filter((r) => (r.entity_group ?? r.entity) !== undefined)
        .map((r) => {
          const rawLabel = (r.entity_group ?? r.entity) as string;
          return {
            kind: canonicalKind(rawLabel),
            surface: normalizeGroupedWord(r.word),
            score: r.score,
            raw: r.word,
          };
        })
    : stitchBioTokens(results).map((run) => ({
        kind: run.kind,
        surface: joinWordPieces(run.pieces),
        score: run.score,
        raw: run.pieces.join(" "),
      }));

  let cursor = 0;
  for (const entity of entities) {
    if (!KEPT_KINDS.has(entity.kind)) continue;
    if (entity.score < threshold) continue;
    if (entity.surface.length < 2) continue;

    // Exact match first (fast path), then whitespace-insensitive so a stitched
    // surface with single spaces still matches irregular source whitespace and
    // its offsets span the real (possibly wider) source region.
    let start = text.indexOf(entity.surface, cursor);
    let end = start === -1 ? -1 : start + entity.surface.length;
    if (start === -1) {
      const fuzzy = whitespaceInsensitiveIndexOf(text, entity.surface, cursor);
      if (fuzzy) {
        start = fuzzy.start;
        end = fuzzy.end;
      }
    }
    if (start === -1 || end === -1) {
      // Could not locate — dropping is safer than emitting a wrong offset.
      logger.debug(
        `[PiiGuard] dropping unlocatable NER entity ${JSON.stringify(entity.raw)}`,
      );
      continue;
    }

    const slice = text.slice(start, end);
    const value = slice.trim();
    if (value.length < 2) continue;
    // Re-tighten offsets if trim removed leading/trailing whitespace.
    const trimmedStart = start + (slice.length - slice.trimStart().length);
    const trimmedEnd = trimmedStart + value.length;

    spans.push({
      kind: entity.kind,
      value,
      start: trimmedStart,
      end: trimmedEnd,
      score: entity.score,
    });
    cursor = end;
  }
  return spans;
}

// Approximate character budget for one model window. distilbert-NER caps at 512
// tokens; ~4 chars/token → ~2000 chars. We stay conservatively under that.
const WINDOW_CHARS = 1600;
const WINDOW_OVERLAP = 200;

/**
 * Split `text` into overlapping windows on whitespace boundaries so no window
 * exceeds the model's token limit. Returns each window with its char offset in
 * the source so results can be re-based onto the full text.
 */
export function chunkText(
  text: string,
  windowChars = WINDOW_CHARS,
  overlap = WINDOW_OVERLAP,
): { text: string; offset: number }[] {
  if (text.length <= windowChars) return [{ text, offset: 0 }];
  const chunks: { text: string; offset: number }[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + windowChars, text.length);
    // Prefer to break on whitespace so an entity is not split mid-token.
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(" ", end);
      if (lastSpace > start + overlap) end = lastSpace;
    }
    chunks.push({ text: text.slice(start, end), offset: start });
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

/** De-duplicate spans by (kind, start, end); prefer the higher score. */
function dedupeSpans(spans: EntitySpan[]): EntitySpan[] {
  const byKey = new Map<string, EntitySpan>();
  for (const span of spans) {
    const key = `${span.kind}:${span.start}:${span.end}`;
    const existing = byKey.get(key);
    if (!existing || (span.score ?? 0) > (existing.score ?? 0)) {
      byKey.set(key, span);
    }
  }
  return [...byKey.values()].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

/**
 * Default classifier factory: the real transformers.js pipeline. Points the
 * model cache at the eliza local-inference models dir so PII downloads share the
 * same on-disk store as other local models, and forces `fp32` (distilbert-NER
 * ships no quantized ONNX variant).
 */
const realClassifierFactory: ClassifierFactory = async (modelId) => {
  const { pipeline, env } = await import("@huggingface/transformers");
  try {
    env.cacheDir = path.join(resolveStateDir(), "local-inference", "models");
  } catch {
    // Fall back to transformers.js' default HF cache if the state dir is
    // unavailable; this is a cache-location convenience, not a correctness gate.
  }
  const pipe = await pipeline("token-classification", modelId, {
    dtype: "fp32",
  });
  return async (text) => {
    const output = await pipe(text);
    // Single-input calls return a flat TokenClassificationOutput; normalize the
    // (unused here) batched shape away and narrow to the subset we consume.
    const flat = Array.isArray(output[0]) ? output.flat() : output;
    return flat as unknown as RawNerGroup[];
  };
};

/**
 * `PiiEntityRecognizer` backed by a local distilbert-NER model. Lazy-loads the
 * pipeline on first `recognize()` (or explicit {@link load}); concurrent callers
 * share one load promise. If the load fails, `recognize()` returns `[]` and logs
 * — the layer degrades to regex-only rather than throwing.
 */
export class NerEntityRecognizer implements PiiEntityRecognizer {
  readonly name = "distilbert-ner";

  private readonly modelId: string;
  private readonly scoreThreshold: number;
  private readonly classifierFactory: ClassifierFactory;

  private classifier: TokenClassifier | null = null;
  private loadPromise: Promise<TokenClassifier | null> | null = null;
  private loadFailed = false;

  constructor(options: NerRecognizerOptions = {}) {
    this.modelId = options.modelId ?? DEFAULT_NER_MODEL;
    this.scoreThreshold = options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
    this.classifierFactory = options.classifierFactory ?? realClassifierFactory;
  }

  /** True once the model is loaded and ready to classify. */
  isReady(): boolean {
    return this.classifier !== null;
  }

  /** True if the model load was attempted and failed. */
  hasFailed(): boolean {
    return this.loadFailed;
  }

  /**
   * Load the pipeline. Idempotent and safe to call concurrently — the first call
   * starts the load, later calls await the same promise. Returns the classifier,
   * or `null` if the load failed.
   */
  load(): Promise<TokenClassifier | null> {
    if (this.classifier) return Promise.resolve(this.classifier);
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.classifierFactory(this.modelId)
      .then((classifier) => {
        this.classifier = classifier;
        logger.info(`[PiiGuard] NER model ready: ${this.modelId}`);
        return classifier;
      })
      .catch((error) => {
        this.loadFailed = true;
        logger.error(
          error instanceof Error ? error : { error },
          `[PiiGuard] NER model load failed for ${this.modelId}`,
        );
        return null;
      });
    return this.loadPromise;
  }

  async recognize(text: string): Promise<EntitySpan[]> {
    if (!text) return [];
    const classifier = await this.load();
    if (!classifier) return [];

    const spans: EntitySpan[] = [];
    for (const chunk of chunkText(text)) {
      const results = await classifier(chunk.text);
      const chunkSpans = relocateEntities(chunk.text, results, {
        scoreThreshold: this.scoreThreshold,
      });
      // Re-base offsets onto the full source text.
      for (const span of chunkSpans) {
        spans.push({
          ...span,
          start:
            span.start === undefined ? undefined : span.start + chunk.offset,
          end: span.end === undefined ? undefined : span.end + chunk.offset,
        });
      }
    }
    return dedupeSpans(spans);
  }
}
