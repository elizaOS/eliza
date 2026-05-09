import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import {
  createLogger,
  defineConfig,
  type Plugin,
  transformWithEsbuild,
} from "vite";
// Keep workspace-relative TS imports in this config so Vite transpiles them
// while bundling the config instead of asking Node to load package-exported
// .ts files directly in CI.
import { colorizeDevSettingsStartupBanner } from "../../packages/shared/src/dev-settings-banner-style.ts";
import { prependDevSubsystemFigletHeading } from "../../packages/shared/src/dev-settings-figlet-heading.ts";
import {
  type DevSettingsRow,
  formatDevSettingsTable,
} from "../../packages/shared/src/dev-settings-table.ts";
import {
  resolveDesktopApiPort,
  resolveDesktopApiPortPreference,
  resolveDesktopUiPort,
  resolveDesktopUiPortPreference,
} from "../../packages/shared/src/runtime-env.ts";
import { resolveAppBranding } from "../../packages/ui/src/config/app-config.ts";
import { syncElizaEnvAliases } from "../../scripts/lib/sync-eliza-env-aliases.mjs";
import appConfig from "./app.config";
import { CAPACITOR_PLUGIN_NAMES } from "./scripts/capacitor-plugin-names.mjs";
import { normalizeEnvPrefix } from "./src/env-prefix.js";
import {
  generateNodeBuiltinStub,
  nativeModuleStubPlugin,
} from "./vite/native-module-stub-plugin.ts";
import { resolveViteDevServerRuntime } from "./vite-dev-origin.ts";

const _require = createRequire(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const elizaRoot = path.resolve(here, "../..");
const nativePluginsRoot = path.join(elizaRoot, "packages/native-plugins");
const appCoreSrcRoot = path.join(elizaRoot, "packages/app-core/src");
const pluginSqlSrcRoot = path.join(elizaRoot, "plugins/plugin-sql/src");
const pluginBrowserBridgeSrcRoot = path.join(
  elizaRoot,
  "plugins/plugin-browser/src",
);
const appCoreNativePluginEntrypoints = path.join(
  appCoreSrcRoot,
  "platform/native-plugin-entrypoints.ts",
);
const uiPkgRoot = path.join(elizaRoot, "packages/ui");
const capacitorCoreEntry = _require.resolve("@capacitor/core");
const patheEntry = _require.resolve("pathe");
// Other Capacitor packages imported by eliza/packages/app-core sources.
// Resolved here (packages/app scope) so Rollup can find them when bundling
// files from within the eliza submodule tree where bun may not hoist them.
function tryResolve(id: string): string | undefined {
  try {
    return _require.resolve(id);
  } catch {
    return undefined;
  }
}
const capacitorKeyboardEntry = tryResolve("@capacitor/keyboard");
const capacitorPreferencesEntry = tryResolve("@capacitor/preferences");
const capacitorAppEntry = tryResolve("@capacitor/app");

function isExpectedWsProxySocketError(
  message: unknown,
  error: unknown,
): boolean {
  const text = typeof message === "string" ? message : String(message ?? "");
  if (!text.includes("ws proxy socket error")) {
    return false;
  }

  const errorLike =
    error && typeof error === "object"
      ? (error as { code?: unknown; message?: unknown })
      : null;
  return (
    errorLike?.code === "ECONNRESET" ||
    String(errorLike?.message ?? "").includes("read ECONNRESET")
  );
}

const viteLogger = createLogger();
const viteLoggerError = viteLogger.error;
viteLogger.error = (message, options) => {
  if (isExpectedWsProxySocketError(message, options?.error)) {
    return;
  }
  viteLoggerError(message, options);
};

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolvePackageExportTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  for (const condition of ["source", "import", "default"]) {
    const target = record[condition];
    if (typeof target === "string") return target;
  }

  return null;
}

function createWorkspacePackageAliases(packageRoots: string[]) {
  const aliases = [];
  for (const packageRoot of packageRoots) {
    if (!fs.existsSync(packageRoot)) continue;
    const packageRootName = path.basename(packageRoot);
    for (const entry of fs.readdirSync(packageRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (packageRootName === "plugins" && !entry.name.startsWith("app-")) {
        continue;
      }
      const pkgPath = path.join(packageRoot, entry.name, "package.json");
      if (!fs.existsSync(pkgPath)) continue;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const pkgName = pkg.name;
      if (!pkgName) continue;
      const pkgDir = path.dirname(pkgPath);
      for (const [key, value] of Object.entries(pkg.exports || {})) {
        const exportTarget = resolvePackageExportTarget(value);
        if (!exportTarget) continue;
        const aliasKey =
          key === "." ? pkgName : `${pkgName}/${key.replace(/^\.\//, "")}`;
        aliases.push({
          find: new RegExp(`^${escapeRegExp(aliasKey)}$`),
          replacement: path.resolve(pkgDir, exportTarget),
        });
      }
      aliases.push({
        find: new RegExp(`^${escapeRegExp(pkgName)}/(.*)`),
        replacement: path.resolve(pkgDir, "src/$1"),
      });
    }
  }
  return aliases;
}

function resolveAppPluginBrowserEntry(pkgDir: string): string | null {
  const preferred = [
    "src/ui.ts",
    "src/ui/index.ts",
    "src/register.ts",
    "src/index.ts",
  ];
  for (const relativePath of preferred) {
    const candidate = path.join(pkgDir, relativePath);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function createAppPluginBrowserAliases() {
  const pluginsRoot = path.resolve(elizaRoot, "plugins");
  const aliases = [];
  if (!fs.existsSync(pluginsRoot)) return aliases;

  for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("app-")) continue;
    const pkgDir = path.join(pluginsRoot, entry.name);
    const pkgPath = path.join(pkgDir, "package.json");
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const pkgName = pkg.name;
    if (!pkgName) continue;

    const browserEntry = resolveAppPluginBrowserEntry(pkgDir);
    if (browserEntry) {
      aliases.push({
        find: new RegExp(`^${escapeRegExp(pkgName)}$`),
        replacement: browserEntry,
      });
    }

    for (const uiEntry of ["src/ui.ts", "src/ui/index.ts"]) {
      const candidate = path.join(pkgDir, uiEntry);
      if (!fs.existsSync(candidate)) continue;
      aliases.push({
        find: new RegExp(`^${escapeRegExp(pkgName)}/ui$`),
        replacement: candidate,
      });
      break;
    }
  }

  return aliases;
}

function resolveAppShellMetadata() {
  const branding = resolveAppBranding(appConfig);
  const themeColor = appConfig.web?.themeColor?.trim() || "#08080a";
  const backgroundColor = appConfig.web?.backgroundColor?.trim() || "#0a0a0a";
  const shareImagePath =
    appConfig.web?.shareImagePath?.trim() || "/og-image.png";
  const appUrl = ensureTrailingSlash(branding.appUrl.trim());

  return {
    appName: appConfig.appName.trim(),
    shortName: appConfig.web?.shortName?.trim() || appConfig.appName.trim(),
    description: appConfig.description.trim(),
    appUrl,
    themeColor,
    backgroundColor,
    shareImagePath,
    shareImageUrl: new URL(shareImagePath, appUrl).toString(),
  };
}

const APP_SHELL_METADATA = resolveAppShellMetadata();
const APP_ENV_PREFIX = normalizeEnvPrefix(
  appConfig.envPrefix?.trim() || appConfig.cliName.trim(),
);
const APP_NAMESPACE = appConfig.namespace?.trim() || appConfig.cliName.trim();
const BRANDED_ENV = {
  apiPort: `${APP_ENV_PREFIX}_API_PORT`,
  appSourcemap: `${APP_ENV_PREFIX}_APP_SOURCEMAP`,
  assetBaseUrl: `${APP_ENV_PREFIX}_ASSET_BASE_URL`,
  desktopFastDist: `${APP_ENV_PREFIX}_DESKTOP_VITE_FAST_DIST`,
  devPolling: `${APP_ENV_PREFIX}_DEV_POLLING`,
  hmrHost: `${APP_ENV_PREFIX}_HMR_HOST`,
  settingsDebug: `${APP_ENV_PREFIX}_SETTINGS_DEBUG`,
  ttsDebug: `${APP_ENV_PREFIX}_TTS_DEBUG`,
  viteLoopbackOrigin: `${APP_ENV_PREFIX}_VITE_LOOPBACK_ORIGIN`,
  viteOrigin: `${APP_ENV_PREFIX}_VITE_ORIGIN`,
  viteSettingsDebug: `VITE_${APP_ENV_PREFIX}_SETTINGS_DEBUG`,
};
const DEFAULT_APP_ROUTE_PLUGIN_MODULES = [
  "@elizaos/app-vincent/register-routes",
  "@elizaos/app-shopify/register-routes",
  "@elizaos/app-steward/register-routes",
  "@elizaos/app-lifeops/register-routes",
  "@elizaos/plugin-github/register-routes",
  "@elizaos/plugin-computeruse/register-routes",
  "@elizaos/plugin-elizacloud/register-routes",
  "@elizaos/plugin-workflow/register-routes",
];

// Mirror branded app env into ELIZA_* before the shared runtime helpers resolve ports.
syncElizaEnvAliases({
  brandedPrefix: APP_ENV_PREFIX,
  cloudManagedAgentsApiSegment: APP_NAMESPACE,
  appRoutePluginModules: DEFAULT_APP_ROUTE_PLUGIN_MODULES,
});

const NATIVE_PLUGIN_ALIAS_ENTRIES = CAPACITOR_PLUGIN_NAMES.map((name) => ({
  find: new RegExp(`^@elizaos/capacitor-${escapeRegExp(name)}$`),
  replacement: path.join(nativePluginsRoot, `${name}/src/index.ts`),
}));
const CAPACITOR_BUILD_TARGET = process.env.ELIZA_CAPACITOR_BUILD_TARGET ?? "";
const IS_CAPACITOR_MOBILE_BUILD =
  CAPACITOR_BUILD_TARGET === "ios" || CAPACITOR_BUILD_TARGET === "android";

function appShellMetadataPlugin(): Plugin {
  const manifest = `${JSON.stringify(
    {
      name: APP_SHELL_METADATA.appName,
      short_name: APP_SHELL_METADATA.shortName,
      icons: [
        {
          src: "./android-chrome-192x192.png",
          sizes: "192x192",
          type: "image/png",
        },
        {
          src: "./android-chrome-512x512.png",
          sizes: "512x512",
          type: "image/png",
        },
      ],
      theme_color: APP_SHELL_METADATA.themeColor,
      background_color: APP_SHELL_METADATA.backgroundColor,
      display: "standalone",
    },
    null,
    2,
  )}\n`;

  const replacements = new Map<string, string>([
    ["__APP_NAME__", APP_SHELL_METADATA.appName],
    ["__APP_DESCRIPTION__", APP_SHELL_METADATA.description],
    ["__APP_URL__", APP_SHELL_METADATA.appUrl],
    ["__APP_SHARE_IMAGE__", APP_SHELL_METADATA.shareImageUrl],
    ["__APP_THEME_COLOR__", APP_SHELL_METADATA.themeColor],
  ]);

  return {
    name: "app-shell-metadata",
    transformIndexHtml(html) {
      let next = html;
      for (const [token, value] of replacements) {
        next = next.replaceAll(token, value);
      }
      return next;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split("?")[0];
        if (pathname !== "/site.webmanifest") {
          next();
          return;
        }

        res.setHeader(
          "Content-Type",
          "application/manifest+json; charset=utf-8",
        );
        res.end(manifest);
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "site.webmanifest",
        source: manifest,
      });
    },
  };
}

/**
 * Pinned @elizaos/core from the repo root (must match the agent/runtime lock).
 */
function getPinnedElizaCoreVersion(): string {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(elizaRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      overrides?: Record<string, string>;
    };
    const spec =
      raw.dependencies?.["@elizaos/core"] ??
      raw.overrides?.["@elizaos/core"] ??
      "";
    const v = String(spec)
      .trim()
      .replace(/^[\^~]/, "");
    if (v && v !== "workspace:*" && /^\d/.test(v)) {
      const first = v.split(/\s+/)[0];
      if (first) return first;
    }
  } catch {
    /* fall through */
  }
  return "2.0.0-beta.0";
}

/** Bun cache dir names look like `@elizaos+core@2.0.0-beta.0+<hash>`. */
function elizaCoreBetaPrerelease(dir: string): number {
  const m = dir.match(/@elizaos\+core@[\d.]+-beta\.(\d+)/);
  return m?.[1] ? parseInt(m[1], 10) : -1;
}

function resolveExistingUiSourceModule(id: string) {
  if (fs.existsSync(id)) {
    return id;
  }

  const alternate = id.endsWith(".tsx")
    ? `${id.slice(0, -4)}.ts`
    : id.endsWith(".ts")
      ? `${id.slice(0, -3)}.tsx`
      : null;

  if (alternate && fs.existsSync(alternate)) {
    return alternate;
  }

  return id;
}

function resolveExistingTsSourceModule(id: string): string {
  if (fs.existsSync(id)) {
    try {
      if (!fs.statSync(id).isDirectory()) {
        return id;
      }
    } catch {
      return id;
    }
  }

  const candidates = [
    `${id}.ts`,
    `${id}.tsx`,
    path.join(id, "index.ts"),
    path.join(id, "index.tsx"),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? id;
}

function resolveSharedSourceExportTarget(
  sharedPkgDir: string,
  key: string,
  value: unknown,
): string | null {
  if (key === ".") {
    return path.join(sharedPkgDir, "src/index.ts");
  }

  const exportTarget = resolvePackageExportTarget(value);
  if (!exportTarget) return null;

  const sourceRelative = exportTarget
    .replace(/^\.\//, "")
    .replace(/^dist\//, "")
    .replace(/\.js$/, "");
  return resolveExistingTsSourceModule(
    path.join(sharedPkgDir, "src", sourceRelative),
  );
}

/**
 * Bun stores a full npm tarball under node_modules/.bun even when the workspace
 * symlink for @elizaos/core points at an unbuilt local eliza checkout.
 *
 * **WHY sort:** `readdir` order is arbitrary; picking `beta.0` over a later beta
 * mismatches the API and tends to blank the Electrobun webview.
 */
function findElizaCoreBundleInBunStore(
  kind: "browser" | "node",
): string | null {
  const bunDir = path.join(elizaRoot, "node_modules/.bun");
  const rel =
    kind === "browser"
      ? "node_modules/@elizaos/core/dist/browser/index.browser.js"
      : "node_modules/@elizaos/core/dist/node/index.node.js";
  if (!fs.existsSync(bunDir)) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(bunDir);
  } catch {
    return null;
  }
  const pinned = getPinnedElizaCoreVersion();
  const pinnedPrefix = `@elizaos+core@${pinned}+`;

  const withDist = entries.filter((dir) => {
    if (!dir.startsWith("@elizaos+core@")) return false;
    return fs.existsSync(path.join(bunDir, dir, rel));
  });

  const pinnedMatch = withDist.find((d) => d.startsWith(pinnedPrefix));
  if (pinnedMatch) return path.join(bunDir, pinnedMatch, rel);

  if (withDist.length === 0) return null;

  withDist.sort(
    (a, b) => elizaCoreBetaPrerelease(b) - elizaCoreBetaPrerelease(a),
  );
  const best = withDist[0];
  return best ? path.join(bunDir, best, rel) : null;
}

function normalizeModuleId(id: string | undefined): string {
  return (id ?? "").split(path.sep).join("/");
}

function tryResolveElizaCorePkgDir(): string | null {
  try {
    return path.dirname(_require.resolve("@elizaos/core/package.json"));
  } catch {
    const workspaceCorePkg = path.join(elizaRoot, "packages/core/package.json");
    return fs.existsSync(workspaceCorePkg)
      ? path.dirname(workspaceCorePkg)
      : null;
  }
}

function resolveElizaCoreSourceBrowserPath(): string | null {
  const workspaceSourceBrowserEntry = path.join(
    elizaRoot,
    "packages/core/src/index.browser.ts",
  );
  if (fs.existsSync(workspaceSourceBrowserEntry)) {
    return workspaceSourceBrowserEntry;
  }

  const pkgDir = tryResolveElizaCorePkgDir();
  if (!pkgDir) return null;
  const sourceBrowserEntry = path.join(pkgDir, "src/index.browser.ts");
  return fs.existsSync(sourceBrowserEntry) ? sourceBrowserEntry : null;
}

function isElizaCoreBrowserDistId(id: string | undefined): boolean {
  const normalized = normalizeModuleId(id);
  return (
    normalized.endsWith("/node_modules/@elizaos/core/dist/index.browser.js") ||
    normalized.endsWith(
      "/node_modules/@elizaos/core/dist/browser/index.browser.js",
    ) ||
    normalized.endsWith("/eliza/packages/core/dist/index.browser.js") ||
    normalized.endsWith("/eliza/packages/core/dist/browser/index.browser.js")
  );
}

/**
 * Resolved file path for bundling `@elizaos/core` in the renderer.
 * Linked eliza checkouts sometimes omit `dist/` until `bun run build`;
 * prefer the source browser entry when present, otherwise fall back to
 * built artifacts and then the bun install cache copy.
 */
function resolveElizaCoreBundlePath(): string {
  const pkgDir = tryResolveElizaCorePkgDir();
  const sourceBrowserEntry = resolveElizaCoreSourceBrowserPath();
  if (sourceBrowserEntry) return sourceBrowserEntry;
  if (pkgDir) {
    const browserEntry = path.join(pkgDir, "dist/browser/index.browser.js");
    const nodeEntry = path.join(pkgDir, "dist/node/index.node.js");
    const rootBrowserEntry = path.join(pkgDir, "dist/index.browser.js");
    const rootNodeEntry = path.join(pkgDir, "dist/index.node.js");
    const hasBrowserShimTarget = fs.existsSync(browserEntry);
    const hasNodeShimTarget = fs.existsSync(nodeEntry);
    if (fs.existsSync(browserEntry)) return browserEntry;
    if (fs.existsSync(rootBrowserEntry) && hasBrowserShimTarget)
      return rootBrowserEntry;
    if (fs.existsSync(nodeEntry)) {
      console.warn(
        "[eliza][vite] @elizaos/core dist/browser is missing; using dist/node for the client bundle. " +
          "For a linked eliza workspace, run `bun run build` in that checkout (e.g. packages/core). " +
          "Or reinstall with ELIZA_SKIP_LOCAL_ELIZA=1 to use the published npm package.",
      );
      return nodeEntry;
    }
    if (fs.existsSync(rootNodeEntry) && hasNodeShimTarget) {
      console.warn(
        "[eliza][vite] @elizaos/core dist/browser is missing; using dist/index.node.js for the client bundle. " +
          "This usually means the local core workspace only has a flat dist/ build artifact.",
      );
      return rootNodeEntry;
    }
  }
  const bunBrowser = findElizaCoreBundleInBunStore("browser");
  if (bunBrowser) {
    console.warn(
      `[eliza][vite] @elizaos/core not resolvable from packages/app${pkgDir ? ` (pkgDir=${pkgDir} has no dist/)` : ""}; using bun cache build at ${bunBrowser}. ` +
        "Run `bun run build` in your eliza checkout or ELIZA_SKIP_LOCAL_ELIZA=1 bun install to align versions.",
    );
    return bunBrowser;
  }
  const bunNode = findElizaCoreBundleInBunStore("node");
  if (bunNode) {
    console.warn(
      `[eliza][vite] @elizaos/core not resolvable from packages/app${pkgDir ? ` (pkgDir=${pkgDir})` : ""}; using bun cache node bundle at ${bunNode}.`,
    );
    return bunNode;
  }
  throw new Error(
    `[eliza][vite] @elizaos/core has no built artifacts${pkgDir ? ` under ${pkgDir}` : " (not resolvable from packages/app)"} and none in node_modules/.bun. ` +
      "Expected src/index.browser.ts, dist/browser/index.browser.js, dist/index.browser.js, dist/node/index.node.js, or dist/index.node.js. " +
      "Build your local eliza workspace or run `ELIZA_SKIP_LOCAL_ELIZA=1 bun install`.",
  );
}

/**
 * Some linked @elizaos/core workspaces have a flat dist/index.browser.js shim
 * even when dist/browser/index.browser.js was never emitted. If anything in the
 * dependency graph resolves that shim directly, redirect it back to the source
 * browser entry so Vite never follows the missing relative import.
 */
function elizaCoreBrowserEntryFallbackPlugin(): Plugin {
  return {
    name: "eliza-core-browser-entry-fallback",
    enforce: "pre",
    resolveId(id, importer) {
      const sourceBrowserEntry = resolveElizaCoreSourceBrowserPath();
      if (!sourceBrowserEntry) return null;
      if (isElizaCoreBrowserDistId(id)) return sourceBrowserEntry;
      if (
        id === "./browser/index.browser.js" &&
        isElizaCoreBrowserDistId(importer)
      ) {
        return sourceBrowserEntry;
      }
      return null;
    },
  };
}

// The dev script sets the branded API port env; default to 31337 for standalone vite dev.
const apiPort = resolveDesktopApiPort(process.env);
const uiPort = resolveDesktopUiPort(process.env);
const viteDevServerRuntime = resolveViteDevServerRuntime(
  process.env,
  uiPort,
  APP_ENV_PREFIX,
);
const enableAppSourceMaps = process.env[BRANDED_ENV.appSourcemap] === "1";
/** Set by eliza/packages/app-core/scripts/dev-platform.mjs for `vite build --watch` (Electrobun desktop). */
const desktopFastDist = process.env[BRANDED_ENV.desktopFastDist] === "1";

function pathIncludesAny(id: string, markers: string[]): boolean {
  return markers.some((marker) => id.includes(marker));
}

function resolveManualChunk(id: string): string | undefined {
  const normalizedId = id.split(path.sep).join("/");

  if (normalizedId.includes("/node_modules/")) {
    if (
      pathIncludesAny(normalizedId, [
        "/@react-spring/",
        "/react-dom/",
        "/react-is/",
        "/scheduler/",
        "/react/",
      ])
    ) {
      return "vendor-react";
    }

    if (normalizedId.includes("/@pixiv/three-vrm/")) {
      return "vendor-vrm";
    }

    // Collapse all three.js code into one chunk to avoid cross-chunk TDZ
    // init ordering bugs with WebGPU/TSL enums (see fix/three-chunk-tdz).
    if (normalizedId.includes("/three/")) {
      return "vendor-three";
    }
  }

  return undefined;
}

/**
 * Dev-only middleware that handles CORS for the desktop custom-scheme origin
 * (electrobun://-). Vite's proxy doesn't reliably forward CORS headers
 * for non-http origins, so we intercept preflight OPTIONS requests and tag
 * every /api response with the correct headers before the proxy layer.
 */
function envFlagEffective(name: string): "on" | "off" {
  return process.env[name] === "1" ? "on" : "off";
}

function envFlagSource(name: string, whenOn = "1"): string {
  const v = process.env[name]?.trim();
  if (v === whenOn || (whenOn === "1" && v === "true"))
    return `env set — ${name}=${v}`;
  return `default (unset — off)`;
}

function buildViteDevSettingsRows(
  mode: "dev-server" | "build-watch",
): DevSettingsRow[] {
  const apiPref = resolveDesktopApiPortPreference(process.env);
  const uiPref = resolveDesktopUiPortPreference(process.env);
  const apiPort = resolveDesktopApiPort(process.env);
  const uiPort = resolveDesktopUiPort(process.env);
  const assetBase =
    process.env.VITE_ASSET_BASE_URL?.trim() ||
    process.env[BRANDED_ENV.assetBaseUrl]?.trim() ||
    "—";

  return [
    {
      setting: BRANDED_ENV.appSourcemap,
      effective: envFlagEffective(BRANDED_ENV.appSourcemap),
      source: envFlagSource(BRANDED_ENV.appSourcemap),
      change: `export ${BRANDED_ENV.appSourcemap}=1 to enable; unset for off`,
    },
    {
      setting: BRANDED_ENV.desktopFastDist,
      effective: envFlagEffective(BRANDED_ENV.desktopFastDist),
      source: envFlagSource(BRANDED_ENV.desktopFastDist),
      change:
        "set by dev orchestrator for Rollup watch; unset for normal dev server",
    },
    {
      setting: BRANDED_ENV.ttsDebug,
      effective: process.env[BRANDED_ENV.ttsDebug]?.trim() ? "set" : "—",
      source: process.env[BRANDED_ENV.ttsDebug]?.trim()
        ? `env set — ${BRANDED_ENV.ttsDebug}`
        : "default (unset)",
      change: `export ${BRANDED_ENV.ttsDebug}=1 for TTS trace logs`,
    },
    {
      setting: `${BRANDED_ENV.settingsDebug} / ${BRANDED_ENV.viteSettingsDebug}`,
      effective:
        process.env[BRANDED_ENV.settingsDebug]?.trim() ||
        process.env[BRANDED_ENV.viteSettingsDebug]?.trim()
          ? "set"
          : "—",
      source: process.env[BRANDED_ENV.viteSettingsDebug]?.trim()
        ? `env set — ${BRANDED_ENV.viteSettingsDebug}`
        : process.env[BRANDED_ENV.settingsDebug]?.trim()
          ? `env set — ${BRANDED_ENV.settingsDebug}`
          : "default (unset)",
      change: `export ${BRANDED_ENV.settingsDebug}=1 or ${BRANDED_ENV.viteSettingsDebug}=1`,
    },
    {
      setting: `VITE_ASSET_BASE_URL / ${BRANDED_ENV.assetBaseUrl}`,
      effective: assetBase,
      source: process.env.VITE_ASSET_BASE_URL?.trim()
        ? "env set — VITE_ASSET_BASE_URL"
        : process.env[BRANDED_ENV.assetBaseUrl]?.trim()
          ? `env set — ${BRANDED_ENV.assetBaseUrl}`
          : "default (unset — empty)",
      change: `export VITE_ASSET_BASE_URL=… or ${BRANDED_ENV.assetBaseUrl}=…`,
    },
    {
      setting: BRANDED_ENV.devPolling,
      effective: envFlagEffective(BRANDED_ENV.devPolling),
      source: envFlagSource(BRANDED_ENV.devPolling),
      change: `export ${BRANDED_ENV.devPolling}=1 for watch polling (VM/file shares)`,
    },
    {
      setting: "API port (resolved)",
      effective: String(apiPort),
      source: apiPref.sourceLabel,
      change: `${apiPref.changeLabel}; proxy /api → http://127.0.0.1:${apiPort}`,
    },
    {
      setting: "UI port (resolved)",
      effective: String(uiPort),
      source: uiPref.sourceLabel,
      change: uiPref.changeLabel,
    },
    {
      setting: "Mode",
      effective:
        mode === "dev-server" ? "vite dev (HMR)" : "vite build --watch",
      source: "derived",
      change:
        mode === "dev-server"
          ? `bun run dev (default); ${APP_ENV_PREFIX}_DESKTOP_VITE_BUILD_WATCH=1 for Rollup watch`
          : `${APP_ENV_PREFIX}_DESKTOP_VITE_WATCH=1 + ${APP_ENV_PREFIX}_DESKTOP_VITE_BUILD_WATCH=1`,
    },
  ];
}

/** Print effective env once per Vite process (dev server or first Rollup watch tick). */
function appDevSettingsBannerPlugin(): Plugin {
  let printedWatch = false;
  return {
    name: "app-dev-settings-banner",
    configureServer() {
      return () => {
        console.log(
          colorizeDevSettingsStartupBanner(
            prependDevSubsystemFigletHeading(
              "vite",
              formatDevSettingsTable(
                "Vite — effective settings (dev server)",
                buildViteDevSettingsRows("dev-server"),
              ),
            ),
          ),
        );
      };
    },
    buildStart() {
      if (process.env[BRANDED_ENV.desktopFastDist] === "1" && !printedWatch) {
        printedWatch = true;
        console.log(
          colorizeDevSettingsStartupBanner(
            prependDevSubsystemFigletHeading(
              "vite",
              formatDevSettingsTable(
                "Vite — effective settings (build --watch)",
                buildViteDevSettingsRows("build-watch"),
              ),
            ),
          ),
        );
      }
    },
  };
}

function desktopCorsPlugin(): Plugin {
  return {
    name: "desktop-cors",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const origin = req.headers.origin;
        if (!origin || !req.url?.startsWith("/api")) return next();

        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET, POST, PUT, DELETE, OPTIONS",
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, X-Eliza-Token, X-Api-Key, X-Eliza-Export-Token, X-Eliza-Client-Id, X-Eliza-Terminal-Token, X-Eliza-UI-Language",
        );

        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }

        next();
      });
    },
  };
}

/**
 * Patch the final bundle output to fix AsyncLocalStorage stubs.
 *
 * Some packages import `{ AsyncLocalStorage } from "node:async_hooks"` at the
 * top level. Vite's dep optimizer and Rollup inline the virtual-module stub
 * as `(()=>({}))`, making AsyncLocalStorage `undefined` and causing
 * `new undefined` → "xte is not a constructor" at runtime in mobile webviews.
 *
 * This plugin replaces the empty-object stub with a proper class in the
 * final rendered chunks.
 */
function asyncLocalStoragePatchPlugin(): Plugin {
  return {
    name: "async-local-storage-patch",
    enforce: "post",
    renderChunk(code) {
      // Match: var{AsyncLocalStorage:<id>}=(()=>({}))
      const re =
        /var\s*\{\s*AsyncLocalStorage\s*:\s*(\w+)\s*\}\s*=\s*\(\s*\(\s*\)\s*=>\s*\(\s*\{\s*\}\s*\)\s*\)/g;
      if (!re.test(code)) return null;
      re.lastIndex = 0;
      const patched = code.replace(re, (_match, id) => {
        // Use block-body arrow + named class — concise arrow with inline
        // anonymous class fails in older WebViews (Chrome 124 and below).
        return `var{AsyncLocalStorage:${id}}=(()=>{function A(){} A.prototype.getStore=function(){return undefined};A.prototype.run=function(s,fn){return fn.apply(void 0,[].slice.call(arguments,2))};A.prototype.enterWith=function(){};A.prototype.disable=function(){};return{AsyncLocalStorage:A}})()`;
      });
      return { code: patched, map: null };
    },
  };
}

function watchWorkspacePackagesPlugin(): Plugin {
  return {
    name: "watch-workspace-packages",
    configureServer(server) {
      server.watcher.add(path.resolve(elizaRoot, "packages"));
      server.watcher.add(nativePluginsRoot);
      server.watcher.on("change", (file) => {
        if (file.includes("/packages/")) {
          if (file.endsWith("package.json")) {
            server.restart();
          } else {
            // Force a full reload on any other package file change (e.g. ts/tsx files)
            server.hot.send({ type: "full-reload" });
          }
        }
      });
    },
  };
}

/**
 * Serve @elizaos/app-companion's public/ assets alongside the app's own
 * public/ directory. In dev the companion dir is served as a fallback
 * middleware; in build the files are copied into the output.
 */
function companionAssetsPlugin(): Plugin {
  const companionPublic = path.resolve(
    elizaRoot,
    "plugins/app-companion/public",
  );
  return {
    name: "companion-assets",
    configureServer(server) {
      // Serve companion public as fallback (after app public)
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();
        const clean = req.url.split("?")[0];
        const filePath = path.join(companionPublic, clean);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          res.setHeader(
            "Content-Type",
            filePath.endsWith(".wasm")
              ? "application/wasm"
              : filePath.endsWith(".js")
                ? "application/javascript"
                : "application/octet-stream",
          );
          fs.createReadStream(filePath).pipe(res);
        } else {
          next();
        }
      });
    },
    closeBundle() {
      // Copy companion public to dist at build time
      if (fs.existsSync(companionPublic)) {
        const outDir = path.resolve(here, "dist");
        fs.cpSync(companionPublic, outDir, { recursive: true, force: false });
      }
    },
  };
}

function workspaceJsxInJsPlugin(): Plugin {
  const normalizedAppCoreSrcRoot = appCoreSrcRoot.split(path.sep).join("/");

  return {
    name: "workspace-jsx-in-js",
    enforce: "pre",
    async transform(code, id) {
      const cleanId = id.split("?")[0];
      const normalizedId = cleanId.split(path.sep).join("/");
      if (!cleanId.endsWith(".js")) return null;
      if (!normalizedId.startsWith(`${normalizedAppCoreSrcRoot}/`)) return null;

      return transformWithEsbuild(code, cleanId, {
        loader: "jsx",
        jsx: "automatic",
        sourcemap: true,
      });
    },
  };
}

export default defineConfig({
  root: here,
  customLogger: viteLogger,
  base: "./",
  // Keep pre-bundle cache under the app dir (not node_modules/.vite) so Bun
  // installs don't fight Vite, and `bun run clean` / docs can target one path.
  cacheDir: path.resolve(here, ".vite"),
  publicDir: path.resolve(here, "public"),
  define: {
    global: "globalThis",
    // Mirror the branded TTS debug env into the client bundle so one env
    // enables UI + server TTS logs in dev.
    [`import.meta.env.${BRANDED_ENV.ttsDebug}`]: JSON.stringify(
      process.env[BRANDED_ENV.ttsDebug] ?? "",
    ),
    [`import.meta.env.${BRANDED_ENV.settingsDebug}`]: JSON.stringify(
      process.env[BRANDED_ENV.settingsDebug] ?? "",
    ),
    [`import.meta.env.${BRANDED_ENV.viteSettingsDebug}`]: JSON.stringify(
      process.env[BRANDED_ENV.viteSettingsDebug] ?? "",
    ),
    "import.meta.env.VITE_ASSET_BASE_URL": JSON.stringify(
      process.env.VITE_ASSET_BASE_URL ??
        process.env[BRANDED_ENV.assetBaseUrl] ??
        "",
    ),
  },
  plugins: [
    appShellMetadataPlugin(),
    companionAssetsPlugin(),
    elizaCoreBrowserEntryFallbackPlugin(),
    nativeModuleStubPlugin({
      isCapacitorMobileBuild: IS_CAPACITOR_MOBILE_BUILD,
      requireModule: _require,
    }),
    asyncLocalStoragePatchPlugin(),
    watchWorkspacePackagesPlugin(),
    workspaceJsxInJsPlugin(),
    tailwindcss(),
    react(),
    desktopCorsPlugin(),
    appDevSettingsBannerPlugin(),
  ],
  oxc: {
    // Override tsconfig target so generated workspace configs cannot push the
    // browser transform beyond the runtime baseline.
    target: "es2022",
  },
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "three",
      "@capacitor/core",
      "@elizaos/app-core",
    ],
    alias: [
      // Bare Node built-in polyfills for browser — pathe provides ESM path,
      // events is pre-bundled via optimizeDeps.
      { find: /^path$/, replacement: patheEntry },
      { find: /^@capacitor\/core$/, replacement: capacitorCoreEntry },
      // Aliases for Capacitor packages that may not be hoisted to root node_modules
      // by bun workspaces. Apps/app resolves them; eliza submodule sources cannot.
      ...(capacitorKeyboardEntry
        ? [
            {
              find: /^@capacitor\/keyboard$/,
              replacement: capacitorKeyboardEntry,
            },
          ]
        : []),
      ...(capacitorPreferencesEntry
        ? [
            {
              find: /^@capacitor\/preferences$/,
              replacement: capacitorPreferencesEntry,
            },
          ]
        : []),
      ...(capacitorAppEntry
        ? [{ find: /^@capacitor\/app$/, replacement: capacitorAppEntry }]
        : []),
      // Keep this subpath on the concrete source file so Docker/Vite builds
      // do not fall back to the extensionless tsconfig wildcard rewrite.
      {
        find: /^@elizaos\/app-core\/platform\/native-plugin-entrypoints$/,
        replacement: appCoreNativePluginEntrypoints,
      },
      {
        find: /^@elizaos\/app-core\/platform\/native-plugin-entrypoints\.js$/,
        replacement: appCoreNativePluginEntrypoints,
      },
      // Keep plugin-sql subpath imports on the repo-local source layout. Some
      // cached package copies still describe the old src/ layout, which makes
      // renderer builds fail before the server-only imports can be stubbed.
      {
        find: /^@elizaos\/plugin-sql\/drizzle$/,
        replacement: path.join(pluginSqlSrcRoot, "drizzle/index.ts"),
      },
      {
        find: /^@elizaos\/plugin-sql\/schema$/,
        replacement: path.join(pluginSqlSrcRoot, "schema/index.ts"),
      },
      {
        find: /^@elizaos\/plugin-sql\/types$/,
        replacement: path.join(pluginSqlSrcRoot, "types.ts"),
      },
      // Keep the migrated browser bridge plugin on local source in renderer
      // builds. It is not an `app-*` route package, so the dynamic app plugin
      // aliases intentionally skip it.
      {
        find: /^@elizaos\/plugin-browser$/,
        replacement: path.join(pluginBrowserBridgeSrcRoot, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-browser\/contracts$/,
        replacement: path.join(pluginBrowserBridgeSrcRoot, "contracts.ts"),
      },
      {
        find: /^@elizaos\/plugin-browser\/schema$/,
        replacement: path.join(pluginBrowserBridgeSrcRoot, "schema.ts"),
      },
      {
        find: /^@elizaos\/plugin-browser\/packaging$/,
        replacement: path.join(pluginBrowserBridgeSrcRoot, "packaging.ts"),
      },
      {
        find: /^@elizaos\/plugin-browser\/routes$/,
        replacement: path.join(pluginBrowserBridgeSrcRoot, "routes.ts"),
      },
      {
        find: /^@elizaos\/plugin-browser\/service$/,
        replacement: path.join(pluginBrowserBridgeSrcRoot, "service.ts"),
      },
      {
        find: /^@elizaos\/plugin-browser\/actions$/,
        replacement: path.join(pluginBrowserBridgeSrcRoot, "actions.ts"),
      },
      {
        find: /^@elizaos\/plugin-browser\/plugin$/,
        replacement: path.join(pluginBrowserBridgeSrcRoot, "plugin.ts"),
      },
      // Node built-in subpaths that browser polyfills don't provide.
      // Server-only code imports these but they're never executed in-browser.
      ...["util/types", "stream/promises", "stream/web"].flatMap((sub) => [
        {
          find: `node:${sub}`,
          replacement: path.join(
            appCoreSrcRoot,
            "platform/empty-node-module.ts",
          ),
        },
        {
          find: sub,
          replacement: path.join(
            appCoreSrcRoot,
            "platform/empty-node-module.ts",
          ),
        },
      ]),
      // Capacitor plugins — resolve to local plugin sources
      ...NATIVE_PLUGIN_ALIAS_ENTRIES,
      // Force local @elizaos/ui source paths when the app bundles linked
      // @elizaos/app-core sources directly.
      {
        find: /^@elizaos\/ui$/,
        replacement: path.join(uiPkgRoot, "src/index.ts"),
      },
      {
        find: /^@elizaos\/ui\/components\/ui\/(.*)$/,
        replacement: `${uiPkgRoot}/src/components/ui/$1.tsx`,
        customResolver: resolveExistingUiSourceModule,
      },
      {
        find: /^@elizaos\/ui\/components\/composites\/([^/]+)$/,
        replacement: `${uiPkgRoot}/src/components/composites/$1/index.ts`,
      },
      {
        find: /^@elizaos\/ui\/components\/composites\/(.+)\/([^/]+)$/,
        replacement: `${uiPkgRoot}/src/components/composites/$1/$2.tsx`,
        customResolver: resolveExistingUiSourceModule,
      },
      {
        find: /^@elizaos\/ui\/components\/(.+)\/([^/]+)$/,
        replacement: `${uiPkgRoot}/src/components/$1/$2.tsx`,
        customResolver: resolveExistingUiSourceModule,
      },
      {
        find: /^@elizaos\/ui\/hooks$/,
        replacement: path.join(uiPkgRoot, "src/hooks/index.ts"),
      },
      {
        find: /^@elizaos\/ui\/hooks\/(.*)$/,
        replacement: `${uiPkgRoot}/src/hooks/$1.ts`,
      },
      {
        find: /^@elizaos\/ui\/layouts$/,
        replacement: path.join(uiPkgRoot, "src/layouts/index.ts"),
      },
      {
        find: /^@elizaos\/ui\/layouts\/([^/]+)$/,
        replacement: `${uiPkgRoot}/src/layouts/$1/index.ts`,
      },
      {
        find: /^@elizaos\/ui\/layouts\/(.+)\/([^/]+)$/,
        replacement: `${uiPkgRoot}/src/layouts/$1/$2.tsx`,
      },
      {
        find: /^@elizaos\/ui\/lib\/(.*)$/,
        replacement: `${uiPkgRoot}/src/lib/$1.ts`,
      },
      {
        find: /^@elizaos\/ui\/styles\/(.*)$/,
        replacement: path.join(uiPkgRoot, "src/styles/$1"),
      },
      // Browser-safe aliases for local app plugin package roots.
      ...createAppPluginBrowserAliases(),
      // Dynamic aliases for local app plugin package subpaths.
      ...createWorkspacePackageAliases([path.resolve(elizaRoot, "plugins")]),
      ...(() => {
        const sharedPkgPath = path.resolve(
          elizaRoot,
          "packages/shared/package.json",
        );
        const sharedPkgDir = path.dirname(sharedPkgPath);
        const sharedPkg = JSON.parse(fs.readFileSync(sharedPkgPath, "utf8"));
        const aliases = [];
        for (const [key, value] of Object.entries(sharedPkg.exports || {})) {
          const exportTarget = resolveSharedSourceExportTarget(
            sharedPkgDir,
            key,
            value,
          );
          if (!exportTarget) continue;
          const aliasKey =
            key === "."
              ? "@elizaos/shared"
              : `@elizaos/shared/${key.replace(/^\.\//, "")}`;
          aliases.push({
            find: new RegExp(`^${escapeRegExp(aliasKey)}$`),
            replacement: exportTarget,
          });
        }
        return aliases;
      })(),
      // Force local @elizaos/app-core when workspace-linked (prevents stale
      // bun cache copies from overriding the symlinked local source).
      ...(() => {
        const appCorePkgPath = path.resolve(
          elizaRoot,
          "packages/app-core/package.json",
        );
        const appCorePkgDir = path.dirname(appCorePkgPath);
        const appCoreBrowserEntry = path.resolve(
          appCorePkgDir,
          "src/browser.ts",
        );
        const appCorePkg = JSON.parse(fs.readFileSync(appCorePkgPath, "utf8"));

        const generatedAliases = [];

        for (const [key, value] of Object.entries(appCorePkg.exports || {})) {
          const exportTarget = resolvePackageExportTarget(value);
          if (!exportTarget) continue;
          const aliasKey =
            key === "."
              ? "@elizaos/app-core"
              : `@elizaos/app-core/${key.replace(/^\.\//, "")}`;
          // Keep the renderer on a browser-safe entry. The package root barrel
          // re-exports server modules that pull Node-only code like sharp into
          // the Vite client graph.
          const targetPath =
            key === "."
              ? appCoreBrowserEntry
              : path.resolve(appCorePkgDir, exportTarget);

          generatedAliases.push({
            find: new RegExp(`^${escapeRegExp(aliasKey)}$`),
            replacement: targetPath,
          });
          // Also map .js extension for users importing it as .js
          if (!aliasKey.endsWith(".js") && !aliasKey.endsWith(".css")) {
            generatedAliases.push({
              find: new RegExp(`^${escapeRegExp(aliasKey)}\\.js$`),
              replacement: targetPath,
            });
          }
        }

        const uiSource = path.resolve(elizaRoot, "packages/ui/src");

        return [
          ...generatedAliases,
          // Fallback: catch any @elizaos/app-core sub-path not covered by the
          // dynamic export-map aliases above (e.g. when the published package
          // uses conditional exports objects and the `typeof value === "string"`
          // guard skips them).  Maps directly to the local src/ tree.
          {
            find: /^@elizaos\/app-core\/(.+)$/,
            replacement: `${appCorePkgDir}/src/$1`,
          },
          {
            find: /^@elizaos\/ui$/,
            replacement: path.join(uiSource, "index.ts"),
          },
          {
            find: /^@elizaos\/ui\/(.*)$/,
            replacement: `${uiSource}/$1`,
            customResolver: resolveExistingTsSourceModule,
          },
          // NOTE: App and UI code should import `@elizaos/agent/<subpath>` only.
          // The package root still resolves to `./src/index.ts`, which pulls in
          // server-only modules. Map the bare specifier to a no-op so the client
          // bundle never traverses that graph.
          {
            find: /^@elizaos\/agent$/,
            replacement: path.join(
              appCoreSrcRoot,
              "platform/empty-node-module.ts",
            ),
          },
          // Fallback for @elizaos/agent sub-path imports (e.g. /autonomy,
          // /contracts/onboarding). The npm-published package may not include
          // all export entries that the local workspace source provides, so
          // resolve sub-paths directly from the local agent source tree.
          {
            find: /^@elizaos\/agent\/(.+)$/,
            replacement: path.resolve(elizaRoot, "packages/agent/src/$1"),
          },
          // @elizaos/core — force ALL copies (including nested ones in plugins
          // that bundle their own older core) to the
          // main workspace copy's browser entry.  The browser entry has all
          // needed exports and avoids pulling in createRequire/node:fs/etc.
          {
            find: /^@elizaos\/core$/,
            replacement: resolveElizaCoreBundlePath(),
          },
        ];
      })(),
    ],
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      // Three.js core + all subpath imports must be pre-bundled together so
      // esbuild shares a single module identity.
      "three",
      "three/examples/jsm/controls/OrbitControls.js",
      "three/examples/jsm/libs/meshopt_decoder.module.js",
      "three/examples/jsm/loaders/DRACOLoader.js",
      "three/examples/jsm/loaders/GLTFLoader.js",
      "three/examples/jsm/loaders/FBXLoader.js",
    ],
    // Remap node: builtins to npm polyfills during dep optimization so
    // Rolldown doesn't externalize them as browser-incompatible node:* imports.
    rolldownOptions: {
      plugins: [
        {
          name: "workspace-jsx-in-js",
          async transform(code, id) {
            const normalizedPath = id.split("?")[0]?.split(path.sep).join("/");
            if (
              !id.endsWith(".js") ||
              !normalizedPath?.startsWith(
                `${appCoreSrcRoot.split(path.sep).join("/")}/`,
              )
            ) {
              return null;
            }

            return transformWithEsbuild(code, id, {
              loader: "jsx",
              jsx: "automatic",
              sourcemap: true,
            });
          },
        },
        {
          name: "node-builtins-polyfill",
          resolveId(source) {
            const polyfills: Record<string, string> = {};
            for (const [nodeId, pkg, entry] of [
              ["node:events", "events", "events.js"],
              ["events", "events", "events.js"],
              ["node:buffer", "buffer", "index.js"],
              ["buffer", "buffer", "index.js"],
              ["node:util", "util", "util.js"],
              ["util", "util", "util.js"],
              ["node:process", "process", "browser.js"],
              ["process", "process", "browser.js"],
              ["node:stream", "stream-browserify", "index.js"],
              ["stream", "stream-browserify", "index.js"],
            ] as const) {
              try {
                const pkgDir = path.dirname(
                  _require.resolve(`${pkg}/package.json`),
                );
                polyfills[nodeId] = path.join(pkgDir, entry);
              } catch {
                // polyfill not installed
              }
            }
            const polyfill = polyfills[source];
            if (polyfill) return polyfill;
            if (source.startsWith("node:")) return `\0node-stub:${source}`;
            return null;
          },
          load(id) {
            if (!id.startsWith("\0node-stub:")) return null;
            return generateNodeBuiltinStub(
              id.slice("\0node-stub:".length),
              _require,
            );
          },
        },
      ],
    },
    exclude: [
      "node-llama-cpp",
      "@node-llama-cpp/mac-arm64-metal",
      // Contains native-only pty-state-capture / pty-console imports; skip pre-bundling.
      "@elizaos/plugin-agent-orchestrator",
      "pty-console",
      // Built-in secrets live in @elizaos/core features; Vite must not externalize them as a separate package.
      // Node-only HTTP client — crashes in browser, stub via nativeModuleStubPlugin
      "undici",
      // Browser automation is server-only and pulls in proxy-agent/httpUtil.
      "puppeteer-core",
      "@puppeteer/browsers",
      // Native LLM embedding — uses node-llama-cpp, never runs in browser
      "@elizaos/plugin-local-embedding",
      // Node-only connector; LifeOps server services may dynamically import it,
      // but the renderer must not parse its Baileys/qrcode-terminal graph.
      "@elizaos/plugin-whatsapp",
      // Native keychain bindings (.node). Dep optimization treats .node as text → UTF-8 error.
      "@napi-rs/keyring",
      // Pulls `@napi-rs/keyring` dynamically; excluding avoids the optimizer crawling native bindings.
      "@elizaos/vault",
      // Vite occasionally invalidates zod's optimized chunk during dev startup,
      // which leaves the UI serving a missing .vite/deps file.
      "zod",
    ],
  },
  build: {
    outDir: path.resolve(here, "dist"),
    // Watch + incremental: avoid wiping dist each cycle; keeps Electrobun reloads fast.
    emptyOutDir: !desktopFastDist,
    sourcemap: desktopFastDist ? false : enableAppSourceMaps,
    target: "es2022",
    // The desktop/web shell intentionally ships a large eagerly-loaded main
    // chunk; warn only when it grows beyond the current known baseline.
    chunkSizeWarningLimit: 5500,
    minify: desktopFastDist ? false : undefined,
    cssMinify: desktopFastDist ? false : undefined,
    reportCompressedSize: !desktopFastDist,
    rolldownOptions: {
      // Native-only deps that must not be resolved during the browser build.
      // Node built-ins (node:fs, fs, path, etc.) are NOT externalized here —
      // they are intercepted by nativeModuleStubPlugin which replaces them
      // with no-op Proxy stubs. Externalizing them causes Rollup to emit
      // bare `import "node:fs"` in output chunks, which the browser rejects
      // with a CSP violation.
      external: (id) => {
        if (
          [
            "pty-state-capture",
            "pty-console",
            "electron",
            "node-llama-cpp",
            "pty-manager",
            // Lazy-imported only by sql-compat's runtime repair path (server-side
            // database column reconciliation). Never reached from the browser
            // bundle, but rolldown's static analyzer still tries to resolve the
            // dynamic import. Externalising prevents resolution; the import will
            // throw at runtime if the repair path ever runs in the renderer
            // (which it shouldn't — that code is database-server-only).
            "drizzle-orm",
            // chalk is used only by @elizaos/shared's terminal theme helpers,
            // which never run in the browser. Same rationale as drizzle-orm.
            "chalk",
          ].includes(id)
        )
          return true;
        if (/^@node-llama-cpp\//.test(id)) return true;
        if (/^@napi-rs\/keyring/.test(id)) return true;
        return false;
      },
      input: {
        main: path.resolve(here, "index.html"),
      },
      output: {
        manualChunks: resolveManualChunk,
      },
    },
  },
  server: {
    host: true,
    port: uiPort,
    strictPort: true,
    // Only pin the dev origin when the desktop shell explicitly asks for a
    // loopback public URL. Capacitor live reload and LAN/browser clients need
    // Vite to keep serving the current request host instead of rewriting
    // module URLs back to 127.0.0.1.
    ...(viteDevServerRuntime.origin
      ? { origin: viteDevServerRuntime.origin }
      : {}),
    hmr: viteDevServerRuntime.hmr,
    cors: {
      origin: true,
      credentials: true,
    },
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        xfwd: true,
        configure: (proxy) => {
          proxy.on("error", (_err, _req, res) => {
            if (!res.headersSent) {
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "API server unavailable" }));
            }
          });
        },
      },
      "/ws": {
        target: `ws://127.0.0.1:${apiPort}`,
        ws: true,
        configure: (proxy) => {
          // Suppress noisy ECONNREFUSED errors during API restart.
          // Clients reconnect automatically via the WS reconnect loop.
          proxy.on("error", () => {});
        },
      },
      // elizaOS plugin-music-player HTTP routes live outside /api (e.g. /music-player/stream).
      "/music-player": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("error", (_err, _req, res) => {
            if (!res.headersSent) {
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "API server unavailable" }));
            }
          });
        },
      },
    },
    fs: {
      // Allow serving files from the app directory and eliza src
      allow: [here, elizaRoot],
    },
    watch: {
      // Polling is only needed in Docker/WSL where native fs events are unreliable
      usePolling: process.env[BRANDED_ENV.devPolling] === "1",
      // Electrobun postBuild copies renderer HTML/assets into electrobun/build/.
      // Watching those paths triggers full reloads while deps are still optimizing,
      // which breaks with "chunk-*.js does not exist" in node_modules/.vite/deps.
      ignored: ["**/electrobun/build/**", "**/electrobun/artifacts/**"],
    },
  },
});
