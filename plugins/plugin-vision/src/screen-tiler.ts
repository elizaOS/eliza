import sharp from "sharp";

export const DEFAULT_MAX_EDGE = 1024;
export const DEFAULT_OVERLAP_FRACTION = 0.1;

export interface TilerInput {
	displayId: string;
	width: number;
	height: number;
	pngBytes: Buffer;
}

export interface TilerOptions {
	maxEdge: number;
	overlapFraction: number;
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

function clampOverlapFraction(f: number): number {
	if (!Number.isFinite(f) || f < 0) return 0;
	if (f >= 0.9) return 0.9;
	return f;
}

function tileStarts(extent: number, tile: number, overlap: number): number[] {
	if (extent <= tile) return [0];
	const pitch = Math.max(1, Math.floor(tile * (1 - overlap)));
	const starts: number[] = [];
	for (let s = 0; s + tile < extent; s += pitch) starts.push(s);
	starts.push(extent - tile);
	return starts;
}

export async function tileScreenshot(
	input: TilerInput,
	options: TilerOptions,
): Promise<ScreenTile[]> {
	const maxEdge = Math.max(1, Math.floor(options.maxEdge));
	const overlap = clampOverlapFraction(options.overlapFraction);
	const { displayId, width, height, pngBytes } = input;

	if (width <= maxEdge && height <= maxEdge) {
		return [
			{
				id: "tile-0-0",
				displayId,
				sourceX: 0,
				sourceY: 0,
				tileW: width,
				tileH: height,
				pngBytes,
			},
		];
	}

	const tileW = Math.min(width, maxEdge);
	const tileH = Math.min(height, maxEdge);
	const xs = tileStarts(width, tileW, overlap);
	const ys = tileStarts(height, tileH, overlap);

	const tiles: ScreenTile[] = [];
	for (let row = 0; row < ys.length; row++) {
		const sy = ys[row];
		if (sy === undefined) continue;
		for (let col = 0; col < xs.length; col++) {
			const sx = xs[col];
			if (sx === undefined) continue;
			const buf = await sharp(pngBytes)
				.extract({ left: sx, top: sy, width: tileW, height: tileH })
				.png()
				.toBuffer();
			tiles.push({
				id: `tile-${row}-${col}`,
				displayId,
				sourceX: sx,
				sourceY: sy,
				tileW,
				tileH,
				pngBytes: buf,
			});
		}
	}
	return tiles;
}
