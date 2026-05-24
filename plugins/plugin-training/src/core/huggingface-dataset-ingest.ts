import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ELIZA_ONE_BENCHMARK_TIERS } from "./eliza1-benchmark-recipe.js";
import { trainingStateRoot } from "./training-config.js";

export const HUGGINGFACE_DATASET_INGEST_SCHEMA =
  "eliza_huggingface_dataset_ingest";
export const HUGGINGFACE_DATASET_INGEST_VERSION = 1;
export const DEFAULT_ELIZA1_HF_DATASET_REPO = "elizaos/eliza-1-training";
const DEFAULT_ELIZA1_HF_DATASET_TIER_FILES = [
  "train.jsonl",
  "val.jsonl",
  "test.jsonl",
  "manifest.json",
  "validation.json",
] as const;
export const DEFAULT_ELIZA1_HF_DATASET_FILES =
  ELIZA_ONE_BENCHMARK_TIERS.flatMap((tier) =>
    DEFAULT_ELIZA1_HF_DATASET_TIER_FILES.map((file) => `sft/${tier}/${file}`),
  );

export interface HuggingFaceDatasetFileReceipt {
  hfPath: string;
  url: string;
  localPath: string;
  bytes: number;
  sha256: string | null;
  rows: number | null;
  contentType: string | null;
  status: "downloaded" | "dry_run";
}

export interface HuggingFaceDatasetIngestManifest {
  schema: typeof HUGGINGFACE_DATASET_INGEST_SCHEMA;
  schemaVersion: typeof HUGGINGFACE_DATASET_INGEST_VERSION;
  generatedAt: string;
  source: {
    kind: "huggingface_dataset";
    repoId: string;
    revision: string;
  };
  outputDir: string;
  manifestPath: string;
  counts: {
    files: number;
    downloadedFiles: number;
    dryRunFiles: number;
    jsonlRows: number;
    bytes: number;
  };
  files: HuggingFaceDatasetFileReceipt[];
}

export interface IngestHuggingFaceDatasetOptions {
  repoId?: string;
  revision?: string;
  files?: string[];
  outputDir?: string;
  token?: string;
  dryRun?: boolean;
  now?: () => Date;
  fetcher?: typeof fetch;
}

export interface HuggingFaceDatasetIngestResult {
  outputDir: string;
  manifestPath: string;
  manifest: HuggingFaceDatasetIngestManifest;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function safeTimestamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function encodeRepoPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function datasetFileUrl(repoId: string, revision: string, file: string): string {
  return `https://huggingface.co/datasets/${encodeRepoPath(
    repoId,
  )}/resolve/${encodeURIComponent(revision)}/${encodeRepoPath(file)}`;
}

function countJsonlRows(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

async function fetchText(
  fetcher: typeof fetch,
  url: string,
  token?: string,
): Promise<{ text: string; contentType: string | null }> {
  const response = await fetcher(url, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return {
    text: await response.text(),
    contentType: response.headers.get("content-type"),
  };
}

export async function ingestHuggingFaceDataset(
  options: IngestHuggingFaceDatasetOptions = {},
): Promise<HuggingFaceDatasetIngestResult> {
  const repoId = options.repoId?.trim() || DEFAULT_ELIZA1_HF_DATASET_REPO;
  const revision = options.revision?.trim() || "main";
  const files = (options.files?.length
    ? options.files
    : [...DEFAULT_ELIZA1_HF_DATASET_FILES]
  )
    .map((file) => file.trim())
    .filter(Boolean);
  if (files.length === 0) {
    throw new Error("At least one Hugging Face dataset file is required");
  }
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const outputDir =
    options.outputDir ??
    join(
      trainingStateRoot(),
      "hf-datasets",
      safeSegment(repoId),
      safeSegment(revision),
      safeTimestamp(generatedAt),
    );
  const fetcher = options.fetcher ?? fetch;
  const dryRun = options.dryRun === true;

  await mkdir(outputDir, { recursive: true });
  const receipts: HuggingFaceDatasetFileReceipt[] = [];
  for (const file of files) {
    const url = datasetFileUrl(repoId, revision, file);
    const localPath = join(outputDir, ...file.split("/").map(safeSegment));
    if (dryRun) {
      receipts.push({
        hfPath: file,
        url,
        localPath,
        bytes: 0,
        sha256: null,
        rows: null,
        contentType: null,
        status: "dry_run",
      });
      continue;
    }

    const { text, contentType } = await fetchText(fetcher, url, options.token);
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, text, "utf8");
    const bytes = Buffer.byteLength(text, "utf8");
    receipts.push({
      hfPath: file,
      url,
      localPath,
      bytes,
      sha256: createHash("sha256").update(text).digest("hex"),
      rows: file.endsWith(".jsonl") ? countJsonlRows(text) : null,
      contentType,
      status: "downloaded",
    });
  }

  const manifestPath = join(outputDir, "huggingface-dataset-manifest.json");
  const manifest: HuggingFaceDatasetIngestManifest = {
    schema: HUGGINGFACE_DATASET_INGEST_SCHEMA,
    schemaVersion: HUGGINGFACE_DATASET_INGEST_VERSION,
    generatedAt,
    source: {
      kind: "huggingface_dataset",
      repoId,
      revision,
    },
    outputDir,
    manifestPath,
    counts: {
      files: receipts.length,
      downloadedFiles: receipts.filter((file) => file.status === "downloaded")
        .length,
      dryRunFiles: receipts.filter((file) => file.status === "dry_run").length,
      jsonlRows: receipts.reduce((sum, file) => sum + (file.rows ?? 0), 0),
      bytes: receipts.reduce((sum, file) => sum + file.bytes, 0),
    },
    files: receipts,
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { outputDir, manifestPath, manifest };
}

export function defaultHuggingFaceDatasetOutputName(repoId: string): string {
  return basename(repoId) || safeSegment(repoId);
}
