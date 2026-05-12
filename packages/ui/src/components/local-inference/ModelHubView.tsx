import { Button } from "../ui/button";
import { CheckCircle2 } from "lucide-react";
import { useMemo } from "react";
import type {
  ActiveModelState,
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
  ModelBucket,
} from "../../api/client-local-inference";
import { DownloadProgress } from "./DownloadProgress";
import {
  bucketLabel,
  computeFit,
  displayModelName,
  type FitLevel,
  findDownload,
  findInstalled,
  fitLabel,
  formatBytes,
  groupByBucket,
} from "./hub-utils";

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
  onVerify?: (modelId: string) => void;
  onRedownload?: (modelId: string) => void;
  busy: boolean;
}

const BUCKET_ORDER: ModelBucket[] = ["small", "mid", "large", "xl"];

const FIT_STYLES: Record<FitLevel, string> = {
  fits: "text-ok",
  tight: "text-warn",
  wontfit: "text-danger",
};

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
  onVerify,
  onRedownload,
  busy,
}: ModelHubViewProps) {
  const grouped = useMemo(() => groupByBucket(catalog), [catalog]);

  return (
    <div className="flex flex-col gap-4">
      {BUCKET_ORDER.map((bucket) => {
        const models = grouped.get(bucket) ?? [];
        if (models.length === 0) return null;
        const isRecommended = hardware.recommendedBucket === bucket;
        return (
          <section key={bucket} className="flex flex-col gap-2">
            <header className="flex h-6 items-center gap-2">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                {bucketLabel(bucket)}
              </h3>
              {isRecommended && (
                <span className="rounded-full border border-primary/45 bg-primary/10 px-1.5 py-0.5 text-[10px] leading-none text-primary">
                  Recommended
                </span>
              )}
            </header>
            <div className="overflow-hidden rounded-lg border border-border/50 bg-card/35">
              {models.map((model) => (
                <ModelListRow
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
                  onVerify={onVerify}
                  onRedownload={onRedownload}
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

type ModelListRowProps = Omit<ModelHubViewProps, "catalog"> & {
  model: CatalogModel;
};

function ModelListRow({
  model,
  hardware,
  installed,
  downloads,
  active,
  onDownload,
  onCancel,
  onActivate,
  onUninstall,
  onVerify,
  onRedownload,
  busy,
}: ModelListRowProps) {
  const fit = computeFit(model, hardware);
  const installedEntry = findInstalled(model, installed);
  const download = findDownload(model.id, downloads);
  const downloading =
    download?.state === "downloading" || download?.state === "queued";
  const failed = download?.state === "failed";
  const isActive = active.modelId === model.id && active.status !== "error";
  const activating = active.modelId === model.id && active.status === "loading";
  const modelMeta = [
    model.params,
    model.quant,
    `${model.sizeGb.toFixed(1)} GB`,
  ];

  return (
    <div
      className="border-border/40 border-b px-2.5 py-2 last:border-b-0"
      title={model.blurb}
    >
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            {isActive ? (
              <span
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-accent"
                title="Active"
                role="img"
                aria-label="Active model"
              >
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
              </span>
            ) : null}
            <div className="min-w-0 flex-1 truncate font-semibold text-sm text-txt">
              {displayModelName(model)}
            </div>
            <span
              className={`inline-flex h-5 w-5 shrink-0 items-center justify-center ${FIT_STYLES[fit]}`}
              title={fitLabel(fit)}
              role="img"
              aria-label={`Fit: ${fitLabel(fit)}`}
            >
              <span className="h-2 w-2 rounded-full bg-current" />
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-muted text-xs">
            <span>{modelMeta.join(" · ")}</span>
            {installedEntry ? (
              <span>
                Installed · {formatBytes(installedEntry.sizeBytes)}
                {installedEntry.source === "external-scan" &&
                installedEntry.externalOrigin
                  ? ` · via ${installedEntry.externalOrigin}`
                  : ""}
              </span>
            ) : null}
          </div>
          {download && downloading ? (
            <div className="mt-1.5">
              <DownloadProgress job={download} />
            </div>
          ) : null}
          {failed && download?.error ? (
            <div className="mt-1 text-danger text-xs">
              Download failed: {download.error}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 md:justify-end">
          {!installedEntry && !downloading ? (
            <Button
              size="sm"
              className="h-7 rounded-md px-2 text-xs"
              onClick={() => onDownload(model.id)}
              disabled={busy || fit === "wontfit"}
            >
              Download
            </Button>
          ) : null}
          {downloading ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 rounded-md px-2 text-xs"
              onClick={() => onCancel(model.id)}
              disabled={busy}
            >
              Cancel
            </Button>
          ) : null}
          {installedEntry && !isActive ? (
            <Button
              size="sm"
              className="h-7 rounded-md px-2 text-xs"
              onClick={() => onActivate(model.id)}
              disabled={busy || activating}
            >
              {activating ? "Activating..." : "Make active"}
            </Button>
          ) : null}
          {installedEntry && onVerify ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 rounded-md px-2 text-xs"
              onClick={() => onVerify(installedEntry.id)}
              disabled={busy}
            >
              Verify
            </Button>
          ) : null}
          {installedEntry?.source === "eliza-download" && onRedownload ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 rounded-md px-2 text-xs"
              onClick={() => onRedownload(model.id)}
              disabled={busy}
            >
              Redownload
            </Button>
          ) : null}
          {installedEntry?.source === "eliza-download" ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 rounded-md px-2 text-xs"
              onClick={() => onUninstall(model.id)}
              disabled={busy}
            >
              Uninstall
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
