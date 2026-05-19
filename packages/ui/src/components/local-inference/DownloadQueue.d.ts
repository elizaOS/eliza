import type { CatalogModel, DownloadJob } from "../../api/client-local-inference";
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
export declare function DownloadQueue({ downloads, catalog, onCancel, }: DownloadQueueProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=DownloadQueue.d.ts.map