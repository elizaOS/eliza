/**
 * Scene OCR boxes on a HiDPI display.
 *
 * `captureDisplay` returns the frame at backing-store resolution — 2x the
 * logical bounds on a macOS retina display — and the OCR provider reports
 * boxes in that frame's pixels. Everything downstream of the Scene works in
 * display-local logical coordinates: AX nodes, `captureDisplayRegion`, and the
 * cascade, which dispatches an OCR box center straight to the input driver.
 * These tests drive the real SceneBuilder, OCR adapter, Brain, Cascade,
 * dispatcher and DefaultComputerInterface with a 2x frame and pin that the
 * Scene carries logical boxes, region re-captures ask for logical regions, and
 * an OCR-grounded click lands on the element.
 */

import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { Brain } from "../actor/brain.js";
import { Cascade } from "../actor/cascade.js";
import { DefaultComputerInterface } from "../actor/computer-interface.js";
import { dispatch } from "../actor/dispatch.js";
import { registerCoordOcrProvider } from "../mobile/ocr-provider.js";
import type { DisplayCapture } from "../platform/capture.js";
import type { DisplayInfo } from "../platform/displays.js";
import { decodePng } from "./dhash.js";
import { SceneBuilder } from "./scene-builder.js";

type Rect = [number, number, number, number];

// ── minimal real PNG synthesizer (RGB, dark rectangles on white) ───────────
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i] ?? 0;
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function makePng(
  w: number,
  h: number,
  isDark: (x: number, y: number) => boolean,
): Buffer {
  const rows: number[] = [];
  for (let y = 0; y < h; y += 1) {
    rows.push(0);
    for (let x = 0; x < w; x += 1) {
      const v = isDark(x, y) ? 0 : 255;
      rows.push(v, v, v);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.from(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
function inside(x: number, y: number, r: Rect): boolean {
  return x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3];
}

/**
 * Render a display at `scale` pixels per logical unit with the given logical
 * rectangles dark — what `screencapture -D` returns for a retina display.
 */
function renderFrame(
  display: DisplayInfo,
  scale: number,
  dark: Rect[],
): Buffer {
  return makePng(display.bounds[2] * scale, display.bounds[3] * scale, (x, y) =>
    dark.some((r) => inside(x / scale, y / scale, r)),
  );
}

/**
 * OCR stand-in that reads the real PNG bytes it is given: one block per
 * call, bounding the dark pixels, in the coordinates of the image plus the
 * caller's source offset (the CoordOcrProvider contract).
 */
function registerPixelOcr(text: string): void {
  registerCoordOcrProvider({
    name: "pixel-bbox-ocr",
    describe: async (input) => {
      const img = decodePng(Buffer.from(input.pngBytes));
      if (!img) return { blocks: [] };
      let x0 = Number.POSITIVE_INFINITY;
      let y0 = Number.POSITIVE_INFINITY;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < img.height; y += 1) {
        for (let x = 0; x < img.width; x += 1) {
          if ((img.rgba[(y * img.width + x) * 4] ?? 255) < 128) {
            x0 = Math.min(x0, x);
            y0 = Math.min(y0, y);
            x1 = Math.max(x1, x);
            y1 = Math.max(y1, y);
          }
        }
      }
      if (x1 < 0) return { blocks: [] };
      return {
        blocks: [
          {
            text,
            bbox: {
              x: x0 + input.sourceX,
              y: y0 + input.sourceY,
              width: x1 - x0 + 1,
              height: y1 - y0 + 1,
            },
            words: [],
            semantic_position: "center",
          },
        ],
      };
    },
  });
}

afterEach(() => registerCoordOcrProvider(null));

// 128x64 logical points; at scale 2 the 256x128 frame's 16x16 block grid has
// 16x8 px cells, so the changed element below covers whole cells.
const retina: DisplayInfo = {
  id: 0,
  bounds: [0, 0, 128, 64],
  scaleFactor: 2,
  primary: true,
  name: "retina",
};
const SAVE: Rect = [20, 10, 10, 5];
const SEND: Rect = [64, 32, 16, 8];

function builderFor(
  display: DisplayInfo,
  frames: { current: Buffer },
  regionScale: number,
  regions: Array<{ x: number; y: number; width: number; height: number }>,
): SceneBuilder {
  const capture = (): DisplayCapture => ({ display, frame: frames.current });
  return new SceneBuilder({
    captureAll: async () => [capture()],
    captureOne: async () => capture(),
    // A region capture of the same display comes back at the same backing
    // resolution as the full frame (`screencapture -R` on retina).
    captureRegion: async (_displayId, region) => {
      regions.push(region);
      const full = decodePng(frames.current);
      if (!full) throw new Error("undecodable frame");
      const ox = region.x * regionScale;
      const oy = region.y * regionScale;
      const png = makePng(
        Math.round(region.width * regionScale),
        Math.round(region.height * regionScale),
        (x, y) => {
          const fx = ox + x;
          const fy = oy + y;
          if (fx >= full.width || fy >= full.height) return false;
          return (full.rgba[(fy * full.width + fx) * 4] ?? 255) < 128;
        },
      );
      return { display, frame: png };
    },
    listDisplays: () => [display],
    enumerateApps: () => [],
    accessibilityProvider: {
      name: "none",
      available: () => true,
      snapshot: async () => [],
    },
  });
}

describe("SceneBuilder OCR boxes on a scale-2 display", () => {
  it("reports full-frame OCR boxes in display-local logical coordinates", async () => {
    registerPixelOcr("Save");
    const frames = { current: renderFrame(retina, 2, [SAVE]) };
    const builder = builderFor(retina, frames, 2, []);

    const scene = await builder.tick("agent-turn");

    expect(scene.ocr.map((b) => b.bbox)).toEqual([SAVE]);
  });

  it("re-captures a changed area as a logical region and keeps its box logical", async () => {
    registerPixelOcr("Save");
    const regions: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];
    const frames = { current: renderFrame(retina, 2, [SAVE]) };
    const builder = builderFor(retina, frames, 2, regions);
    await builder.tick("agent-turn");

    registerPixelOcr("Send");
    frames.current = renderFrame(retina, 2, [SAVE, SEND]);
    const scene = await builder.tick("agent-turn");

    expect(regions).toEqual([{ x: 64, y: 32, width: 16, height: 8 }]);
    expect(
      scene.ocr
        .map((b) => ({ text: b.text, bbox: b.bbox }))
        .sort((a, b) => a.text.localeCompare(b.text)),
    ).toEqual([
      { text: "Save", bbox: SAVE },
      { text: "Send", bbox: SEND },
    ]);
  });

  it("leaves boxes unchanged when the frame matches the logical bounds", async () => {
    registerPixelOcr("Save");
    const flat: DisplayInfo = {
      ...retina,
      bounds: [0, 0, 256, 128],
      scaleFactor: 1,
    };
    const frames = { current: renderFrame(flat, 1, [[40, 20, 20, 10]]) };
    const builder = builderFor(flat, frames, 1, []);

    const scene = await builder.tick("agent-turn");

    expect(scene.ocr.map((b) => b.bbox)).toEqual([[40, 20, 20, 10]]);
  });
});

describe("OCR-grounded click on a scale-2 display", () => {
  async function clickOcrTarget(target: Rect) {
    registerPixelOcr("Save");
    const frames = { current: renderFrame(retina, 2, [target]) };
    const builder = builderFor(retina, frames, 2, []);
    const scene = await builder.tick("agent-turn");
    const brain = new Brain(null, {
      invokeModel: async ({ prompt }) => {
        const ref = /"id": "(t\d+-\d+)",\s*"text": "Save"/.exec(prompt)?.[1];
        return JSON.stringify({
          scene_summary: "a dialog with a Save button",
          target_display_id: 0,
          roi: [],
          proposed_action: { kind: "click", ref, rationale: "press Save" },
        });
      },
    });
    const cascade = new Cascade({ brain });
    const plan = await cascade.run({
      scene,
      goal: "press Save",
      captures: new Map([[0, { display: retina, frame: frames.current }]]),
    });
    const clicks: Array<[number, number]> = [];
    const result = await dispatch(plan.proposed, {
      interface: new DefaultComputerInterface({
        listDisplays: () => [retina],
        driver: {
          click: async (x, y) => {
            clicks.push([x, y]);
          },
        },
      }),
      listDisplays: () => [retina],
    });
    return { result, clicks };
  }

  it("clicks the logical center of the OCR box", async () => {
    const { result, clicks } = await clickOcrTarget(SAVE);
    expect(result.success).toBe(true);
    expect(clicks).toEqual([[25, 13]]);
  });

  it("can click an element in the bottom-right half of the display", async () => {
    const { result, clicks } = await clickOcrTarget([100, 40, 20, 10]);
    expect(result.success).toBe(true);
    expect(clicks).toEqual([[110, 45]]);
  });
});
