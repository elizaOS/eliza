import { Button } from "@elizaos/ui";
import { useState } from "react";
import type {
  CatalogModel,
  HardwareProbe,
  InstalledModel,
} from "../../api/client-local-inference";
import { MODEL_CATALOG } from "../../services/local-inference/catalog";
import { selectRecommendedModels } from "../../services/local-inference/recommendation";
import { displayModelName, findInstalled } from "./hub-utils";

interface FirstRunOfferProps {
  catalog: CatalogModel[];
  installed: InstalledModel[];
  hardware: HardwareProbe;
  onDownload: (modelId: string) => void;
  busy: boolean;
}

const DISMISS_STORAGE_KEY = "eliza.localInference.firstRunOfferDismissed";

export function FirstRunOffer({
  catalog,
  installed,
  hardware,
  onDownload,
  busy,
}: FirstRunOfferProps) {
  const [dismissed, setDismissed] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage?.getItem(DISMISS_STORAGE_KEY) === "1",
  );

  const elizaOwned = installed.filter((m) => m.source === "eliza-download");
  if (elizaOwned.length > 0 || dismissed) return null;

  const recommended = pickRecommended(catalog, installed, hardware);
  if (!recommended) return null;

  const handleDismiss = () => {
    setDismissed(true);
    try {
      window.localStorage?.setItem(DISMISS_STORAGE_KEY, "1");
    } catch {
      // Session-only dismissal is enough when storage is unavailable.
    }
  };

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/45 bg-primary/10 px-2.5 py-2"
      title={recommended.blurb}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="rounded-full border border-primary/40 px-1.5 py-0.5 text-[10px] uppercase leading-none text-primary">
          Recommended
        </span>
        <span className="truncate text-sm font-medium">
          {displayModelName(recommended)}
        </span>
        <span className="text-muted text-xs">
          {recommended.params} · {recommended.sizeGb.toFixed(1)} GB
        </span>
      </div>
      <div className="flex gap-1.5">
        <Button
          size="sm"
          className="h-7 rounded-md px-2 text-xs"
          onClick={() => onDownload(recommended.id)}
          disabled={busy}
        >
          Download {displayModelName(recommended)}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 rounded-md px-2 text-xs"
          onClick={handleDismiss}
        >
          Not now
        </Button>
      </div>
    </div>
  );
}

function pickRecommended(
  catalog: CatalogModel[],
  installed: InstalledModel[],
  hardware: HardwareProbe,
): CatalogModel | null {
  const recommended = selectRecommendedModels(hardware, MODEL_CATALOG);
  for (const candidate of [
    recommended.TEXT_LARGE.model,
    recommended.TEXT_SMALL.model,
  ]) {
    if (!candidate || findInstalled(candidate, installed)) continue;
    return catalog.find((model) => model.id === candidate.id) ?? candidate;
  }
  return null;
}
