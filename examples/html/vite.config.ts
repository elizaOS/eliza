import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    target: "esnext",
    outDir: "dist",
  },
  resolve: {
    conditions: ["browser", "import", "module", "default"],
    alias: {
      // Alias both the package name and the /browser subpath
      "@elizaos/core/browser": resolve(__dirname, "../../packages/core/dist/browser/index.browser.js"),
      "@elizaos/core": resolve(__dirname, "../../packages/core/dist/browser/index.browser.js"),
      "@elizaos/plugin-sql/browser": resolve(__dirname, "../../plugins/plugin-sql/dist/browser/index.browser.js"),
      "@elizaos/plugin-sql": resolve(__dirname, "../../plugins/plugin-sql/dist/browser/index.browser.js"),
    },
  },
  optimizeDeps: {
    include: ["uuid"],
    esbuildOptions: {
      target: "esnext",
    },
  },
  server: {
    port: 3000,
    open: true,
  },
});
