import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig, type Plugin } from "vite";

/**
 * GitHub Pages serves a single static directory and does not understand
 * client-side routes. Copying index.html to 404.html means deep links such as
 * /leaderboard fall through to the SPA shell, which then renders the right
 * route via React Router.
 */
function gh404Fallback(): Plugin {
  return {
    name: "gh-pages-404-fallback",
    apply: "build",
    closeBundle() {
      if (process.env.CF_PAGES === "1") return;

      const outDir = path.resolve(__dirname, "dist");
      const indexHtml = path.join(outDir, "index.html");
      const notFoundHtml = path.join(outDir, "404.html");
      if (fs.existsSync(indexHtml)) {
        fs.copyFileSync(indexHtml, notFoundHtml);
      }
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    gh404Fallback(),
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
      {
        find: "@elizaos/ui/button",
        replacement: path.resolve(
          __dirname,
          "../ui/src/cloud-ui/components/button.tsx",
        ),
      },
      {
        find: "@elizaos/ui/dropdown-menu",
        replacement: path.resolve(
          __dirname,
          "../ui/src/cloud-ui/components/dropdown-menu.tsx",
        ),
      },
      {
        find: "@elizaos/ui/input",
        replacement: path.resolve(
          __dirname,
          "../ui/src/cloud-ui/components/input.tsx",
        ),
      },
      {
        find: "@elizaos/ui/product-switcher",
        replacement: path.resolve(
          __dirname,
          "../ui/src/cloud-ui/components/product-switcher.tsx",
        ),
      },
      {
        find: /^@elizaos\/ui$/,
        replacement: path.resolve(
          __dirname,
          "../ui/src/backgrounds/CloudVideoBackground.tsx",
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
  },
});
