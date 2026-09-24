import { existsSync } from "node:fs";
/**
 * Storybook config for the UI library: story globs, addons, and the Vite
 * builder wiring.
 */
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/react-vite";
import tailwindcss from "@tailwindcss/vite";
import { rejectRuntimeInRendererPlugin } from "../../app/scripts/lib/renderer-runtime-boundary.ts";

// Resolve the package + monorepo roots relative to this config file.
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const monorepoRoot = resolve(packageRoot, "../..");
const uiSrc = resolve(packageRoot, "src");
const coreSrc = resolve(monorepoRoot, "packages/core/src");
const hostExternalStub = resolve(packageRoot, "test/stubs/host-external.ts");
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
  // Cover @elizaos/ui's own stories so the whole component library lives in
  // one catalog.
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  staticDirs: [
    { from: resolve(here, "fixtures"), to: "/" },
    {
      from: resolve(monorepoRoot, "packages/app/public/brand/logos"),
      to: "/brand/logos",
    },
    {
      from: resolve(monorepoRoot, "packages/app/public/logos"),
      to: "/logos",
    },
    {
      from: resolve(monorepoRoot, "packages/app/public/wallpapers"),
      to: "/wallpapers",
    },
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
    cfg.plugins.push(tailwindcss(), rejectRuntimeInRendererPlugin());
    // Native plugin dists use lazy platform loaders - `import("./web")` - with
    // extensionless relative specifiers, and some dists ship without a given
    // platform chunk. Rolldown's production build (unlike the dev server) does
    // not apply `.js` extension resolution there and dies on the unresolved
    // import. Resolve such imports to the real `.js` sibling when present, else
    // an empty module, so the static catalog build never breaks on a
    // platform-fallback the browser catalog never actually invokes.
    cfg.plugins.push({
      name: "eliza-ui-native-plugin-dist-platform-fallback",
      enforce: "pre" as const,
      resolveId(source: string, importer: string | undefined) {
        if (!importer || !/[\\/]dist[\\/]/.test(importer)) return null;
        if (!source.startsWith(".") || extname(source)) return null;
        const baseDir = dirname(importer);
        for (const ext of [".js", ".mjs", ".cjs"]) {
          const candidate = resolve(baseDir, `${source}${ext}`);
          if (existsSync(candidate)) return candidate;
        }
        return "\0eliza-empty-native-platform-fallback";
      },
      load(id: string) {
        if (id === "\0eliza-empty-native-platform-fallback") {
          return "export default {};";
        }
        return null;
      },
    });
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
      {
        find: /^@elizaos\/auth$/,
        replacement: resolve(monorepoRoot, "packages/auth/src/sdk/index.ts"),
      },
      // @elizaos/ui — bare barrel, the renderer-only styles entry, then subpaths.
      {
        find: /^@elizaos\/ui\/styles$/,
        replacement: resolve(uiSrc, "styles.ts"),
      },
      { find: /^@elizaos\/ui$/, replacement: resolve(uiSrc, "index.ts") },
      { find: /^@elizaos\/ui\/(.+)$/, replacement: resolve(uiSrc, "$1") },
      { find: /^@elizaos\/core\/(.+)$/, replacement: resolve(coreSrc, "$1") },
      // Host-only / native modules the browser catalog can't load → stubs.
      {
        find: /^@elizaos\/app(?:\/browser|\/ui-compat)?$/,
        replacement: hostExternalStub,
      },
      {
        // Native capacitor bridges → host-external stub. `camera` is included so
        // the static catalog build never pulls plugin-native-camera's dist
        // (gitignored / unbuilt on a clean CI checkout); the browser catalog
        // never invokes the native bridge anyway.
        find: /^@elizaos\/capacitor-(camera|contacts|messages|mobile-signals|phone|system)$/,
        replacement: hostExternalStub,
      },
      { find: /^llama-cpp-capacitor$/, replacement: hostExternalStub },
      { find: /^@elizaos\/plugin-browser$/, replacement: hostExternalStub },
      // DynamicViewLoader dynamic-imports a few plugin subpaths for runtime
      // view bundles; in the catalog they can't be loaded, stub them.
      {
        find: /^@elizaos\/plugin-health(?:\/.+)?$/,
        replacement: hostExternalStub,
      },
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
    cfg.optimizeDeps ??= {};
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
