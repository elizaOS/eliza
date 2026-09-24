/** Declares renderer freshness and test-auth checks for default or explicit build output directories. */
export function rendererDistMatchesPlaywrightTestAuth(
  appDir: string,
  expectedPlaywrightTestAuth: boolean,
  distDir?: string,
): boolean;

export function resolvePlaywrightTestAuth(appDir: string): boolean;

export function viteRendererBuildNeeded(
  appDir: string,
  repoRoot: string,
  options?: { expectedPlaywrightTestAuth?: boolean; distDir?: string },
): boolean;
