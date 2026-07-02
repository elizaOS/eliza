// Gate lane: drives the REAL LifeOps code — the plugin-inbox triage classifier
// and the plugin-personal-assistant scheduled-task tick over a real
// PGlite-backed runtime with an injected clock.
//
// This reuses plugin-personal-assistant's src-integration config verbatim
// (the proven resolve/alias/stub wiring for booting the PA plugin barrel +
// scheduling spine under vitest) and swaps the include to this package's
// `*.gate.test.ts` files. The config's `root` is the repo root, so the include
// globs are repo-relative.
import { defineConfig } from "vitest/config";
import paIntegrationConfig from "../../../plugins/plugin-personal-assistant/vitest.src-integration.config";

export default defineConfig({
  ...paIntegrationConfig,
  test: {
    ...paIntegrationConfig.test,
    include: ["packages/benchmarks/lifeops-quality/**/*.gate.test.ts"],
    // The timeliness gate replays ~2,300 scheduler ticks against PGlite.
    testTimeout: 900_000,
    hookTimeout: 180_000,
  },
});
