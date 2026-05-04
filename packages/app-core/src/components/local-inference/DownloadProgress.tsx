import type { DownloadJob } from "../../api/client-local-inference";
import { formatBytes, formatEta, progressPercent } from "./hub-utils";

interface DownloadProgressProps {
  job: DownloadJob;
}

export function DownloadProgress({ job }: DownloadProgressProps) {
  const pct = progressPercent(job);
  const eta = formatEta(job.etaMs);
  const speed = job.bytesPerSec > 0 ? `${formatBytes(job.bytesPerSec)}/s` : "";

  return (
    <div className="w-full">
      <div
        className="h-2 w-full overflow-hidden rounded bg-muted"
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
          {formatBytes(job.received)} of {formatBytes(job.total)} · {pct}%
        </span>
        <span>
          {speed}
          {eta ? ` · ${eta} left` : ""}
        </span>
      </div>
    </div>
  );
}
