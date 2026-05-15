/**
 * Real-mode OCR-with-coords wrapper for the vision-CUA E2E harness.
 *
 * Replaces `StubOcrWithCoords`. Goes through the OCR-with-coords contract
 * defined in plugin-vision (`OcrWithCoordsService`) — specifically the
 * `RapidOcrCoordAdapter` (Phase 1, transitional) backed by `RapidOCRService`.
 *
 * The harness imports the source module directly because plugin-vision's
 * bundled `dist/index.js` does not re-export `OcrWithCoordsService` /
 * `RapidOcrCoordAdapter`. The same is true for plugin-computeruse's
 * `registerCoordOcrProvider` registry — the public bundle exposes only the
 * single-line `OcrProvider` slot, not the hierarchical coord-aware one.
 *
 * Real mode thus depends on:
 *   - `plugins/plugin-vision/src/ocr-with-coords.ts` loading cleanly (it
 *     transitively requires `./ocr-service-rapid`, which currently is NOT
 *     present in the repo — see Phase 2 doctr-cpp port).
 *   - The PNG bytes for the requested tile being captured by the harness so
 *     the adapter can run RapidOCR over them.
 *
 * If the import fails (missing rapid backend, missing onnxruntime-node, etc.)
 * `discoverOcrProvider()` returns `null` and the pipeline records the OCR
 * stage as failed with the structured cause message.
 */

import type { OcrCoordResult } from "./types.ts";

export interface RealOcrInput {
  readonly displayId: string;
  readonly sourceX: number;
  readonly sourceY: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly pngBytes: Uint8Array;
}

export interface RealOcrProvider {
  readonly name: string;
  describe(input: RealOcrInput): Promise<OcrCoordResult>;
}

export interface DiscoverOcrResult {
  readonly provider: RealOcrProvider | null;
  readonly reason: string;
}

interface PluginVisionOcrCoordsModule {
  readonly RapidOcrCoordAdapter: new () => {
    readonly name: string;
    describe(input: {
      displayId: string;
      sourceX: number;
      sourceY: number;
      pngBytes: Uint8Array;
    }): Promise<{
      blocks: ReadonlyArray<{
        text: string;
        bbox: { x: number; y: number; width: number; height: number };
        words: ReadonlyArray<{
          text: string;
          bbox: { x: number; y: number; width: number; height: number };
        }>;
      }>;
    }>;
  };
}

/**
 * Probe the OCR-with-coords provider from plugin-vision. Returns a wrapper
 * that conforms to the harness `OcrCoordResult` shape, or `null` with a
 * human-readable reason if the provider can't be loaded on this host.
 */
export async function discoverOcrProvider(): Promise<DiscoverOcrResult> {
  let module: PluginVisionOcrCoordsModule;
  try {
    module = (await import(
      "../../../../plugins/plugin-vision/src/ocr-with-coords.ts" as string
    )) as PluginVisionOcrCoordsModule;
  } catch (err) {
    return {
      provider: null,
      reason: `plugin-vision/ocr-with-coords import failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  let adapter: ReturnType<
    () => InstanceType<PluginVisionOcrCoordsModule["RapidOcrCoordAdapter"]>
  >;
  try {
    adapter = new module.RapidOcrCoordAdapter();
  } catch (err) {
    return {
      provider: null,
      reason: `RapidOcrCoordAdapter construction failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  return {
    provider: {
      name: adapter.name,
      async describe(input: RealOcrInput): Promise<OcrCoordResult> {
        const result = await adapter.describe({
          displayId: input.displayId,
          sourceX: input.sourceX,
          sourceY: input.sourceY,
          pngBytes: input.pngBytes,
        });
        return {
          blocks: result.blocks.map((b) => ({
            text: b.text,
            bbox: b.bbox,
            words: b.words.map((w) => ({ text: w.text, bbox: w.bbox })),
          })),
        };
      },
    },
    reason: `loaded ${adapter.name}`,
  };
}
