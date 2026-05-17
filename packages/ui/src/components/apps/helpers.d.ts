import type { RegistryAppInfo } from "../../api";
export declare const DEFAULT_VIEWER_SANDBOX = "allow-scripts allow-same-origin allow-popups";
export declare const CATEGORY_LABELS: Record<string, string>;
export type AppCatalogSectionKey = "featured" | "favorites" | "games" | "developerUtilities" | "finance" | "other";
export declare const APP_CATALOG_SECTION_LABELS: Record<AppCatalogSectionKey, string>;
export declare const APPS_VIEW_HIDDEN_APP_NAMES: readonly ["@elizaos/app", "@elizaos/browser-bridge-extension", "app-counter", "@elizaos/plugin-form", "@elizaos/plugin-documents", "@elizaos/plugin-screenshare", "@elizaos/plugin-task-coordinator", "@elizaos/plugin-wallet-ui"];
export interface AppCatalogSection {
    key: AppCatalogSectionKey;
    label: string;
    apps: RegistryAppInfo[];
}
interface AppsCatalogFilterOptions {
    activeAppNames?: ReadonlySet<string>;
    isProd?: boolean;
    searchQuery?: string;
    showAllApps?: boolean;
    showActiveOnly?: boolean;
    walletEnabled?: boolean;
    /**
     * When false (or omitted), apps marked `developerOnly: true` are hidden.
     * Pass the current value from `useIsDeveloperMode()` to opt in.
     */
    developerMode?: boolean;
}
export declare function isHiddenFromAppsView(appName: string): boolean;
export declare function isCuratedGameApp(app: Pick<RegistryAppInfo, "category" | "name">): boolean;
export declare function shouldShowAppInAppsView(app: Pick<RegistryAppInfo, "category" | "name">, options?: {
    isProd?: boolean;
    showAllApps?: boolean;
    walletEnabled?: boolean;
}): boolean;
export declare function filterAppsForCatalog(apps: RegistryAppInfo[], { activeAppNames, isProd, searchQuery, showAllApps, showActiveOnly, walletEnabled, developerMode, }?: AppsCatalogFilterOptions): RegistryAppInfo[];
export declare function getDefaultAppsCatalogSelection(apps: RegistryAppInfo[], options?: {
    isProd?: boolean;
    showAllApps?: boolean;
    walletEnabled?: boolean;
}): string | null;
export declare function getAppCatalogSectionKey(app: Pick<RegistryAppInfo, "name" | "displayName" | "description" | "category">): AppCatalogSectionKey;
export declare function getAppCatalogSectionLabel(app: Pick<RegistryAppInfo, "name" | "displayName" | "description" | "category">): string;
export declare function groupAppsForCatalog(apps: RegistryAppInfo[], { favoriteAppNames, }?: {
    favoriteAppNames?: ReadonlySet<string>;
}): AppCatalogSection[];
export declare function getAppShortName(app: RegistryAppInfo): string;
export declare function getAppEmoji(app: RegistryAppInfo): string;
export declare function getAppSessionModeLabel(app: Pick<RegistryAppInfo, "session">): string | null;
export declare function getAppSessionFeatureLabels(app: Pick<RegistryAppInfo, "session">): string[];
/**
 * Derive a URL slug from an app's package name.
 *
 * Uses the existing `packageNameToAppRouteSlug` for scoped packages
 * (`@scope/app-foo` → `foo`, `@scope/plugin-bar` → `bar`).
 * Falls back to a sanitised form of the raw name.
 */
export declare function getAppSlug(appName: string): string;
/** Find an app by its URL slug. */
export declare function findAppBySlug(apps: readonly RegistryAppInfo[], slug: string): RegistryAppInfo | undefined;
export {};
//# sourceMappingURL=helpers.d.ts.map