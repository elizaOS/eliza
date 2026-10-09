/**
 * Build-stamp policy for the tester-only BuildBadge. Production and store
 * renderer builds must not ship build-info.json even when they run from a git
 * checkout, while staging and developer builds keep the stamp for cache checks.
 */
import fs from "node:fs";
import path from "node:path";

const BUILD_INFO_FILE = "build-info.json";

export function shouldSkipBuildStamp(env = process.env, options = {}) {
  const variant = env.ELIZA_BUILD_VARIANT?.toLowerCase();
  const isDeclaredProduction =
    env.VITE_ENVIRONMENT === "production" ||
    env.ELIZA_RELEASE_AUTHORITY === "apple-app-store" ||
    variant === "store";
  const isDeclaredNonProduction =
    (typeof env.VITE_ENVIRONMENT === "string" &&
      env.VITE_ENVIRONMENT.length > 0 &&
      env.VITE_ENVIRONMENT !== "production") ||
    env.ELIZA_RELEASE_AUTHORITY === "developer-toolchain" ||
    variant === "direct";
  const isProductionBuild =
    isDeclaredProduction ||
    ((options.viteMode === "production" ||
      options.viteProductionBuild === true) &&
      !isDeclaredNonProduction);
  return isProductionBuild && env.ELIZA_BUILD_STAMP !== "1";
}

export function removePublicBuildStamp(appDir) {
  fs.rmSync(path.join(appDir, "public", BUILD_INFO_FILE), { force: true });
}

export function removeEmittedBuildStamp(bundle) {
  delete bundle[BUILD_INFO_FILE];
  delete bundle[`/${BUILD_INFO_FILE}`];
}
