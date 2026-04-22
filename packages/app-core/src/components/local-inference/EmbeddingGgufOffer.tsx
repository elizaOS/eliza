import { Button } from "@elizaos/ui";
import { useMemo } from "react";
import type {
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
} from "../../api/client-local-inference";
import { DownloadQueue } from "./DownloadQueue";
import { findInstalled, pickRecommendedEmbedding } from "./hub-utils";
import { InferenceHelpHint } from "./InferenceHelpHint";

interface EmbeddingGgufOfferProps {
  catalog: CatalogModel[];
  installed: InstalledModel[];
  hardware: HardwareProbe;
  downloads: DownloadJob[];
  onDownload: (modelId: string) => void;
  onCancel: (modelId: string) => void;
  busy: boolean;
}

/**
 * Cloud + local embedding: nudge a small curated embedding GGUF (same spirit
 * as `FirstRunOffer` for chat) and surface in-flight embedding downloads.
 */
export function EmbeddingGgufOffer({
  catalog,
  installed,
  hardware,
  downloads,
  onDownload,
  onCancel,
  busy,
}: EmbeddingGgufOfferProps) {
  const embeddingIds = useMemo(
    () =>
      new Set(
        catalog.filter((m) => m.category === "embedding").map((m) => m.id),
      ),
    [catalog],
  );

  const embeddingDownloads = useMemo(
    () => downloads.filter((d) => embeddingIds.has(d.modelId)),
    [downloads, embeddingIds],
  );

  const recommended = useMemo(
    () => pickRecommendedEmbedding(catalog, installed, hardware),
    [catalog, installed, hardware],
  );

  const recommendedInstalled = recommended
    ? Boolean(findInstalled(recommended, installed))
    : true;

  const queue =
    embeddingDownloads.length > 0 ? (
      <DownloadQueue
        downloads={embeddingDownloads}
        catalog={catalog}
        onCancel={onCancel}
      />
    ) : null;

  if (recommendedInstalled || !recommended) {
    return queue;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-primary/40 bg-primary/10 p-4 flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-primary/90">
            {"Add a local embedding model"}
            <InferenceHelpHint aria-label="Recommended embedding model">
              <p>
                Milady picks a small curated embedding GGUF that fits your
                hardware and the{" "}
                <span className="font-mono text-[11px]">TEXT_EMBEDDING</span>{" "}
                slot. Downloading it enables local vectors while chat stays on
                your remote provider.
              </p>
            </InferenceHelpHint>
          </div>
          <div className="text-sm font-medium">
            <span>{recommended.displayName}</span>
            {typeof recommended.embeddingDimensions === "number" &&
              recommended.embeddingDimensions > 0 && (
                <span className="font-normal text-muted-foreground">
                  {" "}
                  ({recommended.embeddingDimensions} dimensions)
                </span>
              )}
          </div>
          <div className="text-xs text-muted-foreground">
            Fits Milady-local{" "}
            <span className="font-mono text-[11px]">TEXT_EMBEDDING</span>
          </div>
          <p className="text-sm text-muted-foreground">
            {recommended.blurb} · ~{Math.round(recommended.sizeGb * 1024)} MB
            download
          </p>
        </div>
        <Button
          size="sm"
          className="shrink-0"
          onClick={() => onDownload(recommended.id)}
          disabled={busy}
        >
          {"Download for embeddings"}
        </Button>
      </div>
      {queue}
    </div>
  );
}
