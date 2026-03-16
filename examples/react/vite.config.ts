import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Plugin to handle PGlite's Node.js-only dynamic imports.
 * PGlite has conditional imports for fs/promises that are only used
 * in Node.js, but Vite still tries to resolve them. This plugin
 * rewrites those imports to empty modules.
 */
function pgliteBrowserPlugin(): Plugin {
  return {
    name: "pglite-browser",
    enforce: "pre",
    resolveId(id) {
      // Only intercept bare module specifiers for Node.js built-ins
      if (
        (id === "fs" ||
          id === "fs/promises" ||
          id === "path" ||
          id === "url") &&
        !id.startsWith(".") &&
        !id.startsWith("/")
      ) {
        return "\0virtual:node-stub";
      }
      return null;
    },
    load(id) {
      if (id === "\0virtual:node-stub") {
        return `
          export default {};
          export const readFile = async () => { throw new Error('fs not available in browser'); };
          export const writeFile = async () => { throw new Error('fs not available in browser'); };
          export const existsSync = () => false;
          export const join = (...args) => args.join('/');
          export const resolve = (...args) => args.join('/');
          export const dirname = (p) => p;
          export const fileURLToPath = (url) => url;
        `;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [pgliteBrowserPlugin(), react()],
  server: {
    port: 5173,
    open: true,
    headers: {
      // Required for SharedArrayBuffer used by PGlite
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    fs: {
      // Allow serving files from node_modules for PGlite WASM assets
      allow: ["../.."],
    },
  },
  define: {
    "process.env": {},
    global: "globalThis",
  },
  resolve: {
    conditions: ["browser", "import", "module", "default"],
  },
  optimizeDeps: {
    // Exclude PGlite from pre-bundling - it handles its own WASM loading
    exclude: ["@electric-sql/pglite"],
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
