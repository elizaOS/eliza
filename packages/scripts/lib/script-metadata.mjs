/**
 * Per-package script metadata, read through the shared workspace-discovery seam
 * (`lib/workspaces.mjs`, #12332). This is the resolver the generic build/test/
 * dev scripts use instead of naming plugin sets in their own source — a package
 * opts into a script behavior by declaring it under `elizaos.scripts` in its own
 * `package.json`, and adding or removing a package updates the resolved set with
 * zero edits to any script (the property enforced by
 * `__tests__/plugin-discovery-zero-edit.test.ts` and the `audit-scripts.mjs`
 * plugin-coupling gate, #12336).
 *
 * The `elizaos.scripts` fields, canonical here (see script-metadata.d.ts for the
 * typed shape):
 *
 *   coreBuild: true
 *     Leaf package the `build:core` set (build-core-packages.mjs) must build
 *     before the server/client/plugin test lanes run. Turbo's `^build` closure
 *     pulls in transitive deps, so list only directly-imported leaves.
 *
 *   testSerial: true
 *     This package's `test` script must not run concurrently with others even in
 *     the parallel PR lane (shared DB / fixed ports). Consumed by
 *     lib/test-task-pool.mjs.
 *
 *   testLanes: string[]
 *     Named root test lanes (run-all-tests.mjs `--lane <name>`) this package
 *     belongs to, e.g. ["server"] / ["client"]. The lane resolver turns the set
 *     of member dirs into the anchored package filter the lane used to hardcode.
 *
 *   buildModel: { doubleCheck?: true, tscTypecheck?: true }
 *     Documented exceptions to the "tsgo checks, tsc only emits" model
 *     (audit-build-typecheck.mjs). `doubleCheck` = build keeps a full tsc check;
 *     `tscTypecheck` = typecheck still runs `tsc` (tsgo migration pending).
 *
 *   turboNonImportedBuildDeps: true
 *     This package's turbo `#build` override deliberately enumerates build deps a
 *     source scan cannot see (dynamic loaders, bundlers, filesystem-path bundling)
 *     so audit-turbo-build-deps.mjs must not flag them as phantom edges.
 *
 *   publish: { registryFallbackTag: string }
 *     When `ELIZA_SKIP_LOCAL_UPSTREAMS=1` leaves a workspace: dep unresolved,
 *     prepare-package-dist.mjs rewrites it to this npm dist-tag instead of
 *     failing. Only optional/independently-published plugins declare it.
 *
 *   devStack: { skipInDevAll?: true, harnessBuild?: true }
 *     Dev-stack membership. `skipInDevAll` = dev-all.mjs adds this plugin to the
 *     agent's ELIZA_SKIP_PLUGINS. `harnessBuild` = dev-harness.mjs builds this
 *     package's dist before the agent watch loop if it is missing.
 *
 *   buildOnInstall: { sentinel: string, order: number }
 *     Private/internal package whose dist is imported by others but produced by
 *     no install step; build-private-workspace-packages.mjs builds it on a fresh
 *     clone. `sentinel` is the dist file whose presence proves it is already
 *     built; `order` is the ascending build order (deps before dependents).
 */

import { listPackages } from "./workspaces.mjs";

/** @param {import("./workspaces.d.ts").WorkspacePackage} pkg */
function scriptsMeta(pkg) {
  const elizaos = pkg.packageJson.elizaos;
  if (!elizaos || typeof elizaos !== "object") return {};
  const scripts = /** @type {Record<string, unknown>} */ (elizaos).scripts;
  return scripts && typeof scripts === "object" ? scripts : {};
}

/** Named workspace packages, each paired with its resolved `elizaos.scripts`. */
function packagesWithScriptMeta(opts) {
  return listPackages(opts)
    .filter((pkg) => typeof pkg.name === "string")
    .map((pkg) => ({ ...pkg, scripts: scriptsMeta(pkg) }));
}

/**
 * Package names (`@elizaos/…`) that opt into `build:core`, sorted. Replaces the
 * hardcoded CORE_BUILD_PACKAGES list.
 */
export function resolveCoreBuildPackages(opts) {
  return packagesWithScriptMeta(opts)
    .filter((pkg) => pkg.scripts.coreBuild === true)
    .map((pkg) => pkg.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Package names whose `test` script must stay serial, as a Set. Replaces the
 * hardcoded SERIALIZE_PACKAGES set consumed by the test task pool.
 */
export function resolveTestSerialPackages(opts) {
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
export function resolveTestLaneDirs(lane, opts) {
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
 * The `buildModel` exception sets (audit-build-typecheck.mjs) as
 * `{ doubleCheck: Set, tscTypecheck: Set }` of package names.
 */
export function resolveBuildModelExceptions(opts) {
  const pkgs = packagesWithScriptMeta(opts);
  const collect = (key) =>
    new Set(
      pkgs
        .filter(
          (pkg) =>
            pkg.scripts.buildModel &&
            typeof pkg.scripts.buildModel === "object" &&
            pkg.scripts.buildModel[key] === true,
        )
        .map((pkg) => pkg.name),
    );
  return {
    doubleCheck: collect("doubleCheck"),
    tscTypecheck: collect("tscTypecheck"),
  };
}

/**
 * Package names whose turbo `#build` may enumerate non-imported build deps, as a
 * Set. Replaces audit-turbo-build-deps.mjs ALLOW_OWNERS.
 */
export function resolveTurboNonImportedBuildDepOwners(opts) {
  return new Set(
    packagesWithScriptMeta(opts)
      .filter((pkg) => pkg.scripts.turboNonImportedBuildDeps === true)
      .map((pkg) => pkg.name),
  );
}

/**
 * Map of `@elizaos/…` package name → npm dist-tag to fall back to when its
 * workspace: version cannot be resolved. Replaces the
 * OPTIONAL_PLUGIN_FALLBACK_VERSIONS map in prepare-package-dist.mjs.
 */
export function resolveRegistryFallbackTags(opts) {
  const map = new Map();
  for (const pkg of packagesWithScriptMeta(opts)) {
    const tag = pkg.scripts.publish?.registryFallbackTag;
    if (typeof tag === "string" && tag.length > 0) map.set(pkg.name, tag);
  }
  return map;
}

/** Package names dev-all.mjs adds to the agent's ELIZA_SKIP_PLUGINS, sorted. */
export function resolveDevAllSkipPlugins(opts) {
  return packagesWithScriptMeta(opts)
    .filter((pkg) => pkg.scripts.devStack?.skipInDevAll === true)
    .map((pkg) => pkg.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Workspace-relative dirs dev-harness.mjs builds before the watch loop, sorted. */
export function resolveDevHarnessBuildDirs(opts) {
  return packagesWithScriptMeta(opts)
    .filter((pkg) => pkg.scripts.devStack?.harnessBuild === true)
    .map((pkg) => pkg.dir)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Private/internal packages to build on a fresh clone, in ascending `order`
 * (deps before dependents). Each entry is `{ dir, name, sentinel, order }`.
 * Replaces the hardcoded PACKAGES list in build-private-workspace-packages.mjs.
 */
export function resolveBuildOnInstallPackages(opts) {
  return packagesWithScriptMeta(opts)
    .filter(
      (pkg) =>
        pkg.scripts.buildOnInstall &&
        typeof pkg.scripts.buildOnInstall === "object" &&
        typeof pkg.scripts.buildOnInstall.sentinel === "string",
    )
    .map((pkg) => ({
      dir: pkg.dir,
      name: pkg.name,
      sentinel: pkg.scripts.buildOnInstall.sentinel,
      order: Number(pkg.scripts.buildOnInstall.order ?? 0),
    }))
    .sort((a, b) => a.order - b.order || a.dir.localeCompare(b.dir));
}
