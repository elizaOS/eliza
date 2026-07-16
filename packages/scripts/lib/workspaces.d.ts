export interface WorkspaceDiscoveryOptions {
  /** Repo root to resolve globs against. Defaults to this repo's root. */
  repoRoot?: string;
  /** Explicit patterns instead of the root package.json workspace set. */
  patterns?: string[];
}

export interface WorkspacePackage {
  /** package.json `name`; undefined for a private, unnamed package. */
  name: string | undefined;
  /** Workspace-relative directory (POSIX-separated). */
  dir: string;
  /** Parsed package.json. */
  packageJson: Record<string, unknown> & { name?: string };
}

export interface Submodule {
  /** Repo-relative submodule path from .gitmodules. */
  path: string;
  /** Remote URL, if declared. */
  url: string | undefined;
  /** Tracked branch, if declared. */
  branch: string | undefined;
  /** True when the submodule working tree is checked out on disk. */
  initialized: boolean;
}

export declare function expandWorkspaceGlobs(
  patterns: string[],
  opts?: WorkspaceDiscoveryOptions,
): string[];

export declare function listWorkspaceDirs(
  opts?: WorkspaceDiscoveryOptions,
): string[];

export declare function listPackages(
  opts?: WorkspaceDiscoveryOptions,
): WorkspacePackage[];

export declare function collectWorkspaceMaps(
  repoRoot: string,
  patterns: string[],
): {
  workspaceDirs: string[];
  nameToDir: Map<string, string>;
  nameToVersion: Map<string, string>;
};

export declare function listSubmodules(
  opts?: WorkspaceDiscoveryOptions,
): Submodule[];
