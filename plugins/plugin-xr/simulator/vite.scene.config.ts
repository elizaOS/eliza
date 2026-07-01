import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the scene e2e fixture (React + the real @elizaos/ui/spatial XRSpatialScene)
// into a self-contained IIFE the static serve.mjs hosts at /scene. Kept separate
// from the emulator build (vite.config.ts) which produces the injected IIFE.
const spatialDir = resolve(__dirname, "../../../packages/ui/src/spatial");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@spatial": spatialDir },
    // One React instance — avoids the "useRef of null" dual-dispatcher hazard
    // when bundling react + react-dom + the UI source into one IIFE.
    dedupe: ["react", "react-dom"],
  },
  // React (and any `process.env` reads in the bundled source) need these defined
  // for a browser IIFE — otherwise `process is not defined` throws at load.
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    lib: {
      entry: resolve(__dirname, "e2e/scene/fixture.tsx"),
      name: "XRSceneFixture",
      fileName: "scene-bundle",
      formats: ["iife"],
    },
    outDir: "e2e/scene/dist",
    emptyOutDir: true,
    rollupOptions: {
      output: { inlineDynamicImports: true, entryFileNames: "scene-bundle.js" },
    },
    minify: false,
    sourcemap: true,
  },
});
