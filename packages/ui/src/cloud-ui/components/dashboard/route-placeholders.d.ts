/**
 * Shared placeholders + skeletons used across dashboard routes (SPA).
 */
/**
 * Generic dashboard page skeleton. Matches the rough silhouette of most
 * dashboard pages (page header + a row of stat cards + a list/table) so the
 * Suspense fallback during route-chunk loads doesn't visually flash.
 */
export declare function DashboardLoadingState({ label }: {
    label?: string;
}): import("react/jsx-runtime").JSX.Element;
export declare function DashboardEndpointPending({ endpoint, what, }: {
    endpoint: string;
    what: string;
}): import("react/jsx-runtime").JSX.Element;
export declare function DashboardErrorState({ message }: {
    message: string;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=route-placeholders.d.ts.map