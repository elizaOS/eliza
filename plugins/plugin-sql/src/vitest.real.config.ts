import { defineConfig } from "vitest/config";

// Companion to `vitest.config.ts` that INCLUDES the real (`*.real.test.ts`)
// suites the default config statically excludes — the focused
// `memory-text-contains` adapter coverage plus the `memory-keyword-search`
// scale test. These exercise a real SQL store: PGlite by default, or a live
// Postgres via `POSTGRES_URL`.
//
// Why a separate config: `vitest.config.ts` hard-excludes the real suites
// (kept intentionally — see #9955) and no `run-all-tests.mjs` lane runs them,
// so they were otherwise unrunnable. Invoke on demand via
// `bun run test:real:files`. Build `@elizaos/core` first (e.g. `bun run build`),
// since this config relies on normal workspace resolution rather than aliasing
// core to its TS source.
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
