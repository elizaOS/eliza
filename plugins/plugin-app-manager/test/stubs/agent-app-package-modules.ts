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
