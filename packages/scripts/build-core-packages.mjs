/**
 * The "core" build set — the leaf workspace packages the test lanes
 * (`test:server`, `test:client`, `test:plugins`) and several CI/deploy workflows
 * need built before they run. Single source of truth for the root `build:core`
 * script (issue #10200).
 *
 * Membership is not listed here: each core leaf declares `elizaos.scripts.coreBuild`
 * in its own package.json, and this module resolves the set through the shared
 * workspace-discovery seam (#12332/#12334). Adding or removing a core package is a
 * package.json edit, not a script edit — `build-core.test.ts` guards that every
 * resolved entry is a real workspace package, and the plugin-coupling gate
 * (#12336) keeps the list out of script source.
 *
 * Each entry is a *leaf* target: Turbo's `build` task is `dependsOn: ["^build"]`,
 * so requesting a package builds its full workspace-dependency closure. Tag only
 * the packages a test lane imports directly — not their transitive dependencies.
 */
import { resolveCoreBuildPackages } from "./lib/script-metadata.mjs";

export const CORE_BUILD_PACKAGES = resolveCoreBuildPackages();
