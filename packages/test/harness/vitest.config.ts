import { defineConfig } from "vitest/config";
import { buildHarnessSourceAliases } from "./source-aliases.ts";

// Resolve every workspace `@elizaos/*` package to source so booting a real
// AgentRuntime is independent of build order (mirrors scenario-runner's config).
// The alias set is shared with every per-plugin harness config via
// `buildHarnessSourceAliases()` so the two never drift.
export default defineConfig({
  test: {
    environment: "node",
    include: ["harness/**/*.test.ts"],
    exclude: ["dist/**", "**/node_modules/**"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: "forks",
  },
  resolve: {
    alias: buildHarnessSourceAliases(),
  },
});
