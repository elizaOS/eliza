/**
 * macOS Apple Vision OCR provider (issue #9105 — per-OS native OCR fallback).
 *
 * Implements the structural `AppleVisionOcrProvider` seam from `ocr-service.ts`
 * by shelling out to a bundled Swift helper (`native/macos-vision-ocr.swift`)
 * that runs `VNRecognizeTextRequest` (accurate level, language correction on).
 * The helper reads PNG/JPEG bytes from stdin and prints a single JSON object;
 * this module pipes the bytes in and maps the result onto the provider shape.
 *
 * Zero LLM tokens, no model download — Apple Vision ships with macOS. This is
 * the darwin sibling of `WindowsMediaOcrService` (Windows.Media.Ocr) and the
 * iOS `createIosVisionOcrProvider` (Capacitor bridge): same VNRecognizeText
 * engine, reached without Capacitor on a desktop host.
 *
 * Coordinate convention: Vision returns normalized BOTTOM-LEFT bboxes; the
 * Swift helper converts them to TOP-LEFT PIXEL coordinates so the result
 * matches the display-absolute convention used by every other provider.
 *
 * Fails soft: `available()` is false off darwin or when `swift` is missing, and
 * `recognize()` returns an empty result rather than throwing on a helper
 * failure, so the `OCRService` chain falls through to the doCTR backend.
 */

import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@elizaos/core";
import type { AppleVisionOcrProvider } from "./ocr-service";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Single JSON line emitted by `native/macos-vision-ocr.swift`. */
interface MacosVisionRaw {
  lines: Array<{
    text: string;
    confidence: number;
    boundingBox: { x: number; y: number; width: number; height: number };
  }>;
  fullText: string;
}

interface MacosVisionAvailabilityOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  pathExists?: (candidate: string) => boolean;
  executableExists?: (name: string, env: NodeJS.ProcessEnv) => boolean;
}

/**
 * Resolve the bundled Swift helper. Works from both the dev tree (`src/`) and
 * the published build (`dist/`) — the `native/` directory sits alongside both,
 * at the package root. `ELIZA_MACOS_VISION_OCR_SCRIPT` overrides for tests.
 */
function resolveScriptPath(
  env: NodeJS.ProcessEnv = process.env,
  pathExists: (candidate: string) => boolean = existsSync,
): string | null {
  const override = env.ELIZA_MACOS_VISION_OCR_SCRIPT;
  if (override) return pathExists(override) ? override : null;
  const candidates = [
    path.join(__dirname, "..", "native", "macos-vision-ocr.swift"),
    path.join(__dirname, "..", "..", "native", "macos-vision-ocr.swift"),
  ];
  return candidates.find((candidate) => pathExists(candidate)) ?? null;
}

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasExecutableOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const pathValue = env.PATH ?? "";
  return pathValue
    .split(path.delimiter)
    .filter((segment) => segment.length > 0)
    .some((segment) => isExecutableFile(path.join(segment, name)));
}

/** True when running on macOS with the `swift` toolchain and the helper present. */
function macosVisionAvailable(
  options: MacosVisionAvailabilityOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== "darwin") return false;
  if (env.ELIZA_DISABLE_APPLE_VISION === "1") return false;
  const scriptPath = resolveScriptPath(env, options.pathExists ?? existsSync);
  if (!scriptPath) return false;
  return (options.executableExists ?? hasExecutableOnPath)("swift", env);
}

function runSwiftOcr(scriptPath: string, png: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "swift",
      [scriptPath],
      { timeout: 20000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `macos-vision-ocr swift failed: ${stderr || err.message}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.on("error", () => {
      /* The helper may have already exited (e.g. empty stdin) — the execFile
         callback owns the real outcome; ignore the broken-pipe write error. */
    });
    child.stdin?.end(Buffer.from(png));
  });
}

const EMPTY = { lines: [] as const, fullText: "" } as const;

/**
 * Build an `AppleVisionOcrProvider` backed by macOS Apple Vision. Register it
 * via `registerAppleVisionOcrProvider(createMacosVisionOcrProvider())` on
 * darwin so the `OCRService` Apple-Vision backend resolves a real engine.
 */
export function createMacosVisionOcrProvider(): AppleVisionOcrProvider {
  return {
    name: "macos-apple-vision",
    available(): boolean {
      return macosVisionAvailable();
    },
    async recognize(input) {
      const scriptPath = resolveScriptPath();
      if (process.platform !== "darwin" || !scriptPath) {
        return EMPTY;
      }
      if (input.data.length === 0) return EMPTY;
      try {
        const stdout = await runSwiftOcr(scriptPath, input.data);
        const raw = JSON.parse(
          stdout.trim() || '{"lines":[],"fullText":""}',
        ) as MacosVisionRaw;
        const lines = (raw.lines ?? []).map((line) => ({
          text: line.text,
          confidence: line.confidence,
          boundingBox: {
            x: line.boundingBox.x,
            y: line.boundingBox.y,
            width: line.boundingBox.width,
            height: line.boundingBox.height,
          },
        }));
        return { lines, fullText: raw.fullText ?? "" };
      } catch (err) {
        logger.warn(
          `[MacosVisionOcr] OCR failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return EMPTY;
      }
    },
  };
}

/** Exposed for the runtime wire-up + tests; mirrors `macosVisionAvailable`. */
export function isMacosVisionOcrAvailable(): boolean {
  return macosVisionAvailable();
}

export const __test__ = {
  macosVisionAvailable,
  resolveScriptPath,
};
