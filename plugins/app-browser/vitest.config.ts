import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: rootDir,
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
