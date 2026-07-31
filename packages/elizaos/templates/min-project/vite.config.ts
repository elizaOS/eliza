/**
 * Vite configuration for the scaffolded minimal React app.
 */

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative base: scaffolded apps deploy under sub-paths (/apps/<slug>/);
  // vite's default "/" emits root-absolute /assets/... URLs that 404 there.
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
