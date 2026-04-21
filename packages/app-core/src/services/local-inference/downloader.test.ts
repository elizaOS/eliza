/**
 * End-to-end download pipeline tests.
 *
 * Spins up a real `http.Server` serving a real binary payload, points the
 * downloader at it via `MILADY_HF_BASE_URL`, and asserts the full flow:
 * stream → .part file → atomic rename → SHA256 record → registry upsert.
 *
 * No mocks. No vi.fn. Real sockets, real bytes on disk.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODEL_CATALOG } from "./catalog";
import { Downloader } from "./downloader";
import { listInstalledModels } from "./registry";
import type { CatalogModel } from "./types";

function makeGgufPayload(sizeBytes: number): Buffer {
  const buf = Buffer.alloc(sizeBytes, 0);
  Buffer.from("GGUF", "ascii").copy(buf, 0);
  // Fill the rest with a deterministic pattern so SHA256 is stable.
  for (let i = 4; i < sizeBytes; i++) buf[i] = (i * 13) & 0xff;
  return buf;
}

interface Upstream {
  baseUrl: string;
  requestsReceived: Array<{
    url: string;
    range: string | undefined;
    method: string;
  }>;
  dispose: () => Promise<void>;
}

async function startUpstream(
  payload: Buffer,
  opts: {
    /** If set, deliver the payload in `chunkBytes` chunks with `chunkDelayMs` between each. */
    chunkBytes?: number;
    chunkDelayMs?: number;
  } = {},
): Promise<Upstream> {
  const requests: Upstream["requestsReceived"] = [];
  const server = http.createServer((req, res) => {
    const range = req.headers.range as string | undefined;
    requests.push({
      url: req.url ?? "",
      range,
      method: req.method ?? "GET",
    });

    let start = 0;
    if (range) {
      const m = /bytes=(\d+)-/.exec(range);
      if (m) start = Number.parseInt(m[1] ?? "0", 10);
    }
    const slice = payload.subarray(start);

    res.writeHead(range ? 206 : 200, {
      "content-length": String(slice.length),
      "content-type": "application/octet-stream",
    });

    if (!opts.chunkBytes || !opts.chunkDelayMs) {
      res.end(slice);
      return;
    }

    // Chunked delivery so cancel tests have a window to act before the
    // body finishes. Stops on client disconnect.
    let offset = 0;
    const step = (): void => {
      if (res.destroyed) return;
      if (offset >= slice.length) {
        res.end();
        return;
      }
      const end = Math.min(offset + (opts.chunkBytes ?? 0), slice.length);
      res.write(slice.subarray(offset, end));
      offset = end;
      setTimeout(step, opts.chunkDelayMs);
    };
    step();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    requestsReceived: requests,
    dispose: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}

describe("Downloader e2e", () => {
  let tmpState: string;
  let origStateDir: string | undefined;
  let origHfBase: string | undefined;

  beforeEach(async () => {
    tmpState = await fs.mkdtemp(path.join(os.tmpdir(), "milady-dl-e2e-"));
    origStateDir = process.env.ELIZA_STATE_DIR;
    origHfBase = process.env.MILADY_HF_BASE_URL;
    process.env.ELIZA_STATE_DIR = tmpState;
  });

  afterEach(async () => {
    if (origStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = origStateDir;
    if (origHfBase === undefined) delete process.env.MILADY_HF_BASE_URL;
    else process.env.MILADY_HF_BASE_URL = origHfBase;
    await fs.rm(tmpState, { recursive: true, force: true });
  });

  it("downloads a file end-to-end, writes it to disk, records SHA256 in the registry", async () => {
    const payload = makeGgufPayload(64 * 1024); // 64 KB of real bytes
    const upstream = await startUpstream(payload);
    process.env.MILADY_HF_BASE_URL = upstream.baseUrl;

    try {
      // Use the smallest catalog entry; swap its spec is fine — downloader
      // fetches URL + filename via the hfRepo + ggufFile pair.
      const catalogModel = MODEL_CATALOG[0];
      expect(catalogModel).toBeDefined();
      if (!catalogModel) return;

      const downloader = new Downloader();
      const events: string[] = [];
      downloader.subscribe((e) => events.push(e.type));

      const job = await downloader.start(catalogModel.id);
      expect(job.modelId).toBe(catalogModel.id);
      // `start()` returns after queuing; the background run may already
      // have transitioned to "downloading" by the time this line executes.
      expect(["queued", "downloading"]).toContain(job.state);

      // Wait for the "completed" event or a failure.
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error("download timed out")),
          10_000,
        );
        downloader.subscribe((e) => {
          if (e.type === "completed") {
            clearTimeout(deadline);
            resolve();
          } else if (e.type === "failed") {
            clearTimeout(deadline);
            reject(new Error(`download failed: ${e.job.error}`));
          }
        });
      });

      expect(events).toContain("progress");

      // Registry should now list this model with the correct sha256 + size.
      const installed = await listInstalledModels();
      const entry = installed.find((m) => m.id === catalogModel.id);
      expect(entry).toBeDefined();
      if (!entry) return;
      expect(entry.sizeBytes).toBe(payload.length);
      expect(entry.sha256).toBe(
        createHash("sha256").update(payload).digest("hex"),
      );
      expect(entry.source).toBe("milady-download");

      // File itself is on disk at the registered path.
      const onDisk = await fs.readFile(entry.path);
      expect(onDisk.equals(payload)).toBe(true);

      // At least one HTTP request was made.
      expect(upstream.requestsReceived.length).toBeGreaterThanOrEqual(1);
    } finally {
      await upstream.dispose();
    }
  }, 30_000);

  it("cancels an in-flight download cleanly", async () => {
    const payload = makeGgufPayload(10 * 1024 * 1024); // 10 MB
    // Slow stream — 16 KB chunks with 20ms between gives us a long enough
    // window to cancel before the download completes.
    const upstream = await startUpstream(payload, {
      chunkBytes: 16 * 1024,
      chunkDelayMs: 20,
    });
    process.env.MILADY_HF_BASE_URL = upstream.baseUrl;

    try {
      const catalogModel = MODEL_CATALOG[0] as CatalogModel;
      const downloader = new Downloader();

      const cancelledEvent = new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error("cancellation timed out")),
          5_000,
        );
        downloader.subscribe((e) => {
          if (e.type === "cancelled") {
            clearTimeout(deadline);
            resolve();
          }
        });
      });

      await downloader.start(catalogModel.id);
      // Race: cancel as soon as the first chunk is received.
      await new Promise((r) => setTimeout(r, 50));
      const cancelled = downloader.cancel(catalogModel.id);
      expect(cancelled).toBe(true);
      await cancelledEvent;

      // No registry entry should have been written.
      const installed = await listInstalledModels();
      expect(installed.find((m) => m.id === catalogModel.id)).toBeUndefined();
    } finally {
      await upstream.dispose();
    }
  }, 15_000);
});
