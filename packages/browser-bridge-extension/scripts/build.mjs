#!/usr/bin/env bun
/**
 * Bun build for the extension: bundles the entrypoints to IIFE, stamps the
 * versioned manifest.json, and emits per-browser output under
 * dist/<chrome|firefox|safari>/. Exports BROWSER_BRIDGE_HOST_ALLOWLIST — the
 * SOC2-scoped default host grant baked into the manifest and checked by the
 * smoke tests.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChromeExtensionIdentity } from "./chrome-identity.mjs";
import {
  buildChromeExtensionVersion,
  resolveBrowserBridgeReleaseVersion,
} from "./release-version.mjs";
import { run } from "./script-utils.mjs";

// SOC2 L-4: explicit host allowlist instead of a blanket `<all_urls>` grant.
// Documented in README.md. Hosts beyond this list require an explicit grant
// through the browser's extension site-access controls.
export const BROWSER_BRIDGE_HOST_ALLOWLIST = [
  // Local Eliza agent API. Chrome match patterns do not encode the port,
  // so these cover 127.0.0.1:31337 plus smoke-test/random dev ports.
  "http://127.0.0.1/*",
  "http://localhost/*",
];

export const BROWSER_BRIDGE_BUILD_KINDS = ["chrome", "firefox", "safari"];

export function parseBrowserBridgeBuildKind(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!BROWSER_BRIDGE_BUILD_KINDS.includes(normalized)) {
    throw new Error(
      `Unsupported browser extension build target "${value ?? ""}". Expected chrome, firefox, or safari.`,
    );
  }
  return normalized;
}

const browserKind = import.meta.main
  ? parseBrowserBridgeBuildKind(process.argv[2] ?? "chrome")
  : "chrome";
const extensionRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const publicDir = path.join(extensionRoot, "public");
const extensionIdentity = JSON.parse(
  await fs.readFile(path.join(extensionRoot, "identity.json"), "utf8"),
);
const chromeIdentity = resolveChromeExtensionIdentity({
  identity: extensionIdentity,
  release: process.env.ELIZA_BROWSER_BRIDGE_RELEASE_PACKAGING === "1",
});
const cleanupHelper = path.resolve(
  extensionRoot,
  "..",
  "scripts",
  "rm-path-recursive.mjs",
);
const release = resolveBrowserBridgeReleaseVersion();
const extensionVersion = buildChromeExtensionVersion(release);

export function resolveBrowserBridgeIconSources(root = extensionRoot) {
  const iconDir = path.resolve(root, "..", "shared", "assets", "favicons");
  return [
    ["icon16.png", path.join(iconDir, "favicon-16x16.png")],
    ["icon32.png", path.join(iconDir, "favicon-32x32.png")],
    ["icon192.png", path.join(iconDir, "android-chrome-192x192.png")],
  ];
}

export async function buildBrowserBridgeExtension(kind = browserKind) {
  const outputDir = path.join(extensionRoot, "dist", kind);

  await run("node", [cleanupHelper, outputDir], { cwd: extensionRoot });
  await fs.mkdir(outputDir, { recursive: true });

  const define = {
    __BROWSER_BRIDGE_KIND__: JSON.stringify(kind),
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
    // Store archives ship executable bundles only. External maps are not
    // referenced by the manifest and unnecessarily expose source paths.
    sourcemap: "none",
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
    ...(kind === "chrome" ? { key: chromeIdentity.manifestKey } : {}),
    permissions: [
      "tabs",
      "storage",
      "scripting",
      "alarms",
      "activeTab",
      "nativeMessaging",
      "declarativeNetRequestWithHostAccess",
    ],
    // SOC2 L-4: scoped host permissions. The default-install allowlist is
    // the minimum set the extension needs to function with first-party
    // Eliza surfaces. Additional hosts require an explicit browser-managed
    // site-access grant and are rechecked before data sharing or action use.
    host_permissions: BROWSER_BRIDGE_HOST_ALLOWLIST,
    optional_host_permissions: ["https://*/*", "http://*/*"],
    background:
      kind === "firefox"
        ? { scripts: ["background.js"] }
        : { service_worker: "background.js" },
    // SOC2 L-4: strict CSP. Disallow inline scripts; only first-party
    // bundle code may execute.
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
    action: {
      default_title: "Agent Browser Bridge",
      default_popup: "popup.html",
    },
    content_scripts: [
      {
        matches: BROWSER_BRIDGE_HOST_ALLOWLIST,
        js: ["content.js"],
        run_at: "document_idle",
      },
    ],
    // DNR redirects originate on arbitrary user-granted sites. Only the
    // interstitial and its first-party bundle are exposed; blocked.ts binds
    // its API access back to the stored companion origin before fetching.
    web_accessible_resources: [
      {
        resources: ["blocked.html", "blocked.js"],
        matches: ["http://*/*", "https://*/*"],
        // Chrome DNR main-frame redirects resolve extensionPath against the
        // stable extension origin. Marking this resource use_dynamic_url makes
        // the browser reject its own redirect with ERR_BLOCKED_BY_CLIENT.
        // Exposure stays limited to this inert interstitial and first-party
        // controller; neither contains a credential or privileged page data.
      },
    ],
    icons: {
      16: "icon16.png",
      32: "icon32.png",
      192: "icon192.png",
    },
    browser_specific_settings:
      kind === "firefox"
        ? {
            gecko: {
              id: "browser-bridge@elizaos.ai",
              strict_min_version: "142.0",
              data_collection_permissions: {
                required: ["none"],
              },
            },
          }
        : kind === "safari"
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
