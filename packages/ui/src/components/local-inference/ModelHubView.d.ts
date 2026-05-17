import type { ActiveModelState, CatalogModel, DownloadJob, HardwareProbe, InstalledModel } from "../../api/client-local-inference";
interface ModelHubViewProps {
    catalog: CatalogModel[];
    installed: InstalledModel[];
    downloads: DownloadJob[];
    active: ActiveModelState;
    hardware: HardwareProbe;
    onDownload: (modelId: string) => void;
    onCancel: (modelId: string) => void;
    onActivate: (modelId: string) => void;
    onUninstall: (modelId: string) => void;
    onVerify?: (modelId: string) => void;
    onRedownload?: (modelId: string) => void;
    busy: boolean;
}
export declare function ModelHubView({ catalog, installed, downloads, active, hardware, onDownload, onCancel, onActivate, onUninstall, onVerify, onRedownload, busy, }: ModelHubViewProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=ModelHubView.d.ts.map