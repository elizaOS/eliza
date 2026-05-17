import type {
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
} from "../../api/client-local-inference";

interface FirstRunOfferProps {
  catalog: CatalogModel[];
  installed: InstalledModel[];
  downloads: DownloadJob[];
  hardware: HardwareProbe;
  onDownload: (modelId: string) => void;
  busy: boolean;
}
export declare function FirstRunOffer({
  catalog,
  installed,
  downloads,
  hardware,
  onDownload,
  busy,
}: FirstRunOfferProps): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=FirstRunOffer.d.ts.map
