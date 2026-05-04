import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

const _dirname =
  typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

// Custom standard Vitest configuration using JSDOM
export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: [
      { find: "@/lib", replacement: path.resolve(_dirname, "../lib") },
      { find: "@/db", replacement: path.resolve(_dirname, "../db") },
      { find: "@/types", replacement: path.resolve(_dirname, "../types") },
      { find: "@/components", replacement: path.resolve(_dirname, "./src/components") },
      { find: "@/app", replacement: path.resolve(_dirname, "../../app") },
      { find: "@/packages/ui/src", replacement: path.resolve(_dirname, "./src") },
      { find: "@", replacement: path.resolve(_dirname, "./src") },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
