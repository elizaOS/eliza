import sharp from "sharp";

export const DEFAULT_MAX_EDGE = 768;
export const DEFAULT_OVERLAP_FRACTION = 0.12;

export interface ScreenshotForTiling {
  displayId: string;
  width: number;
  height: number;
  pngBytes: Buffer;
}

export interface ScreenTilerOptions {
  maxEdge?: number;
  overlapFraction?: number;
}

export interface ScreenTile {
  id: string;
  displayId: string;
  sourceX: number;
  sourceY: number;
  tileW: number;
  tileH: number;
  pngBytes: Buffer;
}

function clampMaxEdge(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) return DEFAULT_MAX_EDGE;
  return Math.max(1, Math.floor(value));
}

function clampOverlap(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) {
    return DEFAULT_OVERLAP_FRACTION;
  }
  return Math.min(0.9, Math.max(0, value));
}

function startsFor(
  length: number,
  tileLength: number,
  stride: number,
): number[] {
  if (length <= tileLength) return [0];
  const starts: number[] = [];
  for (let start = 0; start < length; start += stride) {
    starts.push(start);
    if (start + tileLength >= length) break;
  }
  const finalStart = Math.max(0, length - tileLength);
  if (starts[starts.length - 1] !== finalStart) starts.push(finalStart);
  return starts;
}

export async function tileScreenshot(
  input: ScreenshotForTiling,
  options: ScreenTilerOptions = {},
): Promise<ScreenTile[]> {
  if (input.width <= 0 || input.height <= 0) {
    throw new Error("[screen-tiler] screenshot dimensions must be positive");
  }

  const maxEdge = clampMaxEdge(options.maxEdge);
  const overlap = clampOverlap(options.overlapFraction);
  const tileW = Math.min(maxEdge, input.width);
  const tileH = Math.min(maxEdge, input.height);
  const strideX = Math.max(1, Math.floor(tileW * (1 - overlap)));
  const strideY = Math.max(1, Math.floor(tileH * (1 - overlap)));
  const xStarts = startsFor(input.width, tileW, strideX);
  const yStarts = startsFor(input.height, tileH, strideY);
  const source = sharp(input.pngBytes, { failOn: "none" });
  const tiles: ScreenTile[] = [];

  for (let row = 0; row < yStarts.length; row++) {
    const y = yStarts[row] ?? 0;
    const height = Math.min(tileH, input.height - y);
    for (let col = 0; col < xStarts.length; col++) {
      const x = xStarts[col] ?? 0;
      const width = Math.min(tileW, input.width - x);
      const pngBytes = await source
        .clone()
        .extract({ left: x, top: y, width, height })
        .png()
        .toBuffer();
      tiles.push({
        id: `tile-${row}-${col}`,
        displayId: input.displayId,
        sourceX: x,
        sourceY: y,
        tileW: width,
        tileH: height,
        pngBytes,
      });
    }
  }

  return tiles;
}
