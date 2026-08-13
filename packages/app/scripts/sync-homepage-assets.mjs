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

const ASSETS = [
  ".well-known/apple-app-site-association",
  ".well-known/assetlinks.json",
  "eliza-logo.webp",
  "elizapfp.webp",
  "elizawallpaper.webp",
  "geist-sans-latin-ext.woff2",
  "geist-sans-latin.woff2",
  "grain.webp",
  "eliza-logotext.svg",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "favicon-180x180.png",
  "favicon.svg",
  "install.ps1",
  "install.sh",
  "product/elizaos-usb-key-concept.png",
  "tbg.webp",
];

await Promise.all(
  ASSETS.map(async (relativePath) => {
    const source = path.join(homepagePublic, relativePath);
    const destination = path.join(appPublic, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }),
);
