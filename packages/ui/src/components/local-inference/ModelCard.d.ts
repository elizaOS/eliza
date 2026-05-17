import type { ActiveModelState, CatalogModel, DownloadJob, HardwareProbe, InstalledModel } from "../../api/client-local-inference";
interface ModelCardProps {
    model: CatalogModel;
    hardware: HardwareProbe;
    installed: InstalledModel[];
    downloads: DownloadJob[];
    active: ActiveModelState;
    onDownload: (modelId: string) => void;
    onCancel: (modelId: string) => void;
    onActivate: (modelId: string) => void;
    onUninstall: (modelId: string) => void;
    /** When present, a "Verify" button appears on installed models. */
    onVerify?: (modelId: string) => void;
    /** When present, a "Redownload" button appears on installed models. */
    onRedownload?: (modelId: string) => void;
    downloadDisabledReason?: string;
    busy: boolean;
}
export declare function ModelCard({ model, hardware, installed, downloads, active, onDownload, onCancel, onActivate, onUninstall, onVerify, onRedownload, downloadDisabledReason, busy, }: ModelCardProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=ModelCard.d.ts.map