/**
 * Non-component helper for the dashboard route error surface. Kept out of
 * dashboard-route-error.tsx so that file exports only the React component and
 * stays React Fast Refresh-compatible.
 */

export function formatDashboardRouteErrorMessage(
  error: Error | string | null | undefined,
): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "An unexpected error occurred while loading this page.";
}
