import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { colorizeDevSettingsStartupBanner } from "@elizaos/shared/dev-settings-banner-style";
import { prependDevSubsystemFigletHeading } from "@elizaos/shared/dev-settings-figlet-heading";
import {
  type DevSettingsRow,
  formatDevSettingsTable,
} from "@elizaos/shared/dev-settings-table";
import {
  resolveDesktopApiPort,
  resolveDesktopApiPortPreference,
  resolveDesktopUiPort,
  resolveDesktopUiPortPreference,
} from "@elizaos/shared/runtime-env";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig, type Plugin, transformWithEsbuild } from "vite";

const _require = createRequire(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../..");
const elizaRoot = path.resolve(projectRoot, "eliza");
const nativePluginsRoot = path.join(elizaRoot, "packages", "native-plugins");
const optionalElizaAppStubEntry = path.join(
  here,
  "src/optional-eliza-app-stub.tsx",
);
const nativePluginStubEntry = path.join(here, "src/native-plugin-stubs.ts");

function readSourceModeMarker(): string | null {
  try {
    const raw = fs
      .readFileSync(path.join(projectRoot, ".elizaos/source-mode"), "utf8")
      .trim()
      .toLowerCase();
    if (["local", "source", "workspace"].includes(raw)) return "local";
    if (["packages", "package", "published", "npm", "registry"].includes(raw))
      return "packages";
  } catch {
    return null;
  }
  return null;
}

function shouldUseLocalElizaSource(): boolean {
  const sourceMode = (
    process.env.ELIZA_SOURCE ??
    readSourceModeMarker() ??
    "packages"
  ).toLowerCase();
  return (
    ["local", "source", "workspace"].includes(sourceMode) ||
    process.env.ELIZA_FORCE_LOCAL_UPSTREAMS === "1"
  );
}

function requireResolve(id: string): string {
  try {
    return _require.resolve(id, { paths: [here, projectRoot] });
  } catch (cause) {
    const detail = cause instanceof Error ? ` ${cause.message}` : "";
    throw new Error(
      `[eliza][vite] Could not resolve ${id}.${detail} Run bun install so the published elizaOS package is available.`,
    );
  }
}

const hasLocalElizaWorkspace =
  shouldUseLocalElizaSource() &&
  fs.existsSync(path.join(elizaRoot, "package.json"));
const publishedAppCoreRoot = path.dirname(
  requireResolve("@elizaos/app-core/package.json"),
);
const appCoreSrcRoot = hasLocalElizaWorkspace
  ? path.join(elizaRoot, "packages/app-core/src")
  : fs.existsSync(path.join(publishedAppCoreRoot, "packages/app-core/src"))
    ? path.join(publishedAppCoreRoot, "packages/app-core/src")
    : path.join(publishedAppCoreRoot, "src");

function resolveAppCoreSourceFile(relativePath: string): string {
  const extensionCandidates = hasLocalElizaWorkspace
    ? [".ts", ".tsx", ".js", ".jsx"]
    : [".js", ".jsx", ".ts", ".tsx"];
  for (const extension of extensionCandidates) {
    const candidate = path.join(appCoreSrcRoot, `${relativePath}${extension}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(appCoreSrcRoot, `${relativePath}${extensionCandidates[0]}`);
}

const appCoreNativePluginEntrypoints = resolveAppCoreSourceFile(
  "platform/native-plugin-entrypoints",
);
const emptyNodeModuleEntry = resolveAppCoreSourceFile(
  "platform/empty-node-module",
);

/**
 * Pinned @elizaos/core from the repo root (must match the agent/runtime lock).
 */
function getElizaPinnedElizaCoreVersion(): string {
  const packageJsonPaths = [
    path.join(projectRoot, "package.json"),
    path.join(here, "package.json"),
    ...(hasLocalElizaWorkspace ? [path.join(elizaRoot, "package.json")] : []),
  ];

  for (const packageJsonPath of packageJsonPaths) {
    try {
      const raw = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        overrides?: Record<string, string>;
      };
      const spec =
        raw.dependencies?.["@elizaos/core"] ??
        raw.devDependencies?.["@elizaos/core"] ??
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
      /* try the next package.json */
    }
  }

  try {
    const raw = JSON.parse(
      fs.readFileSync(requireResolve("@elizaos/core/package.json"), "utf8"),
    ) as {
      version?: string;
    };
    if (raw.version && /^\d/.test(raw.version)) return raw.version;
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
  const bunDirs = [
    path.join(projectRoot, "node_modules/.bun"),
    path.join(here, "node_modules/.bun"),
    ...(hasLocalElizaWorkspace
      ? [path.join(elizaRoot, "node_modules/.bun")]
      : []),
  ];
  const rel =
    kind === "browser"
      ? "node_modules/@elizaos/core/dist/browser/index.browser.js"
      : "node_modules/@elizaos/core/dist/node/index.node.js";
  const pinned = getElizaPinnedElizaCoreVersion();
  const pinnedPrefix = `@elizaos+core@${pinned}+`;

  const candidates: Array<{ bunDir: string; dir: string }> = [];
  for (const bunDir of bunDirs) {
    if (!fs.existsSync(bunDir)) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(bunDir);
    } catch {
      continue;
    }
    for (const dir of entries) {
      if (!dir.startsWith("@elizaos+core@")) continue;
      if (fs.existsSync(path.join(bunDir, dir, rel))) {
        candidates.push({ bunDir, dir });
      }
    }
  }

  const pinnedMatch = candidates.find(({ dir }) =>
    dir.startsWith(pinnedPrefix),
  );
  if (pinnedMatch) {
    return path.join(pinnedMatch.bunDir, pinnedMatch.dir, rel);
  }

  if (candidates.length === 0) return null;

  candidates.sort(
    (a, b) => elizaCoreBetaPrerelease(b.dir) - elizaCoreBetaPrerelease(a.dir),
  );
  const best = candidates[0];
  return best ? path.join(best.bunDir, best.dir, rel) : null;
}

/**
 * Resolved file path for bundling `@elizaos/core` in the renderer.
 * Linked eliza checkouts sometimes omit `dist/` until `bun run build`;
 * prefer the source browser entry when present, otherwise fall back to
 * built artifacts and then the bun install cache copy.
 */
function resolveElizaCoreBundlePath(): string {
  const pkgDir = path.dirname(_require.resolve("@elizaos/core/package.json"));
  const sourceBrowserEntry = path.join(pkgDir, "src/index.browser.ts");
  const browserEntry = path.join(pkgDir, "dist/browser/index.browser.js");
  const nodeEntry = path.join(pkgDir, "dist/node/index.node.js");
  const rootBrowserEntry = path.join(pkgDir, "dist/index.browser.js");
  const rootNodeEntry = path.join(pkgDir, "dist/index.node.js");
  const hasBrowserShimTarget = fs.existsSync(browserEntry);
  const hasNodeShimTarget = fs.existsSync(nodeEntry);
  if (fs.existsSync(sourceBrowserEntry)) return sourceBrowserEntry;
  if (fs.existsSync(browserEntry)) return browserEntry;
  if (fs.existsSync(rootBrowserEntry) && hasBrowserShimTarget)
    return rootBrowserEntry;
  if (fs.existsSync(nodeEntry)) {
    console.warn(
      "[eliza][vite] @elizaos/core dist/browser is missing; using dist/node for the client bundle. " +
        "For a linked eliza workspace, run `bun run build` in that checkout (e.g. packages/core). " +
        "Or run `bun run eliza:packages` to use published packages.",
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
  const bunBrowser = findElizaCoreBundleInBunStore("browser");
  if (bunBrowser) {
    console.warn(
      `[eliza][vite] Linked @elizaos/core at ${pkgDir} has no dist/; using bun cache build at ${bunBrowser}. ` +
        "Run `bun run build` in your eliza checkout or `bun run eliza:packages` to align versions.",
    );
    return bunBrowser;
  }
  const bunNode = findElizaCoreBundleInBunStore("node");
  if (bunNode) {
    console.warn(
      `[eliza][vite] Linked @elizaos/core at ${pkgDir} has no dist/; using bun cache node bundle at ${bunNode}.`,
    );
    return bunNode;
  }
  throw new Error(
    `[eliza][vite] @elizaos/core has no built artifacts under ${pkgDir} and none in node_modules/.bun. ` +
      "Expected src/index.browser.ts, dist/browser/index.browser.js, dist/index.browser.js, dist/node/index.node.js, or dist/index.node.js. " +
      "Build your local eliza workspace or run `bun run eliza:packages`.",
  );
}

// The dev script sets ELIZA_API_PORT; default to 31337 for standalone vite dev.
const apiPort = resolveDesktopApiPort(process.env);
const uiPort = resolveDesktopUiPort(process.env);
const enableAppSourceMaps = process.env.ELIZA_APP_SOURCEMAP === "1";
/** Set by eliza/packages/app-core/scripts/dev-platform.mjs for `vite build --watch` (Electrobun desktop). */
const desktopFastDist = process.env.ELIZA_DESKTOP_VITE_FAST_DIST === "1";

function pathIncludesAny(id: string, markers: string[]): boolean {
  return markers.some((marker) => id.includes(marker));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wildcardReplacement(value: string): string {
  let index = 0;
  return value.replace(/\*/g, () => `$${++index}`);
}

function resolvePackageExportTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  for (const condition of ["browser", "import", "default", "types"]) {
    const conditionalValue = record[condition];
    if (typeof conditionalValue === "string") return conditionalValue;
  }
  return null;
}

function createPackageExportAliases(options: {
  packageDir: string;
  packageExports?: Record<string, unknown>;
  packageName: string;
  preferJsAlias?: boolean;
}): Array<{ find: RegExp; replacement: string }> {
  const aliases: Array<{ find: RegExp; replacement: string }> = [];

  for (const [key, value] of Object.entries(options.packageExports || {})) {
    const target = resolvePackageExportTarget(value);
    if (!target) continue;

    const aliasKey =
      key === "."
        ? options.packageName
        : `${options.packageName}/${key.replace(/^\.\//, "")}`;
    const replacementPath = path.resolve(options.packageDir, target);

    if (aliasKey.includes("*") || target.includes("*")) {
      aliases.push({
        find: new RegExp(`^${escapeRegex(aliasKey).replace(/\\\*/g, "(.*)")}$`),
        replacement: wildcardReplacement(replacementPath),
      });
      continue;
    }

    aliases.push({
      find: new RegExp(`^${escapeRegex(aliasKey)}$`),
      replacement: replacementPath,
    });

    if (
      options.preferJsAlias &&
      !aliasKey.endsWith(".js") &&
      !aliasKey.endsWith(".css")
    ) {
      aliases.push({
        find: new RegExp(`^${escapeRegex(aliasKey)}\\.js$`),
        replacement: replacementPath,
      });
    }
  }

  return aliases;
}

function resolveNativePluginAliasEntries(): Array<{
  find: RegExp;
  replacement: string;
}> {
  if (!hasLocalElizaWorkspace || !fs.existsSync(nativePluginsRoot)) return [];

  return fs
    .readdirSync(nativePluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        fs.existsSync(path.join(nativePluginsRoot, name, "package.json")) &&
        fs.existsSync(path.join(nativePluginsRoot, name, "src/index.ts")),
    )
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      find: new RegExp(`^@elizaos/capacitor-${escapeRegex(name)}$`),
      replacement: path.join(nativePluginsRoot, `${name}/src/index.ts`),
    }));
}

const NATIVE_PLUGIN_ALIAS_ENTRIES = resolveNativePluginAliasEntries();

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

    if (normalizedId.includes("/three/examples/")) {
      return "vendor-three-extras";
    }

    if (pathIncludesAny(normalizedId, ["/three/build/", "/three/src/"])) {
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
    process.env.ELIZA_ASSET_BASE_URL?.trim() ||
    "—";

  return [
    {
      setting: "ELIZA_APP_SOURCEMAP",
      effective: envFlagEffective("ELIZA_APP_SOURCEMAP"),
      source: envFlagSource("ELIZA_APP_SOURCEMAP"),
      change: "export ELIZA_APP_SOURCEMAP=1 to enable; unset for off",
    },
    {
      setting: "ELIZA_DESKTOP_VITE_FAST_DIST",
      effective: envFlagEffective("ELIZA_DESKTOP_VITE_FAST_DIST"),
      source: envFlagSource("ELIZA_DESKTOP_VITE_FAST_DIST"),
      change:
        "set by dev orchestrator for Rollup watch; unset for normal dev server",
    },
    {
      setting: "ELIZA_TTS_DEBUG",
      effective: process.env.ELIZA_TTS_DEBUG?.trim() ? "set" : "—",
      source: process.env.ELIZA_TTS_DEBUG?.trim()
        ? "env set — ELIZA_TTS_DEBUG"
        : "default (unset)",
      change: "export ELIZA_TTS_DEBUG=1 for TTS trace logs",
    },
    {
      setting: "ELIZA_SETTINGS_DEBUG / VITE_ELIZA_SETTINGS_DEBUG",
      effective:
        process.env.ELIZA_SETTINGS_DEBUG?.trim() ||
        process.env.VITE_ELIZA_SETTINGS_DEBUG?.trim()
          ? "set"
          : "—",
      source: process.env.VITE_ELIZA_SETTINGS_DEBUG?.trim()
        ? "env set — VITE_ELIZA_SETTINGS_DEBUG"
        : process.env.ELIZA_SETTINGS_DEBUG?.trim()
          ? "env set — ELIZA_SETTINGS_DEBUG"
          : "default (unset)",
      change: "export ELIZA_SETTINGS_DEBUG=1 or VITE_ELIZA_SETTINGS_DEBUG=1",
    },
    {
      setting: "VITE_ASSET_BASE_URL / ELIZA_ASSET_BASE_URL",
      effective: assetBase,
      source: process.env.VITE_ASSET_BASE_URL?.trim()
        ? "env set — VITE_ASSET_BASE_URL"
        : process.env.ELIZA_ASSET_BASE_URL?.trim()
          ? "env set — ELIZA_ASSET_BASE_URL"
          : "default (unset — empty)",
      change: "export VITE_ASSET_BASE_URL=… or ELIZA_ASSET_BASE_URL=…",
    },
    {
      setting: "ELIZA_DEV_POLLING",
      effective: envFlagEffective("ELIZA_DEV_POLLING"),
      source: envFlagSource("ELIZA_DEV_POLLING"),
      change: "export ELIZA_DEV_POLLING=1 for watch polling (VM/file shares)",
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
          ? "bun run dev (default); ELIZA_DESKTOP_VITE_BUILD_WATCH=1 for Rollup watch"
          : "ELIZA_DESKTOP_VITE_WATCH=1 + ELIZA_DESKTOP_VITE_BUILD_WATCH=1",
    },
  ];
}

/** Print effective env once per Vite process (dev server or first Rollup watch tick). */
function elizaDevSettingsBannerPlugin(): Plugin {
  let printedWatch = false;
  return {
    name: "eliza-dev-settings-banner",
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
      if (process.env.ELIZA_DESKTOP_VITE_FAST_DIST === "1" && !printedWatch) {
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
 * Generate a virtual ESM module that stubs all exports of a Node built-in.
 * We `require()` the real module at Vite config time (Node process), read its
 * export names, and emit matching no-op stubs so esbuild's static import
 * analysis succeeds.  At runtime these stubs are never meaningfully called
 * because the server-only code paths that use them are never executed in the
 * browser.
 */
function generateNodeBuiltinStub(moduleId: string, req = _require): string {
  const bareModule = moduleId.replace(/^node:/, "");
  const lines = [
    // noop: returns itself (for chained calls like createRequire(url)(id)),
    // and is a valid class base (so `class X extends noop` works).
    "function noop() { return noop; }",
    "const asyncNoop = () => Promise.resolve();",
    "const handler = { get(t, p) { if (typeof p === 'symbol') return undefined; if (p === '__esModule') return true; if (p === 'default') return t; if (p === 'prototype') return {}; return noop; }, has() { return true; }, ownKeys() { return []; }, getOwnPropertyDescriptor() { return { configurable: true, enumerable: true }; } };",
    "const stub = new Proxy({}, handler);",
    "export default stub;",
  ];

  let exportNames: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const real = req(bareModule);
    exportNames = Object.keys(real).filter(
      (k) => !k.startsWith("_") && k !== "default",
    );
  } catch {
    // Module not available (e.g. dns/promises on some platforms)
  }

  const reserved = new Set([
    "default",
    "arguments",
    "eval",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "delete",
    "do",
    "else",
    "export",
    "extends",
    "finally",
    "for",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "let",
    "new",
    "return",
    "super",
    "switch",
    "this",
    "throw",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
  ]);

  for (const name of exportNames) {
    if (reserved.has(name)) continue;
    // Validate it's a valid JS identifier
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) continue;

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const real = req(bareModule);
      const val = real[name];
      if (typeof val === "function") {
        if (
          /^[A-Z]/.test(name) &&
          val.prototype &&
          Object.getOwnPropertyNames(val.prototype).length > 1
        ) {
          lines.push(`export class ${name} { constructor() {} }`);
        } else {
          lines.push(`export const ${name} = noop;`);
        }
      } else if (typeof val === "object" && val !== null) {
        // For objects like fs.constants, promises, etc. — wrap in Proxy
        lines.push(`export const ${name} = new Proxy({}, handler);`);
      } else if (typeof val === "string") {
        lines.push(`export const ${name} = ${JSON.stringify(val)};`);
      } else if (typeof val === "number" || typeof val === "boolean") {
        lines.push(`export const ${name} = ${val};`);
      } else {
        lines.push(`export const ${name} = undefined;`);
      }
    } catch {
      lines.push(`export const ${name} = noop;`);
    }
  }

  return lines.join("\n");
}

/**
 * Dev-mode plugin that stubs native-only packages.  In production builds
 * rollupOptions.external handles this, but the Vite dev server still tries
 * to resolve + serve excluded deps.  This plugin intercepts the import at
 * the resolveId stage and returns an empty virtual module so Vite never
 * touches the real CJS files (which fail ESM named-export checks).
 */
function nativeModuleStubPlugin(): Plugin {
  const VIRTUAL_PREFIX = "\0native-stub:";
  // Packages that only run on the server / desktop and must never be
  // parsed by Vite's dev pipeline.
  const nativePackages = new Set([
    "node-llama-cpp",
    "fs-extra",
    "pty-state-capture",
    "electron",
    "undici",
    "@elizaos/plugin-local-embedding",
  ]);
  const nativeScopeRe = /^@node-llama-cpp\//;

  return {
    name: "native-module-stub",
    enforce: "pre",
    resolveId(id) {
      // Intercept ALL node: builtins before Vite externalizes them.
      // The @elizaos/core node entry uses many Node APIs (crypto, fs, module,
      // etc.) at the top level.  Rather than stubbing each one individually,
      // we return a Proxy-based virtual module for any node: import.
      if (id.startsWith("node:")) return VIRTUAL_PREFIX + id;
      // Also catch bare imports of Node builtins that get resolved differently
      const nodeBuiltins = new Set([
        "module",
        "crypto",
        "fs",
        "path",
        "os",
        "url",
        "util",
        "stream",
        "http",
        "https",
        "net",
        "tls",
        "zlib",
        "child_process",
        "worker_threads",
        "perf_hooks",
        "async_hooks",
        "dns",
        "dgram",
        "readline",
        "tty",
        "cluster",
        "v8",
        "vm",
        "assert",
        "buffer",
        "string_decoder",
        "querystring",
        "punycode",
      ]);
      if (nodeBuiltins.has(id) || nodeBuiltins.has(id.split("/")[0]))
        return `${VIRTUAL_PREFIX}node:${id}`;
      if (
        /^@napi-rs\/keyring/.test(id) ||
        id.replace(/\\/g, "/").includes("/@napi-rs/keyring")
      ) {
        return `${VIRTUAL_PREFIX}@napi-rs/keyring`;
      }
      const bare = id.startsWith("@")
        ? id.split("/").slice(0, 2).join("/")
        : id.split("/")[0];
      // Scoped: @node-llama-cpp/*
      if (nativeScopeRe.test(id)) return VIRTUAL_PREFIX + id;
      // Exact or sub-path match against native packages
      if (nativePackages.has(bare)) return VIRTUAL_PREFIX + id;
      return null;
    },
    load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;

      const strippedFull = id.slice(VIRTUAL_PREFIX.length);
      if (strippedFull === "@napi-rs/keyring") {
        return [
          "export class Entry {",
          "  constructor(_service, _account) {}",
          '  getPassword() { return ""; }',
          "  setPassword() {",
          "    throw new Error(",
          '      "OS keychain is unavailable in the browser/renderer build."',
          "    );",
          "  }",
          "}",
        ].join("\n");
      }

      const modName = strippedFull.split("/")[0];
      // node-llama-cpp is the most import-heavy native module — its consumers
      // use many named exports (LlamaLogLevel, getLlama, etc.).  Return a
      // module whose default export is a Proxy that returns no-op stubs for
      // any property access, AND re-export that proxy as every known name so
      // static `import { X }` statements resolve without error.
      if (modName === "node-llama-cpp") {
        return [
          "const handler = { get: (_, p) => (p === Symbol.toPrimitive ? () => 0 : typeof p === 'string' ? (() => {}) : undefined) };",
          "const stub = new Proxy({}, handler);",
          "export default stub;",
          // Known named exports used by @elizaos/plugin-local-embedding and
          // other consumers — extend as needed:
          "export const getLlama = () => Promise.resolve(stub);",
          "export const LlamaLogLevel = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });",
          "export const Llama = stub;",
          "export const LlamaModel = stub;",
          "export const LlamaEmbeddingContext = stub;",
          "export const LlamaContext = stub;",
          "export const LlamaChatSession = stub;",
          "export const LlamaGrammar = stub;",
          "export const LlamaJsonSchemaGrammar = stub;",
        ].join("\n");
      }

      // fs-extra: CJS module with default + named exports
      if (modName === "fs-extra") {
        return [
          "const noop = () => {};",
          "const stub = new Proxy({}, { get: () => noop });",
          "export default stub;",
          // Re-export common fs-extra named exports so static imports work:
          ...[
            "copy",
            "copySync",
            "move",
            "moveSync",
            "remove",
            "removeSync",
            "ensureDir",
            "ensureDirSync",
            "ensureFile",
            "ensureFileSync",
            "mkdirs",
            "mkdirsSync",
            "readJson",
            "readJsonSync",
            "writeJson",
            "writeJsonSync",
            "pathExists",
            "pathExistsSync",
            "outputFile",
            "outputFileSync",
            "outputJson",
            "outputJsonSync",
            "emptyDir",
            "emptyDirSync",
          ].map((n) => `export const ${n} = noop;`),
        ].join("\n");
      }

      // events: CJS module, consumers use `import { EventEmitter } from "events"`
      if (modName === "events") {
        return [
          "function EventEmitter() {}",
          "EventEmitter.prototype.on = function() { return this; };",
          "EventEmitter.prototype.off = function() { return this; };",
          "EventEmitter.prototype.emit = function() { return false; };",
          "EventEmitter.prototype.addListener = EventEmitter.prototype.on;",
          "EventEmitter.prototype.removeListener = EventEmitter.prototype.off;",
          "export { EventEmitter };",
          "export default EventEmitter;",
        ].join("\n");
      }

      // undici: Node HTTP client — re-export browser globals (fetch, WebSocket, etc.)
      if (modName === "undici") {
        return [
          "export const fetch = globalThis.fetch;",
          "export const Request = globalThis.Request;",
          "export const Response = globalThis.Response;",
          "export const Headers = globalThis.Headers;",
          "export const FormData = globalThis.FormData;",
          "export const WebSocket = globalThis.WebSocket;",
          "export const EventSource = globalThis.EventSource || class {};",
          "export const AbortController = globalThis.AbortController;",
          "export const File = globalThis.File;",
          "export const Blob = globalThis.Blob;",
          "export class Agent {}",
          "export class Pool {}",
          "export class Client {}",
          "export class Dispatcher {}",
          "export const setGlobalDispatcher = () => {};",
          "export const getGlobalDispatcher = () => ({});",
          "export default { fetch, Request, Response, Headers, WebSocket };",
        ].join("\n");
      }

      // async_hooks — AsyncLocalStorage must be a real constructor because
      // @elizaos packages do `new AsyncLocalStorage()` at the
      // top level. Uses function-constructor syntax (not class expressions)
      // for maximum WebView compatibility. The renderChunk plugin
      // (asyncLocalStoragePatchPlugin) also patches the final bundle output
      // as a safety net for patterns inlined by Rollup.
      if (modName === "node:async_hooks" || modName === "async_hooks") {
        return [
          "function AsyncLocalStorage() {} AsyncLocalStorage.prototype.getStore = function() { return undefined; }; AsyncLocalStorage.prototype.run = function(store, fn) { return fn.apply(void 0, [].slice.call(arguments, 2)); }; AsyncLocalStorage.prototype.enterWith = function() {}; AsyncLocalStorage.prototype.disable = function() {};",
          "export { AsyncLocalStorage };",
          "export function executionAsyncId() { return 0; }",
          "export function triggerAsyncId() { return 0; }",
          "export function executionAsyncResource() { return {}; }",
          "function AsyncResource() {} AsyncResource.prototype.runInAsyncScope = function(fn) { return fn.apply(void 0, [].slice.call(arguments, 1)); }; AsyncResource.prototype.emitDestroy = function() { return this; }; AsyncResource.prototype.asyncId = function() { return 0; }; AsyncResource.prototype.triggerAsyncId = function() { return 0; };",
          "export { AsyncResource };",
          "export function createHook() { return { enable: function(){}, disable: function(){} }; }",
          "export default { AsyncLocalStorage: AsyncLocalStorage, AsyncResource: AsyncResource, executionAsyncId: executionAsyncId, triggerAsyncId: triggerAsyncId, executionAsyncResource: executionAsyncResource, createHook: createHook };",
        ].join("\n");
      }

      // node:* builtins — return a Proxy-based module that provides any
      // named export as a no-op function.  This handles @elizaos/core's node
      // entry which uses createRequire, randomUUID, fs, etc. at the top level.
      if (modName.startsWith("node:")) {
        // Dynamic: read the real Node module's export names at config time
        // and generate matching no-op stubs so esbuild's static analysis passes.
        return generateNodeBuiltinStub(id.slice(VIRTUAL_PREFIX.length));
      }

      // Generic fallback for other native modules
      return "export default {};\n";
    },
    // Patch @elizaos/core browser entry at transform time to add missing
    // exports and fix browser-incompatible patterns.
    transform(code, id) {
      const isCoreDistFile =
        id.endsWith("index.browser.js") || id.endsWith("index.node.js");
      const normId = id.split(path.sep).join("/");
      const isCorePackagePath =
        normId.includes("/node_modules/@elizaos/core/") ||
        normId.includes("packages/core/dist/");
      if (!isCoreDistFile || !isCorePackagePath) return null;

      // Fix AsyncLocalStorage: the browser entry has a try/catch that does
      //   let {AsyncLocalStorage:$} = (() => {throw new Error(...)})()
      // Rollup/esbuild may optimize the throw into (()=>({})) which makes
      // AsyncLocalStorage undefined, causing "xte is not a constructor".
      // Replace the broken IIFE pattern with a working stub class.
      const patched = code.replace(
        /\(\(\)\s*=>\s*\{\s*throw\s+new\s+Error\(\s*"Cannot require module "\s*\+\s*"node:async_hooks"\s*\)\s*;\s*\}\)\(\)/g,
        "(function(){function A(){} A.prototype.getStore=function(){return undefined};A.prototype.run=function(s,fn){return fn.apply(void 0,[].slice.call(arguments,2))};A.prototype.enterWith=function(){};A.prototype.disable=function(){};return{AsyncLocalStorage:A}})()",
      );
      // Names that downstream plugins and the agent runtime
      // import from @elizaos/core but that are missing from the browser entry.
      const missingExports: Record<string, string> = {
        resolveSecretKeyAlias: "function(k){return k}",
        SECRET_KEY_ALIASES: "{}",
        OnboardingStateMachine: "function(){}",
        isOnboardingComplete: "function(){return false}",
        AgentEventService: "function(){}",
        AutonomyService: "function(){}",
        createBasicCapabilitiesPlugin: "function(){return{name:'stub'}}",
      };
      // Check which are actually missing from the existing export block
      const needed = Object.keys(missingExports).filter((n) => {
        // Check if already exported (as named export or re-export alias)
        const exportedAs = new RegExp(`\\b${n}\\b`);
        // Search only in export{} blocks
        const exportBlocks = patched.match(/export\s*\{[^}]+\}/g) || [];
        return !exportBlocks.some((b) => exportedAs.test(b));
      });
      if (needed.length === 0 && patched === code) return null;
      // Use unique prefixed names to avoid collisions with minified vars
      const prefix = "__eliza_stub_";
      const stubs = needed
        .map((n) => `var ${prefix}${n} = ${missingExports[n]};`)
        .join("\n");
      const exports =
        needed.length > 0
          ? `export { ${needed.map((n) => `${prefix}${n} as ${n}`).join(", ")} };`
          : "";
      return { code: `${patched}\n${stubs}\n${exports}`, map: null };
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
      if (!hasLocalElizaWorkspace) return;
      server.watcher.add(path.resolve(elizaRoot, "packages"));
      server.watcher.add(nativePluginsRoot);
      server.watcher.on("change", (file) => {
        if (file.includes("/packages/")) {
          if (file.endsWith("package.json")) {
            server.restart();
          } else {
            // Force a full reload on any other package file change (e.g. ts/tsx files)
            server.ws.send({ type: "full-reload" });
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
      if (!fs.existsSync(companionPublic)) return;
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
  base: "./",
  // Keep pre-bundle cache under the app dir (not node_modules/.vite) so Bun
  // installs don't fight Vite, and `bun run clean` / docs can target one path.
  cacheDir: path.resolve(here, ".vite"),
  publicDir: path.resolve(here, "public"),
  define: {
    global: "globalThis",
    // Mirror ELIZA_TTS_DEBUG into the client bundle so one env enables UI + server TTS logs in dev.
    "import.meta.env.ELIZA_TTS_DEBUG": JSON.stringify(
      process.env.ELIZA_TTS_DEBUG ?? "",
    ),
    // Settings load/save trace (ElizaClient + shared isElizaSettingsDebugEnabled).
    "import.meta.env.ELIZA_SETTINGS_DEBUG": JSON.stringify(
      process.env.ELIZA_SETTINGS_DEBUG ?? "",
    ),
    "import.meta.env.VITE_ELIZA_SETTINGS_DEBUG": JSON.stringify(
      process.env.VITE_ELIZA_SETTINGS_DEBUG ?? "",
    ),
    "import.meta.env.VITE_ASSET_BASE_URL": JSON.stringify(
      process.env.VITE_ASSET_BASE_URL ?? process.env.ELIZA_ASSET_BASE_URL ?? "",
    ),
  },
  plugins: [
    companionAssetsPlugin(),
    nativeModuleStubPlugin(),
    asyncLocalStoragePatchPlugin(),
    watchWorkspacePackagesPlugin(),
    workspaceJsxInJsPlugin(),
    tailwindcss(),
    react(),
    desktopCorsPlugin(),
    elizaDevSettingsBannerPlugin(),
  ],
  esbuild: {
    // Override tsconfig target — some extended configs use ES2024 which older
    // esbuild does not recognize; this avoids "Unrecognized target environment"
    // warnings regardless of tsconfig resolution.
    target: "es2022",
  },
  resolve: {
    dedupe: ["react", "react-dom", "three", "@elizaos/app-core"],
    alias: [
      // Bare Node built-in polyfills for browser — pathe provides ESM path,
      // events is pre-bundled via optimizeDeps.
      { find: /^path$/, replacement: "pathe" },
      // Node built-in subpaths that browser polyfills don't provide.
      // Server-only code imports these but they're never executed in-browser.
      ...["util/types", "stream/promises", "stream/web"].flatMap((sub) => [
        {
          find: `node:${sub}`,
          replacement: emptyNodeModuleEntry,
        },
        {
          find: sub,
          replacement: emptyNodeModuleEntry,
        },
      ]),
      {
        find: /^@elizaos\/app-core\/platform\/native-plugin-entrypoints$/,
        replacement: appCoreNativePluginEntrypoints,
      },
      {
        find: /^@elizaos\/app-core\/platform\/native-plugin-entrypoints\.js$/,
        replacement: appCoreNativePluginEntrypoints,
      },
      // Capacitor plugins — local source mode resolves real plugin sources;
      // package mode uses browser-safe stubs for renderer builds.
      ...NATIVE_PLUGIN_ALIAS_ENTRIES,
      {
        find: /^@elizaos\/capacitor-.+$/,
        replacement: nativePluginStubEntry,
      },
      // Dynamic aliases for all eliza/plugins/app-* packages
      ...(() => {
        if (!hasLocalElizaWorkspace) return [];
        const appPluginsDir = path.resolve(elizaRoot, "plugins");
        const aliases = [];
        if (!fs.existsSync(appPluginsDir)) return aliases;
        for (const entry of fs.readdirSync(appPluginsDir, {
          withFileTypes: true,
        })) {
          if (!entry.isDirectory()) continue;
          if (!entry.name.startsWith("app-")) continue;
          const pkgPath = path.join(appPluginsDir, entry.name, "package.json");
          if (!fs.existsSync(pkgPath)) continue;
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
          const pkgName = pkg.name;
          if (!pkgName) continue;
          const pkgDir = path.dirname(pkgPath);
          aliases.push(
            ...createPackageExportAliases({
              packageDir: pkgDir,
              packageExports: pkg.exports,
              packageName: pkgName,
            }),
          );
          // Catch-all subpath for direct src/ access
          aliases.push({
            find: new RegExp(`^${escapeRegex(pkgName)}/(.*)`),
            replacement: path.resolve(pkgDir, "src/$1"),
          });
        }
        return aliases;
      })(),
      {
        find: /^@clawville\/app-clawville(\/.*)?$/,
        replacement: optionalElizaAppStubEntry,
      },
      {
        find: /^@elizaos\/app-(?!core(\/|$)).+$/,
        replacement: optionalElizaAppStubEntry,
      },
      ...(() => {
        if (!hasLocalElizaWorkspace) return [];
        const sharedPkgPath = path.resolve(
          elizaRoot,
          "packages/shared/package.json",
        );
        if (!fs.existsSync(sharedPkgPath)) return [];
        const sharedPkgDir = path.dirname(sharedPkgPath);
        const sharedPkg = JSON.parse(fs.readFileSync(sharedPkgPath, "utf8"));
        return createPackageExportAliases({
          packageDir: sharedPkgDir,
          packageExports: sharedPkg.exports,
          packageName: "@elizaos/shared",
        });
      })(),
      // Force local @elizaos/app-core when workspace-linked (prevents stale
      // bun cache copies from overriding the symlinked local source).
      ...(() => {
        const packageAgnosticAliases = [
          {
            find: /^@elizaos\/agent$/,
            replacement: emptyNodeModuleEntry,
          },
          {
            find: /^@elizaos\/core$/,
            replacement: resolveElizaCoreBundlePath(),
          },
        ];

        if (!hasLocalElizaWorkspace) return packageAgnosticAliases;

        const appCorePkgPath = path.resolve(
          elizaRoot,
          "packages/app-core/package.json",
        );
        if (!fs.existsSync(appCorePkgPath)) return packageAgnosticAliases;
        const appCorePkgDir = path.dirname(appCorePkgPath);
        const appCorePkg = JSON.parse(fs.readFileSync(appCorePkgPath, "utf8"));

        const generatedAliases = createPackageExportAliases({
          packageDir: appCorePkgDir,
          packageExports: appCorePkg.exports,
          packageName: "@elizaos/app-core",
          preferJsAlias: true,
        });
        const uiPkgPath = path.resolve(elizaRoot, "packages/ui/package.json");
        if (!fs.existsSync(uiPkgPath)) {
          return [...generatedAliases, ...packageAgnosticAliases];
        }
        const uiPkgDir = path.dirname(uiPkgPath);
        const uiPkg = JSON.parse(fs.readFileSync(uiPkgPath, "utf8"));
        const _autonomousSource = path.resolve(
          elizaRoot,
          "node_modules/@elizaos/agent/packages/agent/src",
        );

        return [
          ...generatedAliases,
          ...createPackageExportAliases({
            packageDir: uiPkgDir,
            packageExports: uiPkg.exports,
            packageName: "@elizaos/ui",
          }),
          // NOTE: @elizaos/agent barrel re-exports server-only code (eliza.ts,
          // server.ts) that imports native modules (node-llama-cpp, node:module).
          // Nothing in the browser needs the barrel — only subpath imports like
          // @elizaos/agent/contracts/onboarding are used.  Map the bare import
          // to an empty module so Vite never traverses the server-side tree.
          {
            find: /^@elizaos\/agent$/,
            replacement: emptyNodeModuleEntry,
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
    // esbuild doesn't externalize them as "browser-external:node:*".
    esbuildOptions: {
      // Must match build/esbuild targets: Vite's dep optimizer otherwise
      // defaults to legacy browser targets (chrome87, safari14, …) and
      // esbuild fails with "Transforming destructuring … is not supported yet"
      // across modern node_modules (Radix, three, zod, etc.).
      target: "es2022",
      plugins: [
        {
          name: "workspace-jsx-in-js",
          setup(build) {
            const normalizedAppCoreSrcRoot = appCoreSrcRoot
              .split(path.sep)
              .join("/");

            build.onLoad({ filter: /\.js$/ }, (args) => {
              const normalizedPath = args.path.split(path.sep).join("/");
              if (!normalizedPath.startsWith(`${normalizedAppCoreSrcRoot}/`)) {
                return null;
              }

              return {
                contents: fs.readFileSync(args.path, "utf8"),
                loader: "jsx",
              };
            });
          },
        },
        {
          name: "node-builtins-polyfill",
          setup(build) {
            // Map node: builtins to their npm polyfill packages.
            // require.resolve("events") returns the bare name on Node 22+, so
            // we resolve via the polyfill's package.json to get an absolute path.
            const polyfills: Record<string, string> = {};
            for (const [nodeId, pkg, entry] of [
              ["node:events", "events", "events.js"],
              ["node:buffer", "buffer", "index.js"],
              ["node:util", "util", "util.js"],
              ["node:process", "process", "browser.js"],
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
            for (const [nodeId, absPath] of Object.entries(polyfills)) {
              const re = new RegExp(`^${nodeId.replace(":", "\\:")}$`);
              build.onResolve({ filter: re }, () => ({ path: absPath }));
            }
            // For all OTHER node: builtins, provide empty stubs via
            // generateNodeBuiltinStub so esbuild doesn't externalize them.
            build.onResolve({ filter: /^node:/ }, (args) => ({
              path: args.path,
              namespace: "node-stub",
            }));
            build.onLoad({ filter: /.*/, namespace: "node-stub" }, (args) => ({
              contents: generateNodeBuiltinStub(args.path),
              loader: "js",
            }));
          },
        },
      ],
    },
    exclude: [
      "node-llama-cpp",
      "@node-llama-cpp/mac-arm64-metal",
      // Contains native-only pty-state-capture import; skip pre-bundling.
      "@elizaos/plugin-agent-orchestrator",
      // Built-in secrets live in @elizaos/core features; Vite must not externalize them as a separate package.
      // Node-only HTTP client — crashes in browser, stub via nativeModuleStubPlugin
      "undici",
      // Native LLM embedding — uses node-llama-cpp, never runs in browser
      "@elizaos/plugin-local-embedding",
      "@napi-rs/keyring",
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
    chunkSizeWarningLimit: 3800,
    minify: desktopFastDist ? false : undefined,
    cssMinify: desktopFastDist ? false : undefined,
    reportCompressedSize: !desktopFastDist,
    rollupOptions: {
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
            "electron",
            "node-llama-cpp",
            "pty-manager",
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
    commonjsOptions: {
      include: [/node_modules/],
    },
  },
  server: {
    host: true,
    port: uiPort,
    strictPort: true,
    // Electrobun/WKWebView runs the renderer in a null-origin context. When
    // Vite leaves dev asset URLs relative, worker source-map lookups can turn
    // into malformed blob://nullhttp//... requests. Pin the dev origin so
    // worker chunks, source maps, and HMR all resolve against loopback.
    // Keep ELIZA_HMR_HOST as an override for remote HMR / VPS development.
    origin: `http://127.0.0.1:${uiPort}`,
    hmr: {
      host: process.env.ELIZA_HMR_HOST || "127.0.0.1",
      port: uiPort,
    },
    cors: {
      origin: true,
      credentials: true,
    },
    proxy: {
      "/api": {
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
      // Allow serving files from the app package, workspace root/node_modules,
      // and the optional local elizaOS checkout.
      allow: hasLocalElizaWorkspace
        ? [here, projectRoot, elizaRoot]
        : [here, projectRoot],
    },
    watch: {
      // Polling is only needed in Docker/WSL where native fs events are unreliable
      usePolling: process.env.ELIZA_DEV_POLLING === "1",
      // Electrobun postBuild copies renderer HTML/assets into electrobun/build/.
      // Watching those paths triggers full reloads while deps are still optimizing,
      // which breaks with "chunk-*.js does not exist" in node_modules/.vite/deps.
      ignored: ["**/electrobun/build/**", "**/electrobun/artifacts/**"],
    },
  },
});
