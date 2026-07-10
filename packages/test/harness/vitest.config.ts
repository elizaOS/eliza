/** Configures the shared test harness Vitest project for deterministic keyless runtime tests. */
import { defineConfig } from "vitest/config";
import { buildHarnessSourceAliases } from "./source-aliases.ts";

// Resolve every workspace `@elizaos/*` package to source so booting a real
// AgentRuntime is independent of build order (mirrors scenario-runner's config).
// The alias set is shared with every per-plugin harness config via
// `buildHarnessSourceAliases()` so the two never drift.
export default defineConfig({
  test: {
    environment: "node",
    // `scenarios/**` holds .scenario.ts specs for the scenario runner, but unit
    // tests of their assertion modules live alongside them as *.test.ts. This
    // package's `test` script is their only recurring lane (server lane on
    // develop pushes + nightly), so they must be included here or they run
    // nowhere (#16020).
    include: ["harness/**/*.test.ts", "scenarios/**/*.test.ts"],
    exclude: ["dist/**", "**/node_modules/**"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: "forks",
  },
  resolve: {
    alias: buildHarnessSourceAliases(),
  },
});
