import { useMemo } from "react";
import type {
  ActiveModelState,
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
  ModelBucket,
} from "../../api/client-local-inference";
import { ModelCard } from "./ModelCard";
import { bucketLabel, groupByBucket } from "./hub-utils";

interface ModelHubViewProps {
  catalog: CatalogModel[];
  installed: InstalledModel[];
  downloads: DownloadJob[];
  active: ActiveModelState;
  hardware: HardwareProbe;
  onDownload: (modelId: string) => void;
  onCancel: (modelId: string) => void;
  onActivate: (modelId: string) => void;
  onUninstall: (modelId: string) => void;
  busy: boolean;
}

const BUCKET_ORDER: ModelBucket[] = ["small", "mid", "large", "xl"];

/**
 * Curated Milady Model Hub — groups the hand-picked catalog by preset
 * bucket so a user's recommended tier sits at the natural starting point.
 * A separate HF-search view is mounted as a sibling; the two share the
 * same ModelCard.
 */
export function ModelHubView({
  catalog,
  installed,
  downloads,
  active,
  hardware,
  onDownload,
  onCancel,
  onActivate,
  onUninstall,
  busy,
}: ModelHubViewProps) {
  const grouped = useMemo(() => groupByBucket(catalog), [catalog]);

  return (
    <div className="flex flex-col gap-6">
      {BUCKET_ORDER.map((bucket) => {
        const models = grouped.get(bucket) ?? [];
        if (models.length === 0) return null;
        const isRecommended = hardware.recommendedBucket === bucket;
        return (
          <section key={bucket} className="flex flex-col gap-3">
            <header className="flex items-center gap-3">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {bucketLabel(bucket)}
              </h3>
              {isRecommended && (
                <span className="rounded-full border border-primary/50 bg-primary/10 px-2 py-0.5 text-xs text-primary">
                  Recommended for your device
                </span>
              )}
            </header>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {models.map((model) => (
                <ModelCard
                  key={model.id}
                  model={model}
                  hardware={hardware}
                  installed={installed}
                  downloads={downloads}
                  active={active}
                  onDownload={onDownload}
                  onCancel={onCancel}
                  onActivate={onActivate}
                  onUninstall={onUninstall}
                  busy={busy}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
