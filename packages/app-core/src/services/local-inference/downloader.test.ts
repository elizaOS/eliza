import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findCatalogModel } from "./catalog";
import { Downloader } from "./downloader";
import type { Eliza1DeviceCaps } from "./manifest";
import { listInstalledModels } from "./registry";
import type { DownloadJob } from "./types";

function eliza1Manifest(overrides: {
  ramBudgetMin?: number;
  ramBudgetRecommended?: number;
  verifiedBackends?: Record<
    string,
    { status: string; atCommit: string; report: string }
  >;
  shaFor: (key: string) => string;
}): string {
  const verifiedBackends = overrides.verifiedBackends ?? {
    metal: { status: "pass", atCommit: "t", report: "metal" },
    vulkan: { status: "pass", atCommit: "t", report: "vulkan" },
    cuda: { status: "pass", atCommit: "t", report: "cuda" },
    rocm: { status: "pass", atCommit: "t", report: "rocm" },
    cpu: { status: "pass", atCommit: "t", report: "cpu" },
  };
  return JSON.stringify({
    id: "eliza-1-0_6b",
    tier: "0_6b",
    version: "1.0.0",
    publishedAt: "2026-05-11T00:00:00.000Z",
    lineage: {
      text: { base: "eliza-1-text", license: "test" },
      voice: { base: "eliza-1-voice", license: "test" },
      asr: { base: "eliza-1-asr", license: "test" },
      vad: { base: "eliza-1-vad", license: "test" },
      drafter: { base: "eliza-1-drafter", license: "test" },
    },
    defaultEligible: true,
    files: {
      text: [
        {
          path: "text/eliza-1-0_6b-32k.gguf",
          sha256: overrides.shaFor("text"),
          ctx: 32768,
        },
      ],
      voice: [{ path: "tts/voice.gguf", sha256: overrides.shaFor("voice") }],
      asr: [{ path: "asr/asr.gguf", sha256: overrides.shaFor("asr") }],
      vision: [],
      dflash: [
        {
          path: "dflash/drafter-0_6b.gguf",
          sha256: overrides.shaFor("drafter"),
        },
      ],
      cache: [
        {
          path: "cache/voice-preset-default.bin",
          sha256: overrides.shaFor("cache"),
        },
      ],
      vad: [{ path: "vad/eliza-1-vad.onnx", sha256: overrides.shaFor("vad") }],
    },
    kernels: {
      required: ["turboquant_q3", "qjl", "polarquant", "dflash"],
      optional: [],
      verifiedBackends,
    },
    evals: {
      textEval: { score: 1, passed: true },
      voiceRtf: { rtf: 0.5, passed: true },
      asrWer: { wer: 0.05, passed: true },
      vadLatencyMs: { median: 16, passed: true },
      e2eLoopOk: true,
      thirtyTurnOk: true,
    },
    ramBudgetMb: {
      min: overrides.ramBudgetMin ?? 2048,
      recommended: overrides.ramBudgetRecommended ?? 4096,
    },
  });
}

const cpuOnlyCaps: Eliza1DeviceCaps = {
  availableBackends: ["cpu"],
  ramMb: 16_384,
};

function remotePathOf(url: string | URL | Request): string {
  const href =
    typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  const pathname = new URL(href).pathname;
  const marker = "/resolve/main/";
  const idx = pathname.indexOf(marker);
  return idx >= 0
    ? decodeURIComponent(pathname.slice(idx + marker.length))
    : "";
}

/** A fetch that serves only the manifest; any weight fetch throws. */
function installManifestOnlyFetch(
  manifestBody: string,
): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (url: string | URL | Request) => {
    if (remotePathOf(url) === "eliza-1.manifest.json") {
      return new Response(manifestBody, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(manifestBody)) },
      });
    }
    throw new Error(`unexpected weight fetch for ${remotePathOf(url)}`);
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

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
            modelId: "eliza-1-1_7b",
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

    expect(job?.modelId).toBe("eliza-1-1_7b");
    expect(job?.state).toBe("failed");
    expect(job?.error).toBe("network reset");
  });

  it("installs Eliza-1 manifest bundles with the hidden DFlash companion", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
    process.env.ELIZA_STATE_DIR = root;
    const model = findCatalogModel("eliza-1-0_6b");
    expect(model).toBeDefined();
    if (!model) throw new Error("missing test catalog model");

    const text = "GGUF text model";
    const voice = "GGUF voice model";
    const asr = "GGUF ASR model";
    const vad = "VAD model";
    const drafter = "GGUF drafter model";
    const cache = "voice preset";
    const manifest = JSON.stringify({
      id: "eliza-1-0_6b",
      tier: "0_6b",
      version: "1.0.0",
      publishedAt: "2026-05-11T00:00:00.000Z",
      lineage: {
        text: { base: "eliza-1-text", license: "test" },
        voice: { base: "eliza-1-voice", license: "test" },
        asr: { base: "eliza-1-asr", license: "test" },
        vad: { base: "eliza-1-vad", license: "test" },
        drafter: { base: "eliza-1-drafter", license: "test" },
      },
      defaultEligible: true,
      files: {
        text: [
          {
            path: "text/eliza-1-0_6b-32k.gguf",
            sha256: sha256(text),
            ctx: 32768,
          },
        ],
        voice: [{ path: "tts/voice.gguf", sha256: sha256(voice) }],
        asr: [{ path: "asr/asr.gguf", sha256: sha256(asr) }],
        vision: [],
        dflash: [
          {
            path: "dflash/drafter-0_6b.gguf",
            sha256: sha256(drafter),
          },
        ],
        cache: [
          {
            path: "cache/voice-preset-default.bin",
            sha256: sha256(cache),
          },
        ],
        vad: [{ path: "vad/eliza-1-vad.onnx", sha256: sha256(vad) }],
      },
      kernels: {
        required: ["turboquant_q3", "qjl", "polarquant", "dflash"],
        optional: [],
        verifiedBackends: {
          metal: {
            status: "pass",
            atCommit: "test",
            report: "test-metal",
          },
          vulkan: {
            status: "pass",
            atCommit: "test",
            report: "test-vulkan",
          },
          cuda: {
            status: "pass",
            atCommit: "test",
            report: "test-cuda",
          },
          rocm: {
            status: "pass",
            atCommit: "test",
            report: "test-rocm",
          },
          cpu: {
            status: "pass",
            atCommit: "test",
            report: "test-cpu",
          },
        },
      },
      evals: {
        textEval: { score: 1, passed: true },
        voiceRtf: { rtf: 0.5, passed: true },
        asrWer: { wer: 0.05, passed: true },
        vadLatencyMs: { median: 16, passed: true },
        e2eLoopOk: true,
        thirtyTurnOk: true,
      },
      ramBudgetMb: { min: 2048, recommended: 4096 },
    });
    installFetchFixture(
      new Map([
        ["eliza-1.manifest.json", manifest],
        ["text/eliza-1-0_6b-32k.gguf", text],
        ["tts/voice.gguf", voice],
        ["asr/asr.gguf", asr],
        ["vad/eliza-1-vad.onnx", vad],
        ["dflash/drafter-0_6b.gguf", drafter],
        ["cache/voice-preset-default.bin", cache],
      ]),
    );

    const downloader = new Downloader({
      probeDeviceCaps: async () => cpuOnlyCaps,
    });
    const completed = waitForTerminal(downloader, model.id);
    await downloader.start(model.id);
    const job = await completed;
    const installed = await listInstalledModels();
    const main = installed.find((entry) => entry.id === model.id);
    const companion = installed.find(
      (entry) => entry.id === "eliza-1-0_6b-drafter",
    );
    expect(main).toBeDefined();
    expect(companion).toBeDefined();
    const bundleRoot = main?.bundleRoot;
    expect(bundleRoot).toBeDefined();
    if (!main || !companion || !bundleRoot) {
      throw new Error("bundle install did not register expected files");
    }

    expect(job.state).toBe("completed");
    expect(main.path.endsWith("text/eliza-1-0_6b-32k.gguf")).toBe(true);
    expect(bundleRoot).toBe(
      path.join(root, "local-inference", "models", "eliza-1-0_6b.bundle"),
    );
    expect(main.manifestPath).toBe(
      path.join(bundleRoot, "eliza-1.manifest.json"),
    );
    expect(main.bundleVersion).toBe("1.0.0");
    expect(main.bundleSizeBytes).toBeGreaterThan(main.sizeBytes);
    expect(fs.existsSync(path.join(bundleRoot, "tts/voice.gguf"))).toBe(true);
    expect(fs.existsSync(path.join(bundleRoot, "asr/asr.gguf"))).toBe(true);
    expect(fs.existsSync(path.join(bundleRoot, "vad/eliza-1-vad.onnx"))).toBe(
      true,
    );
    expect(companion.runtimeRole).toBe("dflash-drafter");
    expect(companion.companionFor).toBe(model.id);
    expect(companion.path.endsWith("dflash/drafter-0_6b.gguf")).toBe(true);
    expect(companion.bundleRoot).toBe(bundleRoot);
  });

  it("restarts single-file partial downloads when a server ignores Range", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
    process.env.ELIZA_STATE_DIR = root;
    const model = findCatalogModel("eliza-1-0_6b-drafter");
    expect(model).toBeDefined();
    if (!model) throw new Error("missing test catalog model");

    const body = "complete drafter";
    installFetchFixture(new Map([["dflash/drafter-0_6b.gguf", body]]));

    const downloadsDir = path.join(root, "local-inference", "downloads");
    fs.mkdirSync(downloadsDir, { recursive: true });
    fs.writeFileSync(
      path.join(downloadsDir, "eliza-1-0_6b-drafter.part"),
      "stale partial",
    );

    const downloader = new Downloader();
    const completed = waitForTerminal(downloader, model.id);
    await downloader.start(model.id);
    await completed;

    const installed = await listInstalledModels();
    const entry = installed.find((m) => m.id === model.id);
    expect(entry).toBeDefined();
    if (!entry) throw new Error("missing installed drafter");
    expect(fs.readFileSync(entry.path, "utf8")).toBe(body);
  });

  it("aborts before any weight byte when no verified backend overlaps the device", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
    process.env.ELIZA_STATE_DIR = root;
    const model = findCatalogModel("eliza-1-0_6b");
    if (!model) throw new Error("missing test catalog model");

    const manifest = eliza1Manifest({
      shaFor: () => sha256("x"),
      // Bundle only verified Metal/CUDA — a cpu-only Linux box must reject it.
      verifiedBackends: {
        metal: { status: "pass", atCommit: "t", report: "metal" },
        vulkan: { status: "needs-hardware", atCommit: "t", report: "vk" },
        cuda: { status: "pass", atCommit: "t", report: "cuda" },
        rocm: { status: "needs-hardware", atCommit: "t", report: "rocm" },
        cpu: { status: "needs-hardware", atCommit: "t", report: "cpu" },
      },
    });
    const fetchSpy = installManifestOnlyFetch(manifest);

    const downloader = new Downloader({
      probeDeviceCaps: async () => cpuOnlyCaps,
    });
    const failed = new Promise<DownloadJob>((resolve) => {
      const unsub = downloader.subscribe((event) => {
        if (event.job.modelId === model.id && event.type === "failed") {
          unsub();
          resolve(event.job);
        }
      });
    });
    await downloader.start(model.id);
    const job = await failed;
    expect(job.state).toBe("failed");
    expect(job.error).toMatch(/no required-kernel backend/i);
    // Manifest is fetched (it's metadata, not a weight); nothing else is.
    const weightFetches = fetchSpy.mock.calls.filter(
      ([u]) => remotePathOf(u) !== "eliza-1.manifest.json",
    );
    expect(weightFetches).toHaveLength(0);
    expect((await listInstalledModels()).some((m) => m.id === model.id)).toBe(
      false,
    );
  });

  it("aborts before any weight byte when the RAM budget exceeds the device", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
    process.env.ELIZA_STATE_DIR = root;
    const model = findCatalogModel("eliza-1-0_6b");
    if (!model) throw new Error("missing test catalog model");

    const manifest = eliza1Manifest({
      shaFor: () => sha256("x"),
      ramBudgetMin: 999_999,
      ramBudgetRecommended: 999_999,
    });
    installManifestOnlyFetch(manifest);

    const downloader = new Downloader({
      probeDeviceCaps: async () => cpuOnlyCaps,
    });
    const failed = new Promise<DownloadJob>((resolve) => {
      const unsub = downloader.subscribe((event) => {
        if (event.job.modelId === model.id && event.type === "failed") {
          unsub();
          resolve(event.job);
        }
      });
    });
    await downloader.start(model.id);
    const job = await failed;
    expect(job.error).toMatch(/needs at least 999999 MB RAM/);
    expect((await listInstalledModels()).some((m) => m.id === model.id)).toBe(
      false,
    );
  });

  it("runs the verify-on-device hook before the bundle fills a default slot", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
    process.env.ELIZA_STATE_DIR = root;
    const model = findCatalogModel("eliza-1-0_6b");
    if (!model) throw new Error("missing test catalog model");

    const bytes = {
      text: "GGUF text",
      voice: "GGUF voice",
      asr: "GGUF asr",
      vad: "VAD onnx",
      drafter: "GGUF drafter",
      cache: "voice preset",
    } as const;
    const manifest = eliza1Manifest({
      shaFor: (k) => sha256(bytes[k as keyof typeof bytes]),
    });
    installFetchFixture(
      new Map([
        ["eliza-1.manifest.json", manifest],
        ["text/eliza-1-0_6b-32k.gguf", bytes.text],
        ["tts/voice.gguf", bytes.voice],
        ["asr/asr.gguf", bytes.asr],
        ["vad/eliza-1-vad.onnx", bytes.vad],
        ["dflash/drafter-0_6b.gguf", bytes.drafter],
        ["cache/voice-preset-default.bin", bytes.cache],
      ]),
    );

    const verifyCalls: Array<{ modelId: string; textGgufPath: string }> = [];
    const downloader = new Downloader({
      probeDeviceCaps: async () => cpuOnlyCaps,
      verifyOnDevice: async ({ modelId, textGgufPath }) => {
        verifyCalls.push({ modelId, textGgufPath });
      },
    });
    const completed = waitForTerminal(downloader, model.id);
    await downloader.start(model.id);
    await completed;

    expect(verifyCalls).toHaveLength(1);
    expect(verifyCalls[0]?.modelId).toBe(model.id);
    expect(
      verifyCalls[0]?.textGgufPath.endsWith("text/eliza-1-0_6b-32k.gguf"),
    ).toBe(true);
    const installed = await listInstalledModels();
    const main = installed.find((m) => m.id === model.id);
    expect(main?.bundleVerifiedAt).toBeTruthy();
  });

  it("fails the download (no install) when the verify-on-device hook rejects", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
    process.env.ELIZA_STATE_DIR = root;
    const model = findCatalogModel("eliza-1-0_6b");
    if (!model) throw new Error("missing test catalog model");

    const bytes = {
      text: "GGUF text",
      voice: "GGUF voice",
      asr: "GGUF asr",
      vad: "VAD onnx",
      drafter: "GGUF drafter",
      cache: "voice preset",
    } as const;
    const manifest = eliza1Manifest({
      shaFor: (k) => sha256(bytes[k as keyof typeof bytes]),
    });
    installFetchFixture(
      new Map([
        ["eliza-1.manifest.json", manifest],
        ["text/eliza-1-0_6b-32k.gguf", bytes.text],
        ["tts/voice.gguf", bytes.voice],
        ["asr/asr.gguf", bytes.asr],
        ["vad/eliza-1-vad.onnx", bytes.vad],
        ["dflash/drafter-0_6b.gguf", bytes.drafter],
        ["cache/voice-preset-default.bin", bytes.cache],
      ]),
    );

    const downloader = new Downloader({
      probeDeviceCaps: async () => cpuOnlyCaps,
      verifyOnDevice: async () => {
        throw new Error("barge-in cancel test failed");
      },
    });
    const failed = new Promise<DownloadJob>((resolve) => {
      const unsub = downloader.subscribe((event) => {
        if (event.job.modelId === model.id && event.type === "failed") {
          unsub();
          resolve(event.job);
        }
      });
    });
    await downloader.start(model.id);
    const job = await failed;
    expect(job.error).toMatch(/barge-in cancel test failed/);
    expect((await listInstalledModels()).some((m) => m.id === model.id)).toBe(
      false,
    );
  });
});
