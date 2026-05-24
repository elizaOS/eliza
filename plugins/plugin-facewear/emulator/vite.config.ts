import { resolve } from "node:path";
import { defineConfig } from "vite";

// Builds the browser-side emulator as a self-contained IIFE.
// Output: dist/emulator.js — injected into pages by Playwright via addInitScript.
export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/emulator.ts"),
      name: "XREmulator",
      fileName: "emulator",
      formats: ["iife"],
    },
    outDir: "dist",
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        // Force the output filename to emulator.js (not emulator.iife.js)
        entryFileNames: "[name].js",
      },
    },
    minify: false, // keep readable for debugging
    sourcemap: true,
  },
});
