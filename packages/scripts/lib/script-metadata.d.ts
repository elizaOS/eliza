import type { WorkspaceDiscoveryOptions } from "./workspaces.d.ts";

/** The `elizaos.scripts` block a package declares to opt into script behaviors. */
export interface ScriptMetadata {
  /** Leaf package the `build:core` set must build before the test lanes. */
  coreBuild?: true;
  /** `test` script must stay serial even in the parallel PR lane. */
  testSerial?: true;
  /** Named root test lanes this package belongs to (e.g. "server" | "client"). */
  testLanes?: string[];
  /** Documented exceptions to the "tsgo checks, tsc emits" build model. */
  buildModel?: {
    /** Build deliberately keeps a full tsc type-check. */
    doubleCheck?: true;
    /** typecheck still runs `tsc` rather than `tsgo` (migration pending). */
    tscTypecheck?: true;
  };
  /** turbo `#build` override enumerates build deps a source scan cannot see. */
  turboNonImportedBuildDeps?: true;
  /** Publish-time behavior. */
  publish?: {
    /** npm dist-tag to fall back to when the workspace: version is unresolved. */
    registryFallbackTag?: string;
  };
  /** Dev-stack membership. */
  devStack?: {
    /** dev-all.mjs adds this plugin to the agent's ELIZA_SKIP_PLUGINS. */
    skipInDevAll?: true;
    /** dev-harness.mjs builds this package's dist before the watch loop. */
    harnessBuild?: true;
  };
  /** Private package to build on a fresh clone (no other install step emits it). */
  buildOnInstall?: {
    /** dist file whose presence proves the package is already built. */
    sentinel: string;
    /** Ascending build order — deps before dependents. */
    order: number;
  };
}

export interface BuildOnInstallPackage {
  dir: string;
  name: string;
  sentinel: string;
  order: number;
}

export declare function resolveCoreBuildPackages(
  opts?: WorkspaceDiscoveryOptions,
): string[];

export declare function resolveTestSerialPackages(
  opts?: WorkspaceDiscoveryOptions,
): Set<string>;

export declare function resolveTestLaneDirs(
  lane: string,
  opts?: WorkspaceDiscoveryOptions,
): string[];

export declare function resolveBuildModelExceptions(
  opts?: WorkspaceDiscoveryOptions,
): { doubleCheck: Set<string>; tscTypecheck: Set<string> };

export declare function resolveTurboNonImportedBuildDepOwners(
  opts?: WorkspaceDiscoveryOptions,
): Set<string>;

export declare function resolveRegistryFallbackTags(
  opts?: WorkspaceDiscoveryOptions,
): Map<string, string>;

export declare function resolveDevAllSkipPlugins(
  opts?: WorkspaceDiscoveryOptions,
): string[];

export declare function resolveDevHarnessBuildDirs(
  opts?: WorkspaceDiscoveryOptions,
): string[];

export declare function resolveBuildOnInstallPackages(
  opts?: WorkspaceDiscoveryOptions,
): BuildOnInstallPackage[];
