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
        find: /^@elizaos\/core$/,
        replacement: resolve(coreSrc, "index.node.ts"),
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
    // Shared UI source reads Node's `process.env` unguarded at module load;
    // shim it so those modules import cleanly in the browser catalog.
    cfg.define = { ...(cfg.define ?? {}), "process.env": "({})" };
    cfg.optimizeDeps ??= {};
    cfg.optimizeDeps.noDiscovery = true;
    cfg.optimizeDeps.include = [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-dev-runtime",
      "react/jsx-runtime",
    ];
    cfg.optimizeDeps.exclude = [
      ...(cfg.optimizeDeps.exclude ?? []),
      "@napi-rs/keyring",
      "@napi-rs/keyring-darwin-arm64",
      "discord.js",
      "qrcode-terminal",
      "zlib-sync",
    ];
    return cfg;
  },
};

export default config;
