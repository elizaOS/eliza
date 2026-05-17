import type { RegistryAppInfo } from "../../api";
interface AppsCatalogGridProps {
    activeAppNames: Set<string>;
    error: string | null;
    favoriteAppNames: Set<string>;
    loading: boolean;
    searchQuery: string;
    visibleApps: RegistryAppInfo[];
    onLaunch: (app: RegistryAppInfo) => void;
    onRetry?: () => void;
    onToggleFavorite: (appName: string) => void;
}
export declare function AppsCatalogGrid({ activeAppNames, error, favoriteAppNames, loading, searchQuery, visibleApps, onLaunch, onRetry, onToggleFavorite, }: AppsCatalogGridProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=AppsCatalogGrid.d.ts.map