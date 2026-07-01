import { defineConfig } from "vitest/config";

// Real-integration lane for plugin-sql. The default vitest.config.ts
// UNCONDITIONALLY excludes **/*.real.test.ts, so the entire real
// DatabaseAdapter / migration / RLS / CRUD suite (backed by a real PGlite
// instance via createIsolatedTestDatabase) ran in no lane at all — the default
// runtime DB adapter shipped with zero CI coverage of its actual DB behavior
// (#10718). This config INCLUDES the real tests. PGlite needs no external
// service; the Postgres/RLS-specific files self-skip when POSTGRES_URL is unset.
// `*.real.e2e.test.ts` stays out — those need a running stack (owned by test:e2e).
export default defineConfig({
  test: {
    include: ["**/*.real.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.real.e2e.test.ts",
    ],
    hookTimeout: 60000,
    testTimeout: 120000,
    pool: "forks",
    isolate: true,
    fileParallelism: false,
    retry: 1,
    reporters: process.env.CI ? ["verbose"] : ["default"],
  },
});
