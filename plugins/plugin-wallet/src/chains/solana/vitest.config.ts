/** Vitest config scoping the Solana chain sub-suite to its own test/spec globs, run under Node. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts", "tests/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.live.test.ts"],
  },
});
