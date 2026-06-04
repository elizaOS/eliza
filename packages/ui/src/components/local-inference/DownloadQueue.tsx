import type {
  CatalogModel,
  DownloadJob,
} from "../../api/client-local-inference";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { Button } from "../ui/button";
import { DownloadProgress } from "./DownloadProgress";
import { displayModelName, findCatalogModel } from "./hub-utils";

interface DownloadQueueProps {
  downloads: DownloadJob[];
  catalog: CatalogModel[];
  onCancel: (modelId: string) => void;
}

/**
 * Global view of all in-flight downloads. The SSE stream already removes
 * completed + cancelled jobs from the snapshot, so this list only holds
 * active/queued/failed jobs. Failures stick around until a new download
 * for the same model supersedes them.
 */
export function DownloadQueue({
  downloads,
  catalog,
  onCancel,
}: DownloadQueueProps) {
  const { t } = useTranslation();
  if (downloads.length === 0) {
    return (
      <div className="rounded-sm border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        {t("downloadqueue.empty", {
          defaultValue:
            "No downloads in progress. Start one from Eliza-1 or use explicit custom search.",
        })}
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {downloads.map((job) => {
        const entry = findCatalogModel(job.modelId, catalog);
        const label = entry ? displayModelName(entry) : job.modelId;
        const isActive = job.state === "downloading" || job.state === "queued";
        return (
          <li
            key={job.jobId}
            className="rounded-sm border border-border bg-card p-4 flex flex-col gap-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium truncate">{label}</div>
                <div className="text-xs text-muted-foreground">
                  {job.state === "queued" &&
                    t("downloadqueue.queued", { defaultValue: "Queued" })}
                  {job.state === "downloading" &&
                    t("downloadqueue.downloading", {
                      defaultValue: "Downloading",
                    })}
                  {job.state === "failed" &&
                    t("downloadqueue.failed", { defaultValue: "Failed" })}
                  {job.state === "completed" &&
                    t("downloadqueue.completed", { defaultValue: "Completed" })}
                  {job.state === "cancelled" &&
                    t("downloadqueue.cancelled", { defaultValue: "Cancelled" })}
                </div>
              </div>
              {isActive && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onCancel(job.modelId)}
                >
                  {t("downloadqueue.cancel", { defaultValue: "Cancel" })}
                </Button>
              )}
            </div>

            {(job.state === "downloading" || job.state === "queued") && (
              <DownloadProgress job={job} />
            )}

            {job.state === "failed" && job.error && (
              <div className="text-xs text-rose-500">{job.error}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
