import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { formatByteSize, getLogPrefix } from "@elizaos/shared";
import { EMBEDDING_PRESETS } from "./embedding-presets.js";

/**
 * Callback for reporting download/init progress.
 * @param phase - Current phase: "checking", "downloading", "loading", "ready"
 * @param detail - Human-readable detail (e.g. "45% of 95 MB")
 */
export type EmbeddingProgressCallback = (
  phase: "checking" | "downloading" | "loading" | "ready",
  detail?: string,
) => void;

/**
 * Callback for raw download byte progress.
 * @param downloaded - Bytes received so far
 * @param total - Total bytes expected (null if Content-Length unavailable)
 */
export type DownloadProgressCallback = (
  downloaded: number,
  total: number | null,
) => void;

export interface EmbeddingManagerConfig {
  /** GGUF model filename (default: detected hardware preset) */
  model?: string;
  /** HuggingFace repo for auto-download (default: detected hardware preset repo) */
  modelRepo?: string;
  /** Embedding dimensions (default: detected hardware preset dimensions) */
  dimensions?: number;
  /** GPU layers: "auto" | "max" | number (default: detected hardware preset gpuLayers) */
  gpuLayers?: "auto" | "max" | number;
  /** Model context window in tokens (default: detected hardware preset contextSize) */
  contextSize?: number;
  /** Idle timeout in ms before unloading model (default: 1800000 = 30 min, 0 = never unload) */
  idleTimeoutMs?: number;
  /** Models directory (default: ~/.eliza/models) */
  modelsDir?: string;
  /** Optional callback for reporting initialization progress phases. */
  onProgress?: EmbeddingProgressCallback;
}

export interface EmbeddingManagerStats {
  lastUsedAt: number | null;
  isLoaded: boolean;
  model: string;
  gpuLayers: string | number;
  dimensions: number;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const DEFAULT_MODELS_DIR = path.join(os.homedir(), ".eliza", "models");

const EMBEDDING_META_DIR =
  process.env.ELIZA_EMBEDDING_META_DIR ??
  path.join(os.homedir(), ".eliza", "state");
export const EMBEDDING_META_PATH =
  process.env.ELIZA_EMBEDDING_META_PATH ??
  path.join(EMBEDDING_META_DIR, "embedding-meta.json");

let _logger:
  | {
      info: (...a: unknown[]) => void;
      warn: (...a: unknown[]) => void;
      error: (...a: unknown[]) => void;
      debug: (...a: unknown[]) => void;
    }
  | undefined;

export function getLogger() {
  if (_logger) return _logger;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const core = require("@elizaos/core");
    if (core?.logger) {
      _logger = core.logger;
      return _logger as NonNullable<typeof _logger>;
    }
  } catch {
    // Fallback below
  }
  _logger = console;
  return _logger;
}

interface EmbeddingMeta {
  model: string;
  dimensions: number;
  lastChanged: string;
}

export function readEmbeddingMeta(): EmbeddingMeta | null {
  try {
    if (!fs.existsSync(EMBEDDING_META_PATH)) return null;
    return JSON.parse(
      fs.readFileSync(EMBEDDING_META_PATH, "utf-8"),
    ) as EmbeddingMeta;
  } catch {
    return null;
  }
}

function writeEmbeddingMeta(meta: EmbeddingMeta): void {
  try {
    fs.mkdirSync(EMBEDDING_META_DIR, { recursive: true });
    fs.writeFileSync(EMBEDDING_META_PATH, JSON.stringify(meta, null, 2));
  } catch (err) {
    getLogger().warn(
      `${getLogPrefix()} Failed to write embedding metadata: ${err}`,
    );
  }
}

export function checkDimensionMigration(
  model: string,
  dimensions: number,
): void {
  const log = getLogger();
  const stored = readEmbeddingMeta();

  if (stored && stored.dimensions !== dimensions) {
    log.warn(
      `${getLogPrefix()} Embedding dimensions changed (${stored.dimensions} → ${dimensions}). ` +
        "Existing memory embeddings will be re-indexed on next access.",
    );
  }

  writeEmbeddingMeta({
    model,
    dimensions,
    lastChanged: new Date().toISOString(),
  });
}

export function safeUnlink(filepath: string): void {
  try {
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  } catch {
    // best-effort cleanup
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (
    error != null &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

export function isCorruptedModelLoadError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("failed to load model") ||
    message.includes("data is not within the file bounds") ||
    (message.includes("tensor") && message.includes("is corrupted")) ||
    message.includes("model is corrupted")
  );
}

function parseContentLength(
  contentLength: string | string[] | undefined,
): number | null {
  if (!contentLength || Array.isArray(contentLength)) return null;
  const parsed = Number.parseInt(contentLength, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isAllowedDownloadHost(hostname: string): boolean {
  return (
    hostname === "huggingface.co" ||
    hostname.endsWith(".huggingface.co") ||
    hostname === "hf.co" ||
    hostname.endsWith(".hf.co")
  );
}

function validateDownloadUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Download failed: invalid URL "${rawUrl}"`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Download failed: only https:// URLs are allowed");
  }

  if (!isAllowedDownloadHost(parsed.hostname.toLowerCase())) {
    throw new Error(
      `Download failed: host "${parsed.hostname}" is not allowed`,
    );
  }

  return parsed;
}

function sanitizeModelRepo(repo: string): string {
  const trimmed = repo.trim();
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(`Invalid embedding model repo: ${repo}`);
  }
  return trimmed;
}

function sanitizeModelFilename(filename: string): string {
  const trimmed = filename.trim();
  // Permit forward-slash separated path segments so canonical HF-style ids like
  // `text/eliza-1-lite-0_6b-32k.gguf` (a real subdirectory in the upstream repo
  // and the on-disk layout under `modelsDir`) pass validation. Each segment is
  // restricted to `[A-Za-z0-9._-]+`, which alone would let `.` / `..` through;
  // we reject those explicitly below. `resolveModelPath` provides
  // defense-in-depth via a realpath comparison against `modelsDir`.
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.gguf$/i.test(trimmed)) {
    throw new Error(`Invalid embedding model filename: ${filename}`);
  }
  for (const segment of trimmed.split("/")) {
    if (segment === "." || segment === "..") {
      throw new Error(`Invalid embedding model filename: ${filename}`);
    }
  }
  return trimmed;
}

function resolveModelPath(modelsDir: string, filename: string): string {
  const resolvedDir = path.resolve(modelsDir);
  const resolvedPath = path.resolve(resolvedDir, filename);
  if (
    resolvedPath !== resolvedDir &&
    !resolvedPath.startsWith(`${resolvedDir}${path.sep}`)
  ) {
    throw new Error("Invalid embedding model path");
  }
  return resolvedPath;
}

/** Known TEXT_EMBEDDING GGUFs the framework may warm up (same filenames as HuggingFace repos). */
export interface WarmupReuseEmbeddingCandidate {
  readonly model: string;
  readonly modelRepo: string;
  readonly dimensions: number;
  readonly contextSize: number;
  readonly gpuLayers: string;
}

function warmupReuseEmbeddingCandidates(): WarmupReuseEmbeddingCandidate[] {
  return [
    {
      model: EMBEDDING_PRESETS.performance.model,
      modelRepo: EMBEDDING_PRESETS.performance.modelRepo,
      dimensions: EMBEDDING_PRESETS.performance.dimensions,
      contextSize: EMBEDDING_PRESETS.performance.contextSize,
      gpuLayers: String(EMBEDDING_PRESETS.performance.gpuLayers),
    },
  ];
}

/** True if a sanitized GGUF with this basename exists under `modelsDir`. */
export function embeddingGgufFilePresent(
  modelsDir: string,
  filename: string,
): boolean {
  try {
    const safe = sanitizeModelFilename(filename);
    return fs.existsSync(resolveModelPath(modelsDir, safe));
  } catch {
    return false;
  }
}

/**
 * When the configured embedding file is missing, reuse only the compact,
 * SQL-safe embedding GGUF already on disk. The framework intentionally avoids
 * reviving legacy larger defaults from MODELS_DIR because they would reintroduce
 * dimension mismatches and unnecessary RAM/download cost.
 */
export function findExistingEmbeddingModelForWarmupReuse(
  modelsDir: string,
): WarmupReuseEmbeddingCandidate | null {
  const dir = path.resolve(modelsDir);
  if (!fs.existsSync(dir)) {
    return null;
  }
  for (const c of warmupReuseEmbeddingCandidates()) {
    if (embeddingGgufFilePresent(dir, c.model)) {
      return c;
    }
  }
  return null;
}

export function isEmbeddingWarmupReuseDisabled(): boolean {
  const raw =
    process.env.ELIZA_EMBEDDING_WARMUP_NO_REUSE?.trim().toLowerCase() ?? "";
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Alias for the shared byte-size formatter with precision tuned for download progress. */
function formatBytes(bytes: number): string {
  return formatByteSize(bytes, {
    kbPrecision: 0,
    mbPrecision: 1,
    gbPrecision: 2,
  });
}

function downloadFile(
  url: string,
  dest: string,
  maxRedirects = 5,
  onProgress?: DownloadProgressCallback,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let redirectCount = 0;

    const request = (reqUrl: string) => {
      let validatedUrl: URL;
      try {
        validatedUrl = validateDownloadUrl(reqUrl);
      } catch (error) {
        reject(
          error instanceof Error ? error : new Error("Invalid download URL"),
        );
        return;
      }

      const file = fs.createWriteStream(dest);
      let bytesReceived = 0;
      let expectedBytes: number | null = null;
      let lastProgressPercent = -1;

      const settleError = (err: Error) => {
        if (settled) return;
        settled = true;
        file.close();
        safeUnlink(dest);
        reject(err);
      };

      const settleSuccess = () => {
        if (settled) return;
        if (expectedBytes != null && bytesReceived !== expectedBytes) {
          settleError(
            new Error(
              `${getLogPrefix()} Download failed: bytes received (${bytesReceived}) ` +
                `does not match Content-Length (${expectedBytes})`,
            ),
          );
          return;
        }
        settled = true;
        file.close();
        resolve();
      };

      https
        .get(
          validatedUrl.toString(),
          { headers: { "User-Agent": "eliza" } },
          (res) => {
            expectedBytes = parseContentLength(res.headers["content-length"]);
            if (
              res.statusCode &&
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location
            ) {
              res.resume();
              file.close();
              safeUnlink(dest);
              redirectCount += 1;
              if (redirectCount > maxRedirects) {
                settleError(
                  new Error(
                    `Download failed: too many redirects (>${maxRedirects})`,
                  ),
                );
                return;
              }
              let next: string;
              try {
                next = new URL(
                  res.headers.location,
                  validatedUrl.toString(),
                ).toString();
              } catch {
                settleError(
                  new Error(
                    `Download failed: malformed redirect URL "${res.headers.location}"`,
                  ),
                );
                return;
              }
              request(next);
              return;
            }
            if (res.statusCode !== 200) {
              settleError(
                new Error(
                  `Download failed: HTTP ${res.statusCode} for ${validatedUrl.toString()}`,
                ),
              );
              return;
            }
            res.on("data", (chunk: Buffer) => {
              bytesReceived += chunk.length;
              if (onProgress) {
                // Throttle callbacks to every 2% to avoid excessive updates
                const pct = expectedBytes
                  ? Math.floor((bytesReceived / expectedBytes) * 50)
                  : -1;
                if (pct !== lastProgressPercent) {
                  lastProgressPercent = pct;
                  onProgress(bytesReceived, expectedBytes);
                }
              }
            });
            res.pipe(file);
            file.on("finish", settleSuccess);
            file.on("error", settleError);
          },
        )
        .on("error", settleError);
    };
    request(url);
  });
}

export async function ensureModel(
  modelsDir: string,
  repo: string,
  filename: string,
  force?: boolean,
  onProgress?: EmbeddingProgressCallback,
): Promise<string> {
  const safeRepo = sanitizeModelRepo(repo);
  const safeFilename = sanitizeModelFilename(filename);
  const modelPath = resolveModelPath(modelsDir, safeFilename);
  if (force) safeUnlink(modelPath);

  onProgress?.("checking", safeFilename);

  if (fs.existsSync(modelPath)) {
    onProgress?.("ready", "model already downloaded");
    return modelPath;
  }

  const log = getLogger();
  // Bundled embedding filenames are namespaced under `text/`, `tts/`, etc.
  // (e.g. `text/eliza-1-lite-0_6b-32k.gguf`), and the download target is
  // `<modelsDir>/<filename>`. We need to create the *file's* parent dir
  // (`<modelsDir>/text`), not just `modelsDir`. Without this, downloadFile's
  // `fs.createWriteStream(dest)` emits an ENOENT that escapes the warmup
  // catch as an uncaughtException, kills the agent at boot.
  fs.mkdirSync(path.dirname(path.resolve(modelPath)), { recursive: true });

  const url = `https://huggingface.co/${safeRepo}/resolve/main/${safeFilename}`;
  log.info(
    `${getLogPrefix()} Downloading TEXT_EMBEDDING / memory vector model (not chat LLM): ${safeFilename} from ${safeRepo}`,
  );

  onProgress?.(
    "downloading",
    `${safeFilename} — TEXT_EMBEDDING for memory, not chat · ${safeRepo}`,
  );

  const downloadOnProgress: DownloadProgressCallback | undefined = onProgress
    ? (downloaded, total) => {
        const totalStr = total ? formatBytes(total) : "unknown size";
        const pct = total ? Math.round((downloaded / total) * 100) : 0;
        onProgress("downloading", `${safeFilename} ${pct}% of ${totalStr}`);
      }
    : undefined;

  await downloadFile(url, modelPath, 5, downloadOnProgress);
  log.info(`${getLogPrefix()} Embedding model downloaded: ${modelPath}`);
  return modelPath;
}
