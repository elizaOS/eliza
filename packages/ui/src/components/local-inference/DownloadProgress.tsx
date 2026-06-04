import type { DownloadJob } from "../../api/client-local-inference";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { formatByteSize } from "../../utils/format";
import { formatEta, progressPercent } from "./hub-utils";

const formatBytes = (bytes: number): string =>
  formatByteSize(bytes, { unknownLabel: "—" });

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
      <div
        className="h-2 w-full overflow-hidden rounded-sm bg-muted"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full bg-primary transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
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
