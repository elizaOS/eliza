/**
 * Resolves package-owned automation metadata for build, test and development
 * runners. Workspace discovery is canonical; Turbo owns install build ordering
 * and freshness, while package metadata selects participating tasks.
 */
import { listPackages, type WorkspaceDiscoveryOptions } from "./workspaces.ts";

/** The `elizaos.scripts` block a package declares to opt into script behaviors. */
export interface ScriptMetadata {
  contentContextEvidence?: { role: "coding-tools" | "sql" };
  /** Leaf package the `build:core` set must build before the test lanes. */
  coreBuild?: true;
  /** `test` script must stay serial even in the parallel PR lane. */
  testSerial?: true;
  /** Named root test lanes this package belongs to (e.g. "server" | "client"). */
  testLanes?: string[];
  /** Documented exceptions to the "tsgo checks, tsc emits" build model. */
  buildModel?: {
    /** Build deliberately keeps a full tsc type-check. */
    doubleCheck?: { reason: string };
    /** typecheck still runs compatibility `tsc6` rather than stable `tsc`. */
    tscTypecheck?: { reason: string };
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
    /** dev-all.ts adds this plugin to the agent's ELIZA_SKIP_PLUGINS. */
    skipInDevAll?: true;
    /** dev-harness.ts builds this package's dist before the watch loop. */
    harnessBuild?: true;
  };
  /** Private package to build on a fresh clone (no other install step emits it). */
  buildOnInstall?: {
    /** Optional distribution-only task, avoiding application asset builds. */
    script?: string;
  };
}

export interface BuildOnInstallPackage {
  dir: string;
  name: string;
  script?: string;
}

/** Additional package test entrypoints selected by the runner and lane audit. */
export const EXTRA_SCRIPT_NAMES = Object.freeze([
  "test:integration",
  "test:e2e",
  "test:playwright",
  "test:ui",
  "test:live",
]);

/** @param {import("./workspaces.ts").WorkspacePackage} pkg */
function scriptsMeta(
  pkg: import("./workspaces.ts").WorkspacePackage,
): ScriptMetadata {
  const elizaos = pkg.packageJson.elizaos;
  if (!elizaos || typeof elizaos !== "object") return {};
  const scripts = (elizaos as Record<string, unknown>).scripts;
  return scripts && typeof scripts === "object"
    ? (scripts as ScriptMetadata)
    : {};
}

/** Named workspace packages, each paired with its resolved `elizaos.scripts`. */
function packagesWithScriptMeta(opts?: WorkspaceDiscoveryOptions) {
  return listPackages(opts)
    .filter(
      (pkg): pkg is typeof pkg & { name: string } =>
        typeof pkg.name === "string",
    )
    .map((pkg) => ({ ...pkg, scripts: scriptsMeta(pkg) }));
}

/**
 * Package names (`@elizaos/…`) that opt into `build:core`, sorted. Replaces the
 * hardcoded CORE_BUILD_PACKAGES list.
 */
export function resolveCoreBuildPackages(opts?: WorkspaceDiscoveryOptions) {
  return packagesWithScriptMeta(opts)
    .filter((pkg) => pkg.scripts.coreBuild === true)
    .map((pkg) => pkg.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Package names whose `test` script must stay serial, as a Set. Replaces the
 * hardcoded SERIALIZE_PACKAGES set consumed by the test task pool.
 */
export function resolveTestSerialPackages(opts?: WorkspaceDiscoveryOptions) {
  return new Set(
    packagesWithScriptMeta(opts)
      .filter((pkg) => pkg.scripts.testSerial === true)
      .map((pkg) => pkg.name),
  );
}

/**
 * Workspace-relative dirs belonging to a named test lane, sorted. Empty when the
 * lane is unknown. Callers build the anchored package filter from these dirs.
 */
export function resolveTestLaneDirs(
  lane: string,
  opts?: WorkspaceDiscoveryOptions,
) {
  return packagesWithScriptMeta(opts)
    .filter(
      (pkg) =>
        Array.isArray(pkg.scripts.testLanes) &&
        pkg.scripts.testLanes.includes(lane),
    )
    .map((pkg) => pkg.dir)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Raw `elizaos.scripts.testLanes` declarations, keyed by workspace-relative
 * dir, for every package that declares the key at all — present regardless of
 * whether the value is a well-formed lane array. `resolveTestLaneDirs` silently
 * drops a malformed or unrecognized declaration (`Array.isArray` + `includes`),
 * which is correct for resolving one lane's membership but hides the mistake
 * from a completeness auditor. audit-test-lane-membership.ts uses this
 * unfiltered read to tell "not declared" apart from "declared but invalid".
 */
export function resolveTestLaneDeclarations(opts?: WorkspaceDiscoveryOptions) {
  const map = new Map();
  for (const pkg of packagesWithScriptMeta(opts)) {
    if (Object.hasOwn(pkg.scripts, "testLanes")) {
      map.set(pkg.dir, pkg.scripts.testLanes);
    }
  }
  return map;
}

/**
 * The `buildModel` exception maps (audit-build-typecheck.ts) as package name
 * to package-owned reason, plus validation errors for malformed declarations.
 */
export function resolveBuildModelExceptions(opts?: WorkspaceDiscoveryOptions) {
  const pkgs = packagesWithScriptMeta(opts);
  const invalid: string[] = [];
  const collect = (key: "doubleCheck" | "tscTypecheck") => {
    const exceptions = new Map();
    for (const pkg of pkgs) {
      const buildModel = pkg.scripts.buildModel;
      if (!buildModel || typeof buildModel !== "object") continue;
      const declaration = buildModel[key];
      if (declaration === undefined) continue;
      const reason =
        declaration &&
        typeof declaration === "object" &&
        typeof declaration.reason === "string"
          ? declaration.reason.trim()
          : "";
      if (!reason) {
        invalid.push(
          `${pkg.name}: buildModel.${key} must be an object with a non-empty reason`,
        );
        continue;
      }
      exceptions.set(pkg.name, reason);
    }
    return exceptions;
  };
  return {
    doubleCheck: collect("doubleCheck"),
    tscTypecheck: collect("tscTypecheck"),
    invalid,
  };
}

/**
 * Package names whose turbo `#build` may enumerate non-imported build deps, as a
 * Set. Replaces audit-turbo-build-deps.ts ALLOW_OWNERS.
 */
export function resolveTurboNonImportedBuildDepOwners(
  opts?: WorkspaceDiscoveryOptions,
) {
  return new Set(
    packagesWithScriptMeta(opts)
      .filter((pkg) => pkg.scripts.turboNonImportedBuildDeps === true)
      .map((pkg) => pkg.name),
  );
}

/**
 * Map of `@elizaos/…` package name → npm dist-tag to fall back to when its
 * workspace: version cannot be resolved. Replaces the
 * OPTIONAL_PLUGIN_FALLBACK_VERSIONS map in prepare-package-dist.ts.
 */
export function resolveRegistryFallbackTags(opts?: WorkspaceDiscoveryOptions) {
  const map = new Map();
  for (const pkg of packagesWithScriptMeta(opts)) {
    const tag = pkg.scripts.publish?.registryFallbackTag;
    if (typeof tag === "string" && tag.length > 0) map.set(pkg.name, tag);
  }
  return map;
}

/** Package names dev-all.ts adds to the agent's ELIZA_SKIP_PLUGINS, sorted. */
export function resolveDevAllSkipPlugins(opts?: WorkspaceDiscoveryOptions) {
  return packagesWithScriptMeta(opts)
    .filter((pkg) => pkg.scripts.devStack?.skipInDevAll === true)
    .map((pkg) => pkg.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Workspace-relative dirs dev-harness.ts builds before the watch loop, sorted. */
export function resolveDevHarnessBuildDirs(opts?: WorkspaceDiscoveryOptions) {
  return packagesWithScriptMeta(opts)
    .filter((pkg) => pkg.scripts.devStack?.harnessBuild === true)
    .map((pkg) => pkg.dir)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Selects install-required build tasks; Turbo orders their dependencies and
 * restores or refreshes outputs from content hashes.
 */
export function resolveBuildOnInstallPackages(
  opts?: WorkspaceDiscoveryOptions,
) {
  return packagesWithScriptMeta(opts)
    .flatMap((pkg): BuildOnInstallPackage[] => {
      const install = pkg.scripts.buildOnInstall;
      if (!install || typeof install !== "object") {
        return [];
      }
      const script = install.script;
      return [
        {
          dir: pkg.dir,
          name: pkg.name,
          ...(typeof script === "string" && script.length > 0
            ? { script }
            : {}),
        },
      ];
    })
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

export function resolveContentContextEvidencePackages(
  opts?: WorkspaceDiscoveryOptions,
) {
  const packages = new Map();
  const invalid = [];
  for (const pkg of packagesWithScriptMeta(opts)) {
    const declaration = pkg.scripts.contentContextEvidence;
    if (declaration === undefined) continue;
    const role =
      declaration && typeof declaration === "object"
        ? declaration.role
        : undefined;
    if (role !== "coding-tools" && role !== "sql") {
      invalid.push(
        `${pkg.name}: contentContextEvidence.role must be coding-tools or sql`,
      );
      continue;
    }
    if (packages.has(role)) {
      invalid.push(
        `${pkg.name}: duplicate contentContextEvidence role ${role}`,
      );
      continue;
    }
    packages.set(role, pkg);
  }
  return { packages, invalid };
}
