import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
    // Prioritize browser conditions for package exports
    conditions: ["browser", "import", "module", "default"],
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
