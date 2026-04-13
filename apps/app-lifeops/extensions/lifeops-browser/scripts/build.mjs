#!/usr/bin/env bun
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildChromeExtensionVersion,
  resolveLifeOpsBrowserReleaseVersion,
} from "./release-version.mjs";

const browserKind = process.argv[2] === "safari" ? "safari" : "chrome";
const extensionRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const publicDir = path.join(extensionRoot, "public");
const release = resolveLifeOpsBrowserReleaseVersion();
const extensionVersion = buildChromeExtensionVersion(release);

export function resolveLifeOpsBrowserIconSources(root = extensionRoot) {
  const appPublicDir = path.resolve(root, "..", "..", "app", "public");
  return [
    ["icon16.png", path.join(appPublicDir, "favicon-16x16.png")],
    ["icon32.png", path.join(appPublicDir, "favicon-32x32.png")],
    ["icon128.png", path.join(appPublicDir, "android-chrome-192x192.png")],
  ];
}

export async function buildLifeOpsBrowserExtension(kind = browserKind) {
  const outputDir = path.join(extensionRoot, "dist", kind);

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  const define = {
    __LIFEOPS_BROWSER_KIND__: JSON.stringify(kind),
  };

  const buildResult = await Bun.build({
    entrypoints: [
      path.join(extensionRoot, "entrypoints", "background.ts"),
      path.join(extensionRoot, "entrypoints", "content.ts"),
      path.join(extensionRoot, "entrypoints", "popup.ts"),
      path.join(extensionRoot, "entrypoints", "blocked.ts"),
    ],
    outdir: outputDir,
    target: "browser",
    format: "iife",
    sourcemap: "external",
    minify: false,
    naming: "[name].js",
    define,
  });

  if (!buildResult.success) {
    const messages = buildResult.logs.map((log) => log.message).join("\n");
    throw new Error(`Extension build failed:\n${messages}`);
  }

  await fs.copyFile(
    path.join(publicDir, "popup.html"),
    path.join(outputDir, "popup.html"),
  );
  await fs.copyFile(
    path.join(publicDir, "popup.css"),
    path.join(outputDir, "popup.css"),
  );
  await fs.copyFile(
    path.join(publicDir, "blocked.html"),
    path.join(outputDir, "blocked.html"),
  );

  for (const [fileName, sourcePath] of resolveLifeOpsBrowserIconSources()) {
    await fs.copyFile(sourcePath, path.join(outputDir, fileName));
  }

  const manifest = {
    manifest_version: 3,
    name: "LifeOps Browser",
    version: extensionVersion,
    version_name: release.raw,
    description:
      "LifeOps personal-browser relay for syncing the current page and executing owner-approved browser sessions.",
    permissions: [
      "tabs",
      "storage",
      "scripting",
      "alarms",
      "activeTab",
      "declarativeNetRequest",
      "declarativeNetRequestWithHostAccess",
    ],
    host_permissions: ["<all_urls>"],
    background: {
      service_worker: "background.js",
    },
    action: {
      default_title: "LifeOps Browser",
      default_popup: "popup.html",
    },
    content_scripts: [
      {
        matches: ["<all_urls>"],
        js: ["content.js"],
        run_at: "document_idle",
      },
    ],
    icons: {
      16: "icon16.png",
      32: "icon32.png",
      128: "icon128.png",
    },
    browser_specific_settings:
      kind === "safari"
        ? {
            safari: {
              strict_min_version: "17.0",
            },
          }
        : undefined,
  };

  await fs.writeFile(
    path.join(outputDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  console.log(
    `Built LifeOps Browser extension ${release.raw} (${extensionVersion}) to ${outputDir}`,
  );
}

if (import.meta.main) {
  await buildLifeOpsBrowserExtension();
}
