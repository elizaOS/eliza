/**
 * On-screen text readout for captured audit screenshots via the system
 * `tesseract` binary.
 *
 * There is no bundled OCR engine; `tesseract.js` is only in the repo's native-
 * build allowlist, not an installed dependency. So this shells out to the
 * homebrew/apt `tesseract` binary when present and degrades HONESTLY to a
 * `{ available: false }` result when it is not — the caller renders that column
 * as an explicit "N/A (tesseract not found)" rather than fabricating text. Never
 * larp OCR: a missing engine is reported, not filled in.
 *
 * The binary probe is memoized because a run OCRs ~100 screenshots and `which`
 * on every call is wasteful.
 */

import { spawn, spawnSync } from "node:child_process";

/** @type {{ path: string | null } | null} */
let probe = null;

/**
 * Resolve the `tesseract` binary path once per process. Uses `which` (POSIX) —
 * the audit lanes that run this are macOS/Linux.
 * @returns {string | null} absolute path, or null when tesseract is absent.
 */
export function resolveTesseract() {
  if (probe) return probe.path;
  const envPath = process.env.ELIZA_TESSERACT_BIN;
  if (envPath) {
    probe = { path: envPath };
    return envPath;
  }
  const which = spawnSync(process.platform === "win32" ? "where" : "which", [
    "tesseract",
  ]);
  const out = which.status === 0 ? which.stdout.toString().trim().split(/\r?\n/)[0] : "";
  probe = { path: out || null };
  return probe.path;
}

/** Test seam: reset the memoized probe so a test can force re-resolution. */
export function resetTesseractProbe() {
  probe = null;
}

/**
 * OCR a single PNG. Returns the recognized text plus a `words` count and the
 * engine label, or an honest unavailable result when tesseract is missing.
 *
 * @param {string} pngPath
 * @param {{ lang?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ available: true, text: string, words: number, chars: number, engine: string } | { available: false, reason: string }>}
 */
export async function ocrImage(pngPath, opts = {}) {
  const bin = resolveTesseract();
  if (!bin) {
    return { available: false, reason: "tesseract binary not found" };
  }
  const lang = opts.lang ?? "eng";
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const text = await runTesseract(bin, pngPath, lang, timeoutMs);
  const normalized = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
  const words = normalized ? normalized.split(/\s+/).filter(Boolean).length : 0;
  return {
    available: true,
    text: normalized,
    words,
    chars: normalized.replace(/\s+/g, "").length,
    engine: `tesseract (${bin})`,
  };
}

/**
 * `tesseract <img> stdout -l <lang>` → recognized text on stdout. Rejects on
 * spawn error, non-zero exit, or timeout — a failed OCR is surfaced, not turned
 * into empty text (empty text is a legitimate "no readable glyphs" result and
 * must stay distinguishable from a crashed engine).
 */
function runTesseract(bin, pngPath, lang, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [pngPath, "stdout", "-l", lang], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`tesseract timed out after ${timeoutMs}ms on ${pngPath}`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `tesseract exited ${code} on ${pngPath}: ${stderr.trim().slice(0, 200)}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}
