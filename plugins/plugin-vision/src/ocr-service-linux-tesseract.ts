/**
 * Native Linux OCR-with-coords via the classic `tesseract` CLI (issue #9105 /
 * M4).
 *
 * Zero LLM tokens, no in-repo model download, no ONNX — `tesseract` is a
 * standalone C++ engine packaged by every Linux distro (`apt install
 * tesseract-ocr`). We shell to it with `tsv` output, which emits one row per
 * recognized element with a `level` column (1=page, 2=block, 3=para, 4=line,
 * 5=word) plus per-element `left/top/width/height` boxes and a per-word `conf`.
 * Output maps onto `OcrWithCoordsResult`, so this plugs straight into the
 * `OcrWithCoordsService` registry seam and (via the M1 bridge) into
 * plugin-computeruse's `CoordOcrProvider`.
 *
 * We read the word rows (`level == 5`), group them by their parent
 * `(block, paragraph, line)` triple into one `OcrWithCoordsBlock` per text
 * line (block bbox = union of its word rects), compute the semantic position
 * against the source-tile thirds, and shift every bbox into display-absolute
 * coordinates via `sourceX/sourceY` — the same shape as the Windows provider.
 *
 * Availability is feature-detected on the `tesseract` binary and cached for the
 * process lifetime. When the binary is absent the provider reports unavailable
 * and `describe()` returns empty blocks; it never throws so the boot chain
 * falls through to the docTR ggml backend cleanly.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@elizaos/core";
import {
  computeSemanticPosition,
  type OcrWithCoordsBlock,
  type OcrWithCoordsInput,
  type OcrWithCoordsResult,
  type OcrWithCoordsService,
  type OcrWithCoordsWord,
} from "./ocr-with-coords.js";
import type { BoundingBox } from "./types.js";

/** A single `level == 5` (word) row parsed from the tesseract TSV. */
interface TesseractWordRow {
  readonly blockNum: number;
  readonly parNum: number;
  readonly lineNum: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** Tesseract confidence in [0, 100]; `-1` for non-word rows (filtered out). */
  readonly conf: number;
  readonly text: string;
}

/** tesseract TSV column order (fixed across 3.x/4.x/5.x). */
const COL = {
  level: 0,
  blockNum: 2,
  parNum: 3,
  lineNum: 4,
  left: 6,
  top: 7,
  width: 8,
  height: 9,
  conf: 10,
  text: 11,
} as const;

const WORD_LEVEL = 5;

/**
 * Parse the raw tesseract TSV into word rows. Pure — exported for tests so the
 * column mapping has a single source of truth and CI never needs a real
 * tesseract binary. Skips the header row, non-word levels, blank text, and any
 * row with too few columns.
 */
export function parseTesseractTsv(tsv: string): TesseractWordRow[] {
  const rows: TesseractWordRow[] = [];
  const lines = tsv.split(/\r?\n/);
  for (const raw of lines) {
    if (!raw) continue;
    const cols = raw.split("\t");
    // Header row begins with the literal "level"; data rows are numeric.
    if (cols.length <= COL.text || cols[COL.level] === "level") continue;
    const level = Number.parseInt(cols[COL.level], 10);
    if (level !== WORD_LEVEL) continue;
    // The text column may itself contain tabs in pathological cases; rejoin
    // everything from COL.text onward so a tab inside a token is preserved.
    const text = cols.slice(COL.text).join("\t");
    if (text.trim().length === 0) continue;
    rows.push({
      blockNum: Number.parseInt(cols[COL.blockNum], 10),
      parNum: Number.parseInt(cols[COL.parNum], 10),
      lineNum: Number.parseInt(cols[COL.lineNum], 10),
      left: Number.parseInt(cols[COL.left], 10),
      top: Number.parseInt(cols[COL.top], 10),
      width: Number.parseInt(cols[COL.width], 10),
      height: Number.parseInt(cols[COL.height], 10),
      conf: Number.parseFloat(cols[COL.conf]),
      text,
    });
  }
  return rows;
}

/**
 * Map grouped word rows (one text line) to an `OcrWithCoordsBlock` in
 * display-absolute coordinates. The block bbox is the union of its word rects.
 */
function lineToBlock(
  words: readonly TesseractWordRow[],
  tileWidth: number,
  tileHeight: number,
  sourceX: number,
  sourceY: number,
): OcrWithCoordsBlock {
  const mappedWords: OcrWithCoordsWord[] = words.map((w) => {
    const tileBox: BoundingBox = {
      x: w.left,
      y: w.top,
      width: w.width,
      height: w.height,
    };
    return {
      text: w.text,
      bbox: {
        x: w.left + sourceX,
        y: w.top + sourceY,
        width: w.width,
        height: w.height,
      },
      semantic_position: computeSemanticPosition({
        bbox: tileBox,
        tileWidth,
        tileHeight,
      }),
    };
  });

  // Union of word rects (tile-relative) → block bbox.
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const w of words) {
    minX = Math.min(minX, w.left);
    minY = Math.min(minY, w.top);
    maxX = Math.max(maxX, w.left + w.width);
    maxY = Math.max(maxY, w.top + w.height);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  const tileBlockBox: BoundingBox = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
  return {
    text: words.map((w) => w.text).join(" "),
    bbox: {
      x: minX + sourceX,
      y: minY + sourceY,
      width: maxX - minX,
      height: maxY - minY,
    },
    words: mappedWords,
    semantic_position: computeSemanticPosition({
      bbox: tileBlockBox,
      tileWidth,
      tileHeight,
    }),
  };
}

/**
 * Pure mapper: raw tesseract TSV → `OcrWithCoordsResult`. Exported for
 * cross-platform unit tests that inject a fixed TSV string (no real binary).
 * Word rows are grouped by their `(block, paragraph, line)` triple — one
 * `OcrWithCoordsBlock` per recognized text line — in first-seen order.
 */
export function mapTesseractTsvToResult(
  tsv: string,
  tileWidth: number,
  tileHeight: number,
  sourceX: number,
  sourceY: number,
): OcrWithCoordsResult {
  const safeWidth = tileWidth > 0 ? tileWidth : 1;
  const safeHeight = tileHeight > 0 ? tileHeight : 1;
  const words = parseTesseractTsv(tsv);

  const order: string[] = [];
  const groups = new Map<string, TesseractWordRow[]>();
  for (const w of words) {
    const key = `${w.blockNum}/${w.parNum}/${w.lineNum}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
      order.push(key);
    }
    group.push(w);
  }

  const blocks = order.map((key) =>
    lineToBlock(
      groups.get(key) as TesseractWordRow[],
      safeWidth,
      safeHeight,
      sourceX,
      sourceY,
    ),
  );
  return { blocks };
}

/** Resolved tesseract invocation: the binary path + the env it must run under. */
export interface TesseractResolution {
  bin: string;
  /** Extra env merged onto `process.env` for child runs (LD_LIBRARY_PATH,
   * TESSDATA_PREFIX) — non-empty only when a bundled tesseract is used. */
  env: Record<string, string>;
}

/**
 * Resolve a tesseract to run, so the OCR path "just ships and works" without a
 * system `apt install tesseract-ocr` (#9105). Order:
 *
 *   1. `ELIZA_TESSERACT_BIN` — an explicit binary path (CI / power users).
 *   2. A vendored bundle the app ships, found at
 *      `${ELIZA_VISION_VENDOR_DIR}/tesseract/{bin/tesseract, lib/*.so*,
 *      tessdata/<lang>.traineddata}`. The desktop build stages a portable
 *      tesseract there (binary + libtesseract/libleptonica + eng.traineddata);
 *      we then run it with that `lib/` on `LD_LIBRARY_PATH` and that `tessdata/`
 *      as `TESSDATA_PREFIX`, so no host install is needed.
 *   3. `tesseract` on `PATH` (a system install, the legacy path).
 *
 * Pure-ish + exported for tests (it only reads env + the filesystem); cached for
 * the process lifetime.
 */
export function resolveTesseract(): TesseractResolution {
  const binOverride = process.env.ELIZA_TESSERACT_BIN;
  if (binOverride && binOverride.length > 0) {
    return { bin: binOverride, env: {} };
  }
  const vendor = process.env.ELIZA_VISION_VENDOR_DIR;
  if (vendor && vendor.length > 0) {
    const root = join(vendor, "tesseract");
    const cand = join(root, "bin", "tesseract");
    const tessdata = join(root, "tessdata");
    // Only select the vendor tier when the bundle is actually usable: a binary
    // AND a language model. A half-staged dir (binary present, tessdata missing)
    // would otherwise be chosen and then fail at OCR time; fall through to PATH
    // so the system tesseract still works.
    if (existsSync(cand) && hasTraineddata(tessdata)) {
      const lib = join(root, "lib");
      const prior = process.env.LD_LIBRARY_PATH;
      return {
        bin: cand,
        env: {
          LD_LIBRARY_PATH: prior ? `${lib}:${prior}` : lib,
          TESSDATA_PREFIX: tessdata,
        },
      };
    }
  }
  return { bin: "tesseract", env: {} };
}

/** A vendored tessdata dir is only usable if it carries at least one language
 * model (`<lang>.traineddata`); otherwise selecting the bundle fails at OCR time. */
function hasTraineddata(tessdataDir: string): boolean {
  if (!existsSync(tessdataDir)) return false;
  return readdirSync(tessdataDir).some((f) => f.endsWith(".traineddata"));
}

let availabilityCache: boolean | null = null;
let resolutionCache: TesseractResolution | null = null;

function resolved(): TesseractResolution {
  if (!resolutionCache) resolutionCache = resolveTesseract();
  return resolutionCache;
}

/**
 * Feature-detect the resolved tesseract by running `--version` under its env.
 * Cached for the process lifetime. Synchronous so it slots into the boot-time
 * availability probe; the probe is cheap (one short-lived child process) and
 * only runs once.
 */
function detectTesseract(): boolean {
  if (availabilityCache !== null) return availabilityCache;
  if (process.platform !== "linux") {
    availabilityCache = false;
    return false;
  }
  const { bin, env } = resolved();
  try {
    execFileSync(bin, ["--version"], {
      timeout: 5000,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, ...env },
    });
    availabilityCache = true;
  } catch {
    availabilityCache = false;
  }
  return availabilityCache;
}

/** Test-only: reset the cached availability + resolution probes between cases. */
export function _resetTesseractAvailabilityForTests(): void {
  availabilityCache = null;
  resolutionCache = null;
}

function runTesseract(imagePath: string): Promise<string> {
  const { bin, env } = resolved();
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      [imagePath, "stdout", "--psm", "11", "tsv"],
      {
        timeout: 15000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...env },
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`tesseract failed: ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Read width/height from the PNG IHDR chunk so the semantic-position thirds are
 * computed against the real tile dimensions (the TSV carries word boxes but no
 * page size header we can trust across versions). PNG signature is 8 bytes;
 * IHDR width/height are big-endian uint32 at offsets 16 and 20.
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

export class LinuxTesseractOcrService implements OcrWithCoordsService {
  readonly name = "linux-tesseract";

  static isAvailable(): boolean {
    return detectTesseract();
  }

  async describe(input: OcrWithCoordsInput): Promise<OcrWithCoordsResult> {
    if (input.pngBytes.byteLength === 0) return { blocks: [] };
    if (!LinuxTesseractOcrService.isAvailable()) return { blocks: [] };

    const dir = mkdtempSync(join(tmpdir(), "eliza-tesseract-"));
    const imgPath = join(dir, "frame.png");
    writeFileSync(imgPath, Buffer.from(input.pngBytes));
    try {
      const tsv = await runTesseract(imgPath);
      const { width, height } = readPngDimensions(input.pngBytes);
      return mapTesseractTsvToResult(
        tsv,
        width,
        height,
        input.sourceX,
        input.sourceY,
      );
    } catch (err) {
      logger.warn(
        `[LinuxTesseractOcr] OCR failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { blocks: [] };
    }
  }
}
