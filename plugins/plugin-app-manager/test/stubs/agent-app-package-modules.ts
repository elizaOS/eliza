/** Test stub for `@elizaos/agent/services/app-package-modules`: app route modules and workspace dirs always resolve to null. */
import type { AppPackageRouteContext } from "@elizaos/core";

export type AppRouteModule = {
  handleAppRoutes?: (ctx: AppPackageRouteContext) => Promise<boolean>;
  [key: string]: unknown;
};

export async function importAppRouteModule(): Promise<AppRouteModule | null> {
  return null;
}

export async function resolveWorkspacePackageDir(): Promise<string | null> {
  return null;
}
