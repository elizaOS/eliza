import { Button } from "@elizaos/ui";
import type {
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
} from "../../api/client-local-inference";
import { selectRecommendedModels } from "../../services/local-inference/recommendation";
import { displayModelName, findInstalled } from "./hub-utils";

interface FirstRunOfferProps {
  catalog: CatalogModel[];
  installed: InstalledModel[];
  downloads: DownloadJob[];
  hardware: HardwareProbe;
  onDownload: (modelId: string) => void;
  busy: boolean;
}

export function FirstRunOffer({
  catalog,
  installed,
  downloads,
  hardware,
  onDownload,
  busy,
}: FirstRunOfferProps) {
  const elizaOwned = installed.filter((m) => m.source === "eliza-download");
  const activeDownloads = downloads.filter(
    (job) => job.state === "queued" || job.state === "downloading",
  );
  if (elizaOwned.length > 0 && activeDownloads.length === 0) return null;

  const recommended = pickRecommended(catalog, installed, hardware);
  const defaultDownload =
    recommended &&
    activeDownloads.find((job) => job.modelId === recommended.id);
  const anyActiveDownload = activeDownloads[0] ?? null;
  const title =
    elizaOwned.length === 0
      ? "Local model required"
      : "Local model download in progress";
  const detail =
    elizaOwned.length === 0
      ? recommended
        ? `Download the default local model (${displayModelName(recommended)}) to run chat on this device.`
        : "No local chat model is available on this device."
      : anyActiveDownload
        ? `A local model download is still running (${anyActiveDownload.modelId}).`
        : "A local model download is still running.";

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-2"
      role="alert"
      title={recommended?.blurb}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-txt">{title}</div>
        <div className="text-xs text-muted">{detail}</div>
      </div>
      {recommended ? (
        <Button
          size="sm"
          className="h-7 rounded-md px-2 text-xs"
          onClick={() => onDownload(recommended.id)}
          disabled={busy || Boolean(defaultDownload)}
        >
          {defaultDownload
            ? "Downloading default model"
            : "Download default model"}
        </Button>
      ) : null}
    </div>
  );
}

function pickRecommended(
  catalog: CatalogModel[],
  installed: InstalledModel[],
  hardware: HardwareProbe,
): CatalogModel | null {
  const recommended = selectRecommendedModels(hardware, catalog);
  for (const candidate of [
    recommended.TEXT_LARGE.model,
    recommended.TEXT_SMALL.model,
  ]) {
    if (!candidate || findInstalled(candidate, installed)) continue;
    return catalog.find((model) => model.id === candidate.id) ?? candidate;
  }
  return (
    catalog.find(
      (model) =>
        model.id.startsWith("eliza-1-") && !findInstalled(model, installed),
    ) ?? null
  );
}
