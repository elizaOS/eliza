export declare function formatDashboardRouteErrorMessage(
  error: Error | string | null | undefined,
): string;
/**
 * Dashboard route error fallback. Used with a React error boundary around
 * dashboard routes when not using a data router.
 */
export declare function DashboardRouteError({
  message,
}: {
  message: string;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=dashboard-route-error.d.ts.map
