#!/usr/bin/env bun
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildChromeExtensionVersion,
  resolveBrowserBridgeReleaseVersion,
} from "./release-version.mjs";

const browserKind = process.argv[2] === "safari" ? "safari" : "chrome";
const extensionRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const publicDir = path.join(extensionRoot, "public");
const release = resolveBrowserBridgeReleaseVersion();
const extensionVersion = buildChromeExtensionVersion(release);

export function resolveBrowserBridgeIconSources(root = extensionRoot) {
  const iconDir = path.join(root, "public", "icons");
  return [
    ["icon16.png", path.join(iconDir, "icon16.png")],
    ["icon32.png", path.join(iconDir, "icon32.png")],
    ["icon128.png", path.join(iconDir, "icon128.png")],
  ];
}

export async function buildBrowserBridgeExtension(kind = browserKind) {
  const outputDir = path.join(extensionRoot, "dist", kind);

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  // Inline the wallet-shim template so the wallet-shim content script is
  // self-contained and can build the MAIN-world payload without filesystem
  // access at runtime. Resolved relative to plugin-wallet's source tree.
  const walletShimTemplatePath = path.resolve(
    extensionRoot,
    "..",
    "..",
    "plugins",
    "plugin-wallet",
    "src",
    "browser-shim",
    "shim.template.js",
  );
  const walletShimTemplate = await fs.readFile(walletShimTemplatePath, "utf8");

  const define = {
    __BROWSER_BRIDGE_KIND__: JSON.stringify(kind),
    __WALLET_SHIM_TEMPLATE__: JSON.stringify(walletShimTemplate),
  };

  const buildResult = await Bun.build({
    entrypoints: [
      path.join(extensionRoot, "entrypoints", "background.ts"),
      path.join(extensionRoot, "entrypoints", "content.ts"),
      path.join(extensionRoot, "entrypoints", "popup.ts"),
      path.join(extensionRoot, "entrypoints", "blocked.ts"),
      path.join(extensionRoot, "entrypoints", "wallet-shim.ts"),
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

  for (const [fileName, sourcePath] of resolveBrowserBridgeIconSources()) {
    await fs.copyFile(sourcePath, path.join(outputDir, fileName));
  }

  const manifest = {
    manifest_version: 3,
    name: "Agent Browser Bridge",
    version: extensionVersion,
    version_name: release.raw,
    description:
      "Agent Browser Bridge pairs your personal browser profile with an Eliza agent so the agent can read the current page and run owner-approved browser actions.",
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
      default_title: "Agent Browser Bridge",
      default_popup: "popup.html",
    },
    content_scripts: [
      {
        matches: ["<all_urls>"],
        js: ["content.js"],
        run_at: "document_idle",
      },
      {
        // wallet-shim must run before page scripts so window.solana /
        // window.ethereum are present for the dApp's own provider-detection
        // logic. It runs in the default isolated world (it just injects a
        // <script>textContent=...></script> into the page DOM, which executes
        // in MAIN world).
        matches: ["<all_urls>"],
        js: ["wallet-shim.js"],
        run_at: "document_start",
        all_frames: true,
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
    `Built Agent Browser Bridge extension ${release.raw} (${extensionVersion}) to ${outputDir}`,
  );
}

if (import.meta.main) {
  await buildBrowserBridgeExtension();
}
