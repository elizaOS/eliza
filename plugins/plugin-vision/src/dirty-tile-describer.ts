/**
 * DirtyTileDescriber — change-gated, per-tile screen description (#9105 M3).
 *
 * The dominant token cost in a CUA loop is re-describing a whole screen to a
 * VLM every step even when almost nothing moved. The Brain already skips the
 * describe entirely when the *whole frame* dHash is unchanged
 * (`plugin-computeruse` `Brain` frame-dHash cache). This describer is the
 * finer-grained tier: it splits a frame into tiles (via `screen-tiler.ts`),
 * computes a per-tile perceptual hash, and only (re)describes tiles whose hash
 * changed since the last frame — every unchanged tile reuses its cached
 * description. So a single text field flipping characters re-describes one tile,
 * not the entire screen.
 *
 * The describer is pure + injectable: the tile hash (`hashTile`) and the
 * per-tile describe call (`describeTile`) are supplied by the caller. The real
 * boot wiring injects `plugin-computeruse`'s `frameDhash` (the existing
 * `scene/dhash.ts`) and a `runtime.useModel(IMAGE_DESCRIPTION)`-backed describe;
 * tests inject deterministic fakes with no model and no native dHash. The
 * counters (`describeCallsSaved`, `approxTokensSaved`) make the saving
 * measurable so a test can assert it.
 */

import type { ScreenTile } from "./screen-tiler.js";
import { tileScreenshot } from "./screen-tiler.js";

/** Approx image tokens charged for one tile describe — used only for the saved-tokens estimate. */
export const APPROX_TOKENS_PER_TILE = 256;

/** A described tile: its source rectangle plus the VLM/OCR text for it. */
export interface DescribedTile {
  /** Tiler id, e.g. `tile-1-0`. */
  id: string;
  displayId: string;
  /** Top-left of the tile in source display pixel space. */
  sourceX: number;
  sourceY: number;
  sourceW: number;
  sourceH: number;
  /** The description text for this tile. */
  description: string;
  /** True when this tile's description was reused from cache (no describe call). */
  cached: boolean;
}

export interface DirtyTileDescription {
  /** One entry per tile, in tiler order. */
  tiles: DescribedTile[];
  /** Composed full-frame description (non-empty tile texts, source-order). */
  vlmScene: string;
  /** Per-tile elements suitable for `Scene.vlm_elements`. */
  elements: DirtyTileElement[];
}

/** A described tile projected into the `Scene.vlm_elements` shape. */
export interface DirtyTileElement {
  id: string;
  kind: string;
  desc: string;
  /** Display-local `[x, y, w, h]` of the tile. */
  bbox: [number, number, number, number];
  displayId: number;
}

/** Token-accounting snapshot for a describer. */
export interface DirtyTileStats {
  /** Tiles actually sent to the describe call. */
  tilesDescribed: number;
  /** Tiles served from the per-tile cache (no describe call). */
  tilesSkipped: number;
  /** Describe calls avoided by the cache (== tilesSkipped). */
  describeCallsSaved: number;
  /** Approx image tokens avoided (tilesSkipped × APPROX_TOKENS_PER_TILE). */
  approxTokensSaved: number;
}

export interface DirtyTileDescriberDeps {
  /**
   * Perceptual hash of a tile PNG. Identical pixels MUST hash equal. The boot
   * wiring passes `plugin-computeruse`'s `frameDhash`; `null` means "could not
   * hash" and forces a (re)describe for that tile.
   */
  hashTile: (png: Buffer) => bigint | null;
  /** Describe one tile's pixels. Only called for changed/new tiles. */
  describeTile: (tile: ScreenTile) => Promise<string>;
  /** Tiling options forwarded to `tileScreenshot`. */
  maxEdge?: number;
  overlapFraction?: number;
  /** Tokens charged per describe, for the saved-tokens estimate. */
  approxTokensPerTile?: number;
}

export class DirtyTileDescriber {
  /** tileId → { hash, description } from the previous frame. */
  private readonly cache = new Map<
    string,
    { hash: bigint | null; description: string }
  >();
  private stats: DirtyTileStats = {
    tilesDescribed: 0,
    tilesSkipped: 0,
    describeCallsSaved: 0,
    approxTokensSaved: 0,
  };

  constructor(private readonly deps: DirtyTileDescriberDeps) {}

  getStats(): DirtyTileStats {
    return { ...this.stats };
  }

  /**
   * Describe a frame, re-describing only tiles whose hash changed since the
   * previous call. Unchanged tiles reuse their cached description.
   */
  async describe(input: {
    displayId: number;
    width: number;
    height: number;
    pngBytes: Buffer;
  }): Promise<DirtyTileDescription> {
    const tiles = await tileScreenshot(
      {
        displayId: String(input.displayId),
        width: input.width,
        height: input.height,
        pngBytes: input.pngBytes,
      },
      {
        maxEdge: this.deps.maxEdge ?? 1280,
        overlapFraction: this.deps.overlapFraction ?? 0.12,
      },
    );
    const tokensPerTile =
      this.deps.approxTokensPerTile ?? APPROX_TOKENS_PER_TILE;
    const seen = new Set<string>();
    const described: DescribedTile[] = [];

    for (const tile of tiles) {
      seen.add(tile.id);
      const hash = this.deps.hashTile(tile.pngBytes);
      const prior = this.cache.get(tile.id);
      // A tile is reusable only when we have a prior description AND both the
      // prior and current hashes are real and equal. A null hash (undecodable)
      // always forces a fresh describe.
      const reusable =
        prior !== undefined &&
        prior.hash !== null &&
        hash !== null &&
        prior.hash === hash;
      if (reusable) {
        this.stats.tilesSkipped += 1;
        this.stats.describeCallsSaved += 1;
        this.stats.approxTokensSaved += tokensPerTile;
        described.push(this.toDescribed(tile, prior.description, true));
        continue;
      }
      const description = await this.deps.describeTile(tile);
      this.stats.tilesDescribed += 1;
      this.cache.set(tile.id, { hash, description });
      described.push(this.toDescribed(tile, description, false));
    }

    // Drop cache entries for tiles that no longer exist (e.g. resolution change
    // collapsed the grid) so the cache stays bounded by the live tile count.
    for (const id of this.cache.keys()) {
      if (!seen.has(id)) this.cache.delete(id);
    }

    return {
      tiles: described,
      vlmScene: composeVlmScene(described),
      elements: described
        .filter((t) => t.description.trim().length > 0)
        .map((t) => ({
          id: t.id,
          kind: "tile",
          desc: t.description,
          bbox: [t.sourceX, t.sourceY, t.sourceW, t.sourceH] as [
            number,
            number,
            number,
            number,
          ],
          displayId: input.displayId,
        })),
    };
  }

  private toDescribed(
    tile: ScreenTile,
    description: string,
    cached: boolean,
  ): DescribedTile {
    return {
      id: tile.id,
      displayId: tile.displayId,
      sourceX: tile.sourceX,
      sourceY: tile.sourceY,
      sourceW: tile.sourceW,
      sourceH: tile.sourceH,
      description,
      cached,
    };
  }
}

function composeVlmScene(tiles: DescribedTile[]): string {
  return tiles
    .map((t) => t.description.trim())
    .filter((d) => d.length > 0)
    .join("\n");
}
