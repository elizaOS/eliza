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
 * empty transcript that would read as "no text on screen". Once availability is
 * confirmed, a failure inside `recognize()` throws a typed `EvidenceError` — the
 * runner boundary translates it into a `failed` record; no engine returns an
 * empty transcript for an image it could not actually read.
 *
 * The `unlimited` endpoint resolves in order: explicit constructor option,
 * `ELIZA_GPU_VISION_URL`, then the discovery record `serve.json` written by
 * `scripts/gpu-vision/serve.mjs` (only after its server answered /health). The
 * OCR prompt is locked byte-for-byte to that service's `OCR_PROMPT`
 * (`scripts/gpu-vision/lib.mjs`) — a drift-guard test compares the two.
 */

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { EvidenceError } from "../../errors.ts";

const execFileAsync = promisify(execFile);

/** One grounded text region parsed from a `title [x1,y1,x2,y2]` decoration. */
export interface OcrGroundedRegion {
  /** The region's text with the coordinate decoration stripped. */
  text: string;
  /** Pixel bounding box `[x1, y1, x2, y2]` exactly as the model emitted it. */
  box: [number, number, number, number];
}

/** A recognized text result. `confidence` is 0..1 when the engine reports it. */
export interface OcrRecognition {
  text: string;
  confidence?: number;
  /** Structured grounding regions, for engines that emit `title [bbox]` lines. */
  regions?: OcrGroundedRegion[];
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
      // error-policy:J4 availability probe — a failed --version IS the
      // "unavailable" answer; it degrades to an honest skipped-missing-tool
      // record carrying the reason, never a fabricated transcript.
      return {
        available: false,
        reason: isEnoent(error)
          ? `tesseract not installed (${this.bin})`
          : `tesseract --version failed: ${errMessage(error)}`,
      };
    }
  }

  async recognize(imagePath: string): Promise<OcrRecognition> {
    const staged = stageTesseractInput(imagePath);
    const { stdout } = await execFileAsync(
      this.bin,
      [staged.path, "-", "--psm", "6"],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    ).finally(staged.cleanup);
    return { text: normalizeOcrText(stdout) };
  }
}

/**
 * Leptonica can truncate/error on long temp artifact paths. Stage through a
 * short filename so bundle layout depth cannot turn available OCR into a
 * `failed` analyzer record.
 */
function stageTesseractInput(imagePath: string): {
  path: string;
  cleanup(): void;
} {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-ocr-"));
  const extension = path.extname(imagePath) || ".png";
  const stagedPath = path.join(scratchDir, `input${extension}`);
  fs.copyFileSync(imagePath, stagedPath);
  return {
    path: stagedPath,
    cleanup: () => fs.rmSync(scratchDir, { recursive: true, force: true }),
  };
}

function normalizeOcrText(stdout: string): string {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Apple Vision engine wrapping the on-device swift helper committed at
 * `packages/app/scripts/ocr-vision.swift` (PR #14490). Available only on macOS
 * with `swift` on PATH and the helper script present; the helper reads image
 * paths on stdin and emits one NDJSON record per image with per-observation
 * mean confidence. Path is resolvable from this package via the workspace
 * layout, or overridable with `ELIZA_APPLE_VISION_OCR` for out-of-tree callers.
 *
 * The helper reports a per-image `ok` flag — false means the image could not be
 * loaded or Vision failed on it. That is a recognition FAILURE: recognize()
 * throws a typed error so the runner records `failed`, instead of passing the
 * helper's empty `text` through as a ran-with-no-text transcript. `command` and
 * `timeoutMs` are injectable so tests can drive the full subprocess protocol
 * with a fake helper (no swift toolchain required).
 */
export class AppleVisionOcrEngine implements OcrEngine {
  readonly id = "apple-vision";
  private readonly scriptPath: string;
  private readonly command: string;
  private readonly timeoutMs: number;

  constructor(
    options: { scriptPath?: string; command?: string; timeoutMs?: number } = {},
  ) {
    this.scriptPath = options.scriptPath ?? resolveAppleVisionScript();
    this.command = options.command ?? "swift";
    this.timeoutMs = options.timeoutMs ?? 60_000;
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
      await execFileAsync(this.command, ["--version"], { timeout: 10_000 });
      return { available: true };
    } catch (error) {
      // error-policy:J4 availability probe — a failed --version IS the
      // "unavailable" answer, surfaced as an honest skip record.
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
    const record = await runAppleVision(
      this.command,
      this.scriptPath,
      imagePath,
      this.timeoutMs,
    );
    if (!record.ok) {
      throw new EvidenceError(
        `apple-vision could not read ${imagePath} (helper reported ok:false — unloadable image or Vision failure)`,
        { code: "APPLE_VISION_OCR_FAILED", context: { imagePath } },
      );
    }
    return {
      text: record.text,
      confidence: record.meanConfidence,
    };
  }
}

interface AppleVisionRecord {
  ok: boolean;
  text: string;
  meanConfidence?: number;
}

/** Typed-invalid parse of the helper's NDJSON record; null when malformed. */
function parseAppleVisionRecord(value: unknown): AppleVisionRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.ok !== "boolean" || typeof record.text !== "string") {
    return null;
  }
  return {
    ok: record.ok,
    text: record.text,
    meanConfidence:
      typeof record.meanConfidence === "number"
        ? record.meanConfidence
        : undefined,
  };
}

/**
 * Feed one image path to the swift helper on stdin and parse its NDJSON line.
 * A wall-clock timeout kills the child and rejects — a hung swift process (JIT
 * compile stall, Vision deadlock) must surface as a `failed` record, not wedge
 * the whole analyzer run.
 */
async function runAppleVision(
  command: string,
  scriptPath: string,
  imagePath: string,
  timeoutMs: number,
): Promise<AppleVisionRecord> {
  return await new Promise<AppleVisionRecord>((resolve, reject) => {
    const child = spawn(command, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new EvidenceError(
            `apple-vision helper timed out after ${timeoutMs}ms`,
            {
              code: "APPLE_VISION_OCR_TIMEOUT",
              context: { imagePath, timeoutMs },
            },
          ),
        ),
      );
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.stdin.on("error", () => {
      // error-policy:J5 EPIPE from a helper that exited before consuming stdin;
      // the failure is observed by the 'close' handler below, which settles the
      // promise with the real outcome (non-zero exit or missing output).
    });
    child.on("close", (code) =>
      finish(() => {
        if (code !== 0) {
          reject(
            new EvidenceError(
              `apple-vision helper exited ${code}: ${err.trim()}`,
              { code: "APPLE_VISION_OCR_FAILED", context: { imagePath } },
            ),
          );
          return;
        }
        const line = out.split("\n").find((l) => l.trim());
        if (!line) {
          reject(
            new EvidenceError("apple-vision helper produced no output", {
              code: "APPLE_VISION_OCR_FAILED",
              context: { imagePath },
            }),
          );
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (cause) {
          // error-policy:J2 context-adding rethrow — untrusted subprocess
          // output; the bare SyntaxError says nothing about which helper broke.
          reject(
            new EvidenceError(
              `apple-vision helper emitted unparseable output: ${line.slice(0, 160)}`,
              {
                code: "APPLE_VISION_OCR_FAILED",
                cause,
                context: { imagePath },
              },
            ),
          );
          return;
        }
        const record = parseAppleVisionRecord(parsed);
        if (!record) {
          reject(
            new EvidenceError(
              `apple-vision helper record missing ok/text fields: ${line.slice(0, 160)}`,
              { code: "APPLE_VISION_OCR_FAILED", context: { imagePath } },
            ),
          );
          return;
        }
        resolve(record);
      }),
    );
    child.stdin.write(`${imagePath}\n`);
    child.stdin.end();
  });
}

/**
 * The exact OCR prompt the GPU vision service is tuned for. MUST stay
 * byte-identical to `OCR_PROMPT` in `scripts/gpu-vision/lib.mjs` — the service
 * and this client are pinned to one prompt so OCR output is reproducible across
 * runs and across the two entry points. A drift-guard test in `ocr.test.ts`
 * imports the script module and compares the constants.
 */
export const UNLIMITED_OCR_PROMPT =
  "Convert this document image to markdown. Transcribe every visible character exactly, preserving reading order. Output only the transcribed text with no commentary.";

// A grounding decoration is a line whose tail is a pixel bbox: `title [x1,y1,x2,y2]`.
const GROUNDING_LINE =
  /^(.*?)\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]$/;

/**
 * Split grounding decorations (`title [x1,y1,x2,y2]` lines the DeepSeek-OCR
 * family emits in grounding mode) out of a raw transcript: each decorated line
 * becomes a structured region and its text stays in the transcript WITHOUT the
 * coordinate tail, so text comparison never diffs against layout coordinates.
 * A bbox that fails validation (x2<x1, y2<y1, or implausibly large numbers) is
 * not a decoration — the line passes through verbatim rather than fabricating a
 * region from garbage coordinates.
 */
export function parseGroundingDecorations(raw: string): {
  text: string;
  regions: OcrGroundedRegion[];
} {
  const regions: OcrGroundedRegion[] = [];
  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    const match = line.trim().match(GROUNDING_LINE);
    if (match) {
      const box: [number, number, number, number] = [
        Number(match[2]),
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
      ];
      if (validGroundingBox(box)) {
        regions.push({ text: match[1], box });
        if (match[1] !== "") lines.push(match[1]);
        continue;
      }
    }
    lines.push(line);
  }
  return { text: lines.join("\n").trim(), regions };
}

function validGroundingBox(box: [number, number, number, number]): boolean {
  const [x1, y1, x2, y2] = box;
  return (
    box.every((value) => Number.isSafeInteger(value) && value >= 0) &&
    x2 >= x1 &&
    y2 >= y1
  );
}

/** Where `scripts/gpu-vision/serve.mjs` records its ready server (its
 * `serveStatePath()`): `ELIZA_GPU_VISION_CACHE` override, else the per-user
 * cache. Kept in lockstep with lib.mjs `cacheDir()`. */
export function defaultServeStatePath(): string {
  const override = process.env.ELIZA_GPU_VISION_CACHE;
  const root = override?.trim()
    ? path.resolve(override.trim())
    : path.join(os.homedir(), ".cache", "eliza", "gpu-vision");
  return path.join(root, "serve.json");
}

// serve.json is keyed by model set; the OCR lane is the `ocr` entry.
const SERVE_SET_KEY = "ocr";

/**
 * GPU vision-lane engine: an OpenAI-compatible chat-completions client against
 * the `llama-server` serving Baidu Unlimited-OCR (#14543). The endpoint
 * resolves from the explicit `baseUrl` option, then `ELIZA_GPU_VISION_URL`,
 * then the `serve.json` discovery record `scripts/gpu-vision/serve.mjs` writes
 * once its server answers /health; when none resolves the engine is
 * unavailable (cpu-tier runs), and when resolved-but-unreachable it reports the
 * transport failure so the analyzer degrades to `skipped-missing-tool` rather
 * than throwing. Request paths are appended to the base URL's own path, so a
 * reverse-proxied base like `http://host/vision` keeps its prefix. The image is
 * inlined as a base64 data URL; the prompt is the service's pinned
 * `UNLIMITED_OCR_PROMPT` at temperature 0 for determinism, and grounding
 * decorations in the reply are split into structured regions.
 */
export class UnlimitedOcrEngine implements OcrEngine {
  readonly id = "unlimited";
  private readonly baseUrlOption: string | undefined;
  private readonly baseUrlOptionSet: boolean;
  private readonly serveStatePathOption: string | undefined;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    options: {
      baseUrl?: string;
      model?: string;
      fetchImpl?: FetchLike;
      /** Override the serve.json location (tests); default mirrors lib.mjs. */
      serveStatePath?: string;
    } = {},
  ) {
    this.baseUrlOptionSet = Object.hasOwn(options, "baseUrl");
    this.baseUrlOption = options.baseUrl;
    this.serveStatePathOption = options.serveStatePath;
    this.model =
      options.model ?? process.env.ELIZA_GPU_VISION_MODEL ?? "unlimited-ocr";
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  /** Resolve the endpoint: option → env → serve.json discovery. */
  private async resolveEndpoint(): Promise<
    { ok: true; baseUrl: string } | { ok: false; reason: string }
  > {
    if (this.baseUrlOptionSet) {
      if (this.baseUrlOption) return { ok: true, baseUrl: this.baseUrlOption };
      return {
        ok: false,
        reason:
          "gpu vision endpoint explicitly unset (baseUrl option overrides ELIZA_GPU_VISION_URL and serve.json discovery)",
      };
    }
    const fromEnv = process.env.ELIZA_GPU_VISION_URL;
    if (fromEnv) return { ok: true, baseUrl: fromEnv };
    return await this.discoverFromServeState();
  }

  private async discoverFromServeState(): Promise<
    { ok: true; baseUrl: string } | { ok: false; reason: string }
  > {
    const statePath = this.serveStatePathOption ?? defaultServeStatePath();
    let raw: string;
    try {
      raw = await fs.promises.readFile(statePath, "utf8");
    } catch (error) {
      // error-policy:J4 discovery probe — no readable serve.json IS the
      // "service not running" answer; it degrades to an honest skip record.
      return {
        ok: false,
        reason: isEnoent(error)
          ? `ELIZA_GPU_VISION_URL unset and no gpu-vision serve.json at ${statePath} (start the service: node scripts/gpu-vision/serve.mjs)`
          : `ELIZA_GPU_VISION_URL unset and gpu-vision serve.json unreadable at ${statePath}: ${errMessage(error)}`,
      };
    }
    let state: unknown;
    try {
      state = JSON.parse(raw);
    } catch (error) {
      // error-policy:J3 untrusted state file — a corrupt serve.json yields an
      // explicit "endpoint unknown" result, never a fabricated endpoint.
      return {
        ok: false,
        reason: `gpu-vision serve.json is not valid JSON (${statePath}): ${errMessage(error)}`,
      };
    }
    const entry =
      typeof state === "object" && state !== null
        ? (state as Record<string, unknown>)[SERVE_SET_KEY]
        : undefined;
    if (typeof entry !== "object" || entry === null) {
      return {
        ok: false,
        reason: `gpu-vision serve.json has no '${SERVE_SET_KEY}' entry (${statePath}) — is the OCR server running?`,
      };
    }
    const port = (entry as Record<string, unknown>).port;
    if (
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      return {
        ok: false,
        reason: `gpu-vision serve.json '${SERVE_SET_KEY}' entry has an invalid port (${statePath})`,
      };
    }
    // serve.mjs always binds 127.0.0.1; the record stores only the port.
    return { ok: true, baseUrl: `http://127.0.0.1:${port}` };
  }

  async available(): Promise<OcrAvailable | OcrUnavailable> {
    const endpoint = await this.resolveEndpoint();
    if (!endpoint.ok) {
      return { available: false, reason: endpoint.reason };
    }
    try {
      const res = await this.fetchImpl(joinUrl(endpoint.baseUrl, "/health"), {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        return {
          available: false,
          reason: `gpu vision health ${res.status} at ${endpoint.baseUrl}`,
        };
      }
      return { available: true };
    } catch (error) {
      // error-policy:J4 availability probe — an unreachable host IS the
      // "unavailable" answer, surfaced as an honest skip record.
      return {
        available: false,
        reason: `gpu vision unreachable at ${endpoint.baseUrl}: ${errMessage(error)}`,
      };
    }
  }

  async recognize(imagePath: string): Promise<OcrRecognition> {
    const endpoint = await this.resolveEndpoint();
    if (!endpoint.ok) {
      // available() gates recognize(); this guards direct callers with the
      // same typed failure the analyzer would have skipped on.
      throw new EvidenceError(endpoint.reason, {
        code: "GPU_VISION_UNCONFIGURED",
      });
    }
    const bytes = await fs.promises.readFile(imagePath);
    const mime = mimeFromExt(imagePath);
    const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
    const res = await this.fetchImpl(
      joinUrl(endpoint.baseUrl, "/v1/chat/completions"),
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
                { type: "text", text: UNLIMITED_OCR_PROMPT },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!res.ok) {
      throw new EvidenceError(`gpu vision chat/completions ${res.status}`, {
        code: "GPU_VISION_HTTP_ERROR",
        context: { status: res.status, baseUrl: endpoint.baseUrl },
      });
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new EvidenceError(
        "gpu vision response missing choices[0].message.content",
        { code: "GPU_VISION_BAD_RESPONSE" },
      );
    }
    const { text, regions } = parseGroundingDecorations(content.trim());
    return { text, regions };
  }
}

/**
 * Append `subPath` to a base URL preserving the base's own path prefix —
 * `new URL("/health", base)` would discard it for proxied bases like
 * `http://host/vision`.
 */
function joinUrl(baseUrl: string, subPath: string): URL {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${subPath}`;
  return url;
}

/** Resolve the committed swift helper relative to this source file. */
function resolveAppleVisionScript(): string {
  const override = process.env.ELIZA_APPLE_VISION_OCR;
  if (override) return override;
  // packages/evidence/src/analyzers/ocr/engines.ts → repo packages root.
  const here = path.dirname(fileURLToPath(import.meta.url));
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
