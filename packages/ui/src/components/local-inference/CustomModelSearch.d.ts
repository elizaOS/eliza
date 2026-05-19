import type { ActiveModelState, CatalogModel, DownloadJob, HardwareProbe, InstalledModel } from "../../api/client-local-inference";
interface CustomModelSearchProps {
    installed: InstalledModel[];
    downloads: DownloadJob[];
    active: ActiveModelState;
    hardware: HardwareProbe;
    onDownload: (spec: CatalogModel) => void;
    onCancel: (modelId: string) => void;
    onActivate: (modelId: string) => void;
    onUninstall: (modelId: string) => void;
    busy: boolean;
}
/**
 * Explicit custom search tab. Curated defaults stay Eliza-1 only; anything
 * from a third-party hub must be searched for here and selected manually.
 */
export declare function CustomModelSearch({ installed, downloads, active, hardware, onDownload, onCancel, onActivate, onUninstall, busy, }: CustomModelSearchProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=CustomModelSearch.d.ts.map