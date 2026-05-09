import { describe, expect, it } from "vitest";
import { buildTextGenerationReadiness } from "./readiness";
import type { ActiveModelState, DownloadJob, InstalledModel } from "./types";

const activeIdle: ActiveModelState = {
  modelId: null,
  loadedAt: null,
  status: "idle",
};

describe("local inference text readiness", () => {
  it("reports assigned, download, companion, and terminal error state", () => {
    const installed: InstalledModel[] = [
      {
        id: "qwen3.5-4b-dflash",
        displayName: "Qwen3.5 4B DFlash (Q4_K_M)",
        path: "/tmp/qwen.gguf",
        sizeBytes: 1024,
        installedAt: new Date().toISOString(),
        lastUsedAt: null,
        source: "eliza-download",
      },
    ];
    const failedCompanion: DownloadJob = {
      jobId: "job-1",
      modelId: "qwen3.5-4b-dflash-drafter-q4",
      state: "failed",
      received: 128,
      total: 512,
      bytesPerSec: 0,
      etaMs: null,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: "HTTP 503 from HuggingFace",
    };

    const readiness = buildTextGenerationReadiness({
      assignments: {
        TEXT_LARGE: "qwen3.5-4b-dflash",
      },
      installed,
      active: activeIdle,
      downloads: [failedCompanion],
    });

    expect(readiness.slots.TEXT_LARGE.assigned).toBe(true);
    expect(readiness.slots.TEXT_LARGE.primaryDownloaded).toBe(true);
    expect(readiness.slots.TEXT_LARGE.downloaded).toBe(false);
    expect(readiness.slots.TEXT_LARGE.state).toBe("failed");
    expect(readiness.slots.TEXT_LARGE.missingModelIds).toContain(
      "qwen3.5-4b-dflash-drafter-q4",
    );
    expect(readiness.slots.TEXT_LARGE.download.percent).toBe(25);
    expect(readiness.slots.TEXT_LARGE.errors).toContain(
      "HTTP 503 from HuggingFace",
    );
  });

  it("marks a downloaded active assignment ready", () => {
    const installed: InstalledModel[] = [
      {
        id: "llama-3.2-3b",
        displayName: "Llama 3.2 3B Instruct",
        path: "/tmp/llama.gguf",
        sizeBytes: 2048,
        installedAt: new Date().toISOString(),
        lastUsedAt: null,
        source: "eliza-download",
      },
    ];

    const readiness = buildTextGenerationReadiness({
      assignments: {
        TEXT_SMALL: "llama-3.2-3b",
      },
      installed,
      active: {
        modelId: "llama-3.2-3b",
        loadedAt: new Date().toISOString(),
        status: "ready",
      },
      downloads: [],
    });

    expect(readiness.slots.TEXT_SMALL.downloaded).toBe(true);
    expect(readiness.slots.TEXT_SMALL.active).toBe(true);
    expect(readiness.slots.TEXT_SMALL.ready).toBe(true);
    expect(readiness.slots.TEXT_SMALL.state).toBe("active");
  });
});
