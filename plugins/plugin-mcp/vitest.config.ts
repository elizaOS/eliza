import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@elizaos/core": path.resolve(rootDir, "../../packages/core/src/index.node.ts"),
    },
  },
  test: {
    include: ["__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    globals: true,
    environment: "node",
  },
});
