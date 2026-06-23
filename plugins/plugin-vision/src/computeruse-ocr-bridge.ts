/**
 * Bridge plugin-vision's hierarchical OCR into plugin-computeruse's
 * `CoordOcrProvider` registry seam.
 *
 * plugin-vision owns the OCR implementations; plugin-computeruse's
 * scene-builder + GET_SCREEN want coordinate-aware OCR but must NOT take a
 * hard dependency on plugin-vision (that would create a cycle and force the
 * vision OCR stack onto every computeruse consumer). So plugin-vision
 * registers a bridge into computeruse's seam at boot via a best-effort dynamic
 * import (see `index.ts`).
 *
 * The two interfaces are structurally identical — vision's
 * `OcrWithCoordsService.describe(OcrWithCoordsInput) -> OcrWithCoordsResult`
 * and computeruse's `CoordOcrProvider.describe(CoordOcrInput) -> CoordOcrResult`
 * share field shapes (displayId/sourceX/sourceY/pngBytes in; blocks with
 * bbox+words+semantic_position out) — so the bridge is a thin pass-through.
 * The types live in different packages, so we describe computeruse's side
 * structurally here rather than importing it (keeps the no-hard-dep rule).
 *
 * Pure + injectable so the wiring is unit-testable without a real
 * plugin-computeruse present.
 */

import {
  getOcrWithCoordsService,
  type OcrWithCoordsResult,
  type OcrWithCoordsService,
} from "./ocr-with-coords.js";

/** Structural shape of `@elizaos/plugin-computeruse`'s `CoordOcrInput`. */
export interface CoordOcrInputLike {
  readonly displayId: string;
  readonly sourceX: number;
  readonly sourceY: number;
  readonly pngBytes: Uint8Array;
}

/** Structural shape of `@elizaos/plugin-computeruse`'s `CoordOcrProvider`. */
export interface CoordOcrProviderLike {
  readonly name: string;
  describe(input: CoordOcrInputLike): Promise<OcrWithCoordsResult>;
}

export type RegisterCoordOcrProvider = (
  provider: CoordOcrProviderLike | null,
) => void;

export const VISION_COORD_OCR_BRIDGE_NAME = "vision-coord-ocr-bridge";

/**
 * Build a `CoordOcrProvider`-shaped bridge that delegates to whatever vision
 * `OcrWithCoordsService` is currently registered. Resolving the service lazily
 * (per call) means a later `registerOcrWithCoordsService()` (e.g. swapping in a
 * native Windows.Media.Ocr / Apple Vision provider) is picked up automatically.
 */
export function buildVisionCoordOcrBridge(
  resolve: () => OcrWithCoordsService | null = getOcrWithCoordsService,
): CoordOcrProviderLike {
  return {
    name: VISION_COORD_OCR_BRIDGE_NAME,
    async describe(input: CoordOcrInputLike): Promise<OcrWithCoordsResult> {
      const service = resolve();
      if (!service) return { blocks: [] };
      // Field shapes match across the two interfaces — pass through directly.
      return service.describe({
        displayId: input.displayId,
        sourceX: input.sourceX,
        sourceY: input.sourceY,
        pngBytes: input.pngBytes,
      });
    },
  };
}

/**
 * Register the vision OCR bridge into computeruse's CoordOcrProvider seam.
 * Idempotent (the seam is last-call-wins). Returns true once registered.
 */
export function wireComputerUseOcrBridge(
  register: RegisterCoordOcrProvider,
  resolve?: () => OcrWithCoordsService | null,
): boolean {
  register(buildVisionCoordOcrBridge(resolve));
  return true;
}
