/**
 * Persistent WinRT OCR host (Windows-only) — kills the per-OCR cold-spawn tax.
 *
 * `WindowsMediaOcrService.describe()` previously ran `powershell -File
 * windows-ocr.ps1` for EVERY recognized region. On Defender-heavy hosts a cold
 * `powershell.exe` spawn is ~10-16s (#9581), and OCR fires on every dirty region
 * every turn — and the scene pipeline OCRs regions in parallel, so a turn would
 * spawn N cold processes at once and thrash the AV scanner.
 *
 * This keeps ONE long-lived `powershell.exe` that loads the (expensive) WinRT
 * projection + `OcrEngine` ONCE in its parent scope, then loops: read an image
 * path on stdin, recognize, emit one compact JSON line on stdout. So each call
 * pays neither the process spawn NOR the WinRT type-load — only the recognize
 * (~0.3-1s). Requests are serialized over the one pipe (fine — each is fast).
 *
 * It is a pure latency optimization: `describe()` falls back to the original
 * one-shot `-File` spawn whenever the host is unavailable / disabled / errors,
 * so output is unchanged. No-op off Windows. Disable with `ELIZA_VISION_OCR_HOST=0`.
 *
 * Protocol: JS writes `<absolute-image-path>\n`; the host writes exactly one
 * line of compact JSON (`{width,height,lines}` — same shape as the one-shot
 * script). base64 isn't needed: temp image paths never contain newlines, and
 * `ConvertTo-Json -Compress` output is always a single physical line.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

const STARTUP_TIMEOUT_MS = 25_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_START_FAILURES = 2;

let host: ChildProcessWithoutNullStreams | null = null;
let starting: Promise<void> | null = null;
let startFailures = 0;
let loopScriptPath: string | null = null;
let stdoutBuf = "";
let stderrRing = "";
let pending: {
  resolve: (line: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
} | null = null;
let chain: Promise<unknown> = Promise.resolve();

// One-time preamble loads the WinRT projection + OcrEngine in the parent scope;
// the loop reuses them per request. Mirrors the recognition logic of the
// one-shot `WIN_OCR_PS1` exactly so output is identical — only the spawn + the
// type-load are amortized. Streams/bitmaps are disposed each iteration (a
// long-lived session must not leak handles or keep temp PNGs locked).
const OCR_SERVER_PS1 =
  `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
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
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
while ($true) {
  $ImagePath = [Console]::In.ReadLine()
  if ($null -eq $ImagePath) { break }
  if ($ImagePath.Length -eq 0) { continue }
  $stream = $null
  $bitmap = $null
  try {
    if ($null -eq $engine) { [Console]::Out.WriteLine('{"width":0,"height":0,"lines":[]}'); [Console]::Out.Flush(); continue }
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
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
    $out = [pscustomobject]@{ width = [int]$bitmap.PixelWidth; height = [int]$bitmap.PixelHeight; lines = $lines } | ConvertTo-Json -Depth 6 -Compress
    [Console]::Out.WriteLine($out)
  } catch {
    [Console]::Out.WriteLine('{"width":0,"height":0,"lines":[],"error":"ocr-host"}')
  } finally {
    # Always release the file handle + bitmap, even on a mid-iteration throw —
    # otherwise the handle leaks and keeps the temp PNG locked so the caller's
    # rmSync cannot delete it (this is a long-lived session).
    if ($null -ne $bitmap) { try { $bitmap.Dispose() } catch {} }
    if ($null -ne $stream) { try { $stream.Dispose() } catch {} }
  }
  [Console]::Out.Flush()
}`;

export function ocrHostAvailable(): boolean {
  if (platform() !== "win32") return false;
  if (process.env.ELIZA_VISION_OCR_HOST === "0") return false;
  if (startFailures >= MAX_START_FAILURES) return false;
  return true;
}

function onStdout(chunk: Buffer): void {
  stdoutBuf += chunk.toString("utf8");
  if (!pending) return;
  const nl = stdoutBuf.indexOf("\n");
  if (nl === -1) return;
  const line = stdoutBuf.slice(0, nl).replace(/\r$/, "");
  stdoutBuf = stdoutBuf.slice(nl + 1);
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  p.resolve(line);
}

function onExit(): void {
  host = null;
  starting = null;
  stdoutBuf = "";
  if (pending) {
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    p.reject(new Error("ocr-host exited unexpectedly"));
  }
}

export function shutdownOcrHost(): void {
  if (host) {
    try {
      host.stdin.end();
    } catch {
      /* best effort */
    }
    try {
      host.kill();
    } catch {
      /* best effort */
    }
  }
  if (loopScriptPath) {
    try {
      unlinkSync(loopScriptPath);
    } catch {
      /* best effort */
    }
    loopScriptPath = null;
  }
  onExit();
}

async function ensureHost(): Promise<void> {
  if (host) return;
  if (starting) return starting;
  starting = (async () => {
    const scriptPath = join(tmpdir(), `eliza-ocr-host-${process.pid}.ps1`);
    writeFileSync(scriptPath, OCR_SERVER_PS1, "utf8");
    loopScriptPath = scriptPath;
    const child = spawn(
      "powershell",
      [
        "-NoProfile",
        "-NoLogo",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    child.stdout.on("data", onStdout);
    child.stderr.on("data", (c: Buffer) => {
      stderrRing = (stderrRing + c.toString("utf8")).slice(-2048);
    });
    // Swallow stdin pipe errors (EPIPE when the host dies between requests) so
    // Node doesn't throw an uncaught exception and crash the process; the dead
    // pipe surfaces via onExit → a normal rejection the caller falls back from.
    child.stdin.on("error", () => {});
    // Bind exit/error to THIS child so a previously-killed host's late 'exit'
    // can't tear down a freshly respawned host or reject its pending request.
    const onChildGone = () => {
      if (host !== child) return;
      onExit();
    };
    child.once("exit", onChildGone);
    child.once("error", onChildGone);
    host = child;
    // Probe: a blank line is ignored by the loop, so prove readiness by sending
    // a path we expect to fail recognition — the loop always answers one JSON
    // line (the error branch), which confirms the preamble loaded and the loop
    // is reading.
    await sendRaw(
      join(tmpdir(), `eliza-ocr-probe-nonexistent-${process.pid}.png`),
      STARTUP_TIMEOUT_MS,
    );
  })();
  try {
    await starting;
    startFailures = 0;
  } catch (err) {
    startFailures += 1;
    shutdownOcrHost();
    throw err;
  } finally {
    starting = null;
  }
}

function sendRaw(imagePath: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (!host) {
      reject(new Error("ocr-host not running"));
      return;
    }
    const timer = setTimeout(() => {
      pending = null;
      shutdownOcrHost();
      reject(
        new Error(
          `ocr-host timeout after ${timeoutMs}ms${stderrRing ? ` (stderr: ${stderrRing.trim().slice(-200)})` : ""}`,
        ),
      );
    }, timeoutMs);
    pending = { resolve, reject, timer };
    try {
      host.stdin.write(`${imagePath}\n`);
    } catch (err) {
      clearTimeout(timer);
      pending = null;
      shutdownOcrHost();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Recognize the image at `imagePath` via the warm host, returning the raw JSON
 * line (same shape the one-shot script emits). Serialized against other calls.
 * Rejects (so the caller can fall back to a one-shot spawn) on host-start
 * failure, timeout, or unexpected exit.
 */
export function runOcrHost(imagePath: string): Promise<string> {
  const task = async (): Promise<string> => {
    await ensureHost();
    return sendRaw(imagePath, REQUEST_TIMEOUT_MS);
  };
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

process.once("exit", () => {
  if (host) {
    try {
      host.kill();
    } catch {
      /* best effort */
    }
  }
});
