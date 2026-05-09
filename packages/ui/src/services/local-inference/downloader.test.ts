import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Downloader } from "./downloader";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

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
            modelId: "qwen3.5-4b-dflash",
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

    expect(job?.modelId).toBe("qwen3.5-4b-dflash");
    expect(job?.state).toBe("failed");
    expect(job?.error).toBe("network reset");
  });
});
