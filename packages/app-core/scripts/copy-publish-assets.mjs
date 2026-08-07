/**
 * Defines and copies the non-TypeScript assets shipped in the app-core npm
 * package. Keeping the manifest here makes payload additions reviewable and
 * gives tests one canonical contract instead of parsing a package script.
 */
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
  "test/scripts",
  "test/helpers",
]);

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await copyPackageAssets({
    repositoryRoot,
    packageDirectory,
    assetPaths: PUBLISH_ASSET_PATHS,
  });
}
