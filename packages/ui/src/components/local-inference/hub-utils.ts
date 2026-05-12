/**
 * Pure helpers used by the Model Hub UI. Kept separate from components so
 * they can be covered by unit tests without a DOM.
 */

import type {
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
  ModelBucket,
} from "../../api/client-local-inference";
import { MODEL_CATALOG } from "../../services/local-inference/catalog";
import { assessCatalogModelFit } from "../../services/local-inference/recommendation";

export type FitLevel = "fits" | "tight" | "wontfit";

const ELIZA_1_DISPLAY_NAMES: Record<string, string> = {
  "eliza-1-0_6b": "eliza-1-0_6b",
  "eliza-1-1_7b": "eliza-1-1_7b",
  "eliza-1-9b": "eliza-1-9b",
  "eliza-1-27b": "eliza-1-27b",
  "eliza-1-27b-256k": "eliza-1-27b",
};

export function displayModelName(model: {
  id: string;
  displayName?: string;
}): string {
  if (model.id.endsWith("-drafter")) {
    const base = model.id.slice(0, -"-drafter".length);
    const label = ELIZA_1_DISPLAY_NAMES[base];
    if (label) return `${label} drafter`;
  }
  return ELIZA_1_DISPLAY_NAMES[model.id] ?? model.displayName ?? model.id;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toFixed(0)} MB`;
}

export function formatEta(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "";
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function progressPercent(job: DownloadJob | undefined): number {
  if (!job || job.total <= 0) return 0;
  return Math.min(100, Math.round((job.received / job.total) * 100));
}

const BUCKET_LABEL: Record<ModelBucket, string> = {
  small: "Fast",
  mid: "Balanced",
  large: "High quality",
  xl: "Premium",
};

export function bucketLabel(bucket: ModelBucket): string {
  return BUCKET_LABEL[bucket];
}

export function fitLabel(fit: FitLevel): string {
  if (fit === "fits") return "Runs smoothly";
  if (fit === "tight") return "Slow on your device";
  return "Not enough memory";
}

export function computeFit(
  model: CatalogModel,
  hardware: HardwareProbe,
): FitLevel {
  return assessCatalogModelFit(hardware, model, MODEL_CATALOG);
}

/**
 * Decide whether a catalog model is already installed.
 * External models show up with ids like `external-<origin>-<hash>` so we
 * also tolerate matches by filename basename.
 */
export function findInstalled(
  model: CatalogModel,
  installed: InstalledModel[],
): InstalledModel | undefined {
  const byId = installed.find((m) => m.id === model.id);
  if (byId) return byId;
  // Fallback: external entries whose basename matches the catalog gguf.
  const target = model.ggufFile.toLowerCase();
  return installed.find(
    (m) =>
      m.path.toLowerCase().endsWith(`/${target}`) ||
      m.path.toLowerCase().endsWith(`\\${target}`),
  );
}

export function findDownload(
  modelId: string,
  downloads: DownloadJob[],
): DownloadJob | undefined {
  return downloads.find((d) => d.modelId === modelId);
}

/**
 * Client-side lookup of a catalog entry by id. Accepts the catalog as an
 * argument so the hub UI can mix curated + HF-search results without
 * importing the server-side singleton.
 */
export function findCatalogModel(
  id: string,
  catalog: CatalogModel[],
): CatalogModel | undefined {
  return catalog.find((m) => m.id === id);
}

export function groupByBucket(
  models: CatalogModel[],
): Map<ModelBucket, CatalogModel[]> {
  const groups = new Map<ModelBucket, CatalogModel[]>();
  for (const bucket of ["small", "mid", "large", "xl"] as const) {
    groups.set(bucket, []);
  }
  for (const model of models) {
    groups.get(model.bucket)?.push(model);
  }
  return groups;
}
