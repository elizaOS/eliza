import { defineConfig } from "vitest/config";

// Live e2e config. The default `vitest.config.ts` (and the repo root config)
// exclude `*.live.e2e.test.ts` because they drive the real running dev stack
// (`bun run dev:web:ui`) with a headless browser. They're opt-in: run with
// `bun run --cwd plugins/plugin-task-coordinator test:e2e:manual`. Each suite
// gates itself on the stack being reachable, so it skips cleanly when it isn't.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.live.e2e.test.ts"],
    exclude: ["dist/**", "**/node_modules/**"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
