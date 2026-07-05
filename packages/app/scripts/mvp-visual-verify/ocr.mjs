/**
 * On-screen text readout for captured audit screenshots.
 *
 * The verifier prefers the packaged `tesseract.js` dependency so CI and local
 * evidence capture do not depend on a developer's Homebrew/apt state. A system
 * `tesseract` binary remains available as an explicit fallback for debugging.
 * Missing or failed OCR returns `{ available: false }`; the expectation layer
 * treats that as a failed text check, never a skip or fabricated empty string.
 *
 * Engine probes and packaged workers are memoized because a run OCRs ~100
 * screenshots. Call `closeOcrEngines` at the end of a verifier run so the worker
 * process does not keep Node alive.
 */

import { spawn, spawnSync } from "node:child_process";

/** @type {{ path: string | null } | null} */
let probe = null;
/** @type {Promise<any> | null} */
let packagedProbe = null;
/** @type {Map<string, Promise<any>>} */
let packagedWorkers = new Map();
const TESSERACT_JS_PACKAGE = "tesseract.js";

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
  const out =
    which.status === 0 ? which.stdout.toString().trim().split(/\r?\n/)[0] : "";
  probe = { path: out || null };
  return probe.path;
}

/**
 * Resolve the OCR engine the verifier will use. Packaged OCR is the default;
 * set `ELIZA_MVP_OCR_ENGINE=system` to force a local binary, or `packaged` to
 * fail closed when the dependency is not installed.
 *
 * @returns {Promise<{ available: true, kind: "packaged"|"system", label: string, bin?: string } | { available: false, reason: string }>}
 */
export async function resolveOcrEngine() {
  const forced = process.env.ELIZA_MVP_OCR_ENGINE;
  if (forced !== "system") {
    const packaged = await loadPackagedTesseract();
    if (packaged?.createWorker) {
      return {
        available: true,
        kind: "packaged",
        label: "tesseract.js package",
      };
    }
    if (forced === "packaged") {
      return {
        available: false,
        reason:
          "tesseract.js package is unavailable; run `bun install` so packages/app installs its OCR dependency",
      };
    }
  }

  const bin = resolveTesseract();
  if (bin) {
    return {
      available: true,
      kind: "system",
      label: `system tesseract (${bin})`,
      bin,
    };
  }
  return {
    available: false,
    reason:
      "no OCR engine available; run `bun install` for packaged tesseract.js or set ELIZA_TESSERACT_BIN",
  };
}

/** Test seam: reset the memoized probe so a test can force re-resolution. */
export function resetTesseractProbe() {
  probe = null;
  packagedProbe = null;
  packagedWorkers = new Map();
}

/**
 * OCR a single PNG. Returns the recognized text plus a `words` count and the
 * engine label, or an honest unavailable result when tesseract is missing/fails.
 *
 * @param {string} pngPath
 * @param {{ lang?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ available: true, text: string, words: number, chars: number, engine: string } | { available: false, reason: string }>}
 */
export async function ocrImage(pngPath, opts = {}) {
  const engine = await resolveOcrEngine();
  if (!engine.available) {
    return { available: false, reason: engine.reason };
  }
  const lang = opts.lang ?? "eng";
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const text =
    engine.kind === "packaged"
      ? await runPackagedTesseract(pngPath, lang, timeoutMs).catch((err) => {
          const detail = err instanceof Error ? err.message : String(err);
          return { error: detail };
        })
      : await runSystemTesseract(engine.bin, pngPath, lang, timeoutMs).catch(
          (err) => {
            const detail = err instanceof Error ? err.message : String(err);
            return { error: detail };
          },
        );
  if (typeof text !== "string") {
    return {
      available: false,
      reason: `${engine.label} failed: ${text.error.slice(0, 200)}`,
    };
  }
  const normalized = text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  const words = normalized ? normalized.split(/\s+/).filter(Boolean).length : 0;
  return {
    available: true,
    text: normalized,
    words,
    chars: normalized.replace(/\s+/g, "").length,
    engine: engine.label,
  };
}

/** Terminate packaged OCR workers after a verifier run. */
export async function closeOcrEngines() {
  const workers = [...packagedWorkers.values()];
  packagedWorkers = new Map();
  for (const workerPromise of workers) {
    const worker = await workerPromise;
    await worker.terminate();
  }
}

async function loadPackagedTesseract() {
  if (!packagedProbe) {
    packagedProbe = import(TESSERACT_JS_PACKAGE).catch(() => null);
  }
  return packagedProbe;
}

async function runPackagedTesseract(pngPath, lang, timeoutMs) {
  const worker = await getPackagedWorker(lang, timeoutMs);
  const result = await withTimeout(
    worker.recognize(pngPath),
    timeoutMs,
    `tesseract.js timed out after ${timeoutMs}ms on ${pngPath}`,
  );
  return result?.data?.text ?? "";
}

async function getPackagedWorker(lang, timeoutMs) {
  const existing = packagedWorkers.get(lang);
  if (existing) return existing;
  const workerPromise = (async () => {
    const tesseract = await loadPackagedTesseract();
    if (!tesseract?.createWorker) {
      throw new Error("tesseract.js createWorker export is unavailable");
    }
    return withTimeout(
      tesseract.createWorker(lang),
      timeoutMs,
      `tesseract.js worker initialization timed out after ${timeoutMs}ms`,
    );
  })();
  packagedWorkers.set(lang, workerPromise);
  return workerPromise;
}

/**
 * `tesseract <img> stdout -l <lang>` → recognized text on stdout. Rejects on
 * spawn error, non-zero exit, or timeout — a failed OCR is surfaced, not turned
 * into empty text (empty text is a legitimate "no readable glyphs" result and
 * must stay distinguishable from a crashed engine).
 */
function runSystemTesseract(bin, pngPath, lang, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [pngPath, "stdout", "-l", lang], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`tesseract timed out after ${timeoutMs}ms on ${pngPath}`),
      );
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

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
