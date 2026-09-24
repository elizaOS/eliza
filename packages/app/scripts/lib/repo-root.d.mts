/**
 * Hand-maintained declarations for repo-root.mjs so TypeScript consumers
 * (e.g. packages/scripts/vitest/repo-root.ts) resolve real types instead of
 * implicit any. Keep in sync with the .mjs exports.
 */
export declare function resolveRepoRoot(startDir?: string): string;
export declare function resolveRepoRootFromCwd(options?: {
  cwd?: string;
}): string;
export declare function resolveRepoRootFromImportMeta(
  importMetaUrl: string,
  options?: { fallbackToCwd?: boolean; cwd?: string },
): string;
export declare function resolveElizaWorkspaceRoot(startDir?: string): string;
export declare function resolveElizaWorkspaceRootFromImportMeta(
  importMetaUrl: string,
  options?: { fallbackToCwd?: boolean; cwd?: string },
): string;
