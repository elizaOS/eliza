/**
 * Pure helpers used by the Model Hub UI. Kept separate from components so
 * they can be covered by unit tests without a DOM.
 */

import type {
  ActiveModelState,
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
  ModelBucket,
} from "../../api/client-local-inference";
import { assessFit } from "../../services/local-inference/hardware";

export type FitLevel = "fits" | "tight" | "wontfit";

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
  return assessFit(hardware, model.sizeGb, model.minRamGb);
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

const EMBEDDING_CATEGORY = "embedding" as CatalogModel["category"];

/**
 * Curated embedding GGUF to offer when nothing suitable is installed yet.
 * Prefers the hardware bucket, then steps through smaller buckets, skipping
 * models that are already on disk or clearly won’t fit.
 */
export function pickRecommendedEmbedding(
  catalog: CatalogModel[],
  installed: InstalledModel[],
  hardware: HardwareProbe,
): CatalogModel | null {
  const emb = catalog.filter((m) => m.category === EMBEDDING_CATEGORY);
  if (emb.length === 0) return null;
  const bucket = hardware.recommendedBucket;
  const order: ModelBucket[] = [bucket, "small", "mid", "large", "xl"];
  const seen = new Set<ModelBucket>();
  for (const b of order) {
    if (seen.has(b)) continue;
    seen.add(b);
    const inBucket = emb.filter((m) => m.bucket === b);
    for (const m of inBucket) {
      if (findInstalled(m, installed)) continue;
      if (computeFit(m, hardware) === "wontfit") continue;
      return m;
    }
  }
  return null;
}

/** Hub catalog ids for `category === "embedding"` (same pool as Local AI embedding offer). */
export function embeddingCatalogModelIds(catalog: CatalogModel[]): Set<string> {
  return new Set(
    catalog.filter((m) => m.category === EMBEDDING_CATEGORY).map((m) => m.id),
  );
}

/**
 * Milady-download installs whose id is in the curated embedding catalog — the
 * only ids the cloud/local embedding strip and TEXT_EMBEDDING slot should list.
 */
export function installedMiladyEmbeddingFromCatalog(
  installed: InstalledModel[],
  catalog: CatalogModel[],
): InstalledModel[] {
  const ids = embeddingCatalogModelIds(catalog);
  return installed.filter(
    (m) => m.source === "milady-download" && ids.has(m.id),
  );
}

/** Label for embedding picker rows when catalog may include `embeddingDimensions`. */
export function formatEmbeddingChoiceLabel(
  model: InstalledModel,
  catalog: CatalogModel[],
): string {
  const entry = catalog.find((c) => c.id === model.id);
  const dims = entry?.embeddingDimensions;
  if (typeof dims === "number" && Number.isFinite(dims) && dims > 0) {
    return `${model.displayName} · ${dims} dimensions`;
  }
  return model.displayName;
}

export interface EmbeddingInUseSummary {
  primaryLabel: string;
  detail?: string;
}

/**
 * Best-effort description of which embedding GGUF applies for TEXT_EMBEDDING:
 * explicit pin → hub active model if it is a catalog embedding → single on-disk
 * embedding → otherwise “not pinned” / none.
 */
export function summarizeEmbeddingInUse(args: {
  assignmentId: string;
  catalog: CatalogModel[];
  installedForPicker: InstalledModel[];
  active: ActiveModelState;
}): EmbeddingInUseSummary {
  const { assignmentId, catalog, installedForPicker, active } = args;
  const embIds = embeddingCatalogModelIds(catalog);
  const byId = (id: string) => installedForPicker.find((m) => m.id === id);

  if (assignmentId && embIds.has(assignmentId)) {
    const m = byId(assignmentId);
    if (m) {
      return {
        primaryLabel: formatEmbeddingChoiceLabel(m, catalog),
        detail: "Pinned for TEXT_EMBEDDING",
      };
    }
    return {
      primaryLabel: assignmentId,
      detail: "Pinned id not found on disk — reinstall or pick another model",
    };
  }

  const activeId = active.modelId;
  const st = active.status;
  if (
    activeId &&
    embIds.has(activeId) &&
    (st === "ready" || st === "loading")
  ) {
    const m = byId(activeId);
    if (m) {
      return {
        primaryLabel: formatEmbeddingChoiceLabel(m, catalog),
        detail:
          st === "loading"
            ? "Hub active model (loading)"
            : "Hub active model (no embedding pin)",
      };
    }
  }

  const onDisk = installedMiladyEmbeddingFromCatalog(
    installedForPicker,
    catalog,
  );
  if (onDisk.length === 1) {
    return {
      primaryLabel: formatEmbeddingChoiceLabel(onDisk[0], catalog),
      detail: "Only curated embedding installed",
    };
  }
  if (onDisk.length === 0) {
    return {
      primaryLabel: "No curated embedding GGUF on disk",
      detail: "Download one above to use local embeddings",
    };
  }
  return {
    primaryLabel: "Not pinned",
    detail: `${onDisk.length} curated embeddings on disk — pick one below or activate one in Local models`,
  };
}
