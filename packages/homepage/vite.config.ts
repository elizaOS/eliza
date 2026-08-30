/**
 * Vite build configuration for the static homepage application.
 *
 * The aliases keep workspace UI imports pointed at source files so the homepage
 * bundle avoids unrelated package barrels.
 */
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig } from "vite";

const homepageBuildRevision = (
  process.env.GITHUB_SHA ??
  process.env.CF_PAGES_COMMIT_SHA ??
  "local"
)
  .slice(0, 12)
  .replaceAll(/[^a-zA-Z0-9_-]/g, "-");

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    visualizer({
      filename: "dist/stats.html",
      gzipSize: true,
      brotliSize: false,
      template: "treemap",
    }),
  ],
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "react-router",
      "react-router-dom",
      "@react-three/fiber",
      "three",
      "zod",
    ],
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      {
        find: "@elizaos/shared/brand",
        replacement: path.resolve(__dirname, "../shared/src/brand/index.ts"),
      },
      {
        find: "@elizaos/shared/elizacloud/domain-contract",
        replacement: path.resolve(
          __dirname,
          "../shared/src/elizacloud/domain-contract.ts",
        ),
      },
      // Keep this bare-package alias after the exact subpaths: Vite string
      // aliases also match slash-prefixed subpaths. The source-aliased UI
      // region helper imports only these dependency-free language primitives,
      // so clean source-harness builds neither require shared/dist nor bundle the
      // full shared (and transitively core) barrel.
      {
        find: "@elizaos/shared",
        replacement: path.resolve(__dirname, "../shared/src/i18n/language.ts"),
      },
      // Icon-only subpath MUST come before the cloud-ui barrel alias —
      // the homepage onboarding pages import only icons here to avoid
      // pulling the full barrel (which drags in hast + framer-motion).
      {
        find: "@elizaos/ui/cloud-ui/components/icons",
        replacement: path.resolve(
          __dirname,
          "../ui/src/cloud-ui/components/icons.tsx",
        ),
      },
      {
        find: "@elizaos/ui/cloud-ui",
        replacement: path.resolve(__dirname, "../ui/src/cloud-ui/index.ts"),
      },
      // Primitives were collapsed from cloud-ui/components shims into the
      // canonical components/ui layer (ui refactor "collapse cloud-ui primitive
      // re-export shims into canonical components/ui"); resolve to the new home.
      {
        find: "@elizaos/ui/button",
        replacement: path.resolve(
          __dirname,
          "../ui/src/components/ui/button.tsx",
        ),
      },
      {
        find: "@elizaos/ui/card",
        replacement: path.resolve(
          __dirname,
          "../ui/src/components/ui/card.tsx",
        ),
      },
      {
        find: "@elizaos/ui/dropdown-menu",
        replacement: path.resolve(
          __dirname,
          "../ui/src/components/ui/dropdown-menu.tsx",
        ),
      },
      {
        find: "@elizaos/ui/input",
        replacement: path.resolve(
          __dirname,
          "../ui/src/components/ui/input.tsx",
        ),
      },
      {
        find: "@elizaos/ui/native-select",
        replacement: path.resolve(
          __dirname,
          "../ui/src/components/ui/native-select.tsx",
        ),
      },
      {
        find: "@elizaos/ui/native-dialog",
        replacement: path.resolve(
          __dirname,
          "../ui/src/components/ui/native-dialog.tsx",
        ),
      },
      {
        find: "@elizaos/ui/textarea",
        replacement: path.resolve(
          __dirname,
          "../ui/src/components/ui/textarea.tsx",
        ),
      },
      {
        find: "@elizaos/ui/i18n/region",
        replacement: path.resolve(__dirname, "../ui/src/i18n/region.ts"),
      },
      {
        find: "@elizaos/ui/product-switcher",
        replacement: path.resolve(
          __dirname,
          "../ui/src/cloud-ui/components/product-switcher.tsx",
        ),
      },
    ],
  },
  server: {
    port: 4444,
  },
  preview: {
    port: 4444,
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // A deployment revision prevents a browser-cached failed module
        // response from pinning a later production build to the same URL.
        entryFileNames: `assets/[name]-[hash]-${homepageBuildRevision}.js`,
        chunkFileNames: `assets/[name]-[hash]-${homepageBuildRevision}.js`,
        assetFileNames: `assets/[name]-[hash]-${homepageBuildRevision}[extname]`,
      },
    },
  },
});
