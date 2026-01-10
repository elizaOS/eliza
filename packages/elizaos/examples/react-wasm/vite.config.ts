import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    headers: {
      // Required for SharedArrayBuffer used by WASM
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    fs: {
      // Allow serving files from node_modules for WASM assets
      allow: ["../.."],
    },
  },
  define: {
    "process.env": {},
    global: "globalThis",
  },
  resolve: {
    conditions: ["browser", "import", "module", "default"],
    alias: {
      // Ensure browser versions of packages are used
      "@elizaos/plugin-localdb": "@elizaos/plugin-localdb/browser",
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "esnext",
    },
  },
  build: {
    target: "esnext",
    modulePreload: {
      polyfill: true,
    },
  },
});
