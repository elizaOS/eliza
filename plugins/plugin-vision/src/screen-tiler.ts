/**
 * Overlap-aware screen tiler for the eliza-1 (Qwen3.5-VL) vision pipeline.
 *
 * Why this exists:
 *   Qwen3.5-VL has a sweet-spot input edge of ~1024-1568 px. A native ultra-
 *   wide or DPI-dense capture (e.g. 5120x2160 or a Retina 6K panel) gets
 *   resized down by the model preprocessor, which destroys small UI text and
 *   makes OCR-class detail unreadable in a single pass. We instead split the
 *   capture into a grid of tiles, each at or below the model's optimal edge,
 *   with a configurable pixel overlap so words/glyphs that straddle a seam
 *   still appear intact in at least one tile.
 *
 * Coordinates:
 *   Every emitted tile carries `sourceX/sourceY` in the source display's
 *   native pixel space. Combined with `displayId`, the agent can reconstruct
 *   absolute on-screen coordinates for any pixel inside a tile (see
 *   `reconstructAbsoluteCoords`). This is what lets the planner click the
 *   thing the model just read.
 */
import sharp from "sharp";

/**
 * One output tile from `tileScreenshot`.
 *
 * - `sourceX/sourceY` are absolute pixel coords in the *source display's*
 *   native space (i.e. the same space `displayId` is reported in by
 *   `plugin-computeruse/src/platform/displays.ts`).
 * - `tileW/tileH` are the actual rendered dimensions of `pngBytes` and may
 *   equal `sourceW/sourceH` (no resize) — the tiler does not downscale; it
 *   only crops. Resizing is the model preprocessor's job.
 */
export interface ScreenTile {
  /** Stable id of the form `tile-<row>-<col>`. */
  id: string;
  /** Display this tile was sourced from. Stringified to keep types narrow. */
  displayId: string;
  /** Top-left X of the tile in the source display's pixel space. */
  sourceX: number;
  /** Top-left Y of the tile in the source display's pixel space. */
  sourceY: number;
  /** Width of the cropped region in source pixels. */
  sourceW: number;
  /** Height of the cropped region in source pixels. */
  sourceH: number;
  /** Pixel width of `pngBytes`. Equal to `sourceW` (no resize). */
  tileW: number;
  /** Pixel height of `pngBytes`. Equal to `sourceH` (no resize). */
  tileH: number;
  /** PNG-encoded crop. */
  pngBytes: Buffer;
}

export interface TileScreenshotInput {
  displayId: string;
  width: number;
  height: number;
  pngBytes: Buffer;
}

export interface TileScreenshotOptions {
  /** Maximum tile edge in pixels. Tiles never exceed this in either dim. */
  maxEdge: number;
  /**
   * Fraction of `tileSize` that adjacent tiles overlap. 0.12 (default) is
   * tuned for Qwen3.5-VL — large enough to keep multi-glyph tokens intact
   * across seams, small enough to keep tile count near minimum.
   */
  overlapFraction: number;
}

/** Default Qwen3.5-VL-friendly tile budget. */
export const DEFAULT_MAX_EDGE = 1280;
/** Default seam overlap (12%). */
export const DEFAULT_OVERLAP_FRACTION = 0.12;

/**
 * Tile a captured screenshot into Qwen3.5-VL-sized PNG patches with
 * pixel-overlap between neighbours.
 *
 * Single-tile fast path: when both dims fit within `maxEdge`, the input is
 * returned as a single `ScreenTile` whose pngBytes is the unmodified input.
 *
 * Grid path: chooses the smallest grid (cols, rows) such that no individual
 * tile exceeds `maxEdge`, then computes a per-axis stride that yields
 * `overlapFraction * tileSize` of overlap between adjacent tiles. The last
 * column/row is anchored to the source's right/bottom edge so we never
 * extend past the screen.
 */
export async function tileScreenshot(
  input: TileScreenshotInput,
  opts: TileScreenshotOptions = {
    maxEdge: DEFAULT_MAX_EDGE,
    overlapFraction: DEFAULT_OVERLAP_FRACTION,
  },
): Promise<ScreenTile[]> {
  const { displayId, width, height, pngBytes } = input;
  validateInput(width, height, pngBytes);
  const { maxEdge, overlapFraction } = opts;
  validateOptions(maxEdge, overlapFraction);

  if (width <= maxEdge && height <= maxEdge) {
    return [
      {
        id: "tile-0-0",
        displayId,
        sourceX: 0,
        sourceY: 0,
        sourceW: width,
        sourceH: height,
        tileW: width,
        tileH: height,
        pngBytes,
      },
    ];
  }

  const cols = Math.max(1, Math.ceil(width / maxEdge));
  const rows = Math.max(1, Math.ceil(height / maxEdge));
  const tileWidth = Math.min(maxEdge, Math.ceil(width / cols + maxEdge * overlapFraction));
  const tileHeight = Math.min(maxEdge, Math.ceil(height / rows + maxEdge * overlapFraction));
  // Stride between top-left corners of adjacent tiles. With a single tile per
  // axis, stride is the full width/height — no overlap math needed.
  const strideX = cols > 1 ? Math.floor((width - tileWidth) / (cols - 1)) : tileWidth;
  const strideY = rows > 1 ? Math.floor((height - tileHeight) / (rows - 1)) : tileHeight;

  const image = sharp(pngBytes);
  const tiles: ScreenTile[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      // Anchor the last col/row to the source's far edge so we never crop
      // outside [0, width)/[0, height). All other tiles slide by stride.
      const sourceX = col === cols - 1 ? width - tileWidth : col * strideX;
      const sourceY = row === rows - 1 ? height - tileHeight : row * strideY;
      const sx = Math.max(0, sourceX);
      const sy = Math.max(0, sourceY);
      const sw = Math.min(tileWidth, width - sx);
      const sh = Math.min(tileHeight, height - sy);
      const cropped = await image
        .clone()
        .extract({ left: sx, top: sy, width: sw, height: sh })
        .png()
        .toBuffer();
      tiles.push({
        id: `tile-${row}-${col}`,
        displayId,
        sourceX: sx,
        sourceY: sy,
        sourceW: sw,
        sourceH: sh,
        tileW: sw,
        tileH: sh,
        pngBytes: cropped,
      });
    }
  }
  return tiles;
}

/**
 * Map a (localX, localY) inside a tile back to the source display's
 * absolute pixel coordinates. Use this to translate "model said click at
 * (x, y) inside tile-0-1" into a coordinate the input driver can act on.
 */
export function reconstructAbsoluteCoords(
  tile: ScreenTile,
  localX: number,
  localY: number,
): { displayId: string; absoluteX: number; absoluteY: number } {
  if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
    throw new Error(
      `[ScreenTiler] reconstructAbsoluteCoords requires finite local coords, got (${localX}, ${localY})`,
    );
  }
  if (localX < 0 || localX > tile.tileW || localY < 0 || localY > tile.tileH) {
    throw new Error(
      `[ScreenTiler] local coords (${localX}, ${localY}) out of tile bounds (${tile.tileW}x${tile.tileH})`,
    );
  }
  return {
    displayId: tile.displayId,
    absoluteX: tile.sourceX + localX,
    absoluteY: tile.sourceY + localY,
  };
}

function validateInput(width: number, height: number, pngBytes: Buffer): void {
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(`[ScreenTiler] width must be a positive integer, got ${width}`);
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new Error(`[ScreenTiler] height must be a positive integer, got ${height}`);
  }
  if (!Buffer.isBuffer(pngBytes) || pngBytes.length === 0) {
    throw new Error("[ScreenTiler] pngBytes must be a non-empty Buffer");
  }
}

function validateOptions(maxEdge: number, overlapFraction: number): void {
  if (!Number.isInteger(maxEdge) || maxEdge < 64) {
    throw new Error(
      `[ScreenTiler] maxEdge must be an integer >= 64, got ${maxEdge}`,
    );
  }
  if (!Number.isFinite(overlapFraction) || overlapFraction < 0 || overlapFraction >= 1) {
    throw new Error(
      `[ScreenTiler] overlapFraction must be in [0, 1), got ${overlapFraction}`,
    );
  }
}
