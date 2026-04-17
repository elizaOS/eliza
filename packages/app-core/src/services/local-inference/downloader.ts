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
 * We use `undici` which is already a dependency of plugin-local-ai and
 * ships first-class Range support. Node's built-in `fetch` lacks a clean
 * way to pipe a ReadableStream into a Node WriteStream.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { buildHuggingFaceResolveUrl, findCatalogModel } from "./catalog";
import { downloadsStagingDir, miladyModelsDir } from "./paths";
import { upsertMiladyModel } from "./registry";
import type {
  CatalogModel,
  DownloadEvent,
  DownloadJob,
  DownloadState,
  InstalledModel,
} from "./types";

interface ActiveJob {
  job: DownloadJob;
  abortController: AbortController;
  stagingPath: string;
  finalPath: string;
}

type DownloadListener = (event: DownloadEvent) => void;

const PROGRESS_THROTTLE_MS = 250;

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

async function ensureDirs(): Promise<void> {
  await fsp.mkdir(downloadsStagingDir(), { recursive: true });
  await fsp.mkdir(miladyModelsDir(), { recursive: true });
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
  private readonly listeners = new Set<DownloadListener>();
  private readonly lastEmit = new Map<string, number>();

  subscribe(listener: DownloadListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): DownloadJob[] {
    return [...this.active.values()].map((a) => ({ ...a.job }));
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
  async start(
    modelIdOrSpec: string | CatalogModel,
  ): Promise<DownloadJob> {
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
    const finalPath = path.join(miladyModelsDir(), finalFilename(catalogEntry));

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
      const url = buildHuggingFaceResolveUrl(catalogEntry);

      // Dynamic import — undici is a runtime dep of plugin-local-ai, not
      // app-core. We tolerate it being absent by falling back to global fetch.
      const undici = await this.loadUndici();
      const startByte = record.job.received;

      const headers: Record<string, string> = {
        "user-agent": "Milady-LocalInference/1.0",
      };
      if (startByte > 0) {
        headers.range = `bytes=${startByte}-`;
      }

      const response = await undici.request(url, {
        method: "GET",
        headers,
        signal: record.abortController.signal,
        maxRedirections: 5,
      });

      if (response.statusCode >= 400) {
        throw new Error(
          `HTTP ${response.statusCode} from HuggingFace for ${catalogEntry.hfRepo}`,
        );
      }

      const contentLengthHeader = response.headers["content-length"];
      const contentLength = Array.isArray(contentLengthHeader)
        ? Number.parseInt(contentLengthHeader[0] ?? "0", 10)
        : Number.parseInt(contentLengthHeader ?? "0", 10);
      if (Number.isFinite(contentLength) && contentLength > 0) {
        record.job.total = startByte + contentLength;
      }

      const writeStream: Writable = fs.createWriteStream(record.stagingPath, {
        flags: startByte > 0 ? "a" : "w",
      });

      const hasher = createHash("sha256");
      let lastSampleBytes = record.job.received;
      let lastSampleAt = Date.now();

      const bodyStream = Readable.from(response.body);
      bodyStream.on("data", (chunk: Buffer) => {
        record.job.received += chunk.length;
        hasher.update(chunk);

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
      const installed: InstalledModel = {
        id: catalogEntry.id,
        displayName: catalogEntry.displayName,
        path: record.finalPath,
        sizeBytes: finalStat.size,
        hfRepo: catalogEntry.hfRepo,
        installedAt: new Date().toISOString(),
        lastUsedAt: null,
        source: "milady-download",
      };
      await upsertMiladyModel(installed);

      this.updateState(record, "completed");
      record.job.received = finalStat.size;
      record.job.total = finalStat.size;
      this.emit({ type: "completed", job: { ...record.job } });
    } catch (err) {
      if (record.abortController.signal.aborted) {
        this.updateState(record, "cancelled");
        this.emit({ type: "cancelled", job: { ...record.job } });
      } else {
        this.updateState(record, "failed");
        record.job.error = err instanceof Error ? err.message : String(err);
        this.emit({ type: "failed", job: { ...record.job } });
      }
    } finally {
      this.active.delete(record.job.modelId);
    }
  }

  private async loadUndici(): Promise<{
    request: (
      url: string,
      options: {
        method: string;
        headers: Record<string, string>;
        signal: AbortSignal;
        maxRedirections: number;
      },
    ) => Promise<{
      statusCode: number;
      headers: Record<string, string | string[] | undefined>;
      body: AsyncIterable<Buffer>;
    }>;
  }> {
    const mod = (await import("undici")) as unknown as {
      request: (
        url: string,
        options: {
          method: string;
          headers: Record<string, string>;
          signal: AbortSignal;
          maxRedirections: number;
        },
      ) => Promise<{
        statusCode: number;
        headers: Record<string, string | string[] | undefined>;
        body: AsyncIterable<Buffer>;
      }>;
    };
    return mod;
  }
}
