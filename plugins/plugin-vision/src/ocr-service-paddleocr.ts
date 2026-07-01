/**
 * PaddleOCR / Paddle-Lite OCR-with-coords backend (issue #9581).
 *
 * The alternate coord-OCR provider beyond the shipped Tesseract + RapidOCR
 * adapters. PaddleOCR is a standalone, cross-platform OCR engine (pip install
 * paddleocr) with strong multilingual detection. We drive it through a small
 * self-contained Python wrapper so the JS side parses a stable JSON shape we
 * control — not PaddleOCR's version-sensitive raw return — and so the wrapper
 * absorbs the numpy/tuple conversion and BOTH detection layouts: the 2.x
 * `ocr()` shape (`[page][det] = [box4pts, (text, conf)]`) and the 3.x
 * `predict()` shape (parallel `rec_texts` / `rec_scores` / `rec_polys`).
 *
 * The wrapper emits one object per recognized text line:
 *   `[{ "box": [[x,y],[x,y],[x,y],[x,y]], "text": "...", "conf": 0.0..1.0 }, …]`
 * PaddleOCR returns line-level (not word-level) detections, so each entry maps
 * to one `OcrWithCoordsBlock` whose single word is the line; the block bbox is
 * the axis-aligned hull of the (possibly rotated) detection quad, shifted into
 * display-absolute coordinates via `sourceX/sourceY` — the same output shape as
 * the Tesseract and Windows providers, so it plugs straight into the
 * `OcrWithCoordsService` registry seam (and via the bridge into
 * plugin-computeruse's `CoordOcrProvider`).
 *
 * Opt-in: this provider is only selected when `ELIZA_VISION_OCR_BACKEND` is
 * `paddleocr`, so it never displaces a verified default provider. When PaddleOCR
 * (or python3) is absent it reports unavailable and `describe()` returns empty
 * blocks; it never throws, so the boot chain falls through cleanly.
 *
 * NOTE (#9581): the JSON parser below is unit-tested without the engine (CI
 * needs no PaddleOCR install). End-to-end behaviour was verified against a real
 * `pip install paddleocr` (3.7.0 / paddlepaddle 3.3.1 CPU) on Linux x86_64:
 * a known-text image round-trips through this wrapper + `mapPaddleOcrJsonToResult`
 * with correct per-line text, confidence, and display-absolute boxes.
 */

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@elizaos/core";
import {
  computeSemanticPosition,
  type OcrWithCoordsBlock,
  type OcrWithCoordsInput,
  type OcrWithCoordsResult,
  type OcrWithCoordsService,
} from "./ocr-with-coords.js";
import type { BoundingBox } from "./types.js";

/** One detection from the wrapper's stable JSON: a quad + line text + score. */
interface PaddleOcrDetection {
  readonly box: ReadonlyArray<readonly [number, number]>;
  readonly text: string;
  readonly conf: number;
}

/**
 * Self-contained Python driver. Reads the image path from argv, runs PaddleOCR,
 * and prints the stable JSON shape. Degrades to `[]` (never a non-zero exit)
 * when the package can't be imported or a detection is malformed, so the JS
 * `available()` probe and `describe()` both see a clean empty result.
 */
const PADDLE_PY = `
import sys, json

def emit_empty(reason):
    # Surface WHY on stderr so a broken install is observable in logs, then
    # honour the service contract (stdout = [], exit 0). The old bare
    # "except: print('[]')" silently swallowed a version mismatch (#9581).
    sys.stderr.write("[paddleocr] " + reason + "\\n")
    print("[]")
    sys.exit(0)

try:
    from paddleocr import PaddleOCR
except Exception as e:
    emit_empty("import failed: " + repr(e))

# PaddleOCR 3.x API (what \`pip install paddleocr\` resolves to today). The old
# wrapper used the 2.x \`PaddleOCR(use_angle_cls, show_log=...)\` + \`ocr(..., cls=)\`
# call; 3.x removed \`show_log\` (passing it raised ValueError -> the silent []
# this fixes), renamed angle-cls to \`use_textline_orientation\`, and replaced
# \`ocr()\` with \`predict()\` returning parallel rec_texts/rec_scores/rec_polys.
# \`enable_mkldnn=False\` avoids the 3.x oneDNN PIR-executor crash on some CPUs.
try:
    ocr = PaddleOCR(lang="en", use_textline_orientation=True, enable_mkldnn=False)
    res = ocr.predict(sys.argv[1])
except Exception as e:
    emit_empty("inference failed: " + repr(e))

out = []
try:
    for r in (res or []):
        d = r if isinstance(r, dict) else dict(r)
        for text, conf, poly in zip(
            d.get("rec_texts", []), d.get("rec_scores", []), d.get("rec_polys", [])
        ):
            try:
                out.append({
                    "box": [[float(p[0]), float(p[1])] for p in poly],
                    "text": str(text),
                    "conf": float(conf),
                })
            except Exception:
                continue
except Exception as e:
    # Honor the "never a non-zero exit" contract even if a result object is
    # not the expected dict-like shape (the dict(r) coercion could raise).
    emit_empty("result mapping failed: " + repr(e))
print(json.dumps(out))
`;

/** Axis-aligned bounding box (hull) of a detection quad (tile-relative). */
function bboxFromQuad(
  points: ReadonlyArray<readonly [number, number]>,
): BoundingBox {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    const x = p[0];
    const y = p[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Parse the wrapper's stable JSON into typed detections. Pure — exported for
 * tests so the contract with `PADDLE_PY` has a single source of truth and CI
 * never needs a real PaddleOCR install. Drops entries without at least a
 * 3-point box (real detections are 4-point quads), blank text, or a non-finite
 * score.
 */
export function parsePaddleOcrJson(raw: string): PaddleOcrDetection[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const dets: PaddleOcrDetection[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const box = e.box;
    const text = e.text;
    const conf = e.conf;
    if (
      !Array.isArray(box) ||
      box.length < 3 ||
      typeof text !== "string" ||
      text.trim().length === 0 ||
      typeof conf !== "number" ||
      !Number.isFinite(conf)
    ) {
      continue;
    }
    const points: Array<readonly [number, number]> = [];
    for (const p of box) {
      if (
        Array.isArray(p) &&
        typeof p[0] === "number" &&
        typeof p[1] === "number"
      ) {
        points.push([p[0], p[1]]);
      }
    }
    if (points.length < 3) continue;
    dets.push({ box: points, text, conf });
  }
  return dets;
}

/**
 * Pure mapper: wrapper JSON → `OcrWithCoordsResult`. Exported for unit tests
 * that inject a fixed JSON string (no real engine). One block per detected line
 * (PaddleOCR is line-level), in first-seen order; the single word is the line.
 */
export function mapPaddleOcrJsonToResult(
  raw: string,
  tileWidth: number,
  tileHeight: number,
  sourceX: number,
  sourceY: number,
): OcrWithCoordsResult {
  const safeWidth = tileWidth > 0 ? tileWidth : 1;
  const safeHeight = tileHeight > 0 ? tileHeight : 1;
  const blocks: OcrWithCoordsBlock[] = parsePaddleOcrJson(raw).map((det) => {
    const tileBox = bboxFromQuad(det.box);
    const displayBox: BoundingBox = {
      x: tileBox.x + sourceX,
      y: tileBox.y + sourceY,
      width: tileBox.width,
      height: tileBox.height,
    };
    const semantic = computeSemanticPosition({
      bbox: tileBox,
      tileWidth: safeWidth,
      tileHeight: safeHeight,
    });
    return {
      text: det.text,
      bbox: displayBox,
      words: [
        { text: det.text, bbox: displayBox, semantic_position: semantic },
      ],
      semantic_position: semantic,
    };
  });
  return { blocks };
}

/**
 * Read width/height from the PNG IHDR chunk (big-endian uint32 at offsets 16/20)
 * so the semantic-position thirds use the real tile dimensions. Mirrors the
 * Tesseract provider's reader.
 */
function readPngDimensions(pngBytes: Uint8Array): {
  width: number;
  height: number;
} {
  if (pngBytes.byteLength < 24) return { width: 0, height: 0 };
  const view = new DataView(
    pngBytes.buffer,
    pngBytes.byteOffset,
    pngBytes.byteLength,
  );
  return {
    width: view.getUint32(16, false),
    height: view.getUint32(20, false),
  };
}

let availabilityCache: boolean | null = null;

/**
 * Feature-detect PaddleOCR: python3 present AND `import paddleocr` succeeds.
 * Opt-in — only probed when `ELIZA_VISION_OCR_BACKEND === "paddleocr"`. Cached
 * for the process lifetime; the probe is one short-lived python process.
 */
function detectPaddleOcr(): boolean {
  if (availabilityCache !== null) return availabilityCache;
  if (process.env.ELIZA_VISION_OCR_BACKEND !== "paddleocr") {
    availabilityCache = false;
    return false;
  }
  try {
    execFileSync("python3", ["-c", "import paddleocr"], {
      timeout: 20000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    availabilityCache = true;
  } catch {
    availabilityCache = false;
  }
  return availabilityCache;
}

/** Test-only: reset the cached availability probe between cases. */
export function _resetPaddleOcrAvailabilityForTests(): void {
  availabilityCache = null;
}

function runPaddleOcr(imagePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "python3",
      ["-c", PADDLE_PY, imagePath],
      { timeout: 30000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`paddleocr failed: ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export class PaddleOcrService implements OcrWithCoordsService {
  readonly name = "paddleocr";

  static isAvailable(): boolean {
    return detectPaddleOcr();
  }

  async describe(input: OcrWithCoordsInput): Promise<OcrWithCoordsResult> {
    if (input.pngBytes.byteLength === 0) return { blocks: [] };
    if (!PaddleOcrService.isAvailable()) return { blocks: [] };

    const dir = mkdtempSync(join(tmpdir(), "eliza-paddleocr-"));
    const imgPath = join(dir, "frame.png");
    writeFileSync(imgPath, Buffer.from(input.pngBytes));
    try {
      const json = await runPaddleOcr(imgPath);
      const { width, height } = readPngDimensions(input.pngBytes);
      return mapPaddleOcrJsonToResult(
        json,
        width,
        height,
        input.sourceX,
        input.sourceY,
      );
    } catch (err) {
      logger.warn(
        `[PaddleOcr] OCR failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { blocks: [] };
    }
  }
}
