/**
 * Native Windows OCR-with-coords via the built-in WinRT `Windows.Media.Ocr`
 * engine (issue #9105 / M4a).
 *
 * Zero LLM tokens, no model download, NPU-accelerated where available. The
 * WinRT projection is only reachable from Windows PowerShell 5.1 (`powershell`),
 * not PowerShell 7 (`pwsh`), so we shell to `powershell` with an embedded
 * script. Output is `OcrWithCoordsResult`, so this plugs straight into the
 * `OcrWithCoordsService` registry seam and (via the M1 bridge) into
 * plugin-computeruse's `CoordOcrProvider`.
 *
 * The engine returns text LINES, each with WORDS that carry bounding rects.
 * We map each line to one `OcrWithCoordsBlock` (block bbox = union of its word
 * rects), compute the semantic position against the source tile thirds, and
 * shift every bbox into display-absolute coordinates via `sourceX/sourceY`.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@elizaos/core";
import { ocrHostAvailable, runOcrHost } from "./ocr-host-windows.js";
import {
  computeSemanticPosition,
  type OcrWithCoordsBlock,
  type OcrWithCoordsInput,
  type OcrWithCoordsResult,
  type OcrWithCoordsService,
  type OcrWithCoordsWord,
} from "./ocr-with-coords.js";
import type { BoundingBox } from "./types.js";

/** Shape emitted by the embedded PowerShell script (parsed from stdout JSON). */
interface WinOcrRaw {
  width: number;
  height: number;
  lines: Array<{
    text: string;
    words: Array<{
      text: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }>;
  }>;
}

/**
 * Windows PowerShell 5.1 script: render the input PNG into a SoftwareBitmap and
 * run `Windows.Media.Ocr`, emitting compact JSON. `$ImagePath` is passed via
 * `-ImagePath`. Kept as a string so the build doesn't have to copy an asset.
 */
const WIN_OCR_PS1 =
  `param([Parameter(Mandatory=$true)][string]$ImagePath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` +
  "`" +
  `1'
})[0]
function Await($op, $resultType) {
  $m = $asTaskGeneric.MakeGenericMethod($resultType)
  $t = $m.Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}
[Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { Write-Output '{"width":0,"height":0,"lines":[]}'; exit 0 }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$lines = @()
foreach ($line in $result.Lines) {
  $words = @()
  foreach ($w in $line.Words) {
    $r = $w.BoundingRect
    $words += [pscustomobject]@{ text = $w.Text; x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }
  }
  $lines += [pscustomobject]@{ text = $line.Text; words = $words }
}
[pscustomobject]@{ width = [int]$bitmap.PixelWidth; height = [int]$bitmap.PixelHeight; lines = $lines } | ConvertTo-Json -Depth 6 -Compress`;

let cachedScriptPath: string | null = null;

function ensureScriptOnDisk(): string {
  if (cachedScriptPath) return cachedScriptPath;
  const dir = mkdtempSync(join(tmpdir(), "eliza-winocr-"));
  const p = join(dir, "windows-ocr.ps1");
  writeFileSync(p, WIN_OCR_PS1, "utf8");
  cachedScriptPath = p;
  return p;
}

function runPowerShell(scriptPath: string, imagePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-ImagePath",
        imagePath,
      ],
      { timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `windows-ocr powershell failed: ${stderr || err.message}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Map a raw Windows OCR line to an `OcrWithCoordsBlock` in display-absolute
 * coordinates. The block bbox is the union of its word rects.
 */
function lineToBlock(
  line: WinOcrRaw["lines"][number],
  tileWidth: number,
  tileHeight: number,
  sourceX: number,
  sourceY: number,
): OcrWithCoordsBlock {
  const words: OcrWithCoordsWord[] = line.words.map((w) => {
    const tileBox: BoundingBox = {
      x: w.x,
      y: w.y,
      width: w.width,
      height: w.height,
    };
    return {
      text: w.text,
      bbox: {
        x: w.x + sourceX,
        y: w.y + sourceY,
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
  for (const w of line.words) {
    minX = Math.min(minX, w.x);
    minY = Math.min(minY, w.y);
    maxX = Math.max(maxX, w.x + w.width);
    maxY = Math.max(maxY, w.y + w.height);
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
    text: line.text,
    bbox: {
      x: minX + sourceX,
      y: minY + sourceY,
      width: maxX - minX,
      height: maxY - minY,
    },
    words,
    semantic_position: computeSemanticPosition({
      bbox: tileBlockBox,
      tileWidth,
      tileHeight,
    }),
  };
}

/** Pure mapper (exported for cross-platform unit tests). */
export function mapWinOcrToResult(
  raw: WinOcrRaw,
  sourceX: number,
  sourceY: number,
): OcrWithCoordsResult {
  const tileWidth = raw.width > 0 ? raw.width : 1;
  const tileHeight = raw.height > 0 ? raw.height : 1;
  const blocks = (raw.lines ?? [])
    .filter((l) => (l.words?.length ?? 0) > 0)
    .map((l) => lineToBlock(l, tileWidth, tileHeight, sourceX, sourceY));
  return { blocks };
}

export class WindowsMediaOcrService implements OcrWithCoordsService {
  readonly name = "windows-media-ocr";

  static isAvailable(): boolean {
    return process.platform === "win32";
  }

  async describe(input: OcrWithCoordsInput): Promise<OcrWithCoordsResult> {
    if (input.pngBytes.byteLength === 0) return { blocks: [] };
    if (process.platform !== "win32") return { blocks: [] };

    const dir = mkdtempSync(join(tmpdir(), "eliza-winocr-img-"));
    const imgPath = join(dir, "frame.png");
    writeFileSync(imgPath, Buffer.from(input.pngBytes));
    try {
      // Prefer the warm OCR host (no per-call cold `powershell.exe` spawn nor
      // WinRT type-load); fall back to the one-shot `-File` spawn on any failure.
      let stdout: string;
      if (ocrHostAvailable()) {
        try {
          stdout = await runOcrHost(imgPath);
        } catch {
          stdout = await runPowerShell(ensureScriptOnDisk(), imgPath);
        }
      } else {
        stdout = await runPowerShell(ensureScriptOnDisk(), imgPath);
      }
      const raw = JSON.parse(
        stdout.trim() || '{"width":0,"height":0,"lines":[]}',
      ) as WinOcrRaw;
      return mapWinOcrToResult(raw, input.sourceX, input.sourceY);
    } catch (err) {
      logger.warn(
        `[WindowsMediaOcr] OCR failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { blocks: [] };
    } finally {
      // Clean up the per-call temp image. The warm host disposes its file
      // handle each iteration and the one-shot process has exited, so the file
      // is unlocked — important now that frequent OCR through the host would
      // otherwise accumulate temp dirs.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}
