/**
 * Bridge plugin-vision's Set-of-Marks fusion into plugin-computeruse's
 * `SetOfMarksProvider` registry seam (#9170 M9).
 *
 * Mirrors `computeruse-ocr-bridge.ts`: plugin-vision owns the GGUF YOLO icon
 * detector and the OCR engines; plugin-computeruse exposes a registration slot
 * and consumes whatever is registered from `detect_elements`, with NO hard
 * dependency on plugin-vision. The provider is built here and registered at
 * boot via a best-effort dynamic import (see `index.ts`).
 *
 * Pure + injectable: the YOLO detector and OCR resolver are passed in, so the
 * fusion wiring is unit-testable with fakes and degrades gracefully when the
 * GGUF detector or OCR engine is unavailable (icons or text simply absent).
 */

import { getOcrWithCoordsService } from "./ocr-with-coords.js";
import {
  buildSceneSetOfMarks,
  type DetectedObjectLike,
  type OcrBlockLike,
  renderSetOfMarksOverlay,
  type SetOfMarksOptions,
  type SomMark,
} from "./som.js";

/** Structural shape of computeruse's `SetOfMarksInput`. */
export interface SetOfMarksInputLike {
  readonly displayId: string;
  readonly sourceX: number;
  readonly sourceY: number;
  readonly pngBytes: Uint8Array;
  readonly renderOverlay?: boolean;
}

/** Structural shape of computeruse's `SetOfMarksResult`. */
export interface SetOfMarksResultLike {
  readonly marks: ReadonlyArray<SomMark>;
  readonly overlayPngBase64?: string;
}

/** Structural shape of computeruse's `SetOfMarksProvider`. */
export interface SetOfMarksProviderLike {
  readonly name: string;
  describe(input: SetOfMarksInputLike): Promise<SetOfMarksResultLike>;
}

export type RegisterSetOfMarksProvider = (
  provider: SetOfMarksProviderLike | null,
) => void;

export const VISION_SET_OF_MARKS_BRIDGE_NAME = "vision-set-of-marks-bridge";

export interface SetOfMarksProviderDeps {
  /**
   * Detect icon-ish boxes from PNG bytes (GGUF YOLO). Returns `[]` when the
   * detector is unavailable — Set-of-Marks then falls back to text-only marks.
   */
  readonly detectIcons?: (
    pngBytes: Uint8Array,
  ) => Promise<DetectedObjectLike[]>;
  /** Resolve the OCR-with-coords service (defaults to the registered one). */
  readonly resolveOcr?: typeof getOcrWithCoordsService;
  /** Fusion tuning forwarded to `buildSetOfMarks`. */
  readonly options?: SetOfMarksOptions;
}

/**
 * Lazily-instantiated default GGUF YOLO icon detector. Best-effort: if the
 * native bindings or GGUF weights are missing, every call resolves to `[]` so
 * Set-of-Marks degrades to OCR-only text marks instead of throwing.
 */
export function createDefaultIconDetector(): (
  pngBytes: Uint8Array,
) => Promise<DetectedObjectLike[]> {
  let detector: {
    detect: (buf: Buffer) => Promise<DetectedObjectLike[]>;
  } | null = null;
  let unavailable = false;
  return async (pngBytes: Uint8Array): Promise<DetectedObjectLike[]> => {
    if (unavailable) return [];
    try {
      if (!detector) {
        const { YOLODetector } = await import("./yolo-detector.js");
        if (!(await YOLODetector.isAvailable())) {
          unavailable = true;
          return [];
        }
        const d = new YOLODetector();
        await d.initialize();
        detector = d;
      }
      return await detector.detect(Buffer.from(pngBytes));
    } catch {
      // One failure marks the detector unavailable for the process lifetime —
      // re-probing on every detect would be wasteful when weights are missing.
      unavailable = true;
      return [];
    }
  };
}

/**
 * Build a `SetOfMarksProvider`-shaped bridge that fuses GGUF YOLO icon
 * detections + OCR text blocks into a numbered mark set (and optional overlay).
 */
export function buildVisionSetOfMarksProvider(
  deps: SetOfMarksProviderDeps = {},
): SetOfMarksProviderLike {
  const detectIcons = deps.detectIcons ?? createDefaultIconDetector();
  const resolveOcr = deps.resolveOcr ?? getOcrWithCoordsService;
  return {
    name: VISION_SET_OF_MARKS_BRIDGE_NAME,
    async describe(input: SetOfMarksInputLike): Promise<SetOfMarksResultLike> {
      const ocr = resolveOcr();
      const [detections, ocrResult] = await Promise.all([
        detectIcons(input.pngBytes),
        ocr
          ? ocr.describe({
              displayId: input.displayId,
              sourceX: input.sourceX,
              sourceY: input.sourceY,
              pngBytes: input.pngBytes,
            })
          : Promise.resolve({ blocks: [] as OcrBlockLike[] }),
      ]);

      const marks = buildSceneSetOfMarks(
        {
          detections,
          ocrBlocks: ocrResult.blocks as readonly OcrBlockLike[],
        },
        deps.options,
      );

      if (!input.renderOverlay || marks.length === 0) {
        return { marks };
      }
      const overlay = await renderSetOfMarksOverlay(input.pngBytes, marks);
      return { marks, overlayPngBase64: overlay.toString("base64") };
    },
  };
}

/**
 * Register the vision Set-of-Marks bridge into computeruse's seam. Idempotent
 * (last-call-wins). Returns true once registered.
 */
export function wireComputerUseSetOfMarksBridge(
  register: RegisterSetOfMarksProvider,
  deps?: SetOfMarksProviderDeps,
): boolean {
  register(buildVisionSetOfMarksProvider(deps));
  return true;
}
