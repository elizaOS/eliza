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

const DISMISS_STORAGE_KEY = "milady.localInference.firstRunOfferDismissed";

/**
 * First-run nudge for local-mode users: when no models are installed, pick
 * the best-matching catalog entry for the user's hardware (recommended
 * bucket + top category) and offer a one-click download. Dismissible per
 * device; won't reappear until the user clears storage.
 */
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

  const miladyOwned = installed.filter((m) => m.source === "milady-download");
  if (miladyOwned.length > 0 || dismissed) return null;

  const catalogForChat = catalog.filter((m) => m.category !== "embedding");
  const recommended = pickRecommended(catalogForChat, installed, hardware);
  if (!recommended) return null;

  const handleDismiss = () => {
    setDismissed(true);
    try {
      window.localStorage?.setItem(DISMISS_STORAGE_KEY, "1");
    } catch {
      // Private mode / quota — dismissing for this session is enough.
    }
  };

  return (
    <div className="rounded-xl border border-primary/50 bg-primary/10 p-4 flex flex-wrap items-start gap-4">
      <div className="flex-1 min-w-0 space-y-1">
        <div className="text-xs uppercase tracking-wide text-primary/80">
          Get started with local inference
        </div>
        <div className="text-sm font-medium">
          {recommended.displayName} looks like a good fit for your device
        </div>
        <p className="text-sm text-muted-foreground">
          {recommended.blurb} · {recommended.sizeGb.toFixed(1)} GB download
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => onDownload(recommended.id)}
          disabled={busy}
        >
          Download {recommended.params}
        </Button>
        <Button size="sm" variant="ghost" onClick={handleDismiss}>
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

  // Nothing suitable in the recommended bucket — step down to "mid", then
  // "small".
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
