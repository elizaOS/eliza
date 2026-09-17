/**
 * Defines and copies the non-TypeScript assets shipped in the app-core npm
 * package. Keeping the manifest here makes payload additions reviewable and
 * gives tests one canonical contract instead of parsing a package script.
 */
import { copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyPackageAssets } from "../../scripts/copy-package-assets.mjs";

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(packageDirectory, "../..");

export const PUBLISH_ASSET_PATHS = Object.freeze([
  "src/styles",
  "scripts",
  "platforms",
  "packaging",
  "patches",
  "test/helpers/http.ts",
  "test/helpers/isolated-config.ts",
  "test/helpers/real-runtime.ts",
  "test/helpers/live-child-env.ts",
  "test/helpers/live-provider.ts",
]);

export async function copyPublishAssets({
  sourceRoot = repositoryRoot,
  destinationPackage = packageDirectory,
} = {}) {
  await copyPackageAssets({
    repositoryRoot: sourceRoot,
    packageDirectory: destinationPackage,
    assetPaths: PUBLISH_ASSET_PATHS,
  });
  // The native package owns this policy but is not a published dependency.
  // Replace the checkout bridge with the exact canonical module for consumers.
  copyFileSync(
    path.join(
      sourceRoot,
      "packages/native/bun-runtime/scripts/ios-app-store-runtime-policy.mjs",
    ),
    path.join(
      destinationPackage,
      "dist/scripts/lib/ios-app-store-runtime-policy.mjs",
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await copyPublishAssets();
}
