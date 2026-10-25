/**
 * Set-of-Marks (SoM) grounding — #9170 M9.
 *
 * Set-of-Marks is the grounding technique trycua/cua uses via OmniParser: take
 * the icon detections (GGUF YOLO) and the OCR text boxes (the `CoordOcrProvider`
 * seam plugin-vision already feeds), fuse them into ONE deduplicated set of
 * candidate targets, draw a 1-indexed numbered box over each on the screenshot,
 * and let the VLM pick a *number* instead of raw pixel coordinates. Numeric
 * selection is far more reliable than free-floating coordinate regression.
 *
 * This module is split into:
 *   - a PURE core (`buildSetOfMarks`) — icon-over-text suppression + NMS +
 *     deterministic reading-order numbering. Dependency-free and structurally
 *     typed so it unit-tests with zero environment, mirroring
 *     `get-screen-elements.ts` and `computeruse-ocr-bridge.ts`.
 *   - a renderer (`renderSetOfMarksOverlay`) — composites a numbered SVG overlay
 *     onto the source PNG via `sharp`.
 *
 * The OmniParser fusion rules we reproduce:
 *   1. Icon-over-text suppression — a text box mostly covered by an icon box is
 *      dropped; the icon is the interactable, the text is its caption.
 *   2. Non-max suppression — overlapping boxes collapse to the highest-priority
 *      one (icons outrank text on ties), so each target is marked once.
 *   3. 1-indexed reading-order numbering — top-to-bottom, then left-to-right,
 *      with a row tolerance so a visual row isn't scrambled by sub-pixel y jitter.
 */

import { bboxIou } from "./get-screen-elements.js";

/** Display-local bounding box `[x, y, w, h]`. */
export type SomBbox = readonly [number, number, number, number];

/** Where a candidate mark came from. Icons outrank text during suppression. */
export type SomSource = "icon" | "text";

/** A raw candidate box fed into the SoM fusion. */
export interface SomCandidate {
  readonly bbox: SomBbox;
  readonly source: SomSource;
  /** Class name (icon) or recognized text (text). Optional. */
  readonly label?: string;
  /** Detector/OCR confidence in [0, 1]. Missing → treated as 0.5. */
  readonly score?: number;
}

/** A finalized, numbered mark in the overlay. */
export interface SomMark {
  /** 1-indexed mark number shown in the overlay. */
  readonly index: number;
  readonly bbox: [number, number, number, number];
  /** Box center `[x, y]` — the click target the VLM's number resolves to. */
  readonly center: [number, number];
  readonly source: SomSource;
  readonly label?: string;
  readonly score: number;
}

export interface SetOfMarksOptions {
  /**
   * A text box is dropped when this fraction of its area is covered by an icon
   * box (icon-over-text suppression). Default 0.7.
   */
  readonly iconOverTextCoverage?: number;
  /** Boxes overlapping above this IoU collapse during NMS. Default 0.5. */
  readonly nmsIouThreshold?: number;
  /**
   * Rows within this many pixels of vertical offset are treated as the same
   * reading row (so left-to-right ordering holds across a row). Default 12.
   */
  readonly rowTolerance?: number;
  /** Drop candidates with a smaller score before fusion. Default 0 (keep all). */
  readonly minScore?: number;
}

const DEFAULT_ICON_OVER_TEXT_COVERAGE = 0.7;
const DEFAULT_NMS_IOU = 0.5;
const DEFAULT_ROW_TOLERANCE = 12;
const DEFAULT_SCORE = 0.5;

interface NormCandidate {
  bbox: [number, number, number, number];
  source: SomSource;
  label?: string;
  score: number;
}

/** Area of intersection of two `[x, y, w, h]` boxes (0 when disjoint). Pure. */
function intersectionArea(a: SomBbox, b: SomBbox): number {
  const ix = Math.max(a[0], b[0]);
  const iy = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const iy2 = Math.min(a[1] + a[3], b[1] + b[3]);
  return Math.max(0, ix2 - ix) * Math.max(0, iy2 - iy);
}

/** Fraction of `inner`'s area covered by `outer` (containment ratio). Pure. */
export function coverageRatio(inner: SomBbox, outer: SomBbox): number {
  const area = inner[2] * inner[3];
  if (area <= 0) return 0;
  return intersectionArea(inner, outer) / area;
}

function isValidBox(b: SomBbox): boolean {
  return (
    Number.isFinite(b[0]) &&
    Number.isFinite(b[1]) &&
    Number.isFinite(b[2]) &&
    Number.isFinite(b[3]) &&
    b[2] > 0 &&
    b[3] > 0
  );
}

/**
 * Fuse icon + text candidates into a deduplicated, 1-indexed set of marks.
 *
 * Pure and deterministic: same inputs → identical numbering, regardless of
 * input ordering. Degenerate boxes (non-finite / zero-area) are dropped.
 */
export function buildSetOfMarks(
  candidates: readonly SomCandidate[],
  options: SetOfMarksOptions = {},
): SomMark[] {
  const iconOverText =
    options.iconOverTextCoverage ?? DEFAULT_ICON_OVER_TEXT_COVERAGE;
  const nmsIou = options.nmsIouThreshold ?? DEFAULT_NMS_IOU;
  const rowTolerance = options.rowTolerance ?? DEFAULT_ROW_TOLERANCE;
  const minScore = options.minScore ?? 0;

  const norm: NormCandidate[] = candidates
    .filter((c) => isValidBox(c.bbox))
    .map((c) => ({
      bbox: [c.bbox[0], c.bbox[1], c.bbox[2], c.bbox[3]] as [
        number,
        number,
        number,
        number,
      ],
      source: c.source,
      label: c.label,
      score: c.score ?? DEFAULT_SCORE,
    }))
    .filter((c) => c.score >= minScore);

  const icons = norm.filter((c) => c.source === "icon");
  const texts = norm.filter((c) => c.source === "text");

  // 1. Icon-over-text suppression: drop text mostly covered by some icon.
  const keptTexts = texts.filter(
    (t) =>
      !icons.some((icon) => coverageRatio(t.bbox, icon.bbox) >= iconOverText),
  );

  // 2. NMS over the survivors. Sort so icons outrank text, then by score desc,
  //    then by a stable positional key — the greedy keep is deterministic.
  const pool = [...icons, ...keptTexts].sort((a, b) => {
    if (a.source !== b.source) return a.source === "icon" ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0];
  });

  const kept: NormCandidate[] = [];
  for (const cand of pool) {
    const overlaps = kept.some((k) => bboxIou(cand.bbox, k.bbox) >= nmsIou);
    if (!overlaps) kept.push(cand);
  }

  // 3. Reading-order numbering: bucket into rows (within rowTolerance), then
  //    order rows top-to-bottom and members left-to-right.
  const ordered = [...kept].sort((a, b) => {
    const sameRow = Math.abs(a.bbox[1] - b.bbox[1]) <= rowTolerance;
    if (sameRow) return a.bbox[0] - b.bbox[0] || a.bbox[1] - b.bbox[1];
    return a.bbox[1] - b.bbox[1];
  });

  return ordered.map((c, i): SomMark => {
    const [x, y, w, h] = c.bbox;
    const mark: SomMark = {
      index: i + 1,
      bbox: [x, y, w, h],
      center: [Math.round(x + w / 2), Math.round(y + h / 2)],
      source: c.source,
      score: c.score,
    };
    if (c.label !== undefined) (mark as { label?: string }).label = c.label;
    return mark;
  });
}

/** XML-escape a label so it is safe to embed in the SVG overlay. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface SomOverlayOptions extends SetOfMarksOptions {
  /** Stroke / badge color for icon marks. Default "#FF8C00" (orange). */
  readonly iconColor?: string;
  /** Stroke / badge color for text marks. Default "#1FA9FF". */
  readonly textColor?: string;
  /** Box stroke width in px. Default 2. */
  readonly strokeWidth?: number;
  /** Badge font size in px. Default 13. */
  readonly fontSize?: number;
}

/**
 * Build the SVG overlay markup for a set of marks over a `width × height`
 * canvas. Pure (no I/O) — separated from the raster composite so it is
 * unit-testable and reusable by non-sharp consumers (e.g. a browser overlay).
 */
export function buildSetOfMarksSvg(
  marks: readonly SomMark[],
  width: number,
  height: number,
  options: SomOverlayOptions = {},
): string {
  const iconColor = options.iconColor ?? "#FF8C00";
  const textColor = options.textColor ?? "#1FA9FF";
  const strokeWidth = options.strokeWidth ?? 2;
  const fontSize = options.fontSize ?? 13;
  const badgeW = Math.round(fontSize * 1.4);
  const badgeH = Math.round(fontSize * 1.3);

  const parts: string[] = [];
  for (const mark of marks) {
    const [x, y, w, h] = mark.bbox;
    const color = mark.source === "icon" ? iconColor : textColor;
    const label = String(mark.index);
    // Badge sits just inside the top-left of the box, clamped to the canvas.
    const bx = Math.max(0, Math.min(x, width - badgeW));
    const by = Math.max(0, Math.min(y, height - badgeH));
    parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" ` +
        `stroke="${color}" stroke-width="${strokeWidth}" />`,
      `<rect x="${bx}" y="${by}" width="${badgeW}" height="${badgeH}" ` +
        `fill="${color}" />`,
      `<text x="${bx + badgeW / 2}" y="${by + badgeH / 2}" ` +
        `font-family="monospace" font-size="${fontSize}" font-weight="bold" ` +
        `fill="#000000" text-anchor="middle" dominant-baseline="central">` +
        `${escapeXml(label)}</text>`,
    );
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" ` +
    `height="${height}">${parts.join("")}</svg>`
  );
}

// ── Source adapters ─────────────────────────────────────────────────────────
//
// Turn the two grounding sources we already have — GGUF YOLO icon detections
// and `CoordOcrProvider` text blocks — into SoM candidates. Both are described
// structurally so this module keeps no hard dependency on the detector or OCR
// implementations (same no-hard-dep rule as `get-screen-elements.ts`).

/** Structural shape of a `DetectedObject` (YOLO) — `{x,y,width,height}` box. */
export interface DetectedObjectLike {
  readonly boundingBox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly type?: string;
  readonly confidence?: number;
}

/** Structural shape of an OCR block (`OcrWithCoordsBlock`). */
export interface OcrBlockLike {
  readonly text?: string;
  readonly confidence?: number;
  readonly bbox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/** Adapt GGUF YOLO detections into icon-source SoM candidates. */
export function somCandidatesFromDetections(
  objects: readonly DetectedObjectLike[],
): SomCandidate[] {
  return objects.map((o) => {
    const c: SomCandidate = {
      bbox: [
        o.boundingBox.x,
        o.boundingBox.y,
        o.boundingBox.width,
        o.boundingBox.height,
      ],
      source: "icon",
      score: o.confidence ?? DEFAULT_SCORE,
    };
    if (o.type !== undefined) (c as { label?: string }).label = o.type;
    return c;
  });
}

/** Adapt `CoordOcrProvider` text blocks into text-source SoM candidates. */
export function somCandidatesFromOcr(
  blocks: readonly OcrBlockLike[],
): SomCandidate[] {
  return blocks.map((b) => {
    const c: SomCandidate = {
      bbox: [b.bbox.x, b.bbox.y, b.bbox.width, b.bbox.height],
      source: "text",
      score: b.confidence ?? DEFAULT_SCORE,
    };
    if (b.text !== undefined) (c as { label?: string }).label = b.text;
    return c;
  });
}

/**
 * Convenience: fuse YOLO detections + OCR blocks straight into a numbered mark
 * set. The seam `detect_elements`/grounding calls — pass whatever icon and text
 * boxes the scene already has.
 */
export function buildSceneSetOfMarks(
  args: {
    readonly detections?: readonly DetectedObjectLike[];
    readonly ocrBlocks?: readonly OcrBlockLike[];
  },
  options?: SetOfMarksOptions,
): SomMark[] {
  return buildSetOfMarks(
    [
      ...somCandidatesFromDetections(args.detections ?? []),
      ...somCandidatesFromOcr(args.ocrBlocks ?? []),
    ],
    options,
  );
}

/**
 * Composite a numbered Set-of-Marks overlay onto a source PNG.
 *
 * Returns PNG bytes the same size as the input. `sharp` is loaded lazily so the
 * pure core (`buildSetOfMarks`) carries no native dependency for consumers that
 * only need coordinates.
 */
export async function renderSetOfMarksOverlay(
  pngBytes: Uint8Array,
  marks: readonly SomMark[],
  options: SomOverlayOptions = {},
): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const base = sharp(Buffer.from(pngBytes));
  const meta = await base.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new Error(
      `[vision/som] cannot overlay marks: source image has no dimensions`,
    );
  }
  const svg = buildSetOfMarksSvg(marks, width, height, options);
  return base
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}
