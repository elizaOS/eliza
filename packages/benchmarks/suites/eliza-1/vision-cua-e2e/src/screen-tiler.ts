/**
 * Local re-implementation of the overlap-aware screen tiler used by
 * plugin-vision (`plugins/plugin-vision/src/screen-tiler.ts`).
 *
 * Why duplicated here:
 *   - This harness must scaffold ahead of in-flight refactors landing in
 *     plugin-vision (Tasks 3 & 4 in the parallel batch). Importing directly
 *     would couple the harness to whichever revision of those files is on
 *     disk during a CI run.
 *   - The contract is small and stable: `tileScreenshot()` produces tiles
 *     with absolute `sourceX/sourceY` against the source display; callers
 *     reconstruct absolute coords with `reconstructAbsoluteCoords()`.
 *
 * If/when the plugin-vision tiler is exported from the package's barrel,
 * delete this file and import the real one instead.
 */

import sharp from "sharp";

export interface ScreenTile {
  readonly id: string;
  readonly displayId: string;
  readonly sourceX: number;
  readonly sourceY: number;
  readonly sourceW: number;
  readonly sourceH: number;
  readonly tileW: number;
  readonly tileH: number;
  readonly pngBytes: Buffer;
}

export interface TileScreenshotInput {
  readonly displayId: string;
  readonly width: number;
  readonly height: number;
  readonly pngBytes: Buffer;
}

export interface TileScreenshotOptions {
  readonly maxEdge: number;
  readonly overlapFraction: number;
}

const DEFAULT_MAX_EDGE = 1280;
const DEFAULT_OVERLAP_FRACTION = 0.12;

export async function tileScreenshot(
  input: TileScreenshotInput,
  opts: TileScreenshotOptions = {
    maxEdge: DEFAULT_MAX_EDGE,
    overlapFraction: DEFAULT_OVERLAP_FRACTION,
  },
): Promise<ScreenTile[]> {
  const { displayId, width, height, pngBytes } = input;
  const { maxEdge, overlapFraction } = opts;
  if (width <= 0 || height <= 0) {
    throw new Error(`tileScreenshot: invalid dims ${width}x${height}`);
  }
  if (pngBytes.length === 0) {
    throw new Error("tileScreenshot: empty pngBytes");
  }

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
  const tileWidth = Math.min(
    maxEdge,
    Math.ceil(width / cols + maxEdge * overlapFraction),
  );
  const tileHeight = Math.min(
    maxEdge,
    Math.ceil(height / rows + maxEdge * overlapFraction),
  );
  const strideX =
    cols > 1 ? Math.floor((width - tileWidth) / (cols - 1)) : tileWidth;
  const strideY =
    rows > 1 ? Math.floor((height - tileHeight) / (rows - 1)) : tileHeight;

  const image = sharp(pngBytes);
  const tiles: ScreenTile[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
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

export function reconstructAbsoluteCoords(
  tile: ScreenTile,
  localX: number,
  localY: number,
): { displayId: string; absoluteX: number; absoluteY: number } {
  if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
    throw new Error(
      `reconstructAbsoluteCoords: non-finite local coords (${localX}, ${localY})`,
    );
  }
  if (localX < 0 || localX > tile.tileW || localY < 0 || localY > tile.tileH) {
    throw new Error(
      `reconstructAbsoluteCoords: local coords (${localX}, ${localY}) out of tile bounds (${tile.tileW}x${tile.tileH})`,
    );
  }
  return {
    displayId: tile.displayId,
    absoluteX: tile.sourceX + localX,
    absoluteY: tile.sourceY + localY,
  };
}
