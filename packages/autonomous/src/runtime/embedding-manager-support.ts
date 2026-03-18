import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

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
  process.env.ELIZA_EMBEDDING_META_DIR ??
  path.join(os.homedir(), ".eliza", "state");
export const EMBEDDING_META_PATH =
  process.env.ELIZA_EMBEDDING_META_PATH ??
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
    getLogger().warn(`[eliza] Failed to write embedding metadata: ${err}`);
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
      `[eliza] Embedding dimensions changed (${stored.dimensions} → ${dimensions}). ` +
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
  return hostname === "huggingface.co" || hostname.endsWith(".huggingface.co");
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
  if (!/^[A-Za-z0-9._-]+\.gguf$/i.test(trimmed)) {
    throw new Error(`Invalid embedding model filename: ${filename}`);
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

function downloadFile(
  url: string,
  dest: string,
  maxRedirects = 5,
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
              `[eliza] Download failed: bytes received (${bytesReceived}) ` +
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
  force = false,
): Promise<string> {
  const safeRepo = sanitizeModelRepo(repo);
  const safeFilename = sanitizeModelFilename(filename);
  const modelPath = resolveModelPath(modelsDir, safeFilename);
  if (force) safeUnlink(modelPath);
  if (fs.existsSync(modelPath)) return modelPath;

  const log = getLogger();
  fs.mkdirSync(path.resolve(modelsDir), { recursive: true });

  const url = `https://huggingface.co/${safeRepo}/resolve/main/${safeFilename}`;
  log.info(
    `[eliza] Downloading embedding model: ${safeFilename} from ${safeRepo}...`,
  );

  await downloadFile(url, modelPath);
  log.info(`[eliza] Embedding model downloaded: ${modelPath}`);
  return modelPath;
}
