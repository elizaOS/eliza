/**
 * STUB FOR HARNESS WIRING — replace with the real eliza-1 IMAGE_DESCRIPTION
 * handler before treating any results as real benchmarks.
 *
 * This module exists so the E2E pipeline can be wired, exercised, and CI-gated
 * without paid inference. It returns canned outputs for the three known
 * fixtures (single-display 1920x1080, ultra-wide 5120x1440, and the
 * multi-display composite).
 *
 * Public contract this file fakes:
 *   - `runtime.useModel(IMAGE_DESCRIPTION, { imageUrl, prompt })` in plugin-vision
 *     (see plugins/plugin-vision/src/service.ts ~line 1057). When eliza-1 is
 *     loaded locally it owns the IMAGE_DESCRIPTION slot. This stub mimics that
 *     handler signature for both scene-description and bbox grounding.
 *
 * Replace by:
 *   1. Setting ELIZA_VISION_CUA_E2E_REAL=1.
 *   2. Booting an `IAgentRuntime` with @elizaos/plugin-local-inference loaded
 *      (it registers eliza-1 against IMAGE_DESCRIPTION).
 *   3. Wiring `runReal()` in `pipeline.ts` to call `runtime.useModel(...)`
 *      instead of `StubVlm.describe()` / `StubVlm.ground()`.
 */

import type {
  GroundingRequest,
  GroundingResult,
  VlmDescribeRequest,
  VlmDescribeResult,
} from "../types.ts";

/** Recognized fixture ids — the stub uses these to pick a canned response. */
export type StubFixtureId =
  | "single-1920x1080"
  | "ultra-wide-5120x1440"
  | "multi-display-composite";

export interface StubVlmOptions {
  readonly fixtureId: StubFixtureId;
}

/**
 * Tile dims used by the harness when issuing a grounding call. The real
 * IMAGE_DESCRIPTION grounding handler can read these dims off the image
 * directly; the stub needs them passed in so the canned coords stay inside
 * the actual tile (which varies by display resolution after the tiler runs).
 */
export interface StubGroundingExtra {
  readonly tileWidth: number;
  readonly tileHeight: number;
}

/**
 * Canned VLM stub. Stage 1 (`describe`) returns a one-line scene summary that
 * mirrors what eliza-1 / Qwen3.5-VL would emit for the fixture. Stage 2
 * (`ground`) returns a tile-local center for the requested element. The
 * coordinates are deliberately picked so the absolute reconstruction lands
 * inside the simulated "close button" bbox baked into the fixture.
 */
export class StubVlm {
  constructor(private readonly opts: StubVlmOptions) {}

  /**
   * Stand-in for `runtime.useModel(IMAGE_DESCRIPTION, { imageUrl, prompt })`.
   * Returns the same shape plugin-vision's `extractDescriptionFromUseModel`
   * accepts (`{ description: string }`).
   */
  // biome-ignore lint/suspicious/useAwait: matches the async surface of the real handler
  async describe(_req: VlmDescribeRequest): Promise<VlmDescribeResult> {
    switch (this.opts.fixtureId) {
      case "single-1920x1080":
        return {
          description:
            "Desktop with a focused window in the upper-center; the title bar's close button sits in the upper-right of the window chrome.",
        };
      case "ultra-wide-5120x1440":
        return {
          description:
            "Ultra-wide desktop tiled across two horizontal halves; the focused editor occupies the left half, with a close button at the upper-right of its window.",
        };
      case "multi-display-composite":
        return {
          description:
            "Two displays: a 1920x1080 panel showing a chat window and a 2560x1440 panel showing a code editor; the focused window's close button is on the secondary 2560x1440 panel.",
        };
      default:
        return { description: "Visual scene captured" };
    }
  }

  /**
   * Stand-in for the grounding call the orchestrator would issue against the
   * VLM ("locate the close button on the focused window"). Returns a center
   * point in tile-local coords plus the parent tile's dims so the harness
   * can reconstruct absolute display coordinates.
   *
   * Coordinates are computed relative to the actual tile dims so the canned
   * answer stays inside the cropped tile regardless of display resolution.
   * The fixture paints a 32x32 close button at display-x = (width - 140)
   * and display-y = 8, so we anchor the click to that same offset, but in
   * tile-local space. The stub assumes the harness has already picked the
   * upper-right tile (see `pickTileForUpperRight` in `pipeline.ts`).
   */
  // biome-ignore lint/suspicious/useAwait: matches the async surface of the real handler
  async ground(
    req: GroundingRequest,
    extra: StubGroundingExtra,
  ): Promise<GroundingResult> {
    const tileWidth = extra.tileWidth;
    const tileHeight = extra.tileHeight;
    // The fixture paints the close button starting at display-x =
    // displayWidth - 140 with width 32. The right-most tile's right edge
    // sits at displayWidth, so within that tile the button starts at
    // tileLocalX = tileWidth - 140 (anchored to the right edge of the
    // tile). Center the click 16px in (button is 32x32) and 24px down.
    const tileLocalX = Math.max(0, tileWidth - 140 + 16);
    const tileLocalY = 24;
    return {
      tileLocalX,
      tileLocalY,
      tileWidth,
      tileHeight,
      tileId: req.tileId,
      displayId: req.displayId,
      bbox: {
        x: Math.max(0, tileWidth - 140),
        y: 8,
        width: 32,
        height: 32,
      },
      rationale: `[stub] grounding "${req.description}" to upper-right close-button hotspot`,
    };
  }
}
