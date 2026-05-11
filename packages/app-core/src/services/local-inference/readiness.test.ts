import { describe, expect, it } from "vitest";
import { buildTextGenerationReadiness } from "./readiness";
import type { ActiveModelState, DownloadJob, InstalledModel } from "./types";

const activeIdle: ActiveModelState = {
  modelId: null,
  loadedAt: null,
  status: "idle",
};

describe("local inference text readiness", () => {
  it("reports assigned download terminal error state", () => {
    const installed: InstalledModel[] = [];
    const failedDownload: DownloadJob = {
      jobId: "job-1",
      modelId: "eliza-1-1_7b",
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
        TEXT_LARGE: "eliza-1-1_7b",
      },
      installed,
      active: activeIdle,
      downloads: [failedDownload],
    });

    expect(readiness.slots.TEXT_LARGE.assigned).toBe(true);
    expect(readiness.slots.TEXT_LARGE.primaryDownloaded).toBe(false);
    expect(readiness.slots.TEXT_LARGE.downloaded).toBe(false);
    expect(readiness.slots.TEXT_LARGE.state).toBe("failed");
    expect(readiness.slots.TEXT_LARGE.missingModelIds).toContain(
      "eliza-1-1_7b",
    );
    expect(readiness.slots.TEXT_LARGE.download.percent).toBe(25);
    expect(readiness.slots.TEXT_LARGE.errors).toContain(
      "HTTP 503 from HuggingFace",
    );
  });

  it("marks a downloaded active assignment ready", () => {
    const installed: InstalledModel[] = [
      {
        id: "eliza-1-1_7b",
        displayName: "Eliza-1 1.7B",
        path: "/tmp/eliza-1-1_7b.gguf",
        sizeBytes: 2048,
        installedAt: new Date().toISOString(),
        lastUsedAt: null,
        source: "eliza-download",
      },
      {
        id: "eliza-1-1_7b-drafter",
        displayName: "Eliza-1 1.7B drafter",
        path: "/tmp/eliza-1-1_7b-drafter.gguf",
        sizeBytes: 512,
        installedAt: new Date().toISOString(),
        lastUsedAt: null,
        source: "eliza-download",
      },
    ];

    const readiness = buildTextGenerationReadiness({
      assignments: {
        TEXT_SMALL: "eliza-1-1_7b",
      },
      installed,
      active: {
        modelId: "eliza-1-1_7b",
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
