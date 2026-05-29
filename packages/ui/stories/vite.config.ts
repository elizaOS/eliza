import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiSrc = path.resolve(here, "../src");

export default defineConfig({
  root: here,
  // Shared UI source reads Node's `process.env` (terminal/theme, globals, etc.)
  // unguarded at module load; shim it to an empty object so those modules can
  // be imported in the browser catalog.
  define: {
    "process.env": "({})",
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@ui-src": uiSrc,
    },
  },
  server: {
    port: 4321,
  },
});
