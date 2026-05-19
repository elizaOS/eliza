import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
    },
  },
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
    passWithNoTests: true,
    environment: "node",
  },
});
