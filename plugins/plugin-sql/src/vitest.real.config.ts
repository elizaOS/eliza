/**
 * Companion to `vitest.config.ts` that includes the real (`*.real.test.ts`)
 * suites the default config excludes — the focused `memory-text-contains`
 * adapter coverage plus the `memory-keyword-search` scale test. These
 * exercise a real SQL store: PGlite by default, or a live Postgres via
 * `POSTGRES_URL`. No `run-all-tests.mjs` lane runs this config; invoke it on
 * demand via `bun run test:real:files`, after building `@elizaos/core` (this
 * config uses normal workspace resolution rather than aliasing core to its
 * TS source).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.real.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.real.e2e.test.ts"],
    hookTimeout: 120000,
    testTimeout: 300000,
    pool: "forks",
    isolate: true,
    fileParallelism: false,
    retry: 1,
    reporters: process.env.CI ? ["verbose"] : ["default"],
  },
});
