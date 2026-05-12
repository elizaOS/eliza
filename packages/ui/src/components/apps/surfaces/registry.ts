import type { AppOperatorSurfaceComponent } from "./types";

/**
 * Registry of operator surface components keyed by app package name.
 *
 * Apps register their surface on startup via side-effect import. The host
 * app entry imports each game/app UI package which calls
 * `registerOperatorSurface` during module initialization.
 */
const OPERATOR_SURFACE_COMPONENTS = new Map<
  string,
  AppOperatorSurfaceComponent
>();

/**
 * Register an operator surface component for a given app package name.
 * Call this once per app at module load time (e.g. from the app's UI entry).
 *
 * @example
 *   registerOperatorSurface("@elizaos/app-babylon", BabylonOperatorSurface);
 */
export function registerOperatorSurface(
  appName: string,
  component: AppOperatorSurfaceComponent,
): void {
  OPERATOR_SURFACE_COMPONENTS.set(appName, component);
}

export function getAppOperatorSurface(
  appName: string | null | undefined,
): AppOperatorSurfaceComponent | null {
  if (!appName) return null;
  return OPERATOR_SURFACE_COMPONENTS.get(appName) ?? null;
}
