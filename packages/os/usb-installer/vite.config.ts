import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@elizaos/shared/brand": path.resolve(
        dirname,
        "../../shared/src/brand/index.ts",
      ),
    },
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
