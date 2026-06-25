/**
 * Wiring seam for the change-gated per-tile scene describe (#9105 efficiency).
 *
 * `DirtyTileDescriber` (dirty-tile-describer.ts) is pure + injectable: it owns
 * the per-tile hash cache and the "only re-describe changed tiles" loop, but it
 * does not know how to hash a tile or how to ask the VLM to describe one. This
 * module supplies those two collaborators from the live runtime so
 * `VisionService` can build a describer that re-describes only the screen
 * regions that actually changed since the previous frame instead of paying for
 * a whole-frame VLM pass every scene tick.
 *
 * Two collaborators:
 *   - `hashTile`: a perceptual hash. We reuse plugin-computeruse's `frameDhash`
 *     (the same dHash the Brain frame-cache uses), resolved via a best-effort
 *     dynamic import so plugin-vision never eagerly pulls computeruse's module
 *     graph at boot — exactly the idiom the OCR bridge already uses. When
 *     computeruse is absent the resolve returns `null` and the caller degrades
 *     to the existing full-frame describe.
 *   - `describeTile`: one `runtime.useModel(IMAGE_DESCRIPTION, …)` call per
 *     changed tile, built from a caller-supplied prompt + result normalizer so
 *     the per-tile path reuses the same prompt plumbing as the full-frame path.
 */

import type { ScreenTile } from "./screen-tiler.js";

/** PNG perceptual hash. Identical pixels MUST hash equal; `null` = undecodable. */
export type FrameHash = (png: Buffer) => bigint | null;

/** Per-tile describe call. Returns the model's description text for one tile. */
export type TileDescribeFn = (tile: ScreenTile) => Promise<string>;

export interface TileDescribeDeps {
  /**
   * Build the per-tile image URL the VLM is asked to describe. The tile carries
   * PNG bytes (`tile.pngBytes`), so this is a `data:image/png;base64,…` URL.
   */
  buildTileImageUrl: (tile: ScreenTile) => string;
  /**
   * Build the per-tile prompt. Receives the tile so callers can include bounds.
   * Async because the scene context is pulled from a peer provider per call.
   */
  buildTilePrompt: (tile: ScreenTile) => Promise<string>;
  /** Invoke the IMAGE_DESCRIPTION model and return its raw result. */
  invokeModel: (imageUrl: string, prompt: string) => Promise<unknown>;
  /**
   * Normalize a model result into a description string, or `null` when the
   * result is unusable (sentinel / empty). A `null` result yields an empty tile
   * description, which the describer treats as "nothing to compose for this
   * tile" while still caching the (empty) result against the tile hash.
   */
  extractDescription: (result: unknown) => string | null;
}

/**
 * Build a `describeTile` function bound to the runtime's IMAGE_DESCRIPTION
 * model. The describer calls this only for tiles whose hash changed.
 */
export function createTileDescribeFn(deps: TileDescribeDeps): TileDescribeFn {
  return async (tile: ScreenTile): Promise<string> => {
    const imageUrl = deps.buildTileImageUrl(tile);
    const prompt = await deps.buildTilePrompt(tile);
    const result = await deps.invokeModel(imageUrl, prompt);
    return deps.extractDescription(result) ?? "";
  };
}

/** Encode a tile's PNG bytes into a base64 data URL for the VLM. */
export function tilePngToImageUrl(tile: ScreenTile): string {
  return `data:image/png;base64,${tile.pngBytes.toString("base64")}`;
}
