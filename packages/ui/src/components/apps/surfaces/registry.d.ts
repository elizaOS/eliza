import type { AppOperatorSurfaceComponent } from "./types";
/**
 * Register an operator surface component for a given app package name.
 * Call this once per app at module load time (e.g. from the app's UI entry).
 *
 * @example
 *   registerOperatorSurface("@elizaos/plugin-babylon", BabylonOperatorSurface);
 */
export declare function registerOperatorSurface(
  appName: string,
  component: AppOperatorSurfaceComponent,
): void;
export declare function getAppOperatorSurface(
  appName: string | null | undefined,
): AppOperatorSurfaceComponent | null;
//# sourceMappingURL=registry.d.ts.map
