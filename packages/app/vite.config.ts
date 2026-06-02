import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import {
  createLogger,
  defineConfig,
  type Plugin,
  transformWithOxc,
} from "vite";
import { resolveAppBranding } from "../shared/src/config/app-config.ts";
import { colorizeDevSettingsStartupBanner } from "../shared/src/dev-settings-banner-style.ts";
import { prependDevSubsystemFigletHeading } from "../shared/src/dev-settings-figlet-heading.ts";
import {
  type DevSettingsRow,
  formatDevSettingsTable,
} from "../shared/src/dev-settings-table.ts";
import {
  resolveDesktopApiPort,
  resolveDesktopApiPortPreference,
  resolveDesktopUiPort,
  resolveDesktopUiPortPreference,
} from "../shared/src/runtime-env.ts";
import { syncElizaEnvAliases } from "../shared/src/utils/env.ts";
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
const nativePluginsRoot = path.join(elizaRoot, "plugins");

// Authoritative PascalCase-icon-name → kebab-file map, parsed from lucide's own
// ESM barrel so there is zero name-guessing. Used to rewrite the app's
// `import { X } from "lucide-react"` into per-icon deep imports so only the
// ~130 icons actually used ship instead of the full ~1500-icon set (the barrel
// is not tree-shaken under the directory alias).
let lucideIconFileMap: Map<string, string> | null = null;
function getLucideIconFileMap(): Map<string, string> {
  if (lucideIconFileMap) return lucideIconFileMap;
  const map = new Map<string, string>();
  try {
    const barrelPath = path.resolve(
      elizaRoot,
      "packages/ui/node_modules/lucide-react/dist/esm/lucide-react.mjs",
    );
    const src = fs.readFileSync(barrelPath, "utf8");
    const lineRe =
      /export\s*\{([^}]*)\}\s*from\s*['"]\.\/icons\/([\w-]+)\.mjs['"]/g;
    let m: RegExpExecArray | null = lineRe.exec(src);
    while (m !== null) {
      const file = m[2];
      for (const part of m[1].split(",")) {
        const named = part.trim().match(/default as (\w+)/);
        if (named) map.set(named[1], file);
      }
      m = lineRe.exec(src);
    }
  } catch {
    // Barrel not found / unreadable — leave the map empty so the transform
    // no-ops and imports fall back to the (untransformed) barrel.
  }
  lucideIconFileMap = map;
  return map;
}

// Virtual module id served in place of the bare `lucide-react` barrel for the
// one remaining barrel consumer: the runtime module registry in
// `packages/ui/src/components/views/DynamicViewLoader.tsx`, which does
// `() => import("lucide-react")`. That dynamic import is invisible to the
// static per-icon rewrite, so without this it pulls lucide's full
// `icons/index.mjs` (~1500 icons → ~600KB). The virtual barrel re-exports only
// the icons the app statically imports, so the dynamic chunk shares the same
// curated icon set instead of the whole library.
const LUCIDE_USED_BARREL_ID = "virtual:lucide-react-used";
const LUCIDE_USED_BARREL_RESOLVED = `\0${LUCIDE_USED_BARREL_ID}`;

// The lucide per-icon rewrite is build-only (see the plugin's configResolved).
// In dev the barrel import is kept and pre-bundled, so we skip the rewrite.
let lucideRewriteEnabled = true;

let lucideUsedBarrelSource: string | null = null;
function buildLucideUsedBarrelSource(): string {
  if (lucideUsedBarrelSource !== null) return lucideUsedBarrelSource;
  const map = getLucideIconFileMap();
  // name → file for every icon statically imported anywhere in app source.
  const used = new Map<string, string>();
  const importRe = /import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g;
  const exts = new Set([".ts", ".tsx", ".js", ".jsx"]);
  const roots = ["packages", "plugins", "apps"].map((d) =>
    path.join(elizaRoot, d),
  );
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".git" ||
        entry.name === "benchmarks"
      ) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!exts.has(path.extname(entry.name))) continue;
      let code: string;
      try {
        code = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (!code.includes("lucide-react")) continue;
      let m: RegExpExecArray | null = importRe.exec(code);
      while (m !== null) {
        for (const rawSpec of m[1].split(",")) {
          const spec = rawSpec.trim();
          if (!spec || spec.startsWith("type ")) continue;
          const asMatch = spec.match(/^(\w+)\s+as\s+\w+$/);
          const name = asMatch ? asMatch[1] : spec;
          const file = map.get(name);
          if (file) used.set(name, file);
        }
        m = importRe.exec(code);
      }
    }
  };
  for (const root of roots) walk(root);
  const lines = [...used.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, file]) =>
        `export { default as ${name} } from "lucide-react/dist/esm/icons/${file}.mjs";`,
    );
  lucideUsedBarrelSource = `${lines.join("\n")}\n`;
  return lucideUsedBarrelSource;
}

const NATIVE_PLUGIN_DIR_PREFIX = "plugin-native-";
const appCoreSrcRoot = path.join(elizaRoot, "packages/app-core/src");
const pluginBrowserBridgeSrcRoot = path.join(
  elizaRoot,
  "plugins/plugin-browser/src",
);
const uiPkgRoot = path.join(elizaRoot, "packages/ui");
const capacitorCoreEntry = path.join(
  path.dirname(_require.resolve("@capacitor/core/package.json")),
  "dist/index.js",
);
const patheEntry = _require.resolve("pathe");
// Other Capacitor packages imported by eliza/packages/app-core sources.
// Resolved here (packages/app scope) so Rollup can find them when bundling
// files from within the eliza submodule tree where bun may not hoist them.
function _tryResolve(id: string): string | undefined {
  try {
    return _require.resolve(id);
  } catch {
    return undefined;
  }
}
function tryResolvePackageModuleEntry(id: string): string | undefined {
  try {
    const packageJsonPath = _require.resolve(`${id}/package.json`);
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      module?: unknown;
      main?: unknown;
    };
    const entry =
      typeof pkg.module === "string"
        ? pkg.module
        : typeof pkg.main === "string"
          ? pkg.main
          : undefined;
    return entry ? path.join(path.dirname(packageJsonPath), entry) : undefined;
  } catch {
    return undefined;
  }
}
const capacitorKeyboardEntry = tryResolvePackageModuleEntry(
  "@capacitor/keyboard",
);
const capacitorPreferencesEntry = tryResolvePackageModuleEntry(
  "@capacitor/preferences",
);
const capacitorAppEntry = tryResolvePackageModuleEntry("@capacitor/app");
const json5EsmEntry = path.join(
  path.dirname(_require.resolve("json5/package.json")),
  "dist/index.mjs",
);
// @opentelemetry/api is a transitive runtime dep of @elizaos/core's browser
// bundle (StackContextManager / streaming-context tracing) but is not hoisted
// where packages/app can resolve the bare specifier, so Vite served its ~46
// internal modules raw in dev. Resolve its ESM entry through core's scope and
// alias the bare specifier to it so it can be pre-bundled + deduped to one copy.
const otelApiEntry = (() => {
  // Search candidate roots in priority order:
  // 1. workspace root node_modules (hoisted installs — npm/yarn/bun default)
  // 2. direct require() resolution from packages/app scope
  // 3. core's nested node_modules
  // 4. bun content-addressable store entries for the ai package
  // 5. bun content-addressable store entries for @opentelemetry/api directly
  const candidateRoots: string[] = [];

  // 1. Workspace root — fastest probe, covers most CI environments.
  candidateRoots.push(path.join(elizaRoot, "node_modules"));

  // 2. Direct require() resolution — works when hoisted correctly.
  try {
    const resolved = _require.resolve("@opentelemetry/api/package.json");
    // resolved is the package.json path; parent is the package dir,
    // grandparent is the node_modules root we want.
    candidateRoots.push(path.join(path.dirname(resolved), ".."));
  } catch {
    /* not resolvable from this scope */
  }

  // 3. core's nested node_modules.
  try {
    candidateRoots.push(
      path.join(
        path.dirname(_require.resolve("@elizaos/core/package.json")),
        "node_modules",
      ),
    );
  } catch {
    /* core not resolvable */
  }

  // 4. bun content-addressable store — ai package's nested node_modules.
  try {
    const bunDir = path.join(elizaRoot, "node_modules/.bun");
    if (fs.existsSync(bunDir)) {
      // Collect ALL ai@ entries; there may be multiple hash-variants.
      const aiEntries = fs
        .readdirSync(bunDir)
        .filter((d) => d.startsWith("ai@"));
      for (const aiEntry of aiEntries) {
        candidateRoots.push(path.join(bunDir, aiEntry, "node_modules"));
      }
    }
  } catch {
    /* bun store not accessible */
  }

  // 5. bun content-addressable store — @opentelemetry/api direct entries.
  try {
    const bunDir = path.join(elizaRoot, "node_modules/.bun");
    if (fs.existsSync(bunDir)) {
      const otelEntries = fs
        .readdirSync(bunDir)
        .filter((d) => d.startsWith("@opentelemetry+api@"))
        .sort();
      for (const otelEntry of otelEntries) {
        // Entry may have a nested node_modules/@opentelemetry/api layout or
        // place the package directly at the entry root.
        const withNested = path.join(bunDir, otelEntry, "node_modules");
        const asDirect = path.join(bunDir, otelEntry);
        if (
          fs.existsSync(
            path.join(withNested, "@opentelemetry/api/package.json"),
          )
        ) {
          candidateRoots.push(withNested);
        } else if (fs.existsSync(path.join(asDirect, "package.json"))) {
          // The package itself is at the entry root; its parent is the "root"
          // from which `@opentelemetry/api` resolves if we treat it as `{root}/@opentelemetry/api`.
          // Construct a synthetic path that the loop below can find.
          candidateRoots.push(path.join(bunDir, otelEntry, ".."));
        }
      }
    }
  } catch {
    /* bun store not accessible */
  }

  for (const root of candidateRoots) {
    const pkgJsonPath = path.join(root, "@opentelemetry/api/package.json");
    if (!fs.existsSync(pkgJsonPath)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
        module?: unknown;
        main?: unknown;
      };
      const entry =
        typeof pkg.module === "string"
          ? pkg.module
          : typeof pkg.main === "string"
            ? pkg.main
            : undefined;
      if (entry) return path.join(path.dirname(pkgJsonPath), entry);
    } catch {
      /* bad package.json */
    }
  }
  return undefined;
})();

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

/**
 * The /api proxy fires ECONNREFUSED on every request until the API server
 * finishes booting (~30s in dev). Those errors are transient startup noise —
 * when the API is genuinely down the UI surfaces its own connection errors —
 * so drop them rather than spamming the dev log.
 */
function isExpectedApiProxyConnectError(
  message: unknown,
  error: unknown,
): boolean {
  const text = typeof message === "string" ? message : String(message ?? "");
  if (!text.includes("http proxy error")) {
    return false;
  }
  const code =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  return code === "ECONNREFUSED" || text.includes("ECONNREFUSED");
}

function stringifyBuildLogMessage(message: unknown): string {
  if (!message || typeof message !== "object") {
    return typeof message === "string" ? message : String(message ?? "");
  }
  const record = message as {
    code?: unknown;
    id?: unknown;
    message?: unknown;
    plugin?: unknown;
  };
  return [record.code, record.message, record.id, record.plugin]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function isKnownToleratedBuildWarning(message: unknown): boolean {
  const text = stringifyBuildLogMessage(message);
  if (
    text.includes("Use of direct eval") &&
    text.includes("@electric-sql/pglite")
  ) {
    return true;
  }
  // @elizaos/core's importAiProvider lazy-loads AI SDK providers by string
  // specifier; its /* @vite-ignore */ is stripped by Bun.build's minifier from
  // dist/browser/index.browser.js, so vite:import-analysis re-warns in local
  // mode (the symlinked core realpath has no node_modules segment). Intentional
  // and resolves correctly at runtime.
  if (text.includes("dynamic import cannot be analyzed by Vite")) {
    return true;
  }
  if (!text.includes("INEFFECTIVE_DYNAMIC_IMPORT")) {
    if (!text.includes("dynamically imported")) {
      return false;
    }
    return (
      text.includes("@capacitor/core") ||
      text.includes("@capacitor/preferences") ||
      text.includes("components/views/view-interact-registry.ts")
    );
  }
  return (
    text.includes("../app-core/src/browser.ts") ||
    text.includes("native-stub:node:fs/promises")
  );
}

function iosLocalAgentKernelEsbuildPlugin(): Plugin {
  const targetPath = path
    .join(elizaRoot, "packages/ui/src/api/ios-local-agent-kernel.ts")
    .split(path.sep)
    .join("/");

  return {
    name: "ios-local-agent-kernel-esbuild",
    enforce: "pre",
    async transform(code, id) {
      const normalizedId = id.split("?")[0]?.split(path.sep).join("/");
      if (normalizedId !== targetPath) return null;
      return transformWithOxc(code, id, {
        lang: "ts",
        target: "es2022",
      });
    },
  };
}

const viteLogger = createLogger();
const viteLoggerError = viteLogger.error;
const viteLoggerWarn = viteLogger.warn;
const viteLoggerWarnOnce = viteLogger.warnOnce;
viteLogger.error = (message, options) => {
  if (
    isExpectedWsProxySocketError(message, options?.error) ||
    isExpectedApiProxyConnectError(message, options?.error)
  ) {
    return;
  }
  viteLoggerError(message, options);
};
viteLogger.warn = (message, options) => {
  if (isKnownToleratedBuildWarning(message)) {
    return;
  }
  viteLoggerWarn(message, options);
};
viteLogger.warnOnce = (message, options) => {
  if (isKnownToleratedBuildWarning(message)) {
    return;
  }
  viteLoggerWarnOnce(message, options);
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

function resolveLocalPackageSourceExportTarget(
  packageDir: string,
  exportTarget: string,
): string | null {
  if (!exportTarget.startsWith("./dist/") || !exportTarget.endsWith(".js")) {
    return null;
  }

  const sourceTarget = path.join(
    packageDir,
    "src",
    `${exportTarget.slice("./dist/".length, -".js".length)}.ts`,
  );
  return fs.existsSync(sourceTarget) ? sourceTarget : null;
}

function isAppPluginPackage(
  packageRootName: string,
  entryName: string,
  pkg: Record<string, unknown>,
): boolean {
  if (packageRootName !== "plugins") return true;
  if (entryName.startsWith("app-")) return true;
  const elizaos = pkg.elizaos;
  if (!elizaos || typeof elizaos !== "object") return false;
  return "app" in elizaos;
}

function createWorkspacePackageAliases(packageRoots: string[]) {
  const aliases = [];
  for (const packageRoot of packageRoots) {
    if (!fs.existsSync(packageRoot)) continue;
    const packageRootName = path.basename(packageRoot);
    for (const entry of fs.readdirSync(packageRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = path.join(packageRoot, entry.name, "package.json");
      if (!fs.existsSync(pkgPath)) continue;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<
        string,
        unknown
      >;
      if (!isAppPluginPackage(packageRootName, entry.name, pkg)) continue;
      const pkgName = pkg.name;
      if (typeof pkgName !== "string") continue;
      const pkgExports =
        pkg.exports && typeof pkg.exports === "object"
          ? (pkg.exports as Record<string, unknown>)
          : {};
      const pkgDir = path.dirname(pkgPath);
      for (const [key, value] of Object.entries(pkgExports)) {
        if (key !== ".") continue;
        const exportTarget = resolvePackageExportTarget(value);
        if (!exportTarget) continue;
        aliases.push({
          find: new RegExp(`^${escapeRegExp(pkgName)}$`),
          replacement: path.resolve(pkgDir, exportTarget),
        });
      }
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
    if (!entry.isDirectory()) continue;
    const pkgDir = path.join(pluginsRoot, entry.name);
    const pkgPath = path.join(pkgDir, "package.json");
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<
      string,
      unknown
    >;
    if (!isAppPluginPackage("plugins", entry.name, pkg)) continue;
    const pkgName = pkg.name;
    if (typeof pkgName !== "string") continue;

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
      // Match both `<pkg>/ui` and the explicit `<pkg>/ui/index` form (the
      // latter is what the package.json `./*` export maps to src/ui/index.ts);
      // without `/index` here vite falls through to the unbuilt dist/ui/index.js
      // in dev and the client bundle fails to resolve.
      aliases.push({
        find: new RegExp(`^${escapeRegExp(pkgName)}/ui(?:/index)?$`),
        replacement: candidate,
      });
      break;
    }

    const registerEntry = path.join(pkgDir, "src/register.ts");
    if (fs.existsSync(registerEntry)) {
      aliases.push({
        find: new RegExp(`^${escapeRegExp(pkgName)}/register$`),
        replacement: registerEntry,
      });
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
  "@elizaos/plugin-vincent",
  "@elizaos/plugin-shopify-ui",
  "@elizaos/plugin-steward-app",
  "@elizaos/plugin-lifeops",
  "@elizaos/plugin-github",
  "@elizaos/plugin-computeruse",
  "@elizaos/plugin-elizacloud",
  "@elizaos/plugin-workflow",
];

// Mirror branded app env into ELIZA_* before the shared runtime helpers resolve ports.
syncElizaEnvAliases({
  brandedPrefix: APP_ENV_PREFIX,
  cloudManagedAgentsApiSegment: APP_NAMESPACE,
  appRoutePluginModules: DEFAULT_APP_ROUTE_PLUGIN_MODULES,
});

const NATIVE_PLUGIN_ALIAS_ENTRIES = CAPACITOR_PLUGIN_NAMES.map((name) => ({
  find: new RegExp(`^@elizaos/capacitor-${escapeRegExp(name)}$`),
  replacement: path.join(
    nativePluginsRoot,
    `${NATIVE_PLUGIN_DIR_PREFIX}${name}/src/index.ts`,
  ),
}));
const CAPACITOR_BUILD_TARGET = process.env.ELIZA_CAPACITOR_BUILD_TARGET ?? "";
const IS_CAPACITOR_MOBILE_BUILD =
  CAPACITOR_BUILD_TARGET === "ios" || CAPACITOR_BUILD_TARGET === "android";

function appShellMetadataPlugin(): Plugin {
  const isIosStoreBuild =
    CAPACITOR_BUILD_TARGET === "ios" &&
    (process.env.ELIZA_BUILD_VARIANT === "store" ||
      process.env.ELIZA_RELEASE_AUTHORITY === "apple-app-store");
  const localHttpSources = isIosStoreBuild
    ? ""
    : " http://localhost:* http://127.0.0.1:*";
  const localConnectSources = isIosStoreBuild
    ? ""
    : " http://localhost:* ws://localhost:* wss://localhost:* http://127.0.0.1:* ws://127.0.0.1:* wss://127.0.0.1:*";
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
    ["__APP_CSP_LOCAL_HTTP__", localHttpSources],
    ["__APP_CSP_LOCAL_CONNECT__", localConnectSources],
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
 *
 * Prefer the pre-built `dist/browser/index.browser.js` BUNDLE: one browser-safe
 * artifact (single request, single parse, node: builtins already stripped). The
 * browser SOURCE entry (`src/index.browser.ts`) is the fallback ONLY when no
 * build exists yet (a fresh linked checkout before `bun run build`).
 *
 * Why this order matters: the source entry transitively pulls 400+ individual
 * core source modules, so the renderer paid 400+ HTTP round-trips + on-demand
 * TS transforms AND tried to evaluate core's node:async_hooks / node:fs imports
 * in the browser — minute-long cold loads that frequently never mounted.
 * Serving the one pre-built bundle avoids all of that. The bundle is rebuilt by
 * `bun run build` (and the desktop build watch), so the only thing traded is
 * HMR on the runtime, which the renderer almost never edits.
 */
function resolveElizaCoreBundlePath(): string {
  const pkgDir = tryResolveElizaCorePkgDir();
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
  // Last resort: no built artifact anywhere. Fall back to the browser SOURCE
  // entry so a fresh linked checkout (before `bun run build`) still boots,
  // accepting the slow source-graph load until a build exists.
  const sourceBrowserEntry = resolveElizaCoreSourceBrowserPath();
  if (sourceBrowserEntry) {
    console.warn(
      "[eliza][vite] @elizaos/core has no built dist/; falling back to the browser SOURCE entry " +
        "(src/index.browser.ts). This pulls the full core source graph and is slow — run `bun run build` " +
        "in your eliza checkout to serve the pre-built browser bundle instead.",
    );
    return sourceBrowserEntry;
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
 * dependency graph resolves that shim directly, redirect it to the best browser
 * entry so Vite never follows the missing relative import.
 */
function elizaCoreBrowserEntryFallbackPlugin(): Plugin {
  return {
    name: "eliza-core-browser-entry-fallback",
    enforce: "pre",
    resolveId(id, importer) {
      const browserEntry = resolveElizaCoreBundlePath();
      if (isElizaCoreBrowserDistId(id)) return browserEntry;
      if (
        id === "./browser/index.browser.js" &&
        isElizaCoreBrowserDistId(importer)
      ) {
        return browserEntry;
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

function appDevWsBasePlugin(): Plugin {
  const wsBase = `ws://127.0.0.1:${apiPort}`;
  const brandedWsBaseKey = `__${APP_ENV_PREFIX}_WS_BASE__`;

  return {
    name: "eliza-dev-ws-base",
    apply: "serve",
    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { type: "text/javascript" },
          injectTo: "head-prepend",
          children: [
            `window.__ELIZA_WS_BASE__ = ${JSON.stringify(wsBase)};`,
            `window.__ELIZAOS_WS_BASE__ = ${JSON.stringify(wsBase)};`,
            `window[${JSON.stringify(brandedWsBaseKey)}] = ${JSON.stringify(wsBase)};`,
          ].join("\n"),
        },
      ];
    },
  };
}

function pathIncludesAny(id: string, markers: string[]): boolean {
  return markers.some((marker) => id.includes(marker));
}

function resolveManualChunk(id: string): string | undefined {
  const normalizedId = id.split(path.sep).join("/");

  // The lucide-per-icon-imports plugin rewrites every `import { X } from
  // "lucide-react"` to a deep `lucide-react/dist/esm/icons/<file>.mjs` import,
  // and redirects the runtime registry's dynamic `import("lucide-react")` to a
  // virtual barrel that re-exports only the used icons. Each icon module is its
  // own ES module, so without a grouping rule Rolldown emits one tiny chunk per
  // icon. Collapse the used icons + their shared `createLucideIcon` helper + the
  // virtual barrel's re-export entry into a single chunk; the full barrel is
  // never imported, so the unused icons never enter the graph.
  if (
    normalizedId.includes("/lucide-react/dist/esm/icons/") ||
    normalizedId.includes("/lucide-react/dist/esm/createLucideIcon.mjs") ||
    normalizedId.includes(LUCIDE_USED_BARREL_ID)
  ) {
    return "vendor-lucide";
  }

  // Phonemizer (eSpeak NG WASM, ~1.3MB) is dynamically imported through the
  // kokoro `phonemizer.ts` adapter (packages/shared/.../kokoro/phonemizer.ts).
  // Because that adapter is the dynamic-import boundary, Rolldown otherwise emits
  // a second async chunk auto-named "phonemizer" and inlines its own copy of the
  // npm package — shipping eSpeak NG twice (a "phonemizer" chunk *and* a
  // "vendor-phonemizer" chunk). Routing BOTH the npm package and the adapter
  // source to one chunk collapses them into a single ~650KB (brotli) chunk.
  // Kept outside the /node_modules/ gate below so the adapter source matches too.
  if (
    normalizedId.includes("/phonemizer/") ||
    normalizedId.includes("/kokoro/phonemizer")
  ) {
    return "vendor-phonemizer";
  }

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

    // Collapse all three.js code (three.module, three.webgpu, three.tsl,
    // three.core, three/examples, three/addons) into one shared async chunk to
    // avoid cross-chunk TDZ init ordering bugs with WebGPU/TSL enums (see
    // fix/three-chunk-tdz) and to keep three out of the eager entry chunk.
    if (normalizedId.includes("/three/")) {
      return "vendor-three";
    }

    if (pathIncludesAny(normalizedId, ["/draco3d/", "/draco3dgltf/"])) {
      return "vendor-draco";
    }
    if (normalizedId.includes("/lucide-react/")) {
      return "vendor-lucide";
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

function isIgnoredWorkspaceGeneratedOutput(normalizedFile: string): boolean {
  return (
    normalizedFile.includes("/packages/app/.vite/") ||
    normalizedFile.includes("/.turbo/") ||
    normalizedFile.includes("/.wrangler/") ||
    normalizedFile.includes("/packages/agent/data/") ||
    normalizedFile.includes("/packages/agent/.elizadb/") ||
    normalizedFile.includes("/packages/examples/") ||
    normalizedFile.includes("/packages/feed/") ||
    normalizedFile.includes("/output/generated-cad/") ||
    normalizedFile.includes("/packages/robot/") ||
    normalizedFile.includes("/src/i18n/generated/") ||
    normalizedFile.endsWith(".d.ts") ||
    normalizedFile.endsWith(".d.ts.map") ||
    normalizedFile.endsWith(".log") ||
    normalizedFile.endsWith(".md") ||
    normalizedFile.endsWith(".tsbuildinfo") ||
    /^.*\/packages\/.*\/dist\//.test(normalizedFile)
  );
}

function watchWorkspacePackagesPlugin(): Plugin {
  return {
    name: "watch-workspace-packages",
    configureServer(server) {
      const watcherStartedAt = Date.now();
      const seenMtimes = new Map<string, number>();
      // Watch ONLY workspace package.json manifests — an alias/dependency change
      // there needs a full Vite restart. We deliberately do NOT add the entire
      // packages/ + plugins/ trees: that re-globbed ~45k files (including ~1GB of
      // benchmarks/os), bypassed server.watch.ignored, risked exhausting
      // fs.inotify watches, and — via the old blanket full-reload below — turned
      // every workspace source edit into a full page reload instead of HMR.
      // Imported workspace *source* is already watched through Vite's module
      // graph, so React Fast Refresh / HMR handles those edits natively.
      const workspaceManifests: string[] = [];
      for (const root of [
        path.resolve(elizaRoot, "packages"),
        nativePluginsRoot,
      ]) {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const manifest = path.join(root, entry.name, "package.json");
          if (fs.existsSync(manifest)) workspaceManifests.push(manifest);
        }
      }
      server.watcher.add(workspaceManifests);
      server.watcher.on("change", (file) => {
        // Source edits are handled by Vite's own HMR / Fast Refresh; only a
        // workspace manifest change forces a full server restart.
        if (!file.endsWith("package.json")) return;
        const normalizedFile = file.split(path.sep).join("/");
        if (isIgnoredWorkspaceGeneratedOutput(normalizedFile)) return;
        const stat = fs.statSync(file, { throwIfNoEntry: false });
        if (!stat) return;
        if (stat.mtimeMs < watcherStartedAt - 1000) return;
        if (seenMtimes.get(normalizedFile) === stat.mtimeMs) return;
        seenMtimes.set(normalizedFile, stat.mtimeMs);
        server.restart();
      });
    },
  };
}

/**
 * Serve @elizaos/plugin-companion's public/ assets alongside the app's own
 * public/ directory. In dev the companion dir is served as a fallback
 * middleware; in build the files are copied into the output.
 */
function companionAssetsPlugin(): Plugin {
  const companionPublic = path.resolve(
    elizaRoot,
    "plugins/plugin-companion/public",
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

      return transformWithOxc(code, cleanId, {
        lang: "jsx",
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
  // ELIZA_VITE_CACHE_DIR lets a parallel dev/measurement server use an isolated
  // dep-optimize cache so it never invalidates the primary server's cache.
  cacheDir: process.env.ELIZA_VITE_CACHE_DIR
    ? path.resolve(process.env.ELIZA_VITE_CACHE_DIR)
    : path.resolve(here, ".vite"),
  publicDir: path.resolve(here, "public"),
  define: {
    global: "globalThis",
    // Build variant — set at signing time by desktop-build.mjs and embedded
    // here so the renderer can branch on store vs direct without an API call.
    __ELIZA_BUILD_VARIANT__: JSON.stringify(
      process.env.ELIZA_BUILD_VARIANT === "store" ? "store" : "direct",
    ),
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
    {
      // lucide-react ships ~1500 icons but the app uses ~130. The barrel is not
      // tree-shaken (the directory alias hides the package's sideEffects:false,
      // so Rolldown keeps every ./icons/*.mjs), shipping a ~600KB chunk. Rewrite
      // each `import { X } from "lucide-react"` in source to a per-icon deep
      // import so only the used icons survive. The name→file map is parsed from
      // lucide's own barrel, so resolution is authoritative; any name not in the
      // map (e.g. a type-only import) leaves that statement untouched.
      //
      // The one consumer the static rewrite cannot reach is the runtime module
      // registry's dynamic `() => import("lucide-react")`
      // (packages/ui/.../DynamicViewLoader.tsx). A dynamic import pulls the full
      // barrel → icons/index.mjs → all ~1500 icons. Redirect that (and any
      // surviving static bare-barrel import) to a virtual module that re-exports
      // only the statically-used icons, so the dynamic chunk shares the same
      // curated set instead of the whole library.
      name: "lucide-per-icon-imports",
      enforce: "pre" as const,
      // The per-icon rewrite trades one barrel import for ~250 deep per-icon
      // imports. That is correct for the production bundle (tree-shaking) but in
      // dev it explodes into ~250 separate raw module round-trips on every cold
      // load. In dev we instead leave the barrel import intact and pre-bundle
      // `lucide-react` once via optimizeDeps.include (bundle size is irrelevant
      // for the dev server), so the rewrite is build-only.
      configResolved(resolved: { command: string }) {
        lucideRewriteEnabled = resolved.command === "build";
      },
      resolveId(source: string) {
        if (source === LUCIDE_USED_BARREL_ID)
          return LUCIDE_USED_BARREL_RESOLVED;
        return null;
      },
      load(id: string) {
        if (id === LUCIDE_USED_BARREL_RESOLVED) {
          return buildLucideUsedBarrelSource();
        }
        return null;
      },
      transform(code: string, id: string) {
        if (!lucideRewriteEnabled) return null;
        if (id.includes("/node_modules/")) return null;
        if (!code.includes("lucide-react")) return null;
        const map = getLucideIconFileMap();
        if (map.size === 0) return null;
        let changed = false;
        let out = code.replace(
          /import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"];?/g,
          (full: string, inner: string) => {
            const specs = inner
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            const valueLines: string[] = [];
            const typeSpecs: string[] = [];
            for (const spec of specs) {
              // `type X` specs are erased at build — keep them as a type-only
              // import so they never pull the runtime barrel.
              if (spec.startsWith("type ")) {
                typeSpecs.push(spec.slice(5).trim());
                continue;
              }
              const asMatch = spec.match(/^(\w+)\s+as\s+(\w+)$/);
              const name = asMatch ? asMatch[1] : spec;
              const local = asMatch ? asMatch[2] : spec;
              const file = map.get(name);
              // A non-type value that isn't an icon (e.g. createLucideIcon) →
              // leave the whole statement untouched so nothing breaks.
              if (!file) return full;
              valueLines.push(
                `import ${local} from "lucide-react/dist/esm/icons/${file}.mjs";`,
              );
            }
            changed = true;
            if (typeSpecs.length > 0) {
              valueLines.push(
                `import type { ${typeSpecs.join(", ")} } from "lucide-react";`,
              );
            }
            return valueLines.join("\n");
          },
        );
        // Redirect dynamic `import("lucide-react")` to the curated virtual
        // barrel — that dynamic import is the registry fallback the static
        // rewrite can't see, and it otherwise pulls the full icon set. Type-only
        // imports (`import type { … } from "lucide-react"`) are left on the real
        // package because they are erased before bundling and never contribute
        // runtime code. Deep `lucide-react/…` specifiers keep a `/` after the
        // package name, so the exact-match below skips them.
        out = out.replace(/\bimport\s*\(\s*(['"])lucide-react\1\s*\)/g, () => {
          changed = true;
          return `import("${LUCIDE_USED_BARREL_ID}")`;
        });
        return changed ? { code: out, map: null } : null;
      },
    },
    appShellMetadataPlugin(),
    appDevWsBasePlugin(),
    companionAssetsPlugin(),
    elizaCoreBrowserEntryFallbackPlugin(),
    nativeModuleStubPlugin({
      isCapacitorMobileBuild: IS_CAPACITOR_MOBILE_BUILD,
      requireModule: _require,
    }),
    asyncLocalStoragePatchPlugin(),
    // @opentelemetry/api is imported by `ai@6+` but is not hoisted to the
    // workspace root under Bun canary's content-addressable store layout.
    // resolve.alias covers it when otelApiEntry is found at config time, but
    // when the store layout differs (e.g. CI Docker smoke) the alias is absent
    // and Vite emits a hard "Rollup failed to resolve" error for node_modules
    // imports before the rolldownOptions plugin layer can intercept them.
    // This top-level Vite plugin intercepts the specifier unconditionally so
    // the alias (when present) or the no-op stub (when absent) always wins.
    {
      name: "otel-api-resolver",
      enforce: "pre" as const,
      resolveId(id: string) {
        if (id !== "@opentelemetry/api") return null;
        if (otelApiEntry) return otelApiEntry;
        return "\0otel-api-stub";
      },
      load(id: string) {
        if (id !== "\0otel-api-stub") return null;
        // Minimal no-op stub satisfying the named exports that `ai` reads at
        // import time: trace, context, propagation, metrics, diag,
        // SpanStatusCode, SpanKind, ROOT_CONTEXT, createContextKey,
        // defaultTextMapPropagator, isSpanContextValid, INVALID_SPAN_CONTEXT,
        // INVALID_TRACER_PROVIDER.
        return `
export const trace = { getTracer: () => ({ startSpan: () => ({end(){},setAttribute(){},setStatus(){},recordException(){},isRecording:()=>false}), startActiveSpan: (_n, _o, _ctx, fn) => { const f = typeof _ctx === 'function' ? _ctx : fn; return f && f({end(){},setAttribute(){},setStatus(){},recordException(){},isRecording:()=>false}); } }) };
export const context = { active: () => ({}), with: (_c, fn) => fn(), bind: (_c, fn) => fn };
export const propagation = { inject: () => {}, extract: (_c, carrier) => _c, fields: () => [] };
export const metrics = { getMeter: () => ({ createCounter: () => ({ add(){} }), createHistogram: () => ({ record(){} }), createGauge: () => ({ record(){} }), createObservableGauge: () => ({}) }) };
export const diag = { setLogger: () => {}, error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, verbose: () => {} };
export const SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 };
export const SpanKind = { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 };
export const ROOT_CONTEXT = {};
export const createContextKey = (name) => Symbol(name);
export const defaultTextMapPropagator = { inject: () => {}, extract: (_c, carrier) => _c, fields: () => [] };
export const isSpanContextValid = () => false;
export const INVALID_SPAN_CONTEXT = {};
export const INVALID_TRACER_PROVIDER = {};
`;
      },
    },
    iosLocalAgentKernelEsbuildPlugin(),
    watchWorkspacePackagesPlugin(),
    workspaceJsxInJsPlugin(),
    tailwindcss(),
    react(),
    desktopCorsPlugin(),
    appDevSettingsBannerPlugin(),
    visualizer({
      filename: "dist/stats.html",
      template: "treemap",
      gzipSize: true,
      brotliSize: true,
      emitFile: false,
    }) as Plugin,
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
      "zod",
      "@opentelemetry/api",
    ],
    alias: [
      ...(otelApiEntry
        ? [{ find: /^@opentelemetry\/api$/, replacement: otelApiEntry }]
        : []),
      // Bare Node built-in polyfills for browser — pathe provides ESM path,
      // events is pre-bundled via optimizeDeps.
      { find: /^path$/, replacement: patheEntry },
      {
        find: /^fast-redact$/,
        replacement: path.resolve(here, "src/shims/fast-redact.ts"),
      },
      {
        find: /^cron-parser$/,
        replacement: path.resolve(here, "src/shims/cron-parser.ts"),
      },
      {
        find: /^picocolors$/,
        replacement: path.resolve(here, "src/shims/picocolors.ts"),
      },
      {
        find: /^mammoth$/,
        replacement: path.resolve(here, "src/shims/mammoth.ts"),
      },
      {
        find: /^unpdf$/,
        replacement: path.resolve(here, "src/shims/unpdf.ts"),
      },
      {
        find: /^react-plaid-link$/,
        replacement: path.resolve(here, "src/shims/react-plaid-link.ts"),
      },
      {
        find: /^handlebars$/,
        replacement: path.resolve(here, "src/shims/handlebars.ts"),
      },
      {
        find: /^@vercel\/oidc$/,
        replacement: path.resolve(here, "src/shims/vercel-oidc.ts"),
      },
      {
        find: /^use-sync-external-store\/shim$/,
        replacement: path.resolve(here, "src/shims/use-sync-external-store.ts"),
      },
      { find: /^json5$/, replacement: json5EsmEntry },
      {
        // Per-icon deep imports (emitted by the lucide-per-icon-imports plugin)
        // resolve here — the exact alias below only matches the bare specifier.
        find: /^lucide-react\/(.*)$/,
        replacement: `${path.resolve(elizaRoot, "packages/ui/node_modules/lucide-react")}/$1`,
      },
      {
        find: /^lucide-react$/,
        replacement: path.resolve(
          elizaRoot,
          "packages/ui/node_modules/lucide-react",
        ),
      },
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
      // Keep the migrated browser bridge plugin on local source in renderer
      // builds. It is not an `app-*` route package, so the dynamic app plugin
      // aliases intentionally skip it.
      {
        find: /^@elizaos\/plugin-browser$/,
        replacement: path.join(pluginBrowserBridgeSrcRoot, "index.ts"),
      },
      // Side-effect app modules are loaded by the renderer only to register
      // UI surfaces/pages. Route handlers and runtime services stay server-side.
      ...[
        ["@elizaos/plugin-feed", "plugins/plugin-feed/src/ui/index.ts"],
        ["@elizaos/plugin-scape", "plugins/plugin-scape/src/ui/index.ts"],
        [
          "@elizaos/plugin-hyperscape",
          "plugins/plugin-hyperscape/src/ui/index.ts",
        ],
        [
          "@elizaos/plugin-2004scape",
          "plugins/plugin-2004scape/src/ui/index.ts",
        ],
        [
          "@elizaos/plugin-defense-of-the-agents",
          "plugins/plugin-defense-of-the-agents/src/ui/index.ts",
        ],
        [
          "@elizaos/plugin-clawville",
          "plugins/plugin-clawville/src/ui/index.ts",
        ],
        [
          "@elizaos/plugin-trajectory-logger",
          "plugins/plugin-trajectory-logger/src/register.ts",
        ],
        [
          "@elizaos/plugin-shopify-ui",
          "plugins/plugin-shopify-ui/src/register.ts",
        ],
        [
          "@elizaos/plugin-hyperliquid-app",
          "plugins/plugin-hyperliquid-app/src/register.ts",
        ],
        [
          "@elizaos/plugin-polymarket-app",
          "plugins/plugin-polymarket-app/src/register.ts",
        ],
        ["@elizaos/plugin-wallet-ui", "plugins/plugin-wallet-ui/src/index.ts"],
        [
          "@elizaos/plugin-contacts/register",
          "plugins/plugin-contacts/src/register.ts",
        ],
        [
          "@elizaos/plugin-device-settings/register",
          "plugins/plugin-device-settings/src/register.ts",
        ],
        [
          "@elizaos/plugin-messages/register",
          "plugins/plugin-messages/src/register.ts",
        ],
        [
          "@elizaos/plugin-phone/register",
          "plugins/plugin-phone/src/register.ts",
        ],
        [
          "@elizaos/plugin-task-coordinator/register",
          "plugins/plugin-task-coordinator/src/register.ts",
        ],
        [
          "@elizaos/plugin-wifi/register",
          "plugins/plugin-wifi/src/register.ts",
        ],
        [
          "@elizaos/plugin-facewear/register",
          "plugins/plugin-facewear/src/register.ts",
        ],
      ].map(([pkgName, relativeEntry]) => ({
        find: new RegExp(`^${escapeRegExp(pkgName)}$`),
        replacement: path.resolve(elizaRoot, relativeEntry),
      })),
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
        replacement: path.join(uiPkgRoot, "src/browser.ts"),
      },
      {
        find: /^@elizaos\/ui\/styles$/,
        replacement: path.join(uiPkgRoot, "src/styles.ts"),
      },
      {
        find: /^@elizaos\/ui\/(.+)$/,
        replacement: path.join(uiPkgRoot, "src/$1"),
      },
      {
        find: /^@elizaos\/shared\/brand$/,
        replacement: path.resolve(
          elizaRoot,
          "packages/shared/src/brand/index.ts",
        ),
      },
      // The LifeOps package root also exports server/service internals.
      // The renderer only needs the UI facade; keep it off Discord/native deps.
      {
        find: /^@elizaos\/plugin-lifeops$/,
        replacement: path.resolve(
          elizaRoot,
          "plugins/plugin-lifeops/src/ui.ts",
        ),
      },
      // The Steward app package root includes wallet route handlers and
      // server-side signing services. The renderer imports only these views.
      {
        find: /^@elizaos\/plugin-steward-app$/,
        replacement: path.resolve(
          elizaRoot,
          "plugins/plugin-steward-app/src/ui.ts",
        ),
      },
      // The training package root exports runtime routes and native backends.
      // The renderer only needs the fine-tuning UI facade.
      {
        find: /^@elizaos\/plugin-training$/,
        replacement: path.resolve(
          elizaRoot,
          "plugins/plugin-training/src/ui/index.ts",
        ),
      },
      // plugin-health is a backend-only plugin (no `elizaos.app`), so it gets no
      // auto-generated browser alias. Its `ui/` directory ships browser-safe
      // assistant-command metadata that the LifeOps renderer imports, so the
      // `/ui` subpath needs an explicit alias to its source entry.
      {
        find: /^@elizaos\/plugin-health\/ui$/,
        replacement: path.resolve(
          elizaRoot,
          "plugins/plugin-health/src/ui/index.ts",
        ),
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
          if (!key.startsWith(".") || key.includes("*")) continue;
          const exportTarget = resolveSharedSourceExportTarget(
            sharedPkgDir,
            key,
            value,
          );
          if (!exportTarget) continue;
          const subpath = key === "." ? "" : key.slice(1);
          aliases.push({
            find: new RegExp(`^${escapeRegExp(`@elizaos/shared${subpath}`)}$`),
            replacement: exportTarget,
          });
        }
        return aliases;
      })(),
      ...(() => {
        const cloudSdkSrcDir = path.resolve(
          elizaRoot,
          "packages/cloud-sdk/src",
        );
        if (!fs.existsSync(path.join(cloudSdkSrcDir, "index.ts"))) {
          return [];
        }
        return [
          {
            find: /^@elizaos\/cloud-sdk$/,
            replacement: path.join(cloudSdkSrcDir, "index.ts"),
          },
          {
            find: /^@elizaos\/cloud-sdk\/cloud-setup-session$/,
            replacement: path.join(
              cloudSdkSrcDir,
              "cloud-setup-session/index.ts",
            ),
          },
          {
            find: /^@elizaos\/cloud-sdk\/cloud-setup-session\/(.+)$/,
            replacement: path.join(cloudSdkSrcDir, "cloud-setup-session/$1.ts"),
          },
        ];
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
          if (key === ".") {
            // Keep the renderer on a browser-safe entry. The package root
            // barrel re-exports server modules that pull Node-only code like
            // sharp into the Vite client graph.
            generatedAliases.push({
              find: new RegExp(`^${escapeRegExp("@elizaos/app-core")}$`),
              replacement: appCoreBrowserEntry,
            });
            continue;
          }

          if (!key.startsWith("./")) continue;
          const sourceTarget = resolveLocalPackageSourceExportTarget(
            appCorePkgDir,
            exportTarget,
          );
          if (!sourceTarget) continue;
          generatedAliases.push({
            find: new RegExp(
              `^${escapeRegExp(`@elizaos/app-core/${key.slice(2)}`)}$`,
            ),
            replacement: sourceTarget,
          });
        }

        const uiSource = path.resolve(elizaRoot, "packages/ui/src");

        return [
          ...generatedAliases,
          {
            find: /^@elizaos\/ui$/,
            replacement: path.join(uiSource, "browser.ts"),
          },
          {
            find: /^@elizaos\/ui\/(.+)$/,
            replacement: path.join(uiSource, "$1"),
          },
          {
            find: /^@elizaos\/app-core\/first-run\/first-run-config$/,
            replacement: path.join(
              appCoreSrcRoot,
              "first-run/first-run-config.ts",
            ),
          },
          {
            find: /^@elizaos\/app-core\/api\/ios-local-agent-transport$/,
            replacement: path.join(
              appCoreSrcRoot,
              "api/ios-local-agent-transport.ts",
            ),
          },
          {
            find: /^@elizaos\/agent$/,
            replacement: path.join(
              appCoreSrcRoot,
              "platform/empty-node-module.ts",
            ),
          },
          // @elizaos/plugin-elizacloud — the plugin ships a deliberately
          // minimal browser facade (`dist/browser/index.browser.js`) that
          // only exports the plugin descriptor + a couple of error classes.
          // `app-core/dist/api/server.js` re-exports several server-only
          // helpers (`__resetCloudBaseUrlCache`, `ensureCloudTtsApiKeyAlias`,
          // `clearCloudSecrets`, `resolveCloudTtsBaseUrl`, etc.) from the
          // plugin; without an alias Rolldown errors with MISSING_EXPORT
          // when bundling that re-export chain for the renderer. Route the
          // import to the local browser stub, which already provides all of
          // those names as no-ops (see `platform/empty-node-module.ts`).
          {
            find: /^@elizaos\/plugin-elizacloud$/,
            replacement: path.join(
              appCoreSrcRoot,
              "platform/empty-node-module.ts",
            ),
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
    noDiscovery: process.env.ELIZA_APP_VITE_NO_DISCOVERY !== "0",
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      // Three.js core + all subpath imports must be pre-bundled together so
      // esbuild shares a single module identity.
      "three",
      "three/examples/jsm/controls/OrbitControls.js",
      "three/examples/jsm/libs/meshopt_decoder.module.js",
      "three/examples/jsm/loaders/DRACOLoader.js",
      "three/examples/jsm/loaders/GLTFLoader.js",
      "three/examples/jsm/loaders/FBXLoader.js",
      // Browser-safe deps that are otherwise served raw, file-by-file in dev
      // (noDiscovery is on, so only this list is pre-bundled). Each entry here
      // collapses dozens of cold-load module round-trips into one bundled chunk.
      // lucide-react alone is ~250 per-icon requests once the build-only
      // per-icon rewrite is disabled in dev; the rest are multi-file ESM libs.
      "lucide-react",
      "yaml",
      "uuid",
      "adze",
      // zod was historically excluded over a Vite dep-optimize chunk
      // invalidation that 404'd the optimized chunk mid-startup. Retested on
      // Vite v8 + Rolldown (8 rapid reloads + 5 cold starts): no chunk 404/504
      // and no forced re-optimize reload. Including it collapses ~90 raw
      // per-load module round-trips (zod v4 core + all locales) into one chunk.
      // zod/v3 and zod/v4 are separate package entry points: a few sources
      // import "zod/v3" (the v3 compat surface) directly, which the bare "zod"
      // pre-bundle does not cover, so pre-bundle those subpaths too.
      "zod",
      "zod/v3",
      "zod/v4",
      // Resolvable via the resolve.alias above (transitive through @elizaos/core).
      "@opentelemetry/api",
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

            return transformWithOxc(code, id, {
              lang: "jsx",
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
      // chalk + drizzle-orm: Node-only deps that never run in the
      // renderer. Excluded from dep-optimisation so the
      // nativeModuleStubPlugin can replace them at resolve-time with
      // browser-safe Proxy stubs (otherwise rolldown emits a bare
      // `import "chalk"` that the browser can't resolve).
      "chalk",
      "drizzle-orm",
      "drizzle-orm/pg-core",
      "drizzle-orm/pglite",
      "drizzle-orm/neon-http",
      // Built-in secrets live in @elizaos/core features; Vite must not externalize them as a separate package.
      // Node-only HTTP client — crashes in browser, stub via nativeModuleStubPlugin
      "undici",
      // Browser automation is server-only and pulls in proxy-agent/httpUtil.
      "puppeteer-core",
      "@puppeteer/browsers",
      // Native LLM embedding — uses node-llama-cpp, never runs in browser
      "@elizaos/plugin-local-inference",
      // Node-only connector; LifeOps server services may dynamically import it,
      // but the renderer must not parse its Baileys/qrcode-terminal graph.
      "@elizaos/plugin-whatsapp",
      // Native keychain bindings (.node). Dep optimization treats .node as text → UTF-8 error.
      "@napi-rs/keyring",
      // Pulls `@napi-rs/keyring` dynamically; excluding avoids the optimizer crawling native bindings.
      "@elizaos/vault",
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
      plugins: [
        // Rolldown build-phase resolver for @opentelemetry/api.
        // The `ai` package imports @opentelemetry/api but it is not hoisted to
        // the workspace root in bun canary's content-addressable layout. The
        // resolve.alias above covers the case when otelApiEntry is resolved, but
        // when the bun store layout differs in CI the alias may be absent.
        // This plugin is a safety net: it resolves the bare specifier to the
        // same entry the alias would use, falling back to a no-op stub.
        ...(otelApiEntry
          ? [
              {
                name: "otel-api-build-resolver",
                resolveId(id: string) {
                  if (id === "@opentelemetry/api") return otelApiEntry;
                  return null;
                },
              },
            ]
          : [
              {
                name: "otel-api-build-stub",
                resolveId(id: string) {
                  if (id === "@opentelemetry/api") return "\0otel-api-stub";
                  return null;
                },
                load(id: string) {
                  if (id === "\0otel-api-stub") {
                    // Minimal no-op that satisfies the `trace`, `context`,
                    // `propagation`, `metrics`, `diag`, `SpanStatusCode` and
                    // `SpanKind` named exports that `ai` reads at import time.
                    return `
export const trace = { getTracer: () => ({ startSpan: () => ({end(){},setAttribute(){},setStatus(){},recordException(){},isRecording:()=>false}), startActiveSpan: (_n, _o, _ctx, fn) => { const f = typeof _ctx === 'function' ? _ctx : fn; return f && f({end(){},setAttribute(){},setStatus(){},recordException(){},isRecording:()=>false}); } }) };
export const context = { active: () => ({}), with: (_c, fn) => fn(), bind: (_c, fn) => fn };
export const propagation = { inject: () => {}, extract: (_c, carrier) => _c, fields: () => [] };
export const metrics = { getMeter: () => ({ createCounter: () => ({ add(){} }), createHistogram: () => ({ record(){} }), createGauge: () => ({ record(){} }), createObservableGauge: () => ({}) }) };
export const diag = { setLogger: () => {}, error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, verbose: () => {} };
export const SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 };
export const SpanKind = { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 };
export const ROOT_CONTEXT = {};
export const createContextKey = (name) => Symbol(name);
export const defaultTextMapPropagator = { inject: () => {}, extract: (_c, carrier) => _c, fields: () => [] };
export const isSpanContextValid = () => false;
export const INVALID_SPAN_CONTEXT = {};
export const INVALID_TRACER_PROVIDER = {};
`;
                  }
                  return null;
                },
              },
            ]),
      ],
      checks: {
        eval: false,
        pluginTimings: false,
      },
      onLog(level, log, defaultHandler) {
        if (level === "warn" && isKnownToleratedBuildWarning(log)) {
          return;
        }
        defaultHandler(level, log);
      },
      onwarn(warning, warn) {
        if (isKnownToleratedBuildWarning(warning)) {
          return;
        }
        warn(warning);
      },
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
            // chalk + drizzle-orm intentionally NOT externalised here:
            // marking them external leaves a bare ESM specifier in the
            // output bundle (e.g. `import "chalk"`), which the browser
            // can't resolve. They are stubbed at resolve-time by
            // nativeModuleStubPlugin instead.
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
    // rollupOptions mirrors the otel stub from rolldownOptions above.
    // Vite reads rolldownOptions only when using experimental Rolldown; when
    // running with the classic Rollup bundler (@rollup/wasm-node, as in CI),
    // rolldownOptions is silently ignored and the otel-api-build-* plugin
    // never runs. The rollupOptions block below is the standard path and is
    // always applied by Vite + Rollup.
    rollupOptions: {
      plugins: [
        ...(otelApiEntry
          ? [
              {
                name: "otel-api-build-resolver",
                resolveId(id: string) {
                  if (id === "@opentelemetry/api") return otelApiEntry;
                  return null;
                },
              },
            ]
          : [
              {
                name: "otel-api-build-stub",
                resolveId(id: string) {
                  if (id === "@opentelemetry/api") return "\0otel-api-stub";
                  return null;
                },
                load(id: string) {
                  if (id !== "\0otel-api-stub") return null;
                  return `
export const trace = { getTracer: () => ({ startSpan: () => ({end(){},setAttribute(){},setStatus(){},recordException(){},isRecording:()=>false}), startActiveSpan: (_n, _o, _ctx, fn) => { const f = typeof _ctx === 'function' ? _ctx : fn; return f && f({end(){},setAttribute(){},setStatus(){},recordException(){},isRecording:()=>false}); } }) };
export const context = { active: () => ({}), with: (_c, fn) => fn(), bind: (_c, fn) => fn };
export const propagation = { inject: () => {}, extract: (_c, carrier) => _c, fields: () => [] };
export const metrics = { getMeter: () => ({ createCounter: () => ({ add(){} }), createHistogram: () => ({ record(){} }), createGauge: () => ({ record(){} }), createObservableGauge: () => ({}) }) };
export const diag = { setLogger: () => {}, error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, verbose: () => {} };
export const SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 };
export const SpanKind = { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 };
export const ROOT_CONTEXT = {};
export const createContextKey = (name) => Symbol(name);
export const defaultTextMapPropagator = { inject: () => {}, extract: (_c, carrier) => _c, fields: () => [] };
export const isSpanContextValid = () => false;
export const INVALID_SPAN_CONTEXT = {};
export const INVALID_TRACER_PROVIDER = {};
`;
                },
              },
            ]),
      ],
      onwarn(warning, warn) {
        if (isKnownToleratedBuildWarning(warning)) {
          return;
        }
        warn(warning);
      },
    },
  },
  server: {
    host: true,
    port: uiPort,
    strictPort: true,
    // Proactively transform the boot entry's import graph at server start
    // instead of lazily on the first browser request. On this app the eager
    // graph is large (~1200 workspace source modules), so warming it parallelizes
    // the transform work and shortens cold-load TTFB after a server (re)start.
    warmup: { clientFiles: ["src/main.tsx"] },
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
      // Benchmark packages are large offline fixture trees; the desktop renderer
      // does not import them, and watching them can exhaust the kernel watcher
      // limit before the desktop renderer is interactive.
      // OS image trees contain distro fixture files/symlinks that can fail
      // fs.watch on Linux/Bun and are also not renderer inputs.
      ignored: [
        "**/electrobun/build/**",
        "**/electrobun/artifacts/**",
        "**/packages/app/.vite/**",
        "**/packages/**/.turbo/**",
        "**/packages/**/.wrangler/**",
        "**/packages/agent/.elizadb/**",
        "**/packages/agent/data/**",
        "**/packages/examples/**",
        "**/packages/feed/**",
        "**/packages/**/dist/**",
        "**/packages/**/*.log",
        "**/packages/**/*.md",
        "**/plugins/**/.turbo/**",
        "**/*.d.ts",
        "**/*.d.ts.map",
        "**/*.tsbuildinfo",
        "**/packages/**/output/generated-cad/**",
        "**/packages/robot/**",
        "**/packages/**/src/i18n/generated/**",
        "**/packages/benchmarks/**",
        "**/packages/os/**",
        "**/packages/training/data/raw/**",
        "**/plugin-local-inference/native/omnivoice.cpp/**",
        "**/plugin-local-inference/src/services/__tests__/**",
      ],
    },
  },
});
