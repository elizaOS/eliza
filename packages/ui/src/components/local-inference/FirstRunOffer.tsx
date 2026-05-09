import { Button } from "@elizaos/ui";
import { useState } from "react";
import type {
  CatalogModel,
  HardwareProbe,
  InstalledModel,
} from "../../api/client-local-inference";
import { findInstalled } from "./hub-utils";

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
          {recommended.displayName}
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
          Download {recommended.params}
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
  const bucket = hardware.recommendedBucket;
  // Prefer a general chat model in the recommended bucket. Fall back to
  // anything in-bucket, then anything smaller.
  const inBucket = catalog.filter((m) => m.bucket === bucket);
  const notInstalled = inBucket.filter((m) => !findInstalled(m, installed));
  const chatFirst = [
    ...notInstalled.filter((m) => m.category === "chat"),
    ...notInstalled.filter((m) => m.category !== "chat"),
  ];
  if (chatFirst[0]) return chatFirst[0];

  const fallbackOrder: Array<typeof bucket> = ["mid", "small"];
  for (const alt of fallbackOrder) {
    if (alt === bucket) continue;
    const candidate = catalog.find(
      (m) =>
        m.bucket === alt &&
        !findInstalled(m, installed) &&
        m.category === "chat",
    );
    if (candidate) return candidate;
  }
  return null;
}
