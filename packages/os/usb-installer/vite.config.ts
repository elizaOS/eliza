// Configures the USB installer build, server, and tests.
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    conditions: ["eliza-source", "module", "browser", "development|production"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3742",
        rewrite: (path) => path.replace(/^\/api/, ""),
        changeOrigin: true,
      },
    },
  },
});
