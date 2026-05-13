/**
 * Resumable GGUF downloader.
 *
 * Streams directly from HuggingFace to a staging file under
 * `$STATE_DIR/local-inference/downloads/<id>.part`, then atomically moves
 * it into `models/<id>.gguf` on success. On restart the staging file is
 * still there; `resumeIfPossible` sends a Range request starting at the
 * current partial size.
 *
 * Concurrency model: at most one download per model id. Callers use
 * `subscribe()` to receive progress events; the service facade wires that
 * to SSE.
 *
 * The runtime `fetch` follows HuggingFace redirects and still gives us a body
 * stream that can be piped into a Node WriteStream.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ensureDefaultAssignment } from "./assignments";
import {
  buildHuggingFaceResolveUrl,
  buildHuggingFaceResolveUrlForPath,
  findCatalogModel,
  isDefaultEligibleId,
} from "./catalog";
import {
  downloadsStagingDir,
  elizaModelsDir,
  localInferenceRoot,
} from "./paths";
import { upsertElizaModel } from "./registry";
import type {
  CatalogModel,
  DownloadEvent,
  DownloadJob,
  DownloadState,
  InstalledModel,
} from "./types";
import { hashFile } from "./verify";

interface ActiveJob {
  job: DownloadJob;
  abortController: AbortController;
  stagingPath: string;
  finalPath: string;
}

type DownloadListener = (event: DownloadEvent) => void;
type BundleFileKind =
  | "text"
  | "voice"
  | "asr"
  | "vision"
  | "dflash"
  | "cache"
  | "embedding"
  | "vad"
  | "wakeword";

interface BundleFileEntry {
  path: string;
  sha256: string;
  ctx?: number;
}

interface BundleManifest {
  id: string;
  version: string;
  files: Record<BundleFileKind, BundleFileEntry[]>;
}

interface DownloadedFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}

const PROGRESS_THROTTLE_MS = 250;
const TERMINAL_DOWNLOADS_FILENAME = "download-status.json";
const TERMINAL_DOWNLOAD_LIMIT = 32;

interface TerminalDownloadsFile {
  version: 1;
  jobs: DownloadJob[];
}

async function* readFetchBody(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<Buffer> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield Buffer.from(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function stagingFilename(modelId: string): string {
  // Filename is derived deterministically so repeated download attempts
  // reuse the same partial file and actually resume.
  const safe = modelId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${safe}.part`;
}

function finalFilename(model: CatalogModel): string {
  const safe = model.id.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${safe}.gguf`;
}

function bundleDirname(modelId: string): string {
  const safe = modelId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${safe}.bundle`;
}

function bundleStagingFilename(modelId: string, filePath: string): string {
  const safePath = filePath.replace(/[^a-zA-Z0-9._-]/g, "_");
  return stagingFilename(`${modelId}__${safePath}`);
}

function bundleTargetPath(root: string, filePath: string): string {
  if (
    !filePath ||
    path.isAbsolute(filePath) ||
    /^[a-zA-Z]:[\\/]/.test(filePath)
  ) {
    throw new Error(`Invalid bundle file path: ${filePath}`);
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, filePath);
  if (
    target !== resolvedRoot &&
    !target.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`Bundle file escapes install root: ${filePath}`);
  }
  return target;
}

function parseBundleFileEntry(
  value: unknown,
  kind: BundleFileKind,
): BundleFileEntry {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid Eliza-1 manifest file entry in files.${kind}`);
  }
  const entry = value as { path?: unknown; sha256?: unknown; ctx?: unknown };
  if (typeof entry.path !== "string" || entry.path.length === 0) {
    throw new Error(`Invalid Eliza-1 manifest file path in files.${kind}`);
  }
  if (
    typeof entry.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  ) {
    throw new Error(`Invalid Eliza-1 manifest sha256 for ${entry.path}`);
  }
  const parsed: BundleFileEntry = {
    path: entry.path,
    sha256: entry.sha256,
  };
  if (typeof entry.ctx === "number") parsed.ctx = entry.ctx;
  return parsed;
}

function parseBundleManifestOrThrow(
  input: unknown,
  catalogEntry: CatalogModel,
): BundleManifest {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid Eliza-1 manifest: expected object");
  }
  const raw = input as {
    id?: unknown;
    version?: unknown;
    files?: unknown;
    defaultEligible?: unknown;
  };
  if (raw.id !== catalogEntry.id) {
    throw new Error(
      `Invalid Eliza-1 manifest: id ${String(raw.id)} does not match ${catalogEntry.id}`,
    );
  }
  if (typeof raw.version !== "string" || raw.version.length === 0) {
    throw new Error("Invalid Eliza-1 manifest: missing version");
  }
  if (raw.defaultEligible !== true) {
    throw new Error("Invalid Eliza-1 manifest: defaultEligible must be true");
  }
  if (!raw.files || typeof raw.files !== "object") {
    throw new Error("Invalid Eliza-1 manifest: missing files");
  }

  const filesRaw = raw.files as Record<string, unknown>;
  const files = {} as Record<BundleFileKind, BundleFileEntry[]>;
  for (const kind of [
    "text",
    "voice",
    "asr",
    "vision",
    "dflash",
    "cache",
    "embedding",
    "vad",
    "wakeword",
  ] as const) {
    const value = filesRaw[kind];
    if (value === undefined && (kind === "embedding" || kind === "wakeword")) {
      files[kind] = [];
      continue;
    }
    if (!Array.isArray(value)) {
      throw new Error(
        `Invalid Eliza-1 manifest: files.${kind} must be an array`,
      );
    }
    files[kind] = value.map((entry) => parseBundleFileEntry(entry, kind));
  }

  for (const kind of [
    "text",
    "voice",
    "asr",
    "dflash",
    "cache",
    "vad",
  ] as const) {
    if (files[kind].length === 0) {
      throw new Error(
        `Invalid Eliza-1 manifest: files.${kind} must be non-empty`,
      );
    }
  }
  if (!files.text.some((entry) => entry.path === catalogEntry.ggufFile)) {
    throw new Error(
      `Invalid Eliza-1 manifest: primary text file ${catalogEntry.ggufFile} is missing`,
    );
  }

  return {
    id: catalogEntry.id,
    version: raw.version,
    files,
  };
}

function collectBundleFiles(
  manifest: BundleManifest,
): Array<{ kind: BundleFileKind; entry: BundleFileEntry }> {
  const seen = new Map<
    string,
    { kind: BundleFileKind; entry: BundleFileEntry }
  >();
  for (const kind of [
    "text",
    "voice",
    "asr",
    "vision",
    "dflash",
    "cache",
    "embedding",
    "vad",
    "wakeword",
  ] as const) {
    for (const entry of manifest.files[kind]) {
      const current = seen.get(entry.path);
      if (current && current.entry.sha256 !== entry.sha256) {
        throw new Error(
          `Conflicting sha256 entries for bundle file ${entry.path}`,
        );
      }
      seen.set(entry.path, { kind, entry });
    }
  }
  return [...seen.values()];
}

async function ensureDirs(): Promise<void> {
  await fsp.mkdir(downloadsStagingDir(), { recursive: true });
  await fsp.mkdir(elizaModelsDir(), { recursive: true });
}

function terminalDownloadsPath(): string {
  return path.join(localInferenceRoot(), TERMINAL_DOWNLOADS_FILENAME);
}

async function partialSize(stagingPath: string): Promise<number> {
  try {
    const stat = await fsp.stat(stagingPath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

export class Downloader {
  private readonly active = new Map<string, ActiveJob>();
  private readonly terminal = new Map<string, DownloadJob>();
  private readonly listeners = new Set<DownloadListener>();
  private readonly lastEmit = new Map<string, number>();

  constructor() {
    this.loadTerminalDownloads();
  }

  subscribe(listener: DownloadListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): DownloadJob[] {
    const active = [...this.active.values()].map((a) => ({ ...a.job }));
    const activeIds = new Set(active.map((job) => job.modelId));
    const terminal = [...this.terminal.values()]
      .filter((job) => !activeIds.has(job.modelId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((job) => ({ ...job }));
    return [...active, ...terminal];
  }

  isActive(modelId: string): boolean {
    const current = this.active.get(modelId);
    return (
      !!current &&
      (current.job.state === "queued" || current.job.state === "downloading")
    );
  }

  /**
   * Start a download for a model. Accepts either a curated catalog id, or
   * a full `CatalogModel` spec for ad-hoc HF-search results. Idempotent —
   * returns the existing job if one is already running for the same id.
   */
  async start(modelIdOrSpec: string | CatalogModel): Promise<DownloadJob> {
    const catalogEntry =
      typeof modelIdOrSpec === "string"
        ? findCatalogModel(modelIdOrSpec)
        : modelIdOrSpec;
    if (!catalogEntry) {
      throw new Error(
        `Unknown model id: ${typeof modelIdOrSpec === "string" ? modelIdOrSpec : "(no id)"}`,
      );
    }
    const modelId = catalogEntry.id;
    this.clearTerminalDownload(modelId);

    const existing = this.active.get(modelId);
    if (
      existing &&
      (existing.job.state === "queued" || existing.job.state === "downloading")
    ) {
      return { ...existing.job };
    }

    await ensureDirs();
    const stagingPath = path.join(
      downloadsStagingDir(),
      stagingFilename(modelId),
    );
    const finalPath = path.join(elizaModelsDir(), finalFilename(catalogEntry));

    const job: DownloadJob = {
      jobId: randomUUID(),
      modelId,
      state: "queued",
      received: await partialSize(stagingPath),
      total: Math.round(catalogEntry.sizeGb * 1024 ** 3),
      bytesPerSec: 0,
      etaMs: null,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const abortController = new AbortController();
    const record: ActiveJob = {
      job,
      abortController,
      stagingPath,
      finalPath,
    };
    this.active.set(modelId, record);

    // Fire-and-forget; errors are captured and emitted as a "failed" event.
    void this.runJob(catalogEntry, record).catch(() => {
      // `runJob` handles its own failure telemetry; we only need to swallow
      // the unhandled-rejection here.
    });

    this.emit({ type: "progress", job: { ...job } });
    return { ...job };
  }

  cancel(modelId: string): boolean {
    const record = this.active.get(modelId);
    if (!record) return false;
    if (record.job.state !== "downloading" && record.job.state !== "queued") {
      return false;
    }
    record.abortController.abort();
    this.updateState(record, "cancelled");
    this.rememberTerminalDownload(record.job);
    this.emit({ type: "cancelled", job: { ...record.job } });
    this.active.delete(modelId);
    return true;
  }

  private emit(event: DownloadEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A bad listener must not kill the downloader; drop it silently.
        this.listeners.delete(listener);
      }
    }
  }

  private updateState(record: ActiveJob, state: DownloadState): void {
    record.job.state = state;
    record.job.updatedAt = new Date().toISOString();
  }

  private loadTerminalDownloads(): void {
    try {
      const raw = fs.readFileSync(terminalDownloadsPath(), "utf8");
      const parsed = JSON.parse(raw) as TerminalDownloadsFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
        return;
      }
      for (const job of parsed.jobs) {
        if (
          job &&
          typeof job.modelId === "string" &&
          (job.state === "completed" ||
            job.state === "failed" ||
            job.state === "cancelled")
        ) {
          this.terminal.set(job.modelId, { ...job });
        }
      }
    } catch {
      // Missing or malformed terminal-download state should not block
      // local inference. New terminal states will rewrite the file.
    }
  }

  private persistTerminalDownloads(): void {
    try {
      fs.mkdirSync(localInferenceRoot(), { recursive: true });
      const jobs = [...this.terminal.values()]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, TERMINAL_DOWNLOAD_LIMIT);
      const payload: TerminalDownloadsFile = { version: 1, jobs };
      fs.writeFileSync(
        terminalDownloadsPath(),
        JSON.stringify(payload, null, 2),
        "utf8",
      );
    } catch {
      // Terminal status is useful for chat/UI telemetry but is not allowed to
      // fail the download path.
    }
  }

  private rememberTerminalDownload(job: DownloadJob): void {
    this.terminal.set(job.modelId, { ...job });
    const ordered = [...this.terminal.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
    this.terminal.clear();
    for (const terminalJob of ordered.slice(0, TERMINAL_DOWNLOAD_LIMIT)) {
      this.terminal.set(terminalJob.modelId, terminalJob);
    }
    this.persistTerminalDownloads();
  }

  private clearTerminalDownload(modelId: string): void {
    if (!this.terminal.delete(modelId)) return;
    this.persistTerminalDownloads();
  }

  private throttleEmit(record: ActiveJob): void {
    const now = Date.now();
    const last = this.lastEmit.get(record.job.modelId) ?? 0;
    if (now - last < PROGRESS_THROTTLE_MS) return;
    this.lastEmit.set(record.job.modelId, now);
    this.emit({ type: "progress", job: { ...record.job } });
  }

  private async runJob(
    catalogEntry: CatalogModel,
    record: ActiveJob,
  ): Promise<void> {
    try {
      this.updateState(record, "downloading");
      if (
        catalogEntry.bundleManifestFile &&
        catalogEntry.runtimeRole !== "dflash-drafter"
      ) {
        await this.runBundleJob(catalogEntry, record);
        return;
      }

      const url = buildHuggingFaceResolveUrl(catalogEntry);

      const httpClient = await this.loadHttpClient();
      const startByte = record.job.received;

      const headers: Record<string, string> = {
        "user-agent": "Eliza-LocalInference/1.0",
      };
      if (startByte > 0) {
        headers.range = `bytes=${startByte}-`;
      }

      const response = await httpClient.request(url, {
        method: "GET",
        headers,
        signal: record.abortController.signal,
      });

      if (response.statusCode >= 400) {
        throw new Error(
          `HTTP ${response.statusCode} from HuggingFace for ${catalogEntry.hfRepo}`,
        );
      }

      let effectiveStartByte = startByte;
      if (effectiveStartByte > 0 && response.statusCode !== 206) {
        effectiveStartByte = 0;
        record.job.received = 0;
      }

      const contentLengthHeader = response.headers["content-length"];
      const contentLength = Array.isArray(contentLengthHeader)
        ? Number.parseInt(contentLengthHeader[0] ?? "0", 10)
        : Number.parseInt(contentLengthHeader ?? "0", 10);
      if (Number.isFinite(contentLength) && contentLength > 0) {
        record.job.total = effectiveStartByte + contentLength;
      }

      const writeStream: Writable = fs.createWriteStream(record.stagingPath, {
        flags: effectiveStartByte > 0 ? "a" : "w",
      });

      let lastSampleBytes = record.job.received;
      let lastSampleAt = Date.now();

      const bodyStream = Readable.from(response.body);
      bodyStream.on("data", (chunk: Buffer) => {
        record.job.received += chunk.length;

        const now = Date.now();
        const elapsed = now - lastSampleAt;
        if (elapsed >= 1000) {
          record.job.bytesPerSec =
            ((record.job.received - lastSampleBytes) * 1000) / elapsed;
          record.job.etaMs =
            record.job.bytesPerSec > 0
              ? ((record.job.total - record.job.received) * 1000) /
                record.job.bytesPerSec
              : null;
          lastSampleAt = now;
          lastSampleBytes = record.job.received;
        }

        this.throttleEmit(record);
      });

      await pipeline(bodyStream, writeStream);

      await fsp.rename(record.stagingPath, record.finalPath);

      const finalStat = await fsp.stat(record.finalPath);
      // Compute SHA256 on commit so we have an integrity baseline. The
      // chunk hasher we maintain during streaming gives the same result
      // but would also have to handle resume-from-partial correctly; for
      // a ~1-20 GB file a second disk pass at the end is simpler and
      // robust. Measured at ~400 MB/s on an NVMe so even the 20 GB
      // catalog entries finish in well under a minute.
      const sha256 = await hashFile(record.finalPath);

      const installed: InstalledModel = {
        id: catalogEntry.id,
        displayName: catalogEntry.displayName,
        path: record.finalPath,
        sizeBytes: finalStat.size,
        hfRepo: catalogEntry.hfRepo,
        installedAt: new Date().toISOString(),
        lastUsedAt: null,
        source: "eliza-download",
        sha256,
        lastVerifiedAt: new Date().toISOString(),
        ...(catalogEntry.runtimeRole
          ? { runtimeRole: catalogEntry.runtimeRole }
          : {}),
        ...(catalogEntry.companionForModelId
          ? { companionFor: catalogEntry.companionForModelId }
          : {}),
      };
      await upsertElizaModel(installed);

      // First-light convenience: only default-eligible Eliza-1 downloads
      // can fill empty slots. Ad-hoc Hugging Face downloads remain
      // explicit opt-in even though Eliza owns the downloaded file.
      if (
        catalogEntry.runtimeRole !== "dflash-drafter" &&
        isDefaultEligibleId(installed.id)
      ) {
        await ensureDefaultAssignment(installed.id);
      }

      for (const companionId of catalogEntry.companionModelIds ?? []) {
        if (!this.isActive(companionId)) {
          void this.start(companionId).catch((err) => {
            const job: DownloadJob = {
              jobId: randomUUID(),
              modelId: companionId,
              state: "failed",
              received: 0,
              total: 0,
              bytesPerSec: 0,
              etaMs: null,
              startedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              error: err instanceof Error ? err.message : String(err),
            };
            this.rememberTerminalDownload(job);
            this.emit({
              type: "failed",
              job,
            });
          });
        }
      }

      this.updateState(record, "completed");
      record.job.received = finalStat.size;
      record.job.total = finalStat.size;
      this.rememberTerminalDownload(record.job);
      this.emit({ type: "completed", job: { ...record.job } });
    } catch (err) {
      if (record.abortController.signal.aborted) {
        this.updateState(record, "cancelled");
        this.rememberTerminalDownload(record.job);
        this.emit({ type: "cancelled", job: { ...record.job } });
      } else {
        this.updateState(record, "failed");
        record.job.error = err instanceof Error ? err.message : String(err);
        this.rememberTerminalDownload(record.job);
        this.emit({ type: "failed", job: { ...record.job } });
      }
    } finally {
      this.active.delete(record.job.modelId);
    }
  }

  private async runBundleJob(
    catalogEntry: CatalogModel,
    record: ActiveJob,
  ): Promise<void> {
    if (!catalogEntry.bundleManifestFile) {
      throw new Error(
        `[local-inference] ${catalogEntry.id} has no bundle manifest`,
      );
    }

    const bundleRoot = path.join(
      elizaModelsDir(),
      bundleDirname(catalogEntry.id),
    );
    await fsp.mkdir(bundleRoot, { recursive: true });

    const manifestPath = bundleTargetPath(
      bundleRoot,
      catalogEntry.bundleManifestFile,
    );
    const manifestDownloaded = await this.downloadRemotePath(
      catalogEntry,
      catalogEntry.bundleManifestFile,
      path.join(
        downloadsStagingDir(),
        bundleStagingFilename(catalogEntry.id, catalogEntry.bundleManifestFile),
      ),
      manifestPath,
      record,
      0,
      catalogEntry.bundleManifestSha256,
    );

    const manifest = parseBundleManifestOrThrow(
      JSON.parse(await fsp.readFile(manifestPath, "utf8")),
      catalogEntry,
    );

    let completedBytes = manifestDownloaded.sizeBytes;
    const downloaded = new Map<string, DownloadedFile>();
    for (const { entry } of collectBundleFiles(manifest)) {
      const finalPath = bundleTargetPath(bundleRoot, entry.path);
      const result = await this.downloadRemotePath(
        catalogEntry,
        entry.path,
        path.join(
          downloadsStagingDir(),
          bundleStagingFilename(catalogEntry.id, entry.path),
        ),
        finalPath,
        record,
        completedBytes,
        entry.sha256,
      );
      downloaded.set(entry.path, result);
      completedBytes += result.sizeBytes;
      record.job.received = completedBytes;
      record.job.total = Math.max(record.job.total, completedBytes);
      this.throttleEmit(record);
    }

    const textEntry = manifest.files.text.find(
      (entry) => entry.path === catalogEntry.ggufFile,
    );
    if (!textEntry) {
      throw new Error(
        `[local-inference] Bundle missing primary text file ${catalogEntry.ggufFile}`,
      );
    }
    const textFile = downloaded.get(textEntry.path);
    if (!textFile) {
      throw new Error(
        `[local-inference] Bundle did not install text file ${textEntry.path}`,
      );
    }

    const now = new Date().toISOString();
    const bundleMeta = {
      bundleRoot,
      manifestPath,
      manifestSha256: manifestDownloaded.sha256,
      bundleVersion: manifest.version,
      bundleSizeBytes: completedBytes,
    };

    const installed: InstalledModel = {
      id: catalogEntry.id,
      displayName: catalogEntry.displayName,
      path: textFile.path,
      sizeBytes: textFile.sizeBytes,
      hfRepo: catalogEntry.hfRepo,
      installedAt: now,
      lastUsedAt: null,
      source: "eliza-download",
      sha256: textFile.sha256,
      lastVerifiedAt: now,
      ...bundleMeta,
    };
    await upsertElizaModel(installed);

    const companionId =
      catalogEntry.runtime?.dflash?.drafterModelId ??
      catalogEntry.companionModelIds?.[0];
    const companion = companionId ? findCatalogModel(companionId) : undefined;
    if (companion) {
      const drafterEntry = manifest.files.dflash.find(
        (entry) => entry.path === companion.ggufFile,
      );
      if (!drafterEntry) {
        throw new Error(
          `[local-inference] Bundle missing DFlash companion ${companion.ggufFile}`,
        );
      }
      const drafterFile = downloaded.get(drafterEntry.path);
      if (!drafterFile) {
        throw new Error(
          `[local-inference] Bundle did not install DFlash companion ${drafterEntry.path}`,
        );
      }
      await upsertElizaModel({
        id: companion.id,
        displayName: companion.displayName,
        path: drafterFile.path,
        sizeBytes: drafterFile.sizeBytes,
        hfRepo: companion.hfRepo,
        installedAt: now,
        lastUsedAt: null,
        source: "eliza-download",
        sha256: drafterFile.sha256,
        lastVerifiedAt: now,
        runtimeRole: "dflash-drafter",
        companionFor: catalogEntry.id,
        ...bundleMeta,
      });
    }

    if (isDefaultEligibleId(installed.id)) {
      await ensureDefaultAssignment(installed.id);
    }

    this.updateState(record, "completed");
    record.job.received = completedBytes;
    record.job.total = completedBytes;
    this.rememberTerminalDownload(record.job);
    this.emit({ type: "completed", job: { ...record.job } });
  }

  private async downloadRemotePath(
    catalogEntry: CatalogModel,
    remotePath: string,
    stagingPath: string,
    finalPath: string,
    record: ActiveJob,
    baseBytes: number,
    expectedSha256?: string,
  ): Promise<DownloadedFile> {
    if (expectedSha256) {
      try {
        const stat = await fsp.stat(finalPath);
        if (stat.isFile()) {
          const currentSha256 = await hashFile(finalPath);
          if (currentSha256 === expectedSha256) {
            record.job.received = baseBytes + stat.size;
            return {
              path: finalPath,
              sizeBytes: stat.size,
              sha256: currentSha256,
            };
          }
          await fsp.rm(finalPath, { force: true });
        }
      } catch {
        // Missing files are downloaded below; unreadable stale files are
        // treated as invalid and replaced by the fresh bundle artifact.
      }
    } else {
      await fsp.rm(stagingPath, { force: true }).catch(() => undefined);
    }

    await fsp.mkdir(path.dirname(finalPath), { recursive: true });
    await fsp.mkdir(path.dirname(stagingPath), { recursive: true });

    let startByte = expectedSha256 ? await partialSize(stagingPath) : 0;
    record.job.received = baseBytes + startByte;

    const headers: Record<string, string> = {
      "user-agent": "Eliza-LocalInference/1.0",
    };
    if (startByte > 0) {
      headers.range = `bytes=${startByte}-`;
    }

    const httpClient = await this.loadHttpClient();
    const url = buildHuggingFaceResolveUrlForPath(catalogEntry, remotePath);
    const response = await httpClient.request(url, {
      method: "GET",
      headers,
      signal: record.abortController.signal,
    });

    if (response.statusCode >= 400) {
      throw new Error(
        `HTTP ${response.statusCode} from HuggingFace for ${catalogEntry.hfRepo}/${remotePath}`,
      );
    }
    if (startByte > 0 && response.statusCode !== 206) {
      startByte = 0;
      record.job.received = baseBytes;
    }

    const contentLengthHeader = response.headers["content-length"];
    const contentLength = Array.isArray(contentLengthHeader)
      ? Number.parseInt(contentLengthHeader[0] ?? "0", 10)
      : Number.parseInt(contentLengthHeader ?? "0", 10);
    if (Number.isFinite(contentLength) && contentLength > 0) {
      record.job.total = Math.max(
        record.job.total,
        baseBytes + startByte + contentLength,
      );
    }

    const writeStream: Writable = fs.createWriteStream(stagingPath, {
      flags: startByte > 0 ? "a" : "w",
    });

    let lastSampleBytes = record.job.received;
    let lastSampleAt = Date.now();
    const bodyStream = Readable.from(response.body);
    bodyStream.on("data", (chunk: Buffer) => {
      record.job.received += chunk.length;

      const now = Date.now();
      const elapsed = now - lastSampleAt;
      if (elapsed >= 1000) {
        record.job.bytesPerSec =
          ((record.job.received - lastSampleBytes) * 1000) / elapsed;
        record.job.etaMs =
          record.job.bytesPerSec > 0
            ? ((record.job.total - record.job.received) * 1000) /
              record.job.bytesPerSec
            : null;
        lastSampleAt = now;
        lastSampleBytes = record.job.received;
      }

      this.throttleEmit(record);
    });

    await pipeline(bodyStream, writeStream);
    await fsp.rename(stagingPath, finalPath);

    const stat = await fsp.stat(finalPath);
    const sha256 = await hashFile(finalPath);
    if (expectedSha256 && sha256 !== expectedSha256) {
      await fsp.rm(finalPath, { force: true });
      throw new Error(`SHA256 mismatch for bundle file ${remotePath}`);
    }
    return { path: finalPath, sizeBytes: stat.size, sha256 };
  }

  private async loadHttpClient(): Promise<{
    request: (
      url: string,
      options: {
        method: string;
        headers: Record<string, string>;
        signal: AbortSignal;
      },
    ) => Promise<{
      statusCode: number;
      headers: Record<string, string | string[] | undefined>;
      body: AsyncIterable<Buffer>;
    }>;
  }> {
    const fetchImpl = globalThis.fetch;
    return {
      request: async (url, options) => {
        const response = await fetchImpl(url, {
          method: options.method,
          headers: options.headers,
          signal: options.signal,
          redirect: "follow",
        });
        if (!response.body) {
          throw new Error(`Empty response body from ${url}`);
        }
        return {
          statusCode: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: readFetchBody(response.body),
        };
      },
    };
  }
}
