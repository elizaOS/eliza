import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ELIZA1_HF_DATASET_FILES,
  HUGGINGFACE_DATASET_INGEST_SCHEMA,
  ingestHuggingFaceDataset,
} from "./huggingface-dataset-ingest.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hf-dataset-ingest-"));
  tempDirs.push(dir);
  return dir;
}

function mockResponse(body: string, contentType: string): Response {
  return {
    ok: true,
    status: 200,
    text: async () => body,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? contentType : null,
    },
  } as Response;
}

describe("huggingface dataset ingest", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("downloads selected dataset files and writes an analysis manifest", async () => {
    const outputDir = await makeTempDir();
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/sft/0_8b/train.jsonl")) {
        return mockResponse(
          [
            JSON.stringify({
              schema: "eliza.eliza1_trajectory_record.v1",
              trajectoryId: "traj-1",
            }),
            JSON.stringify({
              schema: "eliza.eliza1_trajectory_record.v1",
              trajectoryId: "traj-2",
            }),
            "",
          ].join("\n"),
          "application/x-ndjson",
        );
      }
      return mockResponse('{"schema":"manifest"}\n', "application/json");
    });

    const result = await ingestHuggingFaceDataset({
      repoId: "elizaos/eliza-1-training",
      revision: "main",
      files: ["sft/0_8b/train.jsonl", "sft/0_8b/manifest.json"],
      outputDir,
      now: () => new Date("2026-05-18T12:00:00.000Z"),
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "https://huggingface.co/datasets/elizaos/eliza-1-training/resolve/main/sft/0_8b/train.jsonl",
      { headers: undefined },
    );
    expect(result.manifest.schema).toBe(HUGGINGFACE_DATASET_INGEST_SCHEMA);
    expect(result.manifest.counts).toMatchObject({
      files: 2,
      downloadedFiles: 2,
      dryRunFiles: 0,
      jsonlRows: 2,
    });
    expect(result.manifest.files[0]).toMatchObject({
      hfPath: "sft/0_8b/train.jsonl",
      rows: 2,
      status: "downloaded",
    });

    const jsonl = await readFile(
      join(outputDir, "sft", "0_8b", "train.jsonl"),
      "utf8",
    );
    expect(jsonl).toContain("traj-1");
    const manifestOnDisk = JSON.parse(
      await readFile(result.manifestPath, "utf8"),
    ) as typeof result.manifest;
    expect(manifestOnDisk.counts.jsonlRows).toBe(2);
  });

  it("supports dry runs without fetching files", async () => {
    const outputDir = await makeTempDir();
    const fetcher = vi.fn();

    const result = await ingestHuggingFaceDataset({
      files: ["sft/0_8b/train.jsonl"],
      outputDir,
      dryRun: true,
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.manifest.counts).toMatchObject({
      files: 1,
      downloadedFiles: 0,
      dryRunFiles: 1,
      jsonlRows: 0,
      bytes: 0,
    });
    expect(result.manifest.files[0]?.status).toBe("dry_run");
  });

  it("defaults to every core Eliza-1 SFT tier file", async () => {
    const outputDir = await makeTempDir();
    const fetcher = vi.fn();

    const result = await ingestHuggingFaceDataset({
      outputDir,
      dryRun: true,
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(DEFAULT_ELIZA1_HF_DATASET_FILES).toContain("sft/0_8b/train.jsonl");
    expect(DEFAULT_ELIZA1_HF_DATASET_FILES).toContain("sft/2b/train.jsonl");
    expect(DEFAULT_ELIZA1_HF_DATASET_FILES).toContain("sft/4b/train.jsonl");
    expect(DEFAULT_ELIZA1_HF_DATASET_FILES).toContain("sft/9b/train.jsonl");
    expect(DEFAULT_ELIZA1_HF_DATASET_FILES).toContain("sft/27b/train.jsonl");
    expect(result.manifest.counts).toMatchObject({
      files: DEFAULT_ELIZA1_HF_DATASET_FILES.length,
      downloadedFiles: 0,
      dryRunFiles: DEFAULT_ELIZA1_HF_DATASET_FILES.length,
    });
    expect(result.manifest.files.map((file) => file.hfPath)).toEqual(
      DEFAULT_ELIZA1_HF_DATASET_FILES,
    );
  });
});
