/**
 * Materializes the marketing assets required by the unified Eliza web build.
 * Homepage sources remain independently testable, while packages/app is the
 * only deployable frontend artifact and therefore owns their emitted copies.
 */
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homepagePublic = path.resolve(appRoot, "../homepage/public");
const appPublic = path.join(appRoot, "public");

export const HOMEPAGE_PUBLIC_ASSETS = [
  ".well-known/apple-app-site-association",
  ".well-known/assetlinks.json",
  "brand/people/demo-jamie.webp",
  "brand/people/demo-leo.webp",
  "brand/people/demo-maya.webp",
  "brand/people/demo-priya.webp",
  "eliza-logo.webp",
  "eliza-app-profile-image.webp",
  "elizawallpaper.webp",
  "geist-sans-latin-ext.woff2",
  "geist-sans-latin.woff2",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "favicon-180x180.png",
  "favicon.svg",
  "grain.webp",
  "install.ps1",
  "install.sh",
  "tbg.webp",
];

export async function syncHomepageAssets({
  sourceRoot = homepagePublic,
  destinationRoot = appPublic,
} = {}) {
  await Promise.all(
    HOMEPAGE_PUBLIC_ASSETS.map(async (relativePath) => {
      const source = path.join(sourceRoot, relativePath);
      const destination = path.join(destinationRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }),
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await syncHomepageAssets();
}
