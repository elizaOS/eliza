/**
 * Visual snapshot helper for the Electrobun desktop screenshot endpoint.
 *
 * Consumed by Playwright specs (and any other test runner) that want to assert
 * against the OS-level cursor screenshot exposed by the dev API at
 * `GET /api/dev/cursor-screenshot` (see
 * `packages/app-core/src/api/dev-compat-routes.ts`). The endpoint:
 *   - 200 image/png       → screenshot bytes
 *   - 404 application/json → screenshot server not enabled in this env
 *   - 502/403/etc          → upstream / proxy error
 *
 * Baselines live next to the specs under
 * `packages/app/test/ui-smoke/__visual__/<name>.png`. Create or refresh them
 * with `UPDATE_VISUAL_BASELINES=1` set in the environment.
 *
 * pixelmatch is intentionally NOT a dependency of this package; when it is
 * missing we fall back to a deterministic size + sha256 check and log a
 * warning. That keeps the helper usable in CI without adding new deps.
 *
 * ## Example (Playwright spec)
 *
 * ```ts
 * import { test } from "@playwright/test";
 * import {
 *   captureDesktopScreenshot,
 *   assertMatchesBaseline,
 * } from "./lib/visual-snapshot";
 *
 * test("onboarding cold-start matches baseline", async () => {
 *   const opts = { name: "onboarding-cold-start" } as const;
 *   const png = await captureDesktopScreenshot(opts);
 *   test.skip(png === null, "desktop screenshot server unavailable");
 *   await assertMatchesBaseline(png!, opts);
 * });
 * ```
 *
 * Planned consumers: `onboarding-full-flow.spec.ts` (Stage 1.1) and any
 * `electrobun-*.spec.ts` going forward.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CaptureOptions {
  /** Where the API is listening — defaults to env ELIZA_DESKTOP_API_BASE or http://127.0.0.1:31337 */
  apiBaseUrl?: string;
  /** Test-level label used in the baseline filename */
  name: string;
  /** Looser tolerance for native desktop chrome variability. Default 0.05 (5%). */
  threshold?: number;
}

const DEFAULT_THRESHOLD = 0.05;

const HERE = path.dirname(fileURLToPath(import.meta.url));
// lib/ → ui-smoke/ → __visual__/
const BASELINE_DIR = path.resolve(HERE, "..", "__visual__");

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function resolveApiBaseUrl(opts: CaptureOptions): string {
  const fromOpt = opts.apiBaseUrl?.trim();
  if (fromOpt) return fromOpt.replace(/\/$/, "");
  const fromEnv = process.env.ELIZA_DESKTOP_API_BASE?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return "http://127.0.0.1:31337";
}

function isConnectionRefused(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const cause = (err as { cause?: unknown }).cause;
  const code =
    (err as { code?: string }).code ??
    (typeof cause === "object" && cause !== null
      ? (cause as { code?: string }).code
      : undefined);
  return (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN"
  );
}

function looksLikePng(buf: Buffer): boolean {
  if (buf.length < PNG_SIGNATURE.length) return false;
  return buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function sanitizeName(name: string): string {
  // Allow letters, digits, dash, underscore, dot. Replace others with dash.
  const cleaned = name
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned) {
    throw new Error(
      `[visual-snapshot] options.name produced an empty filename: ${JSON.stringify(name)}`,
    );
  }
  return cleaned;
}

function baselinePath(name: string): string {
  return path.join(BASELINE_DIR, `${sanitizeName(name)}.png`);
}

/**
 * Capture the Electrobun desktop screenshot via /api/dev/cursor-screenshot.
 *
 * Returns the PNG buffer, or null when the endpoint reports the screenshot
 * server is unavailable (HTTP 404 with the documented hint, HTTP 503, or the
 * API is not reachable at all). Callers should treat null as "skip this
 * assertion — visual proof unavailable in this environment".
 */
export async function captureDesktopScreenshot(
  opts: CaptureOptions,
): Promise<Buffer | null> {
  const base = resolveApiBaseUrl(opts);
  const target = `${base}/api/dev/cursor-screenshot`;

  let response: Response;
  try {
    response = await fetch(target, {
      method: "GET",
      headers: { Accept: "image/png" },
      redirect: "error",
    });
  } catch (err) {
    if (isConnectionRefused(err)) {
      return null;
    }
    throw err;
  }

  if (response.status === 404 || response.status === 503) {
    // 404 is the documented "server not enabled" response from the dev route.
    // Drain the body so the connection can be reused.
    await response.text().catch(() => "");
    return null;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `[visual-snapshot] captureDesktopScreenshot: HTTP ${response.status} from ${target}: ${detail.slice(0, 200)}`,
    );
  }

  const contentType = (
    response.headers.get("content-type") ?? ""
  ).toLowerCase();
  const arrayBuffer = await response.arrayBuffer();
  const buf = Buffer.from(arrayBuffer);

  if (!contentType.startsWith("image/png") || !looksLikePng(buf)) {
    console.warn(
      `[visual-snapshot] captureDesktopScreenshot: expected image/png from ${target}, got content-type=${JSON.stringify(contentType)} length=${buf.length}`,
    );
    return null;
  }

  return buf;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

interface PixelmatchModule {
  default: (
    img1: Uint8Array,
    img2: Uint8Array,
    output: Uint8Array | null,
    width: number,
    height: number,
    options?: { threshold?: number },
  ) => number;
}

interface PngStatic {
  PNG: {
    sync: {
      read: (buf: Buffer) => { width: number; height: number; data: Buffer };
    };
  };
}

// Indirected through a variable so the TypeScript compiler does not try to
// resolve these optional peer modules at type-check time. They are loaded only
// when present in node_modules; absence is the documented fallback path.
const dynamicImport = (specifier: string): Promise<unknown> =>
  import(/* @vite-ignore */ specifier);

async function tryLoadPixelDiff(): Promise<{
  pixelmatch: PixelmatchModule["default"];
  PNG: PngStatic["PNG"];
} | null> {
  try {
    const pm = (await dynamicImport("pixelmatch")) as PixelmatchModule;
    const png = (await dynamicImport("pngjs")) as PngStatic;
    return { pixelmatch: pm.default, PNG: png.PNG };
  } catch {
    return null;
  }
}

function ensureBaselineDir(): void {
  if (!existsSync(BASELINE_DIR)) {
    mkdirSync(BASELINE_DIR, { recursive: true });
  }
}

/**
 * Compare a captured screenshot against the stored baseline. If no baseline
 * exists and `process.env.UPDATE_VISUAL_BASELINES === '1'`, writes the new
 * baseline. Otherwise throws.
 *
 * Uses pixelmatch + pngjs when both are resolvable at runtime; otherwise
 * falls back to a size + sha256 equality check and emits a one-time warning.
 */
export async function assertMatchesBaseline(
  buffer: Buffer,
  opts: CaptureOptions,
): Promise<void> {
  if (!looksLikePng(buffer)) {
    throw new Error(
      `[visual-snapshot] assertMatchesBaseline: input buffer is not a PNG (length=${buffer.length}) for name=${JSON.stringify(opts.name)}`,
    );
  }
  ensureBaselineDir();
  const baseline = baselinePath(opts.name);
  const updateMode = process.env.UPDATE_VISUAL_BASELINES === "1";

  if (!existsSync(baseline)) {
    if (updateMode) {
      writeFileSync(baseline, buffer);
      console.warn(
        `[visual-snapshot] wrote new baseline ${baseline} (${buffer.length} bytes)`,
      );
      return;
    }
    throw new Error(
      `[visual-snapshot] no baseline at ${baseline}. Re-run with UPDATE_VISUAL_BASELINES=1 to create it.`,
    );
  }

  const expected = readFileSync(baseline);
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const diff = await tryLoadPixelDiff();

  if (diff === null) {
    const sameSize = expected.length === buffer.length;
    const sameHash = sameSize && sha256(expected) === sha256(buffer);
    console.warn(
      "[visual-snapshot] pixelmatch/pngjs not available — falling back to size+sha256 comparison. Install pixelmatch+pngjs for pixel-tolerance diffing.",
    );
    if (sameHash) return;
    if (updateMode) {
      writeFileSync(baseline, buffer);
      console.warn(
        `[visual-snapshot] updated baseline ${baseline} (was ${expected.length} bytes, now ${buffer.length} bytes)`,
      );
      return;
    }
    throw new Error(
      `[visual-snapshot] ${opts.name}: bytes differ from baseline (expected ${expected.length} bytes, got ${buffer.length}). Re-run with UPDATE_VISUAL_BASELINES=1 to refresh.`,
    );
  }

  const { pixelmatch, PNG } = diff;
  const expectedPng = PNG.sync.read(expected);
  const actualPng = PNG.sync.read(buffer);

  if (
    expectedPng.width !== actualPng.width ||
    expectedPng.height !== actualPng.height
  ) {
    if (updateMode) {
      writeFileSync(baseline, buffer);
      console.warn(
        `[visual-snapshot] updated baseline ${baseline} (dimensions changed from ${expectedPng.width}x${expectedPng.height} to ${actualPng.width}x${actualPng.height})`,
      );
      return;
    }
    throw new Error(
      `[visual-snapshot] ${opts.name}: dimensions differ (baseline ${expectedPng.width}x${expectedPng.height}, captured ${actualPng.width}x${actualPng.height}). Re-run with UPDATE_VISUAL_BASELINES=1 to refresh.`,
    );
  }

  const { width, height } = expectedPng;
  const totalPixels = width * height;
  const diffPixels = pixelmatch(
    expectedPng.data,
    actualPng.data,
    null,
    width,
    height,
    { threshold: 0.1 },
  );
  const ratio = totalPixels === 0 ? 0 : diffPixels / totalPixels;
  if (ratio > threshold) {
    if (updateMode) {
      writeFileSync(baseline, buffer);
      console.warn(
        `[visual-snapshot] updated baseline ${baseline} (diff ratio ${ratio.toFixed(4)} > ${threshold})`,
      );
      return;
    }
    throw new Error(
      `[visual-snapshot] ${opts.name}: ${diffPixels} / ${totalPixels} pixels differ (ratio ${ratio.toFixed(4)} > threshold ${threshold}). Re-run with UPDATE_VISUAL_BASELINES=1 to refresh.`,
    );
  }
}
