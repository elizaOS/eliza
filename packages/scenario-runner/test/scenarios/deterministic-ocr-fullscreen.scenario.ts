/**
 * Deterministic e2e for full-screen OCR readout (issue #9105 §9, M1).
 *
 * Drives the real VISION `get_screen` action → `buildGetScreen` → registered
 * coord-OCR service path end-to-end through the scenario runner, with no live
 * model, no real capture, and no desktop. A fake `OcrWithCoordsService` returns
 * fixed blocks in display-absolute coordinates; a fake `computeruse` service
 * supplies the source PNG via `executeCommand("screenshot")`.
 *
 * Asserts the GET_SCREEN envelope carries the expected display-absolute
 * bbox + text (the CoordOcrBlock → GetScreenElement mapping is preserved) and
 * that zero image bytes are returned by default (`includeImage:false`), proving
 * the token-frugal contract.
 */

import { deflateSync } from "node:zlib";
import type { Plugin } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { visionAction } from "../../../../plugins/plugin-vision/src/action.ts";
import type {
  OcrWithCoordsResult,
  OcrWithCoordsService,
} from "../../../../plugins/plugin-vision/src/ocr-with-coords.ts";
import { registerOcrWithCoordsService } from "../../../../plugins/plugin-vision/src/ocr-with-coords.ts";

// ── minimal valid PNG synthesizer (16x16 RGB) ───────────────────────────────
// `buildGetScreen` reads PNG dimensions from the IHDR chunk, so the source
// frame must be a real, decodable PNG even though OCR itself is faked.
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

function makeTinyPng(): Buffer {
  const w = 16;
  const h = 16;
  const rows: number[] = [];
  for (let y = 0; y < h; y += 1) {
    rows.push(0);
    for (let x = 0; x < w; x += 1) {
      const v = (x * 16) % 255;
      rows.push(v, v, v);
    }
  }
  const idat = deflateSync(Buffer.from(rows));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const SCREENSHOT_B64 = makeTinyPng().toString("base64");

interface ExpectedBlock {
  readonly text: string;
  readonly bbox: readonly [number, number, number, number];
}

// Known blocks in display-absolute coordinates.
const EXPECTED: readonly ExpectedBlock[] = [
  { text: "File", bbox: [12, 8, 40, 18] },
  { text: "Save", bbox: [100, 100, 80, 32] },
  { text: "Cancel", bbox: [200, 100, 96, 32] },
];

function createFakeCoordOcrService(): OcrWithCoordsService {
  return {
    name: "scenario-fake-coord-ocr",
    async describe(): Promise<OcrWithCoordsResult> {
      return {
        blocks: EXPECTED.map((b) => ({
          text: b.text,
          bbox: {
            x: b.bbox[0],
            y: b.bbox[1],
            width: b.bbox[2],
            height: b.bbox[3],
          },
          words: [],
          semantic_position: "center",
        })),
      };
    },
  };
}

/** Structural shape of the GET_SCREEN envelope returned by `buildGetScreen`. */
interface GetScreenData {
  op?: string;
  elements?: ReadonlyArray<{
    text?: string;
    bbox?: readonly number[];
    displayId?: number;
  }>;
  elementCount?: number;
  ocrAvailable?: boolean;
  image?: string;
}

async function seedOcrFullscreen(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as
    | ({
        getService?: (name: string) => unknown;
        registerPlugin?: (plugin: Plugin) => Promise<void>;
      } & Record<string, unknown>)
    | undefined;
  if (!runtime?.registerPlugin) {
    return "runtime.registerPlugin unavailable";
  }

  registerOcrWithCoordsService(createFakeCoordOcrService());

  // VISION action validate() needs a registered VISION service; get_screen
  // acquires its frame from computeruse's screenshot command.
  const fakeComputerUse = {
    executeCommand: async (command: string) =>
      command === "screenshot"
        ? { success: true, screenshot: SCREENSHOT_B64, displayId: 0 }
        : { success: false },
  };
  const fakeVision = { isActive: () => true };

  const previousGetService = runtime.getService?.bind(runtime);
  runtime.getService = (name: string) => {
    if (name === "computeruse") return fakeComputerUse;
    if (name === "VISION") return fakeVision;
    return previousGetService?.(name) ?? null;
  };

  await runtime.registerPlugin({
    name: "scenario-vision-ocr-fullscreen",
    description: "Deterministic full-screen OCR readout scenario plugin",
    actions: [visionAction],
  });
}

function getScreenDataFrom(
  execution: ScenarioTurnExecution,
): GetScreenData | undefined {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "VISION",
  );
  const data = action?.result?.data;
  if (!data || typeof data !== "object") return undefined;
  return data as GetScreenData;
}

function expectGetScreen(execution: ScenarioTurnExecution): string | undefined {
  const data = getScreenDataFrom(execution);
  if (!data) return "no VISION get_screen action result captured";
  if (data.op !== "get_screen") {
    return `expected op get_screen, saw ${JSON.stringify(data.op)}`;
  }
  if (data.ocrAvailable !== true) {
    return "expected ocrAvailable=true (coord-OCR service was registered)";
  }
  if (data.image !== undefined) {
    return "expected zero image bytes by default (includeImage:false)";
  }
  const elements = data.elements ?? [];
  if (elements.length !== EXPECTED.length) {
    return `expected ${EXPECTED.length} elements, saw ${elements.length}`;
  }
  for (let i = 0; i < EXPECTED.length; i += 1) {
    const expected = EXPECTED[i];
    const actual = elements[i];
    if (!expected || !actual) return `missing element at index ${i}`;
    if (actual.text !== expected.text) {
      return `element ${i} text ${JSON.stringify(actual.text)} != ${JSON.stringify(expected.text)}`;
    }
    const bbox = actual.bbox ?? [];
    if (
      bbox.length !== 4 ||
      bbox[0] !== expected.bbox[0] ||
      bbox[1] !== expected.bbox[1] ||
      bbox[2] !== expected.bbox[2] ||
      bbox[3] !== expected.bbox[3]
    ) {
      return `element ${i} bbox ${JSON.stringify(bbox)} != ${JSON.stringify(expected.bbox)}`;
    }
    if (actual.displayId !== 0) {
      return `element ${i} displayId ${JSON.stringify(actual.displayId)} != 0`;
    }
  }
  return undefined;
}

export default scenario({
  id: "deterministic-ocr-fullscreen",
  lane: "pr-deterministic",
  title: "GET_SCREEN full-screen OCR readout (no image bytes)",
  domain: "computeruse",
  tags: ["pr", "deterministic", "zero-cost", "computeruse", "vision", "ocr"],
  isolation: "shared-runtime",
  seed: [
    {
      type: "custom",
      name: "register VISION with a deterministic coord-OCR service",
      apply: seedOcrFullscreen,
    },
  ],
  turns: [
    {
      kind: "action",
      name: "VISION get_screen returns OCR elements without image bytes",
      actionName: "VISION",
      text: "Read the screen",
      options: { parameters: { subaction: "get_screen" } },
      assertTurn: expectGetScreen,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "VISION",
      status: "success",
      minCount: 1,
    },
    {
      type: "custom",
      name: "GET_SCREEN omitted image bytes and preserved display-absolute boxes",
      predicate: (ctx: ScenarioContext) => {
        const turn = ctx.turns?.[0];
        if (!turn) return "no executed turn captured";
        return expectGetScreen(turn);
      },
    },
  ],
});
