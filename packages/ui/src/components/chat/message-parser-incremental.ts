/**
 * Prefix-cached streaming wrapper around `parseSegments` (#15280).
 *
 * Both chat surfaces re-parse an in-flight assistant turn on every rAF flush.
 * `parseSegments` is a pure full-text scan, so a turn of N frames over a reply
 * of length L costs O(N·L) ≈ O(L²). This wrapper caches the last-parsed text,
 * its normalized target, and the `Segment[]`, then on the next (tail-growing)
 * frame re-normalizes and re-parses only the changed tail, splicing it onto a
 * verified-stable prefix — O(delta) per frame in the common case.
 *
 * CORRECTNESS DOCTRINE: the incremental path is taken only while a set of
 * conservative seam invariants hold; the moment anything is uncertain it falls
 * back to a full `parseSegments`, which is never wrong (only slower). Output is
 * therefore byte-identical to the full parser at every frame — proven by the
 * frame-by-frame differential in `message-parser-incremental.test.ts`. When a
 * cut cannot advance (an open construct pins it) the tail simply stays large and
 * work degrades toward today's full scan, never toward wrong output. Analysis
 * mode is not incrementalized (a diagnostic view, not the streaming hot path):
 * it identity-memoizes and otherwise full-parses.
 */

import {
  collectSegmentRegions,
  interleaveSegments,
  MAX_DISPLAY_LEN,
  normalizeDisplayCore,
  normalizeDisplayText,
  parserWork,
  parseSegments,
  SEGMENT_TRIGGER_RE,
  type Segment,
  type SegmentRegion,
} from "./message-parser-helpers";
import { getInlineWidgetOpenTokens } from "./widgets/inline-registry";

/** `"action":"permission_request"` — the substring `parsePermissionRequestFromText` requires. */
const PERMISSION_MARKER = '"action":"permission_request"';

/**
 * Opaque per-component cache. Held in a React ref by {@link useParsedSegments};
 * one instance per mounted transcript row / overlay bubble, so no message-id
 * plumbing is needed. `null` means "no valid history — full parse".
 */
export interface StreamingParseCache {
  /** Exact raw text this cache was built from. */
  readonly raw: string;
  readonly analysisMode: boolean;
  /** Normalized (or raw, analysis mode) parse target for `raw`. */
  readonly target: string;
  /** Full `Segment[]` for `target` (returned verbatim on an identity hit). */
  readonly segments: Segment[];
  /** True once `target` contains a `SEGMENT_TRIGGER_RE` character. */
  readonly hasTrigger: boolean;
  /** True once the message parsed as a permission card (full-parsed each frame). */
  readonly permissionMode: boolean;
  /** Segments fully inside `[0, targetStableCut)` — reused by reference. */
  readonly stableSegments: Segment[];
  /** Monotone offset in `target`; always a region boundary, never mid-prose. */
  readonly targetStableCut: number;
  /**
   * Verified-stable prefix of `normalizeDisplayCore(raw)` — equal to
   * `normalizeDisplayCore(raw.slice(0, normRawCut))`. Grows monotonically; the
   * seam property (`computeSafeNormCut`) guarantees the split is clean.
   */
  readonly normStableCore: string;
  /** Raw offset whose normalized-core prefix is `normStableCore`. */
  readonly normRawCut: number;
}

export interface StreamingParseResult {
  segments: Segment[];
  cache: StreamingParseCache;
}

const HIDDEN_BLOCK_RE =
  /<(think|analysis|reasoning|tool_calls?|tools?)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;

/**
 * Largest raw offset `c ≥ fromCut` such that `normalizeDisplayCore` splits
 * cleanly there — `core(raw) === core(raw.slice(0,c)) + core(raw.slice(c))` —
 * and stays clean as raw grows at its tail. `normalizeDisplayCore`'s passes only
 * reach across a boundary via whitespace, an open `(`, a dangling `<`, an
 * unterminated `*`/`_` span, or an unclosed hidden block; a cut right after a
 * newline whose next char is non-whitespace and not `)`, with the prefix free of
 * dangling `<` and open/spanning hidden blocks, blocks all of them (proven by
 * the seam property test). Scans only `raw[fromCut..]` — `fromCut` is a prior
 * safe cut, so no hidden block spans it and no `<` dangles into it.
 */
export function computeSafeNormCut(raw: string, fromCut: number): number {
  // Hidden blocks intersecting [fromCut, end) all start at ≥ fromCut (fromCut is
  // clean). Detect them in the tail window only.
  const window = raw.slice(fromCut);
  const closed: Array<{ start: number; end: number }> = [];
  let unclosedFrom = raw.length + 1;
  HIDDEN_BLOCK_RE.lastIndex = 0;
  for (
    let m = HIDDEN_BLOCK_RE.exec(window);
    m !== null;
    m = HIDDEN_BLOCK_RE.exec(window)
  ) {
    const start = fromCut + m.index;
    const end = start + m[0].length;
    if (/<\/[a-z_]+\s*>$/i.test(m[0])) {
      closed.push({ start, end });
    } else {
      unclosedFrom = start;
      break;
    }
  }
  const insideClosedBlock = (i: number): boolean =>
    closed.some((b) => i > b.start && i < b.end);

  let openLtAt = -1; // dangling '<' with no later '>' (clean ⇒ -1 at fromCut)
  let bestCut = fromCut;
  for (let i = fromCut + 1; i < raw.length; i++) {
    const prev = raw[i - 1];
    if (prev === "<") openLtAt = i - 1;
    else if (prev === ">") openLtAt = -1;
    if (i > unclosedFrom) break;

    if (prev !== "\n") continue;
    const next = raw[i];
    if (next === "\n" || next === " " || next === "\t" || next === "\r")
      continue;
    if (next === ")") continue;
    if (openLtAt !== -1) continue;
    if (insideClosedBlock(i)) continue;
    if (i > unclosedFrom) break;
    bestCut = i;
  }
  return bestCut;
}

/** Count of ` ``` ` fence delimiters in `text[from..to)`. */
function fenceCount(text: string, from: number, to: number): number {
  let count = 0;
  let i = text.indexOf("```", from);
  while (i !== -1 && i < to) {
    count += 1;
    i = text.indexOf("```", i + 3);
  }
  return count;
}

/**
 * Does prose gap `text[from..to)` hold an open marker (a widget open token or
 * `[CONFIG`) whose closer could arrive later and retroactively claim across the
 * cut? Such a gap pins the parse cut.
 */
function proseHasOpenMarker(
  text: string,
  from: number,
  to: number,
  openTokens: readonly string[],
): boolean {
  if (from >= to) return false;
  const gap = text.slice(from, to);
  if (!gap.includes("[")) return false;
  if (gap.includes("[CONFIG")) return true;
  for (const token of openTokens) if (gap.includes(token)) return true;
  return false;
}

/**
 * Is `r` a patch-derived ui-spec that a later patch line could still extend?
 * `findPatchRegions` merges consecutive patch lines across any run of blank
 * lines, so a patch block is not sealed until a definitively non-patch line
 * follows it. It stays unsealed while the text after it is all-blank (a patch
 * could still arrive) or its first non-blank line begins with `{` (a partial
 * patch that could complete and merge). Fenced-JSON ui-specs (region text starts
 * with a backtick) do not merge and are excluded.
 */
function isMergeablePatchTail(r: SegmentRegion, target: string): boolean {
  if (r.segment.kind !== "ui-spec") return false;
  if (!target.slice(r.start, r.end).trimStart().startsWith("{")) return false;
  const after = target.slice(r.end);
  if (after.trim().length === 0) return true;
  const firstLine = after.split("\n").find((l) => l.trim().length > 0) ?? "";
  return firstLine.trimStart().startsWith("{");
}

/**
 * Return `segment` with any absolute char offsets its payload carries shifted by
 * `by`. Only widget payloads embed offsets (the `InlineWidgetMatch` `start`/`end`
 * mirrored into `data`); every other segment kind is returned untouched. A
 * plugin widget that stores offsets somewhere other than top-level `start`/`end`
 * forfeits exact incremental parity for those nested fields (correctness of the
 * rendered widget is unaffected — the region bounds themselves are always
 * shifted).
 */
function shiftSegmentOffsets(segment: Segment, by: number): Segment {
  if (by === 0 || segment.kind !== "widget") return segment;
  const data = segment.data;
  if (!data || typeof data !== "object") return segment;
  const record = data as Record<string, unknown>;
  const start = record.start;
  const end = record.end;
  if (typeof start !== "number" && typeof end !== "number") return segment;
  return {
    ...segment,
    data: {
      ...record,
      ...(typeof start === "number" ? { start: start + by } : {}),
      ...(typeof end === "number" ? { end: end + by } : {}),
    },
  };
}

/** Rebuild the cache from scratch with a full parse. */
function fullRebuild(raw: string, analysisMode: boolean): StreamingParseResult {
  const target = analysisMode ? raw : normalizeDisplayText(raw);
  const segments = parseSegments(raw, analysisMode);
  const cache: StreamingParseCache = {
    raw,
    analysisMode,
    target,
    segments,
    hasTrigger: SEGMENT_TRIGGER_RE.test(target),
    permissionMode: !analysisMode && target.includes(PERMISSION_MARKER),
    stableSegments: [],
    targetStableCut: 0,
    normStableCore: "",
    normRawCut: 0,
  };
  return { segments, cache };
}

/**
 * Parse `text` reusing `cache` when the change is a pure tail append. Returns
 * fresh segments plus the next cache; pass the previous frame's cache back in.
 */
export function parseSegmentsStreaming(
  text: string,
  analysisMode: boolean,
  cache: StreamingParseCache | null,
): StreamingParseResult {
  if (
    !cache ||
    cache.analysisMode !== analysisMode ||
    !text.startsWith(cache.raw)
  ) {
    return fullRebuild(text, analysisMode);
  }
  if (text === cache.raw) return { segments: cache.segments, cache };
  if (analysisMode) return fullRebuild(text, analysisMode);

  // The full display normalizer truncates the raw input before every other pass.
  // When a stream crosses that boundary, a cached stable prefix may already hold
  // bytes from before the cut; rebuild once so the incremental target stays
  // byte-identical to the full parser's frozen 200k window.
  if (text.length >= MAX_DISPLAY_LEN) {
    return fullRebuild(text, analysisMode);
  }

  // Past MAX_DISPLAY_LEN the normalized target is frozen (the core slices first),
  // so nothing downstream changes — reuse verbatim.
  if (cache.raw.length >= MAX_DISPLAY_LEN) {
    return { segments: cache.segments, cache };
  }

  // ── Incremental normalize (clean-seam splice) ─────────────────────
  const normRawCut = computeSafeNormCut(text, cache.normRawCut);
  const windowCore =
    normRawCut > cache.normRawCut
      ? normalizeDisplayCore(text.slice(cache.normRawCut, normRawCut))
      : "";
  const normStableCore = cache.normStableCore + windowCore;
  const tailCore = normalizeDisplayCore(text.slice(normRawCut));
  const target = (normStableCore + tailCore).trim();

  // Seam guard: the new target must extend the previously-stable target prefix.
  // A back-reaching rewrite that crossed the cut breaks this → full parse.
  if (
    cache.targetStableCut > 0 &&
    !target.startsWith(cache.target.slice(0, cache.targetStableCut))
  ) {
    return fullRebuild(text, analysisMode);
  }

  if (!target) {
    const segments: Segment[] = [{ kind: "text", text: "" }];
    return {
      segments,
      cache: {
        ...cache,
        raw: text,
        target,
        segments,
        hasTrigger: false,
        permissionMode: false,
        stableSegments: [],
        targetStableCut: 0,
        normStableCore,
        normRawCut,
      },
    };
  }

  // ── Trigger fast path — never touch the region scan on pure prose ──
  const hasTrigger = cache.hasTrigger || SEGMENT_TRIGGER_RE.test(target);
  if (!hasTrigger) {
    const segments: Segment[] = [{ kind: "text", text: target }];
    parserWork.incrementalParses += 1;
    return {
      segments,
      cache: {
        ...cache,
        raw: text,
        target,
        segments,
        hasTrigger: false,
        permissionMode: false,
        stableSegments: [],
        targetStableCut: 0,
        normStableCore,
        normRawCut,
      },
    };
  }

  // ── Permission bypass — its `display` grows, so it can't be spliced ──
  const permissionMode =
    cache.permissionMode || target.includes(PERMISSION_MARKER);
  if (permissionMode) {
    const rebuilt = fullRebuild(text, analysisMode);
    return {
      segments: rebuilt.segments,
      cache: {
        ...rebuilt.cache,
        permissionMode: true,
        normStableCore,
        normRawCut,
      },
    };
  }

  // ── Tail region scan ──────────────────────────────────────────────
  // Scan from exactly the stable cut. It is always a region END (never
  // mid-prose), so no region straddles it, and every later patch line / fenced
  // block / marker still begins on its own line within the slice. Scanning from
  // the line START instead would re-include a previous block's closing ``` fence
  // and mis-pair it with the next block's opener.
  const prevCut = cache.targetStableCut;
  const scanStart = prevCut;
  const rawTail = collectSegmentRegions(target.slice(scanStart), analysisMode);
  const tailRegions: SegmentRegion[] = [];
  for (const r of rawTail) {
    const start = r.start + scanStart;
    if (start < prevCut) continue; // already covered by stableSegments
    tailRegions.push({
      start,
      end: r.end + scanStart,
      // Widget payloads carry the match's own `start`/`end` (the region bounds
      // in whatever text the parser saw). Scanning a slice makes those
      // slice-relative; shift them back to absolute so the payload — and any
      // React key derived from it — is byte-identical to the full parse.
      segment: shiftSegmentOffsets(r.segment, scanStart),
    });
  }

  const sortedTail = [...tailRegions].sort((a, b) => a.start - b.start);
  const tail = interleaveSegments(target, sortedTail, prevCut);
  const segments =
    cache.stableSegments.length === 0 && sortedTail.length === 0
      ? [{ kind: "text" as const, text: target }]
      : cache.stableSegments.concat(tail);

  // ── Advance the stable cut to the end of the last finalized region ──
  const openTokens = getInlineWidgetOpenTokens();
  let newCut = prevCut;
  let cutRegionCount = 0;
  let cursor = prevCut;
  let fenceParity = 0;
  for (let idx = 0; idx < sortedTail.length; idx++) {
    const r = sortedTail[idx];
    if (r.start < cursor) continue;
    fenceParity += fenceCount(target, cursor, r.start);
    if (fenceParity % 2 !== 0) break;
    if (proseHasOpenMarker(target, cursor, r.start, openTokens)) break;
    cursor = r.end;
    if (r.end >= target.length) break; // no content after ⇒ closer not confirmed
    if (isMergeablePatchTail(r, target)) break;
    newCut = r.end;
    cutRegionCount = idx + 1;
  }

  let stableSegments = cache.stableSegments;
  let targetStableCut = prevCut;
  if (newCut > prevCut) {
    // Interleave over `target.slice(0, newCut)` so the walk stops at the last
    // finalized region's end — never appending the still-growing trailing prose
    // (that lives in the live tail and would otherwise freeze as a stale
    // duplicate text segment).
    stableSegments = cache.stableSegments.concat(
      interleaveSegments(
        target.slice(0, newCut),
        sortedTail.slice(0, cutRegionCount),
        prevCut,
      ),
    );
    targetStableCut = newCut;
  }

  parserWork.incrementalParses += 1;
  return {
    segments,
    cache: {
      raw: text,
      analysisMode,
      target,
      segments,
      hasTrigger: true,
      permissionMode: false,
      stableSegments,
      targetStableCut,
      normStableCore,
      normRawCut,
    },
  };
}
