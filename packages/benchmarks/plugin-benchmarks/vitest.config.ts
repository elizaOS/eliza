/** Vitest config for this package: Node environment, globals on, test files under __tests__. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // @elizaos/* resolve from the monorepo's TS source (no dist).
    conditions: ["eliza-source"],
  },
  ssr: {
    resolve: {
      conditions: ["eliza-source"],
    },
  },
  test: {
    include: ["__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    globals: true,
    environment: "node",
  },
});
