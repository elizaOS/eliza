/**
 * Progress bar for one model-download job: percent, bytes received/total,
 * throughput, and ETA. Shared by the download queue and the per-model cards.
 */

import type { DownloadJob } from "../../api/client-local-inference";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { Progress } from "../ui/progress";
import { formatBytes, formatEta, progressPercent } from "./hub-utils";

interface DownloadProgressProps {
  job: DownloadJob;
}

export function DownloadProgress({ job }: DownloadProgressProps) {
  const { t } = useTranslation();
  const pct = progressPercent(job);
  const eta = formatEta(job.etaMs);
  const speed = job.bytesPerSec > 0 ? `${formatBytes(job.bytesPerSec)}/s` : "";

  return (
    <div className="w-full">
      <Progress
        aria-label={t("downloadprogress.ariaLabel", {
          model: job.modelId,
          defaultValue: "Download progress for {{model}}",
        })}
        value={pct}
      />
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>
          {t("downloadprogress.progress", {
            received: formatBytes(job.received),
            total: formatBytes(job.total),
            pct,
            defaultValue: "{{received}} of {{total}} · {{pct}}%",
          })}
        </span>
        <span>
          {speed}
          {eta
            ? t("downloadprogress.etaLeft", {
                eta,
                defaultValue: " · {{eta}} left",
              })
            : ""}
        </span>
      </div>
    </div>
  );
}
