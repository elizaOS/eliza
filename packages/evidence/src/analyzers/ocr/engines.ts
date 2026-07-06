/**
 * OCR engine interface and its concrete backends. Splitting the engine out from
 * the `ocr.*` analyzers lets one analyzer body serve several recognizers that
 * differ only in where the text comes from: `tesseract` (CPU CLI, the ported
 * behaviour from `packages/app/scripts/lib/visual-qa.mjs`), `unlimited` (the GPU
 * vision lane — an OpenAI-compatible `llama-server` serving Baidu Unlimited-OCR,
 * #14543), and `apple-vision` (macOS on-device Vision, wrapping the swift helper
 * merged in PR #14490).
 *
 * Every engine reports availability BEFORE it is asked to recognize, so the
 * analyzer can emit an honest `skipped-missing-tool` record with the reason
 * (binary absent, endpoint unset, host unreachable) instead of a fabricated
 * empty transcript that would read as "no text on screen".
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A recognized text result. `confidence` is 0..1 when the engine reports it. */
export interface OcrRecognition {
  text: string;
  confidence?: number;
}

/** Why an engine is unavailable, surfaced verbatim in a skip record. */
export interface OcrUnavailable {
  available: false;
  reason: string;
}

export interface OcrAvailable {
  available: true;
}

/**
 * A pluggable OCR backend. `available()` is cheap and side-effect-free enough to
 * call per run; `recognize()` is only invoked once availability is confirmed.
 */
export interface OcrEngine {
  /** Stable id embedded in the analyzer name, e.g. `tesseract`, `unlimited`. */
  readonly id: string;
  available(): Promise<OcrAvailable | OcrUnavailable>;
  recognize(imagePath: string): Promise<OcrRecognition>;
}

type FetchLike = (
  input: URL,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Tesseract CLI engine — the exact invocation ported from visual-qa.mjs
 * (`tesseract <img> - --psm 6`). `ELIZA_TESSERACT_BIN` overrides the binary,
 * matching the app's OCR resolver so a single env var configures both.
 */
export class TesseractOcrEngine implements OcrEngine {
  readonly id = "tesseract";
  private readonly bin: string;

  constructor(bin = process.env.ELIZA_TESSERACT_BIN || "tesseract") {
    this.bin = bin;
  }

  async available(): Promise<OcrAvailable | OcrUnavailable> {
    try {
      await execFileAsync(this.bin, ["--version"], { timeout: 10_000 });
      return { available: true };
    } catch (error) {
      return {
        available: false,
        reason: isEnoent(error)
          ? `tesseract not installed (${this.bin})`
          : `tesseract --version failed: ${errMessage(error)}`,
      };
    }
  }

  async recognize(imagePath: string): Promise<OcrRecognition> {
    const { stdout } = await execFileAsync(
      this.bin,
      [imagePath, "-", "--psm", "6"],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    );
    const text = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");
    return { text };
  }
}

/**
 * Apple Vision engine wrapping the on-device swift helper committed at
 * `packages/app/scripts/ocr-vision.swift` (PR #14490). Available only on macOS
 * with `swift` on PATH and the helper script present; the helper reads image
 * paths on stdin and emits one NDJSON record per image with per-observation
 * mean confidence. Path is resolvable from this package via the workspace
 * layout, or overridable with `ELIZA_APPLE_VISION_OCR` for out-of-tree callers.
 */
export class AppleVisionOcrEngine implements OcrEngine {
  readonly id = "apple-vision";
  private readonly scriptPath: string;

  constructor(scriptPath = resolveAppleVisionScript()) {
    this.scriptPath = scriptPath;
  }

  async available(): Promise<OcrAvailable | OcrUnavailable> {
    if (process.platform !== "darwin") {
      return { available: false, reason: "apple-vision requires macOS" };
    }
    if (!fs.existsSync(this.scriptPath)) {
      return {
        available: false,
        reason: `apple-vision helper not found: ${this.scriptPath}`,
      };
    }
    try {
      await execFileAsync("swift", ["--version"], { timeout: 10_000 });
      return { available: true };
    } catch (error) {
      return {
        available: false,
        reason: isEnoent(error)
          ? "swift toolchain not installed"
          : `swift --version failed: ${errMessage(error)}`,
      };
    }
  }

  async recognize(imagePath: string): Promise<OcrRecognition> {
    // The helper reads newline-delimited paths on stdin (one path → one NDJSON
    // record), which execFile cannot supply, so it runs through a stdin-capable
    // spawn.
    const record = await runAppleVision(this.scriptPath, imagePath);
    return {
      text: record.text,
      confidence:
        typeof record.meanConfidence === "number"
          ? record.meanConfidence
          : undefined,
    };
  }
}

interface AppleVisionRecord {
  ok: boolean;
  text: string;
  meanConfidence?: number;
}

/** Feed one image path to the swift helper on stdin and parse its NDJSON line. */
async function runAppleVision(
  scriptPath: string,
  imagePath: string,
): Promise<AppleVisionRecord> {
  const { spawn } = await import("node:child_process");
  return await new Promise<AppleVisionRecord>((resolve, reject) => {
    const child = spawn("swift", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`apple-vision helper exited ${code}: ${err.trim()}`));
        return;
      }
      const line = out.split("\n").find((l) => l.trim());
      if (!line) {
        reject(new Error("apple-vision helper produced no output"));
        return;
      }
      resolve(JSON.parse(line) as AppleVisionRecord);
    });
    child.stdin.write(`${imagePath}\n`);
    child.stdin.end();
  });
}

/**
 * GPU vision-lane engine: an OpenAI-compatible chat-completions client against
 * the `llama-server` serving Baidu Unlimited-OCR (#14543). Endpoint comes from
 * `ELIZA_GPU_VISION_URL`; when unset the engine is unavailable (cpu-tier runs),
 * and when set-but-unreachable it reports the transport failure so the analyzer
 * degrades to `skipped-missing-tool` rather than throwing. The image is inlined
 * as a base64 data URL; the prompt is the grounding + convert-to-markdown
 * instruction the service is tuned for, at temperature 0 for determinism.
 */
export class UnlimitedOcrEngine implements OcrEngine {
  readonly id = "unlimited";
  private readonly baseUrl: string | undefined;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    options: {
      baseUrl?: string;
      model?: string;
      fetchImpl?: FetchLike;
    } = {},
  ) {
    this.baseUrl = Object.hasOwn(options, "baseUrl")
      ? options.baseUrl
      : process.env.ELIZA_GPU_VISION_URL;
    this.model =
      options.model ?? process.env.ELIZA_GPU_VISION_MODEL ?? "unlimited-ocr";
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  async available(): Promise<OcrAvailable | OcrUnavailable> {
    if (!this.baseUrl) {
      return {
        available: false,
        reason:
          "ELIZA_GPU_VISION_URL unset (gpu vision service not configured)",
      };
    }
    try {
      const res = await this.fetchImpl(new URL("/health", this.baseUrl), {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        return {
          available: false,
          reason: `gpu vision health ${res.status} at ${this.baseUrl}`,
        };
      }
      return { available: true };
    } catch (error) {
      return {
        available: false,
        reason: `gpu vision unreachable at ${this.baseUrl}: ${errMessage(error)}`,
      };
    }
  }

  async recognize(imagePath: string): Promise<OcrRecognition> {
    if (!this.baseUrl) {
      // available() gates recognize(); this guards the type, never runs.
      throw new Error("unlimited OCR endpoint not configured");
    }
    const bytes = await fs.promises.readFile(imagePath);
    const mime = mimeFromExt(imagePath);
    const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
    const res = await this.fetchImpl(
      new URL("/v1/chat/completions", this.baseUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Convert this screenshot to markdown. Transcribe all visible text verbatim, preserving reading order.",
                },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!res.ok) {
      throw new Error(`gpu vision chat/completions ${res.status}`);
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new Error("gpu vision response missing choices[0].message.content");
    }
    return { text: text.trim() };
  }
}

/** Resolve the committed swift helper relative to this source file. */
function resolveAppleVisionScript(): string {
  const override = process.env.ELIZA_APPLE_VISION_OCR;
  if (override) return override;
  // packages/evidence/src/analyzers/ocr/engines.ts → repo packages root.
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, "../../../../app/scripts/ocr-vision.swift");
}

function mimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function errMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 160);
}
