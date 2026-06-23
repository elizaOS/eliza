/**
 * Pure element-merge core for the GET_SCREEN action (#9105 Slice 2 / M2).
 *
 * GET_SCREEN returns a cheap, token-frugal list of grounded, clickable screen
 * elements unified from three sources: OCR text boxes, accessibility (AX)
 * clickables, and (optionally) VLM-detected elements. This module is the
 * deterministic heart of that envelope — it collapses the three sources into a
 * single deduplicated, stably-ordered element list, recording each element's
 * `groundingSources` provenance.
 *
 * Like the M1 OCR bridge (`computeruse-ocr-bridge.ts`), this is intentionally
 * dependency-free and pure: the source types live in `@elizaos/plugin-computeruse`
 * (`SceneOcrBox` / `SceneAxNode` / `SceneVlmElement`), but we describe their
 * shapes STRUCTURALLY here rather than importing them, to keep the no-hard-dep
 * rule. That also makes the merge engine fully unit-testable with zero
 * environment, decoupled from the runtime/native/model wiring (Slice 3).
 */

/** Display-local bounding box `[x, y, w, h]`. */
export type Bbox = readonly [number, number, number, number];

/** Structural shape of computeruse's `SceneOcrBox`. */
export interface OcrBoxLike {
  readonly id: string;
  readonly text: string;
  readonly bbox: Bbox;
  readonly conf?: number;
  readonly displayId: number;
}

/** Structural shape of computeruse's `SceneAxNode`. */
export interface AxNodeLike {
  readonly id: string;
  readonly role: string;
  readonly label?: string;
  readonly bbox: Bbox;
  readonly actions?: readonly string[];
  readonly displayId: number;
}

/** Structural shape of computeruse's `SceneVlmElement`. */
export interface VlmElementLike {
  readonly id: string;
  readonly kind: string;
  readonly desc: string;
  readonly bbox: Bbox;
  readonly displayId: number;
}

export type GroundingSource = "ocr" | "ax" | "vlm";

/** A single unified, grounded screen element in the GET_SCREEN envelope. */
export interface GetScreenElement {
  /** Stable id, preferring the AX id, then OCR, then VLM. */
  id: string;
  /** Display-local bbox `[x, y, w, h]` of the representative (highest-priority) source. */
  bbox: [number, number, number, number];
  /** User-facing text/label: AX label, else OCR text, else VLM description. */
  text: string;
  /** Element kind/role when known: AX role, else VLM kind. */
  kind?: string;
  displayId: number;
  /** AX actions when the element is accessibility-grounded. */
  actions?: string[];
  /** Provenance — every source that contributed to this element, in fixed
   * `ocr < ax < vlm` order for stability. Always non-empty. */
  groundingSources: GroundingSource[];
}

export interface MergeScreenInput {
  readonly ocr?: readonly OcrBoxLike[];
  readonly ax?: readonly AxNodeLike[];
  readonly vlm?: readonly VlmElementLike[];
}

export interface MergeScreenOptions {
  /** Boxes whose IoU exceeds this collapse into one element (default 0.6). */
  readonly iouThreshold?: number;
}

const DEFAULT_IOU_THRESHOLD = 0.6;

/** Intersection-over-union of two `[x, y, w, h]` boxes. 0 when either is empty
 * or they don't overlap. */
export function bboxIou(a: Bbox, b: Bbox): number {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  if (aw <= 0 || ah <= 0 || bw <= 0 || bh <= 0) return 0;
  const ix = Math.max(ax, bx);
  const iy = Math.max(ay, by);
  const ix2 = Math.min(ax + aw, bx + bw);
  const iy2 = Math.min(ay + ah, by + bh);
  const iw = Math.max(0, ix2 - ix);
  const ih = Math.max(0, iy2 - iy);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}

interface Cluster {
  displayId: number;
  bbox: Bbox;
  ax?: AxNodeLike;
  ocr?: OcrBoxLike;
  vlm?: VlmElementLike;
}

/** Stable sort key: top-to-bottom, then left-to-right, then by id for ties. */
function byPosition(
  a: { bbox: Bbox; id: string },
  b: { bbox: Bbox; id: string },
): number {
  return (
    a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0] || a.id.localeCompare(b.id)
  );
}

/**
 * Merge OCR boxes + AX clickables + VLM elements into one deduplicated,
 * deterministically-ordered element list.
 *
 * - Elements from different sources whose bboxes overlap above `iouThreshold`
 *   (and share a `displayId`) collapse into one element that records all
 *   contributing sources in `groundingSources`.
 * - Field precedence is AX > OCR > VLM (AX wins id/label/role; OCR text fills
 *   in when AX has no label; VLM desc is the last resort).
 * - Output order is top-to-bottom, then left-to-right, so the envelope is
 *   stable across turns regardless of input ordering.
 * - Degrades gracefully: any source may be absent/empty (e.g. accessibility off)
 *   and the function never throws.
 */
export function mergeScreenElements(
  input: MergeScreenInput,
  options: MergeScreenOptions = {},
): GetScreenElement[] {
  const threshold = options.iouThreshold ?? DEFAULT_IOU_THRESHOLD;
  const clusters: Cluster[] = [];

  const attach = (
    displayId: number,
    bbox: Bbox,
    set: (c: Cluster) => void,
  ): void => {
    const match = clusters.find(
      (c) => c.displayId === displayId && bboxIou(c.bbox, bbox) >= threshold,
    );
    if (match) {
      set(match);
      return;
    }
    const cluster: Cluster = { displayId, bbox };
    set(cluster);
    clusters.push(cluster);
  };

  // Process in precedence order so a cluster's representative bbox is set by its
  // highest-priority contributing source, and pre-sort each source by position
  // so cluster creation order is deterministic.
  for (const ax of [...(input.ax ?? [])].sort(byPosition)) {
    attach(ax.displayId, ax.bbox, (c) => {
      if (!c.ax) c.ax = ax;
    });
  }
  for (const ocr of [...(input.ocr ?? [])].sort(byPosition)) {
    attach(ocr.displayId, ocr.bbox, (c) => {
      if (!c.ocr) c.ocr = ocr;
    });
  }
  for (const vlm of [...(input.vlm ?? [])].sort(byPosition)) {
    attach(vlm.displayId, vlm.bbox, (c) => {
      if (!c.vlm) c.vlm = vlm;
    });
  }

  const elements = clusters.map((c): GetScreenElement => {
    const groundingSources: GroundingSource[] = [];
    if (c.ocr) groundingSources.push("ocr");
    if (c.ax) groundingSources.push("ax");
    if (c.vlm) groundingSources.push("vlm");

    const id = c.ax?.id ?? c.ocr?.id ?? c.vlm?.id ?? "el";
    const text = c.ax?.label || c.ocr?.text || c.vlm?.desc || "";
    const kind = c.ax?.role ?? c.vlm?.kind;
    const [x, y, w, h] = c.bbox;

    const element: GetScreenElement = {
      id,
      bbox: [x, y, w, h],
      text,
      displayId: c.displayId,
      groundingSources,
    };
    if (kind !== undefined) element.kind = kind;
    if (c.ax?.actions && c.ax.actions.length > 0) {
      element.actions = [...c.ax.actions];
    }
    return element;
  });

  return elements.sort(byPosition);
}
