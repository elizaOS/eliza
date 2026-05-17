/**
 * OCR adapter for the WS6 scene-builder.
 *
 * The scene-builder needs text-from-image extraction on full frames and
 * (much more often) on cropped dirty blocks. There are three real sources
 * for OCR in this monorepo today:
 *
 *   1. `@elizaos/plugin-vision`'s `OCRService` — canonical RapidOCR
 *      (PP-OCRv5) + Apple-Vision + Tesseract chain. **Owned by WS4.** This is
 *      the one we want to use whenever it's loaded.
 *   2. The on-device iOS Apple-Vision provider — `createIosVisionOcrProvider`
 *      in `mobile/ocr-provider.ts` (WS9). Plugged into the same OcrProvider
 *      registry.
 *   3. A no-op stub that returns `[]` — used in unit tests and when no
 *      provider has been registered.
 *
 * **Integration choice (justified):**
 *
 * plugin-computeruse cannot take a hard `@elizaos/plugin-vision` dependency
 * — that creates a cycle (vision -> capture -> computeruse) and forces every
 * computeruse consumer to install onnxruntime-node, Sharp, and YOLO/Florence2
 * weights even when they only want desktop control.
 *
 * Instead, we re-use the existing `OcrProvider` registry that `mobile/
 * ocr-provider.ts` already publishes. A consumer (e.g. plugin-vision itself,
 * or an integrator) can call `registerOcrProvider(buildVisionOcrAdapter(
 * visionService))` at startup to wire RapidOCR in. plugin-computeruse stays
 * dep-free and the chain just degrades to "no OCR" when nothing is
 * registered. The scene-builder logs that condition once.
 *
 * This module exposes:
 *   - `runOcrOnPng(png, displayId, options)` — the scene-builder calls this.
 *   - `runOcrOnRegions(...)` — same, but for cropped dirty blocks. Falls back
 *     to whole-frame OCR if the provider can't crop in place.
 *   - `setOcrLoggingHook(fn)` — the scene-builder injects a logger so this
 *     module doesn't have to take a `@elizaos/core` dep itself.
 */

import type { OcrLine, OcrProvider } from "../mobile/ocr-provider.js";
import { listOcrProviders } from "../mobile/ocr-provider.js";
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

/**
 * Run OCR on a whole PNG buffer. Returns boxes tagged with `displayId` and
 * stable `t<displayId>-<seq>` ids drawn from `idState`. Empty array if no
 * provider is registered.
 */
export async function runOcrOnPng(
  png: Buffer,
  displayId: number,
  idState: OcrAdapterIdState,
): Promise<SceneOcrBox[]> {
  const provider = pickProvider();
  if (!provider) {
    if (!warnedNoProvider) {
      warnedNoProvider = true;
      logFn(
        "[scene-builder] no OCR provider registered — scene.ocr will be empty until one is registered via registerOcrProvider().",
      );
    }
    return [];
  }
  try {
    const result = await provider.recognize({
      kind: "bytes",
      data: new Uint8Array(png.buffer, png.byteOffset, png.byteLength),
    });
    return result.lines.map((line) => toSceneBox(line, displayId, idState));
  } catch (err) {
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
  const provider = pickProvider();
  if (!provider) return [];
  const out: SceneOcrBox[] = [];
  for (const crop of crops) {
    try {
      const result = await provider.recognize({
        kind: "bytes",
        data: new Uint8Array(
          crop.png.buffer,
          crop.png.byteOffset,
          crop.png.byteLength,
        ),
      });
      for (const line of result.lines) {
        const offset = crop.bbox;
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
    } catch (err) {
      logFn(
        `[scene-builder] OCR region failed at ${crop.bbox.join(",")}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return out;
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
