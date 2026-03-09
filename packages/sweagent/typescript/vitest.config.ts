import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@jest/globals": path.join(rootDir, "tests", "jest-globals.ts"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    setupFiles: [path.join(rootDir, "tests", "setup.ts")],
    testTimeout: 30_000,
  },
});
