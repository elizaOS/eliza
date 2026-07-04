/** Vitest config for plugin-shell: aliases @elizaos/* imports to workspace source. */
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@elizaos/core": path.resolve(__dirname, "../../packages/core/src/index.ts"),
      "@elizaos/logger": path.resolve(__dirname, "../../packages/logger/src/index.ts"),
      "@elizaos/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    globals: true,
  },
});
