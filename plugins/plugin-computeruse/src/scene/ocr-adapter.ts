/**
 * OCR adapter for the WS6 scene-builder.
 *
 * The scene-builder needs text-from-image extraction on full frames and
 * (much more often) on cropped dirty blocks. There are two registry seams it
 * can draw from, in priority order:
 *
 *   1. The coord-aware `CoordOcrProvider` (`mobile/ocr-provider.ts`,
 *      `registerCoordOcrProvider` / `getCoordOcrProvider`). This is the
 *      canonical seam: `@elizaos/plugin-vision` registers a bridge to its
 *      hierarchical OCR (docTR / Apple Vision) at boot, returning blocks with
 *      bbox + words + semantic position in display-absolute coords. Preferred
 *      whenever a provider is registered.
 *   2. The line-only `OcrProvider` registry (`listOcrProviders()`), used by
 *      the on-device iOS Apple-Vision provider and unit-test fakes. Fallback
 *      when no coord provider is registered.
 *
 * **Integration choice (justified):**
 *
 * plugin-computeruse cannot take a hard `@elizaos/plugin-vision` dependency —
 * that creates a cycle (vision -> capture -> computeruse) and forces every
 * computeruse consumer to install the vision OCR stack even when they only
 * want desktop control. Instead, computeruse *publishes* both registries and
 * a consumer (plugin-vision, or an integrator) registers a provider at
 * startup. The chain degrades to "no OCR" when nothing is registered; the
 * scene-builder logs that condition once.
 *
 * This module exposes:
 *   - `runOcrOnPng(png, displayId, options)` — the scene-builder calls this.
 *   - `runOcrOnRegions(...)` — same, but for cropped dirty blocks. Falls back
 *     to whole-frame OCR if the provider can't crop in place.
 *   - `setOcrLoggingHook(fn)` — the scene-builder injects a logger so this
 *     module doesn't have to take a `@elizaos/core` dep itself.
 */

import type {
  CoordOcrBlock,
  CoordOcrProvider,
  OcrLine,
  OcrProvider,
} from "../mobile/ocr-provider.js";
import {
  getCoordOcrProvider,
  listOcrProviders,
} from "../mobile/ocr-provider.js";
import type { SceneOcrBox } from "./scene-types.js";

let logFn: (message: string) => void = () => {};
export function setOcrLoggingHook(fn: (message: string) => void): void {
  logFn = fn;
}

export interface OcrAdapterIdState {
  /** Per-display sequence counter so ids stay stable per Scene. */
  perDisplay: Map<number, number>;
}

export function makeOcrIdState(): OcrAdapterIdState {
  return { perDisplay: new Map() };
}

export function nextOcrId(state: OcrAdapterIdState, displayId: number): string {
  const cur = state.perDisplay.get(displayId) ?? 0;
  const next = cur + 1;
  state.perDisplay.set(displayId, next);
  return `t${displayId}-${next}`;
}

function pickProvider(): OcrProvider | null {
  for (const p of listOcrProviders()) {
    if (p.available()) return p;
  }
  return null;
}

let warnedNoProvider = false;

function warnNoProviderOnce(): void {
  if (!warnedNoProvider) {
    warnedNoProvider = true;
    logFn(
      "[scene-builder] no OCR provider registered — scene.ocr will be empty until a CoordOcrProvider is registered (registerCoordOcrProvider, e.g. by plugin-vision) or an OcrProvider via registerOcrProvider().",
    );
  }
}

/**
 * Run OCR on a whole PNG buffer. Prefers the coord-aware provider; falls back
 * to the line-only registry. Returns boxes tagged with `displayId` and stable
 * `t<displayId>-<seq>` ids drawn from `idState`. Empty array if no provider is
 * registered.
 */
export async function runOcrOnPng(
  png: Buffer,
  displayId: number,
  idState: OcrAdapterIdState,
): Promise<SceneOcrBox[]> {
  const coord = getCoordOcrProvider();
  if (coord) {
    try {
      const result = await coord.describe({
        displayId: String(displayId),
        sourceX: 0,
        sourceY: 0,
        pngBytes: new Uint8Array(png.buffer, png.byteOffset, png.byteLength),
      });
      return result.blocks.map((block) =>
        coordBlockToSceneBox(block, displayId, idState),
      );
    } catch (err) {
      // error-policy:J4 the scene degrades to AX/pixel-only for this turn;
      // the provider failure is logged through the scene-builder hook
      // (logger.warn in the service wiring), never silent.
      logFn(
        `[scene-builder] CoordOcrProvider '${coord.name}' failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  const provider = pickProvider();
  if (!provider) {
    warnNoProviderOnce();
    return [];
  }
  try {
    const result = await provider.recognize({
      kind: "bytes",
      data: new Uint8Array(png.buffer, png.byteOffset, png.byteLength),
    });
    return result.lines.map((line) => toSceneBox(line, displayId, idState));
  } catch (err) {
    // error-policy:J4 the scene degrades to AX/pixel-only for this turn;
    // the provider failure is logged through the scene-builder hook, never
    // silent.
    logFn(
      `[scene-builder] OCR provider '${provider.name}' failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Run OCR on a list of cropped region buffers, each tied to a bbox in the
 * source frame. Used for dirty-block re-OCR.
 *
 * `crops[i].png` is a standalone PNG of the dirty region. `crops[i].bbox` is
 * the region's location in the source frame (display-local). The returned
 * boxes are translated back into display-local source coordinates.
 */
export async function runOcrOnRegions(
  crops: Array<{ png: Buffer; bbox: [number, number, number, number] }>,
  displayId: number,
  idState: OcrAdapterIdState,
): Promise<SceneOcrBox[]> {
  const coord = getCoordOcrProvider();
  if (coord) {
    // OCR each dirty region concurrently (independent calls), then assign ids
    // sequentially. Promise.all preserves input order, so ocr ids stay stable
    // turn-to-turn regardless of which region's OCR finishes first.
    const perCrop = await Promise.all(
      crops.map(async (crop) => {
        try {
          // The coord provider shifts block bboxes by sourceX/sourceY, so the
          // returned coordinates are already in display-local source space.
          const result = await coord.describe({
            displayId: String(displayId),
            sourceX: crop.bbox[0] ?? 0,
            sourceY: crop.bbox[1] ?? 0,
            pngBytes: new Uint8Array(
              crop.png.buffer,
              crop.png.byteOffset,
              crop.png.byteLength,
            ),
          });
          return result.blocks;
        } catch (err) {
          // error-policy:J4 a failed dirty-region re-OCR degrades that
          // region to its previous boxes for this turn; logged per region.
          logFn(
            `[scene-builder] CoordOcr region failed at ${crop.bbox.join(",")}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return [];
        }
      }),
    );
    const out: SceneOcrBox[] = [];
    for (const blocks of perCrop) {
      for (const block of blocks) {
        out.push(coordBlockToSceneBox(block, displayId, idState));
      }
    }
    return out;
  }

  const provider = pickProvider();
  if (!provider) return [];
  // Same concurrency pattern as the coord path: recognize regions in parallel,
  // assign ids in input order afterward (Promise.all preserves order).
  const perCrop = await Promise.all(
    crops.map(async (crop) => {
      try {
        const result = await provider.recognize({
          kind: "bytes",
          data: new Uint8Array(
            crop.png.buffer,
            crop.png.byteOffset,
            crop.png.byteLength,
          ),
        });
        return { crop, lines: result.lines };
      } catch (err) {
        // error-policy:J4 a failed dirty-region re-OCR degrades that region
        // to its previous boxes for this turn; logged per region.
        logFn(
          `[scene-builder] OCR region failed at ${crop.bbox.join(",")}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return { crop, lines: [] };
      }
    }),
  );
  const out: SceneOcrBox[] = [];
  for (const { crop, lines } of perCrop) {
    const offset = crop.bbox;
    for (const line of lines) {
      out.push({
        id: nextOcrId(idState, displayId),
        text: line.text,
        bbox: [
          (offset[0] ?? 0) + line.boundingBox.x,
          (offset[1] ?? 0) + line.boundingBox.y,
          line.boundingBox.width,
          line.boundingBox.height,
        ],
        conf: line.confidence,
        displayId,
      });
    }
  }
  return out;
}

/**
 * Map a coord-aware OCR block to a SceneOcrBox. The coord seam does not carry
 * a per-block confidence, so we default to 1 (present). The block bbox is
 * already in display-absolute source coordinates.
 */
function coordBlockToSceneBox(
  block: CoordOcrBlock,
  displayId: number,
  idState: OcrAdapterIdState,
): SceneOcrBox {
  return {
    id: nextOcrId(idState, displayId),
    text: block.text,
    bbox: [block.bbox.x, block.bbox.y, block.bbox.width, block.bbox.height],
    conf: 1,
    displayId,
  };
}

function toSceneBox(
  line: OcrLine,
  displayId: number,
  idState: OcrAdapterIdState,
): SceneOcrBox {
  return {
    id: nextOcrId(idState, displayId),
    text: line.text,
    bbox: [
      line.boundingBox.x,
      line.boundingBox.y,
      line.boundingBox.width,
      line.boundingBox.height,
    ],
    conf: line.confidence,
    displayId,
  };
}

// Re-export so the optional coord provider type is reachable for consumers.
export type { CoordOcrProvider };
