import { createHash } from "node:crypto";
import {
  createWriteStream,
  constants as fsConstants,
  promises as fsp,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { elizaLogger } from "@elizaos/core";
import youtubeDl from "youtube-dl-exec";

export type YtDlpRunner = (
  url: string,
  flags?: Record<string, string | boolean | number | undefined>,
  opts?: object,
) => Promise<unknown>;

interface YtDlpFactory {
  create: (binaryPath: string) => YtDlpRunner;
}

const ytDlpModule = youtubeDl as unknown as YtDlpRunner & YtDlpFactory;

const YT_DLP_RELEASE_URL =
  "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const YT_DLP_UPDATE_THROTTLE_MS = 60 * 60 * 1000;
const YT_DLP_META_FILENAME = "yt-dlp.meta.json";

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  name?: string;
  assets: GitHubAsset[];
}

interface YtDlpMeta {
  version: string;
  sha256: string;
  assetName: string;
  downloadedAt: number;
  lastUpdateAttemptedAt: number;
}

type YtDlpSource = "env" | "path" | "cache" | "bundled";

const EXTRACTOR_BROKEN_PATTERNS: readonly RegExp[] = [
  /Unable to extract/i,
  /Sign in to confirm/i,
  /nsig extraction failed/i,
  /n_param signature/i,
  /Failed to parse JSON/i,
  /HTTP Error 403/i,
  /This video is unavailable/i,
  /Got error: HTTP Error 429/i,
];

export interface BinaryResolverOptions {
  binariesDir?: string;
  releaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  disableAutoUpdate?: boolean;
  preferSystemPath?: boolean;
  updateThrottleMs?: number;
  envOverridePath?: string | null;
}

export class BinaryResolver {
  private static _instance: BinaryResolver | null = null;

  static instance(): BinaryResolver {
    if (!BinaryResolver._instance)
      BinaryResolver._instance = new BinaryResolver();
    return BinaryResolver._instance;
  }

  /** Test hook: drop the singleton so the next instance() returns fresh state. */
  static resetForTests(): void {
    BinaryResolver._instance = null;
  }

  private readonly binariesDir: string;
  private readonly releaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly disableAutoUpdate: boolean;
  private readonly preferSystemPath: boolean;
  private readonly updateThrottleMs: number;
  private readonly envOverridePath: string | null;

  private resolvedYtDlpPath: string | null = null;
  private resolvedYtDlpSource: YtDlpSource | null = null;
  private cachedRunner: YtDlpRunner | null = null;
  private resolvedFfmpegPath: string | null | undefined = undefined;
  private updateInFlight: Promise<void> | null = null;

  constructor(opts: BinaryResolverOptions = {}) {
    this.binariesDir = opts.binariesDir ?? defaultBinariesDir();
    this.releaseUrl = opts.releaseUrl ?? YT_DLP_RELEASE_URL;
    this.fetchImpl =
      opts.fetchImpl ??
      ((input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, init));
    this.now = opts.now ?? Date.now;
    this.disableAutoUpdate =
      opts.disableAutoUpdate ?? envBool("ELIZA_DISABLE_YTDLP_AUTOUPDATE");
    this.preferSystemPath =
      opts.preferSystemPath ?? envBool("ELIZA_YT_DLP_PREFER_PATH");
    this.updateThrottleMs = opts.updateThrottleMs ?? YT_DLP_UPDATE_THROTTLE_MS;
    this.envOverridePath =
      opts.envOverridePath !== undefined
        ? opts.envOverridePath
        : (process.env.ELIZA_YT_DLP_PATH ?? null);
  }

  get cacheDir(): string {
    return this.binariesDir;
  }

  get cachedYtDlpPath(): string {
    return path.join(this.binariesDir, ytDlpFileName());
  }

  get metaPath(): string {
    return path.join(this.binariesDir, YT_DLP_META_FILENAME);
  }

  /**
   * Resolve the yt-dlp binary path. Order:
   *   1. ELIZA_YT_DLP_PATH env override.
   *   2. If ELIZA_YT_DLP_PREFER_PATH=1: system PATH, then cache.
   *   3. Otherwise: cache (download if missing) → PATH fallback.
   */
  async getYtDlpPath(): Promise<string> {
    if (this.resolvedYtDlpPath) return this.resolvedYtDlpPath;

    if (this.envOverridePath) {
      if (await isExecutable(this.envOverridePath)) {
        this.resolvedYtDlpPath = this.envOverridePath;
        this.resolvedYtDlpSource = "env";
        elizaLogger.log(
          `[plugin-video] Using yt-dlp from env override: ${this.envOverridePath}`,
        );
        return this.envOverridePath;
      }
      elizaLogger.warn(
        `[plugin-video] ELIZA_YT_DLP_PATH=${this.envOverridePath} is not executable; falling through.`,
      );
    }

    if (this.preferSystemPath) {
      const sys = await lookupOnPath("yt-dlp");
      if (sys) {
        this.resolvedYtDlpPath = sys;
        this.resolvedYtDlpSource = "path";
        elizaLogger.log(`[plugin-video] Using yt-dlp from PATH: ${sys}`);
        return sys;
      }
    }

    const cachePath = this.cachedYtDlpPath;
    if (await isExecutable(cachePath)) {
      this.resolvedYtDlpPath = cachePath;
      this.resolvedYtDlpSource = "cache";
      elizaLogger.log(
        `[plugin-video] Using yt-dlp from managed cache: ${cachePath}`,
      );
      return cachePath;
    }

    const sys = await lookupOnPath("yt-dlp");
    if (sys) {
      this.resolvedYtDlpPath = sys;
      this.resolvedYtDlpSource = "path";
      elizaLogger.log(
        `[plugin-video] Using yt-dlp from PATH (cache empty): ${sys}`,
      );
      return sys;
    }

    const bundled = await getBundledYtDlpPath();
    if (bundled) {
      this.resolvedYtDlpPath = bundled;
      this.resolvedYtDlpSource = "bundled";
      elizaLogger.log(
        `[plugin-video] Using yt-dlp from youtube-dl-exec bundle: ${bundled}`,
      );
      return bundled;
    }

    elizaLogger.log(
      "[plugin-video] No yt-dlp binary found; downloading to managed cache.",
    );
    await this.downloadYtDlp();
    this.resolvedYtDlpPath = cachePath;
    this.resolvedYtDlpSource = "cache";
    return cachePath;
  }

  /** Resolution order: ELIZA_FFMPEG_PATH env → system ffmpeg → ffmpeg-static. */
  async getFfmpegPath(): Promise<string | null> {
    if (this.resolvedFfmpegPath !== undefined) return this.resolvedFfmpegPath;

    const envPath = process.env.ELIZA_FFMPEG_PATH;
    if (envPath && (await isExecutable(envPath))) {
      this.resolvedFfmpegPath = envPath;
      return envPath;
    }

    const sys = await lookupOnPath("ffmpeg");
    if (sys) {
      this.resolvedFfmpegPath = sys;
      return sys;
    }

    try {
      const mod: { default?: string | null } = await import("ffmpeg-static");
      const staticPath = mod.default ?? (mod as unknown as string | null);
      if (
        typeof staticPath === "string" &&
        staticPath.length > 0 &&
        (await isExecutable(staticPath))
      ) {
        this.resolvedFfmpegPath = staticPath;
        return staticPath;
      }
    } catch (err) {
      elizaLogger.warn(
        `[plugin-video] ffmpeg-static not loadable: ${describeError(err)}`,
      );
    }

    this.resolvedFfmpegPath = null;
    return null;
  }

  /**
   * Build (or reuse) the yt-dlp runner bound to the resolved binary path.
   * The runner mirrors `youtube-dl-exec`'s default callable signature.
   */
  async getYtDlpRunner(): Promise<YtDlpRunner> {
    if (this.cachedRunner) return this.cachedRunner;
    const binPath = await this.getYtDlpPath();
    this.cachedRunner = ytDlpModule.create(binPath);
    return this.cachedRunner;
  }

  /**
   * Run yt-dlp with one auto-update + retry attempt on extractor-failure
   * patterns, when the active binary is the managed cache.
   */
  async runYtDlp(
    url: string,
    flags: Record<string, string | boolean | number | undefined>,
  ): Promise<unknown> {
    const runner = await this.getYtDlpRunner();
    try {
      return await runner(url, flags);
    } catch (err) {
      if (!this.shouldRetryWithUpdate(err)) {
        throw err;
      }
      const updated = await this.tryUpdate();
      if (!updated) {
        throw err;
      }
      const refreshed = await this.getYtDlpRunner();
      return await refreshed(url, flags);
    }
  }

  private shouldRetryWithUpdate(err: unknown): boolean {
    if (this.disableAutoUpdate) return false;
    // Auto-update fires only when we own the binary lifecycle (managed cache
    // or the bundled-with-youtube-dl-exec copy). User-managed binaries (env
    // override, system PATH) are out of scope — we don't touch homebrew.
    if (
      this.resolvedYtDlpSource !== "cache" &&
      this.resolvedYtDlpSource !== "bundled"
    ) {
      return false;
    }
    const msg = errorMessage(err);
    return EXTRACTOR_BROKEN_PATTERNS.some((p) => p.test(msg));
  }

  /**
   * Run a yt-dlp update attempt, throttled to once per `updateThrottleMs`.
   * Returns true iff a fresh binary was successfully installed.
   */
  private async tryUpdate(): Promise<boolean> {
    if (this.updateInFlight) {
      await this.updateInFlight;
      return true;
    }

    const meta = await this.readMeta();
    // No metadata yet means we have never attempted an update; first failure
    // should always be allowed to try.
    if (meta) {
      const sinceLast = this.now() - meta.lastUpdateAttemptedAt;
      if (sinceLast < this.updateThrottleMs) {
        elizaLogger.warn(
          `[plugin-video] yt-dlp update throttled (last attempt ${Math.floor(sinceLast / 1000)}s ago).`,
        );
        return false;
      }
    }

    const job = (async () => {
      await this.touchUpdateAttempt(meta);
      await this.downloadYtDlp();
      this.resetRunnerCache();
    })();
    this.updateInFlight = job;
    try {
      await job;
      return true;
    } catch (err) {
      elizaLogger.error(
        `[plugin-video] yt-dlp update failed: ${describeError(err)}`,
      );
      return false;
    } finally {
      this.updateInFlight = null;
    }
  }

  private resetRunnerCache(): void {
    this.cachedRunner = null;
    this.resolvedYtDlpPath = null;
    this.resolvedYtDlpSource = null;
  }

  /** Force a fresh yt-dlp download regardless of throttle. Test/admin hook. */
  async forceUpdateYtDlp(): Promise<{ version: string; path: string }> {
    const meta = await this.downloadYtDlp();
    this.resetRunnerCache();
    await this.getYtDlpPath();
    return { version: meta.version, path: this.cachedYtDlpPath };
  }

  private async readMeta(): Promise<YtDlpMeta | null> {
    try {
      const raw = await fsp.readFile(this.metaPath, "utf8");
      return JSON.parse(raw) as YtDlpMeta;
    } catch {
      return null;
    }
  }

  private async writeMeta(meta: YtDlpMeta): Promise<void> {
    await fsp.mkdir(this.binariesDir, { recursive: true });
    await fsp.writeFile(this.metaPath, JSON.stringify(meta, null, 2));
  }

  private async touchUpdateAttempt(prev: YtDlpMeta | null): Promise<void> {
    const next: YtDlpMeta = prev
      ? { ...prev, lastUpdateAttemptedAt: this.now() }
      : {
          version: "",
          sha256: "",
          assetName: "",
          downloadedAt: 0,
          lastUpdateAttemptedAt: this.now(),
        };
    await this.writeMeta(next);
  }

  /**
   * Download the latest yt-dlp release for this platform, verify the SHA256
   * against the published `SHA2-256SUMS`, and atomically replace the cached
   * binary. Returns the new metadata on success; throws on any failure.
   */
  async downloadYtDlp(): Promise<YtDlpMeta> {
    const release = await this.fetchRelease();
    const assetName = ytDlpAssetName();
    const asset = release.assets.find((a) => a.name === assetName);
    if (!asset) {
      throw new Error(
        `yt-dlp release ${release.tag_name} has no asset named '${assetName}'`,
      );
    }
    const sumsAsset = release.assets.find((a) => a.name === "SHA2-256SUMS");
    if (!sumsAsset) {
      throw new Error(
        `yt-dlp release ${release.tag_name} has no SHA2-256SUMS asset`,
      );
    }

    const expectedSha = await this.fetchExpectedSha(
      sumsAsset.browser_download_url,
      assetName,
    );

    await fsp.mkdir(this.binariesDir, { recursive: true });
    const tmpPath = `${this.cachedYtDlpPath}.tmp.${process.pid}.${Date.now()}`;
    await this.downloadToFile(asset.browser_download_url, tmpPath);

    const actualSha = await sha256OfFile(tmpPath);
    if (actualSha !== expectedSha) {
      await safeUnlink(tmpPath);
      throw new Error(
        `yt-dlp SHA256 mismatch: expected ${expectedSha}, got ${actualSha}`,
      );
    }

    await fsp.chmod(tmpPath, 0o755);
    await fsp.rename(tmpPath, this.cachedYtDlpPath);

    const meta: YtDlpMeta = {
      version: release.tag_name,
      sha256: expectedSha,
      assetName,
      downloadedAt: this.now(),
      lastUpdateAttemptedAt: this.now(),
    };
    await this.writeMeta(meta);
    elizaLogger.log(
      `[plugin-video] yt-dlp ${release.tag_name} installed at ${this.cachedYtDlpPath}`,
    );
    return meta;
  }

  private async fetchRelease(): Promise<GitHubRelease> {
    const res = await this.fetchImpl(this.releaseUrl, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      throw new Error(
        `yt-dlp release fetch failed: ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as GitHubRelease;
  }

  private async fetchExpectedSha(
    sumsUrl: string,
    assetName: string,
  ): Promise<string> {
    const res = await this.fetchImpl(sumsUrl);
    if (!res.ok) {
      throw new Error(
        `SHA2-256SUMS fetch failed: ${res.status} ${res.statusText}`,
      );
    }
    const text = await res.text();
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2 && parts[parts.length - 1] === assetName) {
        return parts[0].toLowerCase();
      }
    }
    throw new Error(`SHA2-256SUMS missing entry for ${assetName}`);
  }

  private async downloadToFile(url: string, dest: string): Promise<void> {
    const res = await this.fetchImpl(url);
    if (!res.ok || !res.body) {
      throw new Error(
        `yt-dlp binary fetch failed: ${res.status} ${res.statusText}`,
      );
    }
    const nodeStream = Readable.fromWeb(
      res.body as Parameters<typeof Readable.fromWeb>[0],
    );
    await pipeline(nodeStream, createWriteStream(dest));
  }
}

function defaultBinariesDir(): string {
  const explicit = process.env.ELIZA_BINARIES_DIR;
  if (explicit) return explicit;
  const stateDir =
    process.env.ELIZA_STATE_DIR ?? path.join(os.homedir(), ".eliza");
  return path.join(stateDir, "binaries");
}

export function ytDlpAssetName(): string {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "darwin") return "yt-dlp_macos";
  if (platform === "win32")
    return arch === "ia32" ? "yt-dlp_x86.exe" : "yt-dlp.exe";
  if (platform === "linux") {
    if (arch === "arm64") return "yt-dlp_linux_aarch64";
    if (arch === "arm") return "yt-dlp_linux_armv7l";
    return "yt-dlp_linux";
  }
  throw new Error(`Unsupported platform for yt-dlp: ${platform}/${arch}`);
}

export function ytDlpFileName(): string {
  return process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await fsp.access(p, fsConstants.X_OK);
    const st = await fsp.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * Look for the yt-dlp binary that `youtube-dl-exec`'s postinstall ships into
 * its own `bin/` directory. Tries the package's internal constants first
 * (which the wrapper uses by default), then falls back to a hardcoded
 * relative path. Returns the path only if the binary is actually executable.
 */
async function getBundledYtDlpPath(): Promise<string | null> {
  try {
    const constantsModule = (await import(
      "youtube-dl-exec/src/constants.js" as string
    )) as { default?: { YOUTUBE_DL_PATH?: string } } & {
      YOUTUBE_DL_PATH?: string;
    };
    const fromConstants =
      constantsModule.default?.YOUTUBE_DL_PATH ??
      constantsModule.YOUTUBE_DL_PATH;
    if (
      typeof fromConstants === "string" &&
      fromConstants.length > 0 &&
      (await isExecutable(fromConstants))
    ) {
      return fromConstants;
    }
  } catch {
    /* package internals unavailable; fall through to relative resolve */
  }
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve("youtube-dl-exec/package.json");
    const candidate = path.join(path.dirname(pkgPath), "bin", ytDlpFileName());
    if (await isExecutable(candidate)) return candidate;
  } catch {
    /* youtube-dl-exec not installed in this tree */
  }
  return null;
}

async function lookupOnPath(name: string): Promise<string | null> {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return null;
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
          .split(";")
          .map((e) => e.toLowerCase())
      : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function sha256OfFile(p: string): Promise<string> {
  const hash = createHash("sha256");
  const fd = await fsp.open(p, "r");
  try {
    const stream = fd.createReadStream();
    for await (const chunk of stream) hash.update(chunk as Buffer);
  } finally {
    await fd.close();
  }
  return hash.digest("hex");
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch {
    /* swallow */
  }
}

function envBool(name: string): boolean {
  const v = process.env[name];
  if (!v) return false;
  return v === "1" || v.toLowerCase() === "true";
}

function errorMessage(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  const anyErr = err as { stderr?: unknown; message?: unknown };
  if (typeof anyErr.stderr === "string" && anyErr.stderr.length > 0)
    return anyErr.stderr;
  if (typeof anyErr.message === "string") return anyErr.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function describeError(err: unknown): string {
  return errorMessage(err) || "(no message)";
}
