import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

export default defineConfig({
  root: here,
  resolve: {
    alias: {
      "@elizaos/core": path.join(repoRoot, "packages/core/src/index.ts"),
      "@elizaos/shared": path.join(repoRoot, "packages/shared/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
