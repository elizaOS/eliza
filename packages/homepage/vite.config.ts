import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
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
  plugins: [react(), tailwindcss(), gh404Fallback()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
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
