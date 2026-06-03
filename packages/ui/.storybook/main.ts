import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/react-vite";
import tailwindcss from "@tailwindcss/vite";

// Resolve the package + monorepo roots relative to this config file.
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const monorepoRoot = resolve(packageRoot, "../..");
const uiSrc = resolve(packageRoot, "src");
const sharedSrc = resolve(monorepoRoot, "packages/shared/src");
const coreSrc = resolve(monorepoRoot, "packages/core/src");
const hostExternalStub = resolve(packageRoot, "test/stubs/host-external.ts");
const nodeFsStub = resolve(packageRoot, "test/stubs/node-fs.ts");
const fsExtraStub = resolve(packageRoot, "test/stubs/fs-extra.ts");
const nodeOsStub = resolve(packageRoot, "test/stubs/node-os.ts");
const nodePathStub = resolve(packageRoot, "test/stubs/node-path.ts");
const nodeCryptoStub = resolve(packageRoot, "test/stubs/node-crypto.ts");
const nodeBufferStub = resolve(packageRoot, "test/stubs/node-buffer.ts");
const nodeUrlStub = resolve(packageRoot, "test/stubs/node-url.ts");
const nodeEventsStub = resolve(packageRoot, "test/stubs/node-events.ts");
const nodeUtilStub = resolve(packageRoot, "test/stubs/node-util.ts");
const nodeModuleStub = resolve(packageRoot, "test/stubs/node-module.ts");
const nodeStreamStub = resolve(packageRoot, "test/stubs/node-stream.ts");
const nodeHttpStub = resolve(packageRoot, "test/stubs/node-http.ts");
const nodeHttpsStub = resolve(packageRoot, "test/stubs/node-https.ts");
const nodeNetStub = resolve(packageRoot, "test/stubs/node-net.ts");
const nodeDnsPromisesStub = resolve(
  packageRoot,
  "test/stubs/node-dns-promises.ts",
);
const nodeChildProcessStub = resolve(
  packageRoot,
  "test/stubs/node-child_process.ts",
);

// Pin react/react-dom to the single physical copy lucide-react resolves, so
// stories never hit "Invalid hook call" from a duplicate React (same strategy
// as vitest.config.ts).
const _require = createRequire(import.meta.url);
let reactPath: string;
let reactDomPath: string;
try {
  const lucidePath = _require.resolve("lucide-react");
  const lucideReq = createRequire(lucidePath);
  reactPath = dirname(lucideReq.resolve("react/package.json"));
  reactDomPath = dirname(lucideReq.resolve("react-dom/package.json"));
} catch {
  reactPath = dirname(_require.resolve("react/package.json"));
  reactDomPath = dirname(_require.resolve("react-dom/package.json"));
}

const config: StorybookConfig = {
  // Cover @elizaos/ui's own stories plus the plugin-companion CSF files, so the
  // whole component library lives in one catalog.
  stories: [
    "../src/**/*.stories.@(ts|tsx)",
    "../../../plugins/plugin-companion/src/**/*.stories.@(ts|tsx)",
  ],
  addons: [
    "@storybook/addon-docs",
    "@storybook/addon-a11y",
    "@storybook/addon-themes",
  ],
  framework: { name: "@storybook/react-vite", options: {} },
  docs: { autodocs: "tag" },
  viteFinal: async (cfg) => {
    // The UI is Tailwind v4 (styles.css does `@import "tailwindcss"`); without
    // this plugin the utility classes never generate and components render
    // unstyled/invisible.
    cfg.plugins ??= [];
    cfg.plugins.push(tailwindcss());
    cfg.resolve ??= {};
    cfg.resolve.dedupe = [...(cfg.resolve.dedupe ?? []), "react", "react-dom"];
    // Array-form aliases (regex, first-match-wins) mirroring vitest.config.ts so
    // every @elizaos/* subpath + native/host module resolves to source/stubs.
    // Preserve any existing Storybook-injected aliases (object → array entries).
    const existing = cfg.resolve.alias;
    const existingEntries = Array.isArray(existing)
      ? existing
      : Object.entries(existing ?? {}).map(([find, replacement]) => ({
          find,
          replacement: replacement as string,
        }));
    cfg.resolve.alias = [
      // @elizaos/ui — bare barrel, the renderer-only styles entry, then subpaths.
      {
        find: /^@elizaos\/ui\/styles$/,
        replacement: resolve(uiSrc, "styles.ts"),
      },
      { find: /^@elizaos\/ui$/, replacement: resolve(uiSrc, "index.ts") },
      { find: /^@elizaos\/ui\/(.+)$/, replacement: resolve(uiSrc, "$1") },
      {
        find: /^@elizaos\/shared$/,
        replacement: resolve(sharedSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/shared\/(.+)$/,
        replacement: resolve(sharedSrc, "$1"),
      },
      {
        // Mirror the real browser build: @elizaos/shared re-exports the core
        // barrel, and the renderer resolves it to the browser entry in
        // production. Using index.node.ts here instead dragged the entire
        // server subgraph (plugin-manager, personality → fs-extra, typescript,
        // …) into the catalog, crashing every story that transitively imports
        // @elizaos/shared (ContinuousChatToggle, PermissionCard). The browser
        // entry is curated to be node-free.
        find: /^@elizaos\/core$/,
        replacement: resolve(coreSrc, "index.browser.ts"),
      },
      { find: /^@elizaos\/core\/(.+)$/, replacement: resolve(coreSrc, "$1") },
      // Host-only / native modules the browser catalog can't load → stubs.
      {
        find: /^@elizaos\/app-core(?:\/browser|\/ui-compat)?$/,
        replacement: hostExternalStub,
      },
      {
        find: /^@elizaos\/capacitor-(contacts|messages|mobile-signals|phone|system)$/,
        replacement: hostExternalStub,
      },
      { find: /^llama-cpp-capacitor$/, replacement: hostExternalStub },
      { find: /^@elizaos\/plugin-browser$/, replacement: hostExternalStub },
      // Node builtins pulled by local-inference services (reachable from the
      // state graph) — stubbed so useApp()-dependent stories import cleanly.
      { find: /^node:fs\/promises$/, replacement: nodeFsStub },
      { find: /^node:fs$/, replacement: nodeFsStub },
      // node:os is externalized by Vite; core path helpers (state-dir) call
      // os.homedir()/tmpdir() at load → stub with benign values.
      { find: /^node:os$/, replacement: nodeOsStub },
      // node:path is externalized by Vite; state-dir uses isAbsolute/join/
      // resolve at load → stub with working posix implementations.
      { find: /^node:path$/, replacement: nodePathStub },
      // node:crypto is externalized by Vite; core feature modules touch
      // createHash/createHmac/etc. at load → stub with browser-backed/benign.
      { find: /^node:crypto$/, replacement: nodeCryptoStub },
      // node:buffer is externalized by Vite; core modules touch Buffer at load.
      { find: /^node:buffer$/, replacement: nodeBufferStub },
      // Remaining node builtins reached at module-load through the
      // @elizaos/shared → @elizaos/core server graph. Vite externalizes them,
      // so any load-time access throws; these stubs provide working shims where
      // used at load (url/events/util/module) and benign/throwing surfaces for
      // networking (http/https/net/dns) that never runs during a render.
      { find: /^node:url$/, replacement: nodeUrlStub },
      { find: /^node:events$/, replacement: nodeEventsStub },
      { find: /^node:util$/, replacement: nodeUtilStub },
      { find: /^node:module$/, replacement: nodeModuleStub },
      { find: /^node:stream$/, replacement: nodeStreamStub },
      { find: /^node:http$/, replacement: nodeHttpStub },
      { find: /^node:https$/, replacement: nodeHttpsStub },
      { find: /^node:net$/, replacement: nodeNetStub },
      { find: /^node:dns\/promises$/, replacement: nodeDnsPromisesStub },
      { find: /^node:child_process$/, replacement: nodeChildProcessStub },
      // fs-extra (node-only, reached via core plugin-manager/personality
      // services) is CJS without an ESM default export → stub it.
      { find: /^fs-extra$/, replacement: fsExtraStub },
      // Single React copy (avoid "Invalid hook call").
      { find: /^react$/, replacement: resolve(reactPath, "index.js") },
      {
        find: /^react\/jsx-runtime$/,
        replacement: resolve(reactPath, "jsx-runtime.js"),
      },
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: resolve(reactPath, "jsx-dev-runtime.js"),
      },
      { find: /^react-dom$/, replacement: resolve(reactDomPath, "index.js") },
      {
        find: /^react-dom\/client$/,
        replacement: resolve(reactDomPath, "client.js"),
      },
      ...existingEntries,
    ];
    // Shared UI + core source touch Node's `process` unguarded at module load
    // (process.env / process.cwd / process.platform …); shim the members so
    // those modules import cleanly in the browser catalog. (Member-level
    // defines, not a whole-`process` replacement, so existing `process.env`
    // reads keep working.)
    cfg.define = {
      ...(cfg.define ?? {}),
      "process.env": "({})",
      "process.cwd": "(() => '/')",
      "process.platform": "'browser'",
      "process.arch": "'x64'",
      "process.version": "'v24.0.0'",
      "process.argv": "[]",
      "process.argv0": "''",
      "process.pid": "0",
    };
    cfg.optimizeDeps ??= {};
    // Discovery ON: composite stories (ContinuousChatToggle, PermissionCard)
    // transitively pull a CJS subgraph through the @elizaos/shared barrel
    // (logger/prompts → picocolors, handlebars, json5, markdown-it, fast-redact,
    // …). With discovery off, every un-prebundled CJS dep crashed module
    // evaluation ("does not provide an export named 'default'" / "Cannot set
    // properties of undefined (setting 'exports')"). Letting esbuild discover +
    // prebundle them applies correct CJS→ESM interop. Discovery only adds
    // prebundling, so ESM-only stories are unaffected; node-only deps stay
    // protected by the stubs (node:fs, fs-extra) and the `exclude` list below.
    cfg.optimizeDeps.noDiscovery = false;
    cfg.optimizeDeps.include = [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-dev-runtime",
      "react/jsx-runtime",
      "recharts",
      "use-sync-external-store/shim",
      "use-sync-external-store/shim/with-selector",
      // CJS deps reached via the @elizaos/logger + @elizaos/core util chain
      // (`import fastRedact from "fast-redact"`, `import JSON5 from "json5"`,
      // `import Handlebars from "handlebars"`, `import MarkdownIt from
      // "markdown-it"`). With noDiscovery, Vite serves these un-prebundled, so
      // their default imports resolve to nothing and crash every story that
      // transitively pulls the logger / prompt / markdown utils
      // (ContinuousChatToggle, PermissionCard, …). Pre-bundling synthesises the
      // CJS→ESM default export.
      "fast-redact",
      "json5",
      "handlebars",
      "markdown-it",
    ];
    cfg.optimizeDeps.exclude = [
      ...(cfg.optimizeDeps.exclude ?? []),
      "@napi-rs/keyring",
      "@napi-rs/keyring-darwin-arm64",
      "discord.js",
      "qrcode-terminal",
      "react-hook-form",
      "@radix-ui/react-accordion",
      "@radix-ui/react-alert-dialog",
      "@radix-ui/react-avatar",
      "@radix-ui/react-checkbox",
      "@radix-ui/react-collapsible",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-hover-card",
      "@radix-ui/react-label",
      "@radix-ui/react-popover",
      "@radix-ui/react-progress",
      "@radix-ui/react-scroll-area",
      "@radix-ui/react-select",
      "@radix-ui/react-separator",
      "@radix-ui/react-slider",
      "@radix-ui/react-slot",
      "@radix-ui/react-tabs",
      "@radix-ui/react-toggle",
      "@radix-ui/react-tooltip",
      "@radix-ui/react-use-controllable-state",
      "zlib-sync",
    ];
    return cfg;
  },
};

export default config;
