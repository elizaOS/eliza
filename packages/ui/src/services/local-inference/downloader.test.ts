import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findCatalogModel } from "./catalog";
import { Downloader } from "./downloader";
import { listInstalledModels } from "./registry";
import type { DownloadJob } from "./types";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function bundleRemotePath(
  model: { bundleManifestFile?: string; hfPathPrefix?: string },
  rel: string,
): string {
  if (model.hfPathPrefix && !rel.startsWith(`${model.hfPathPrefix}/`)) {
    return path.posix.join(model.hfPathPrefix, rel);
  }
  if (!model.bundleManifestFile) {
    throw new Error("missing bundle manifest path");
  }
  return path.posix.join(path.posix.dirname(model.bundleManifestFile), rel);
}

function installFetchFixture(files: Map<string, string>): void {
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const href =
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const pathname = new URL(href).pathname;
    const marker = "/resolve/main/";
    const markerIndex = pathname.indexOf(marker);
    const remotePath =
      markerIndex >= 0
        ? decodeURIComponent(pathname.slice(markerIndex + marker.length))
        : "";
    const body = files.get(remotePath);
    if (body === undefined) {
      return new Response(`missing ${remotePath}`, { status: 404 });
    }
    return new Response(body, {
      status: 200,
      headers: { "content-length": String(Buffer.byteLength(body)) },
    });
  }) as unknown as typeof fetch;
}

function waitForTerminal(
  downloader: Downloader,
  modelId: string,
): Promise<DownloadJob> {
  return new Promise((resolve, reject) => {
    const unsubscribe = downloader.subscribe((event) => {
      if (event.job.modelId !== modelId) return;
      if (event.type === "completed") {
        unsubscribe();
        resolve(event.job);
      }
      if (event.type === "failed") {
        unsubscribe();
        reject(new Error(event.job.error ?? "download failed"));
      }
    });
  });
}

describe("local inference downloader status", () => {
  it("loads persisted terminal failures into snapshots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
    process.env.ELIZA_STATE_DIR = root;
    const statusDir = path.join(root, "local-inference");
    fs.mkdirSync(statusDir, { recursive: true });
    fs.writeFileSync(
      path.join(statusDir, "download-status.json"),
      JSON.stringify({
        version: 1,
        jobs: [
          {
            jobId: "job-1",
            modelId: "eliza-1-2b",
            state: "failed",
            received: 64,
            total: 128,
            bytesPerSec: 0,
            etaMs: null,
            startedAt: "2026-05-08T00:00:00.000Z",
            updatedAt: "2026-05-08T00:00:01.000Z",
            error: "network reset",
          },
        ],
      }),
      "utf8",
    );

    const [job] = new Downloader().snapshot();

    expect(job?.modelId).toBe("eliza-1-2b");
    expect(job?.state).toBe("failed");
    expect(job?.error).toBe("network reset");
  });

  it("installs Eliza-1 manifest bundles with the hidden DFlash companion", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
    process.env.ELIZA_STATE_DIR = root;
    const model = findCatalogModel("eliza-1-2b");
    expect(model).toBeDefined();
    if (!model) throw new Error("missing test catalog model");
    const manifestFile = model.bundleManifestFile;
    if (!manifestFile) throw new Error("missing bundle manifest path");

    const text = "GGUF text model";
    const voice = "GGUF voice model";
    const asr = "GGUF asr model";
    const drafter = "GGUF drafter model";
    const cache = "voice preset";
    const vad = "VAD runtime data";
    const textPath = "text/eliza-1-2b-32k.gguf";
    const voicePath = "tts/voice.gguf";
    const asrPath = "asr/eliza-1-asr.gguf";
    const drafterPath = "dflash/drafter-2b.gguf";
    const cachePath = "cache/default-voice-preset.bin";
    const vadPath = "vad/eliza-1-vad.bin";
    const manifest = JSON.stringify({
      id: "eliza-1-2b",
      version: "1.0.0",
      defaultEligible: true,
      files: {
        text: [
          {
            path: textPath,
            sha256: sha256(text),
            ctx: 32768,
          },
        ],
        voice: [{ path: voicePath, sha256: sha256(voice) }],
        asr: [{ path: asrPath, sha256: sha256(asr) }],
        vision: [],
        dflash: [
          {
            path: drafterPath,
            sha256: sha256(drafter),
          },
        ],
        cache: [
          {
            path: cachePath,
            sha256: sha256(cache),
          },
        ],
        vad: [{ path: vadPath, sha256: sha256(vad) }],
      },
    });
    installFetchFixture(
      new Map([
        [bundleRemotePath(model, manifestFile), manifest],
        [bundleRemotePath(model, textPath), text],
        [bundleRemotePath(model, voicePath), voice],
        [bundleRemotePath(model, asrPath), asr],
        [bundleRemotePath(model, drafterPath), drafter],
        [bundleRemotePath(model, cachePath), cache],
        [bundleRemotePath(model, vadPath), vad],
      ]),
    );

    const downloader = new Downloader();
    const completed = waitForTerminal(downloader, model.id);
    await downloader.start(model.id);
    const job = await completed;
    const installed = await listInstalledModels();
    const main = installed.find((entry) => entry.id === model.id);
    const companion = installed.find(
      (entry) => entry.id === "eliza-1-2b-drafter",
    );
    expect(main).toBeDefined();
    expect(companion).toBeDefined();
    const bundleRoot = main?.bundleRoot;
    expect(bundleRoot).toBeDefined();
    if (!main || !companion || !bundleRoot) {
      throw new Error("bundle install did not register expected files");
    }

    expect(job.state).toBe("completed");
    expect(main.path.endsWith(textPath)).toBe(true);
    expect(bundleRoot).toBe(
      path.join(root, "local-inference", "models", "eliza-1-2b.bundle"),
    );
    expect(main.manifestPath).toBe(path.join(bundleRoot, manifestFile));
    expect(main.bundleVersion).toBe("1.0.0");
    expect(main.bundleSizeBytes).toBeGreaterThan(main.sizeBytes);
    expect(fs.existsSync(path.join(bundleRoot, voicePath))).toBe(true);
    expect(fs.existsSync(path.join(bundleRoot, asrPath))).toBe(true);
    expect(fs.existsSync(path.join(bundleRoot, vadPath))).toBe(true);
    expect(companion.runtimeRole).toBe("dflash-drafter");
    expect(companion.companionFor).toBe(model.id);
    expect(companion.path.endsWith(drafterPath)).toBe(true);
    expect(companion.bundleRoot).toBe(bundleRoot);
  });
});
