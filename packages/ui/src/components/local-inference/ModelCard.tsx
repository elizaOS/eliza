/**
 * Full-detail card for one catalog model: fit-for-hardware badge, runtime class,
 * size/quant metadata, and the download / activate / verify / uninstall
 * actions. The compact row variant used by the hub grid lives in ModelHubView.
 */

import type {
  ActiveModelState,
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
} from "../../api/client-local-inference";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { Button } from "../ui/button";
import { DownloadProgress } from "./DownloadProgress";
import {
  computeFit,
  displayModelName,
  type FitLevel,
  findDownload,
  findInstalled,
  fitLabel,
  formatBytes,
} from "./hub-utils";
import {
  catalogRuntimeClass,
  runtimeClassDescription,
} from "./runtime-class-ui";

interface ModelCardProps {
  model: CatalogModel;
  hardware: HardwareProbe;
  installed: InstalledModel[];
  downloads: DownloadJob[];
  active: ActiveModelState;
  onDownload: (modelId: string) => void;
  onCancel: (modelId: string) => void;
  onActivate: (modelId: string) => void;
  onUninstall: (modelId: string) => void;
  /** When present, a "Verify" button appears on installed models. */
  onVerify?: (modelId: string) => void;
  /** When present, a "Redownload" button appears on installed models. */
  onRedownload?: (modelId: string) => void;
  downloadDisabledReason?: string;
  busy: boolean;
}

const FIT_STYLES: Record<FitLevel, string> = {
  fits: "text-emerald-500 border-emerald-500/40 bg-emerald-500/10",
  tight: "text-amber-500 border-amber-500/40 bg-amber-500/10",
  wontfit: "text-rose-500 border-rose-500/40 bg-rose-500/10",
};

export function ModelCard({
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
  downloadDisabledReason,
  busy,
}: ModelCardProps) {
  const { t } = useTranslation();
  const fit = computeFit(model, hardware);
  const installedEntry = findInstalled(model, installed);
  const download = findDownload(model.id, downloads);
  const downloading =
    download?.state === "downloading" || download?.state === "queued";
  const failed = download?.state === "failed";
  const isActive = active.modelId === model.id && active.status !== "error";
  const activating = active.modelId === model.id && active.status === "loading";
  const parameterLabel = model.parameterLabel ?? model.params;

  return (
    <div className="rounded-sm border border-border bg-card p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold truncate">
            {displayModelName(model)}
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {parameterLabel} · {model.quant} · {model.sizeGb.toFixed(1)} GB
          </div>
          <div
            className="mt-1 inline-flex w-fit rounded-full border border-border/60 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
            title={runtimeClassDescription(catalogRuntimeClass(model))}
          >
            {runtimeClassDescription(catalogRuntimeClass(model))}
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${FIT_STYLES[fit]}`}
        >
          {fitLabel(fit)}
        </span>
      </div>

      <p className="text-sm text-muted-foreground line-clamp-2">
        {model.blurb}
      </p>

      {installedEntry && (
        <div className="text-xs text-muted-foreground">
          {t("modelcard.installed", {
            size: formatBytes(installedEntry.sizeBytes),
            defaultValue: "Installed · {{size}}",
          })}
          {installedEntry.source === "external-scan" &&
            installedEntry.externalOrigin &&
            t("modelcard.viaOrigin", {
              origin: installedEntry.externalOrigin,
              defaultValue: " · via {{origin}}",
            })}
        </div>
      )}

      {download && downloading && <DownloadProgress job={download} />}
      {failed && download?.error && (
        <div className="text-xs text-rose-500">
          {t("modelcard.downloadFailed", {
            error: download.error,
            defaultValue: "Download failed: {{error}}",
          })}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {!installedEntry && !downloading && (
          <Button
            size="sm"
            onClick={() => onDownload(model.id)}
            disabled={busy || fit === "wontfit" || !!downloadDisabledReason}
            title={downloadDisabledReason}
          >
            {downloadDisabledReason
              ? t("modelcard.downloadUnavailable", {
                  defaultValue: "Download unavailable",
                })
              : failed
                ? t("modelcard.retry", { defaultValue: "Retry" })
                : t("modelcard.download", { defaultValue: "Download" })}
          </Button>
        )}
        {downloading && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onCancel(model.id)}
            disabled={busy}
          >
            {t("modelcard.cancel", { defaultValue: "Cancel" })}
          </Button>
        )}
        {installedEntry && !isActive && (
          <Button
            size="sm"
            onClick={() => onActivate(model.id)}
            disabled={busy || activating}
          >
            {activating
              ? t("modelcard.activating", { defaultValue: "Activating…" })
              : t("modelcard.makeActive", { defaultValue: "Make active" })}
          </Button>
        )}
        {isActive && (
          <Button size="sm" variant="outline" disabled>
            {t("modelcard.active", { defaultValue: "Active" })}
          </Button>
        )}
        {installedEntry && onVerify && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onVerify(installedEntry.id)}
            disabled={busy}
          >
            {t("modelcard.verify", { defaultValue: "Verify" })}
          </Button>
        )}
        {installedEntry?.source === "eliza-download" && onRedownload && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onRedownload(model.id)}
            disabled={busy}
          >
            {t("modelcard.redownload", { defaultValue: "Redownload" })}
          </Button>
        )}
        {installedEntry?.source === "eliza-download" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onUninstall(model.id)}
            disabled={busy}
          >
            {t("modelcard.uninstall", { defaultValue: "Uninstall" })}
          </Button>
        )}
      </div>
    </div>
  );
}
