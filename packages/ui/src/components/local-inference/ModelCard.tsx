import { Button } from "@elizaos/ui";
import type {
  ActiveModelState,
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
} from "../../api/client-local-inference";
import { DownloadProgress } from "./DownloadProgress";
import {
  computeFit,
  type FitLevel,
  findDownload,
  findInstalled,
  fitLabel,
  formatBytes,
} from "./hub-utils";

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
  busy,
}: ModelCardProps) {
  const fit = computeFit(model, hardware);
  const installedEntry = findInstalled(model, installed);
  const download = findDownload(model.id, downloads);
  const downloading =
    download?.state === "downloading" || download?.state === "queued";
  const failed = download?.state === "failed";
  const isActive = active.modelId === model.id && active.status !== "error";
  const activating = active.modelId === model.id && active.status === "loading";

  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold truncate">{model.displayName}</div>
          <div className="text-xs text-muted-foreground truncate">
            {model.params} · {model.quant} · {model.sizeGb.toFixed(1)} GB
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
          Installed · {formatBytes(installedEntry.sizeBytes)}
          {installedEntry.source === "external-scan" &&
            installedEntry.externalOrigin &&
            ` · via ${installedEntry.externalOrigin}`}
        </div>
      )}

      {download && downloading && <DownloadProgress job={download} />}
      {failed && download?.error && (
        <div className="text-xs text-rose-500">
          Download failed: {download.error}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {!installedEntry && !downloading && (
          <Button
            size="sm"
            onClick={() => onDownload(model.id)}
            disabled={busy || fit === "wontfit"}
          >
            Download
          </Button>
        )}
        {downloading && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onCancel(model.id)}
            disabled={busy}
          >
            Cancel
          </Button>
        )}
        {installedEntry && !isActive && (
          <Button
            size="sm"
            onClick={() => onActivate(model.id)}
            disabled={busy || activating}
          >
            {activating ? "Activating…" : "Make active"}
          </Button>
        )}
        {isActive && (
          <Button size="sm" variant="outline" disabled>
            Active
          </Button>
        )}
        {installedEntry && onVerify && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onVerify(installedEntry.id)}
            disabled={busy}
          >
            Verify
          </Button>
        )}
        {installedEntry?.source === "eliza-download" && onRedownload && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onRedownload(model.id)}
            disabled={busy}
          >
            Redownload
          </Button>
        )}
        {installedEntry?.source === "eliza-download" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onUninstall(model.id)}
            disabled={busy}
          >
            Uninstall
          </Button>
        )}
      </div>
    </div>
  );
}
