/**
 * Factory for plugin view bundle Vite configurations.
 *
 * Each plugin with UI views builds its own self-contained JavaScript bundle
 * (ES module, library mode) that the agent serves at
 * `/api/views/<id>/bundle.js` and the frontend shell loads via `import()`.
 *
 * Usage in a plugin's `vite.config.views.ts`:
 *
 * ```ts
 * import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";
 * export default createViewBundleConfig({
 *   packageName: "@elizaos/plugin-app-control",
 *   viewId: "views-manager",
 *   entry: "./src/views/ViewManagerView.tsx",
 * });
 * ```
 *
 * The factory produces a Vite library build that:
 * - Emits a single `bundle.js` ES module.
 * - Externalizes React, ReactDOM, and shared elizaOS packages so the host
 *   shell provides them — no duplication across view bundles.
 * - Outputs to `dist/views/` by default (configurable via `outDir`).
 */

import react from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "vite";

/**
 * Packages the host shell is responsible for providing. Every view bundle
 * must externalize these so they share a single instance with the shell and
 * with other view bundles loaded in the same page.
 */
const DEFAULT_EXTERNALS: string[] = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@elizaos/core",
  "@elizaos/ui",
  "@elizaos/shared",
  "lucide-react",
];

/**
 * Window globals that the shell exposes for each external. Used by Rollup
 * when generating UMD output (not currently used — ES module format does not
 * need this map, but it is kept for completeness / future IIFE fallback).
 */
const DEFAULT_GLOBALS: Record<string, string> = {
  react: "React",
  "react-dom": "ReactDOM",
  "react/jsx-runtime": "React",
  "react/jsx-dev-runtime": "React",
  "@elizaos/core": "ElizaCore",
  "@elizaos/ui": "ElizaUI",
  "@elizaos/shared": "ElizaShared",
  "lucide-react": "LucideReact",
};

export interface ViewBundleConfigOptions {
  /**
   * Plugin package name (e.g. `"@elizaos/plugin-app-control"`).
   * Used only for Rollup metadata; not emitted in the bundle.
   */
  packageName: string;

  /**
   * View identifier (e.g. `"views-manager"`).
   * Must match the `id` in `Plugin.views[].id` — the agent serves the bundle
   * at `/api/views/<viewId>/bundle.js`.
   */
  viewId: string;

  /**
   * Entry point relative to the plugin package root
   * (e.g. `"./src/views/ViewManagerView.tsx"`).
   */
  entry: string;

  /**
   * Output directory relative to the plugin package root.
   * Defaults to `"dist/views"`.
   */
  outDir?: string;

  /**
   * Named export from the entry file that the shell will mount.
   * When omitted the shell falls back to the module's `default` export.
   * This is purely documentation — Vite doesn't filter exports in library
   * mode, the shell reads `componentExport` from the `ViewDeclaration`.
   */
  componentExport?: string;

  /**
   * Additional package ids to externalize beyond the defaults.
   */
  additionalExternals?: string[];
}

/**
 * Create a Vite config for building a plugin view bundle.
 */
export function createViewBundleConfig(
  options: ViewBundleConfigOptions,
): UserConfig {
  const {
    packageName: _packageName,
    viewId,
    entry,
    outDir = "dist/views",
    additionalExternals = [],
  } = options;

  const externals = [...DEFAULT_EXTERNALS, ...additionalExternals];

  // In watch / dev mode enable sourcemaps and skip minification so rebuild
  // cycles are fast and browser devtools show readable source.
  const isDev = process.env.NODE_ENV !== "production";

  return defineConfig({
    plugins: [react()],
    build: {
      lib: {
        entry,
        name: viewId,
        formats: ["es"],
        fileName: () => "bundle.js",
      },
      outDir,
      emptyOutDir: true,
      sourcemap: isDev,
      minify: isDev ? false : "esbuild",
      rollupOptions: {
        external: (id: string) =>
          externals.some(
            (ext) => id === ext || id.startsWith(`${ext}/`),
          ),
        output: {
          globals: DEFAULT_GLOBALS,
          // Avoid code splitting — the bundle must be a single file.
          inlineDynamicImports: true,
        },
      },
    },
    // Ensure JSX works without explicit import in every file.
    esbuild: {
      jsx: "automatic",
    },
  });
}
