/**
 * OCR-with-coords — hierarchical (block / line / word) OCR with absolute
 * source-display coordinates and a coarse semantic position label per
 * recognized text element.
 *
 * Why this lives in plugin-vision:
 *   - plugin-computeruse needs OCR with coordinates so action targets can be
 *     computed in display-absolute coordinates without re-running detection.
 *   - It cannot take a runtime dep on plugin-vision (which would invert the
 *     layering: computeruse is the higher-level seam and plugin-vision must
 *     stay Node-importable on hosts that don't ship the action surface).
 *   - Mirroring the pattern used by `AppleVisionOcrProvider` in
 *     `./ocr-service.ts`, plugin-vision exports a structural interface plus a
 *     registry seam (`registerCoordOcrProvider` lives in
 *     plugin-computeruse/src/mobile/ocr-provider.ts) that the runtime wires up
 *     at boot.
 *
 * Phase 1 (this file): define the canonical `OcrWithCoordsService` interface,
 * ship a transitional adapter (`RapidOcrCoordAdapter`) backed by the existing
 * `RapidOCRService`, and compute `semantic_position` deterministically from
 * the bbox center against tile-relative thirds.
 *
 * Phase 2 (TODO — see `packages/native-plugins/doctr-cpp/AGENTS.md`): replace
 * the adapter with `DoctrCoordOcrService`, which calls into the doctr-cpp
 * native plugin (db_resnet50 + crnn_vgg16_bn ported to ggml, dispatched by
 * the same elizaOS/llama.cpp fork that runs eliza-1's vision and text
 * tracks). At that point the adapter here will be removed and the native
 * implementation registered as the canonical provider.
 */

import { logger } from "@elizaos/core";
import { RapidOCRService } from "./ocr-service-rapid";
import type { BoundingBox } from "./types";

/** Coarse 3x3 location of a text element relative to the source tile. */
export type SemanticPosition =
  | "upper-left"
  | "upper-center"
  | "upper-right"
  | "middle-left"
  | "center"
  | "middle-right"
  | "lower-left"
  | "lower-center"
  | "lower-right";

export interface OcrWithCoordsWord {
  readonly text: string;
  /** Absolute source-display coordinates. */
  readonly bbox: BoundingBox;
  readonly semantic_position: SemanticPosition;
}

export interface OcrWithCoordsBlock {
  readonly text: string;
  /** Absolute source-display coordinates. */
  readonly bbox: BoundingBox;
  readonly words: ReadonlyArray<OcrWithCoordsWord>;
  readonly semantic_position: SemanticPosition;
}

export interface OcrWithCoordsResult {
  readonly blocks: ReadonlyArray<OcrWithCoordsBlock>;
}

export interface OcrWithCoordsInput {
  /** Stable identifier of the source display. Echoed in logs only. */
  readonly displayId: string;
  /** Absolute X offset of the tile within the source display. */
  readonly sourceX: number;
  /** Absolute Y offset of the tile within the source display. */
  readonly sourceY: number;
  /** Encoded PNG bytes of the tile. */
  readonly pngBytes: Uint8Array;
}

export interface OcrWithCoordsService {
  readonly name: string;
  describe(input: OcrWithCoordsInput): Promise<OcrWithCoordsResult>;
}

// ── Semantic position computation ───────────────────────────────────────────

const ROW_LABELS: ReadonlyArray<"upper" | "middle" | "lower"> = [
  "upper",
  "middle",
  "lower",
];
const COL_LABELS: ReadonlyArray<"left" | "center" | "right"> = [
  "left",
  "center",
  "right",
];

/**
 * Map a bbox center to one of nine semantic positions using strict thirds
 * against the tile dimensions. Pure function — exported for tests so the
 * thirds rule has a single source of truth.
 *
 * Rule:
 *   col = floor(centerX / (tileWidth / 3)) clamped to [0, 2]
 *   row = floor(centerY / (tileHeight / 3)) clamped to [0, 2]
 *   "middle" + "center" collapses to the literal "center".
 *
 * Inputs use tile-relative coordinates so the same function works for words
 * inside their parent block too (callers can pass the parent block bbox as
 * the tile dims for word-relative labeling, but for the canonical
 * implementation here we always label against the source tile).
 */
export function computeSemanticPosition(args: {
  readonly bbox: BoundingBox;
  readonly tileWidth: number;
  readonly tileHeight: number;
}): SemanticPosition {
  const { bbox, tileWidth, tileHeight } = args;
  if (tileWidth <= 0 || tileHeight <= 0) {
    throw new Error(
      `computeSemanticPosition: tile dims must be positive (got ${tileWidth}x${tileHeight})`,
    );
  }
  const centerX = bbox.x + bbox.width / 2;
  const centerY = bbox.y + bbox.height / 2;
  const colIdx = clamp012(Math.floor((centerX * 3) / tileWidth));
  const rowIdx = clamp012(Math.floor((centerY * 3) / tileHeight));
  const row = ROW_LABELS[rowIdx];
  const col = COL_LABELS[colIdx];
  if (row === "middle" && col === "center") return "center";
  return `${row}-${col}` as SemanticPosition;
}

function clamp012(n: number): 0 | 1 | 2 {
  if (n <= 0) return 0;
  if (n >= 2) return 2;
  return 1;
}

// ── Registry seam ───────────────────────────────────────────────────────────

let registeredCoordOcrService: OcrWithCoordsService | null = null;

export function registerOcrWithCoordsService(
  service: OcrWithCoordsService | null,
): void {
  registeredCoordOcrService = service;
  logger.info(
    `[OcrWithCoords] provider ${service ? "registered" : "cleared"}${
      service?.name ? ` (${service.name})` : ""
    }`,
  );
}

export function getOcrWithCoordsService(): OcrWithCoordsService | null {
  return registeredCoordOcrService;
}

// ── Transitional RapidOCR-backed adapter ────────────────────────────────────

/**
 * @deprecated Phase 1 transitional adapter. Wraps the existing
 * `RapidOCRService` (PP-OCRv5 over onnxruntime-node) and maps its line-level
 * output to the hierarchical `OcrWithCoordsResult` shape, computing
 * `semantic_position` deterministically against the source tile thirds.
 *
 * Phase 2 target: replace with the native doctr-cpp implementation. See
 * `packages/native-plugins/doctr-cpp/AGENTS.md` for the port plan
 * (db_resnet50 detection + crnn_vgg16_bn recognition over ggml, dispatched
 * by the elizaOS/llama.cpp fork).
 */
export class RapidOcrCoordAdapter implements OcrWithCoordsService {
  readonly name = "rapid-coord-adapter (transitional, replace with doctr-cpp)";

  constructor(private readonly impl: RapidOCRService = new RapidOCRService()) {}

  async describe(input: OcrWithCoordsInput): Promise<OcrWithCoordsResult> {
    if (input.pngBytes.byteLength === 0) {
      return { blocks: [] };
    }

    const buffer = Buffer.from(input.pngBytes);
    const tileDims = await readPngDimensions(input.pngBytes);
    const ocr = await this.impl.extractText(buffer);

    const blocks: OcrWithCoordsBlock[] = ocr.blocks.map((block) => {
      // Tile-relative bbox is what RapidOCR returns; semantic position is
      // computed against the tile, then bbox is shifted into source-display
      // absolute coords.
      const tileBbox: BoundingBox = {
        x: block.bbox.x,
        y: block.bbox.y,
        width: block.bbox.width,
        height: block.bbox.height,
      };
      const blockSemantic = computeSemanticPosition({
        bbox: tileBbox,
        tileWidth: tileDims.width,
        tileHeight: tileDims.height,
      });
      const absBlockBbox = shiftBbox(tileBbox, input.sourceX, input.sourceY);

      const wordsSrc = block.words ?? [];
      const words: OcrWithCoordsWord[] = wordsSrc.map((word) => {
        const wordTileBbox: BoundingBox = {
          x: word.bbox.x,
          y: word.bbox.y,
          width: word.bbox.width,
          height: word.bbox.height,
        };
        return {
          text: word.text,
          bbox: shiftBbox(wordTileBbox, input.sourceX, input.sourceY),
          semantic_position: computeSemanticPosition({
            bbox: wordTileBbox,
            tileWidth: tileDims.width,
            tileHeight: tileDims.height,
          }),
        };
      });

      return {
        text: block.text,
        bbox: absBlockBbox,
        words,
        semantic_position: blockSemantic,
      };
    });

    return { blocks };
  }
}

function shiftBbox(b: BoundingBox, dx: number, dy: number): BoundingBox {
  return { x: b.x + dx, y: b.y + dy, width: b.width, height: b.height };
}

/**
 * Read width/height from the PNG IHDR chunk without pulling in sharp on the
 * test path. PNG signature is 8 bytes; IHDR begins at offset 8 with a 4-byte
 * length, 4-byte type ("IHDR"), then 4-byte width and 4-byte height (BE).
 *
 * Throws on malformed input so a corrupt tile surfaces immediately rather
 * than silently producing zero-sized semantic-position math.
 */
export async function readPngDimensions(
  pngBytes: Uint8Array,
): Promise<{ width: number; height: number }> {
  if (pngBytes.byteLength < 24) {
    throw new Error("readPngDimensions: input too short to be a PNG");
  }
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i += 1) {
    if (pngBytes[i] !== sig[i]) {
      throw new Error("readPngDimensions: missing PNG signature");
    }
  }
  // IHDR type bytes at offset 12..16 must be "IHDR".
  if (
    pngBytes[12] !== 0x49 ||
    pngBytes[13] !== 0x48 ||
    pngBytes[14] !== 0x44 ||
    pngBytes[15] !== 0x52
  ) {
    throw new Error("readPngDimensions: first chunk is not IHDR");
  }
  const view = new DataView(
    pngBytes.buffer,
    pngBytes.byteOffset,
    pngBytes.byteLength,
  );
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width <= 0 || height <= 0) {
    throw new Error(`readPngDimensions: invalid dimensions ${width}x${height}`);
  }
  return { width, height };
}
