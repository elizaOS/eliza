/**
 * Vite build configuration for the browser-side XR emulator injected by
 * Playwright.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    alias: {
      iwer: require.resolve("iwer"),
    },
  },
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
        // Playwright fixtures load this exact filename with addInitScript.
        entryFileNames: "[name].js",
      },
    },
    minify: false, // keep readable for debugging
    sourcemap: true,
  },
});
