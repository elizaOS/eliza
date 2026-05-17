import { type RegistryAppInfo } from "../../api";

interface LoadMergedCatalogAppsOptions {
  includeHiddenApps?: boolean;
}
export declare function loadMergedCatalogApps({
  includeHiddenApps,
}?: LoadMergedCatalogAppsOptions): Promise<RegistryAppInfo[]>;
//# sourceMappingURL=catalog-loader.d.ts.map
