/** Defines app-core vitest harvest live agent behavior for dashboard host and runtime integration. */
import baseConfig from "./vitest.config";

/**
 * Vitest config for the gpt-5.5 trajectory harvest of the `test/live-agent`
 * live/real e2e lanes.
 *
 * The default `vitest.config.ts` EXCLUDES every `*.live.e2e.test.ts` /
 * `*.real.e2e.test.ts` file with unconditional glob patterns, and
 * `vitest.app-real-e2e.config.ts` only surfaces the `test/app/**` browser-driven
 * lanes — so nothing runs `test/live-agent/*.live.e2e.test.ts` today (the same
 * "these files were dark" situation the app-real-e2e config was created to fix,
 * one directory over). This config inherits the default config's `@elizaos/*`
 * source aliases + setup (so the runtime resolves to source with dist absent)
 * and overrides ONLY `include`/`exclude` so the harvest driver
 * (scripts/training-harvest/bench-e2e-harvest-runner.mjs --family e2e) can run a
 * single live-agent lane on gpt-5.5-via-Codex and capture its trajectory. Each
 * lane self-skips (`describeIf`/`CAN_RUN`) unless `ELIZA_LIVE_TEST=1` + a live
 * provider is present, so this config is inert without those.
 */
export default {
  ...baseConfig,
  resolve: {
    ...baseConfig.resolve,
    // The default config aliases only the main workspace packages to source.
    // The live-agent lanes also dynamically import first-party PLUGINS
    // (@elizaos/plugin-birdclaw, …) whose dist is absent in a fresh worktree, so
    // Vite must resolve them via each package's `eliza-source` export condition
    // (source .ts) instead of the default (dist). Kept first so source wins.
    conditions: [
      "eliza-source",
      ...(baseConfig.resolve?.conditions ?? [
        "import",
        "module",
        "node",
        "default",
      ]),
    ],
  },
  test: {
    ...baseConfig.test,
    include: [
      "test/live-agent/**/*.live.e2e.test.ts",
      "test/live-agent/**/*.real.e2e.test.ts",
    ],
    exclude: ["dist/**", "**/node_modules/**"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
};
