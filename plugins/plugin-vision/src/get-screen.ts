/**
 * GET_SCREEN core (issue #9105 / M2) — token-frugal structured screen readout.
 *
 * Returns OCR text + grounded elements (id/text/bbox/semantic position) from a
 * captured frame using the registered coord-OCR service (native Windows OCR /
 * docTR / Apple Vision — zero LLM tokens). The raw image is OMITTED by default
 * (`includeImage:false`) so a CUA loop can read the screen each tick without
 * spending image tokens; it is only base64-attached when explicitly requested.
 *
 * Pure + injectable (the OCR service can be passed in) so it is unit-testable
 * without a real capture or a registered provider.
 */

import {
  getOcrWithCoordsService,
  type OcrWithCoordsService,
  readPngDimensions,
} from "./ocr-with-coords.js";

export interface GetScreenElement {
  /**
   * Monotonic 1-based Set-of-Marks number (reading order). A model can pick
   * `[3]` instead of regressing raw coordinates.
   */
  index: number;
  /** Stable per-result id. */
  id: string;
  text: string;
  /** Display-absolute [x, y, width, height]. */
  bbox: [number, number, number, number];
  /** Click target — the integer center of `bbox`, the point `index` resolves to. */
  center: { x: number; y: number };
  semantic_position: string;
  displayId: number;
}

export interface GetScreenResult {
  op: "get_screen";
  displayId: number;
  width: number;
  height: number;
  /** When the source frame was captured (ms epoch). */
  lastChangeTime: number;
  /** True when a coord-OCR provider was available and ran. */
  ocrAvailable: boolean;
  ocrText: string;
  elements: GetScreenElement[];
  elementCount: number;
  /** Base64 PNG — only present when `includeImage` was requested. */
  image?: string;
}

export interface BuildGetScreenOptions {
  pngBytes: Uint8Array;
  displayId?: number;
  includeImage?: boolean;
  includeOcr?: boolean;
  capturedAt?: number;
  /** Override for tests; defaults to the registered coord-OCR service. */
  ocrService?: OcrWithCoordsService | null;
}

export async function buildGetScreen(
  opts: BuildGetScreenOptions,
): Promise<GetScreenResult> {
  const displayId = opts.displayId ?? 0;
  const includeOcr = opts.includeOcr ?? true;
  const includeImage = opts.includeImage ?? false;
  const capturedAt = opts.capturedAt ?? 0;

  const dims = (await readPngDimensions(opts.pngBytes)) ?? {
    width: 0,
    height: 0,
  };

  const service =
    opts.ocrService !== undefined ? opts.ocrService : getOcrWithCoordsService();

  let elements: GetScreenElement[] = [];
  let ocrText = "";
  let ocrAvailable = false;

  if (includeOcr && service && opts.pngBytes.byteLength > 0) {
    ocrAvailable = true;
    const result = await service.describe({
      displayId: String(displayId),
      sourceX: 0,
      sourceY: 0,
      pngBytes: opts.pngBytes,
    });
    elements = result.blocks.map((block, i) => ({
      index: i + 1,
      id: `el-${i + 1}`,
      text: block.text,
      bbox: [block.bbox.x, block.bbox.y, block.bbox.width, block.bbox.height],
      center: {
        x: Math.round(block.bbox.x + block.bbox.width / 2),
        y: Math.round(block.bbox.y + block.bbox.height / 2),
      },
      semantic_position: block.semantic_position,
      displayId,
    }));
    ocrText = elements.map((e) => e.text).join("\n");
  }

  const out: GetScreenResult = {
    op: "get_screen",
    displayId,
    width: dims.width,
    height: dims.height,
    lastChangeTime: capturedAt,
    ocrAvailable,
    ocrText,
    elements,
    elementCount: elements.length,
  };
  if (includeImage && opts.pngBytes.byteLength > 0) {
    out.image = Buffer.from(opts.pngBytes).toString("base64");
  }
  return out;
}

/** Human-readable one-line summary for the agent reply. */
export function summarizeGetScreen(r: GetScreenResult): string {
  if (!r.ocrAvailable) {
    return `Screen captured (${r.width}x${r.height}). No OCR provider is registered, so no text was extracted.`;
  }
  if (r.elementCount === 0) {
    return `Screen captured (${r.width}x${r.height}); no text was detected on it.`;
  }
  const preview = r.elements
    .slice(0, 8)
    .filter((e) => e.text)
    .map((e) => `[${e.index}] ${e.text}`)
    .join(" | ");
  return `Screen captured (${r.width}x${r.height}). ${r.elementCount} text element(s) detected: ${preview}${r.elementCount > 8 ? " …" : ""}`;
}
