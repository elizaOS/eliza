/** Resolve @elizaos/* from the monorepo's TS source (eliza-source export condition). */
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["eliza-source"],
  },
  ssr: {
    resolve: {
      conditions: ["eliza-source"],
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
