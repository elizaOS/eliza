import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/test/vitest/default.config";

// Real developer environment (real $HOME, network, disk) for the through-the-UI
// real e2e suite — same rationale as vitest.e2e.config.ts.
process.env.LIVE = "1";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Config for the `test/app/*.{real,live}.e2e.test.ts` browser-driven real e2e
 * suite (qa-checklist, first-run-companion, memory-relationships,
 * streaming-visible-text). These drive a real renderer via puppeteer/playwright
 * against a real app-core runtime + a real model provider; each self-skips
 * (`describeIf`/CAN_RUN) unless `ELIZA_LIVE_TEST=1` + a provider is present.
 *
 * The default `vitest.config.ts` explicitly EXCLUDES these files and only scans
 * `src/`, and `vitest.e2e.config.ts` only includes `src/**`, so before this
 * config nothing ran them — they were dark. Invoke via the `test:app-real-e2e`
 * script; wired into the nightly real lane.
 */
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    setupFiles: [path.join(here, "test/setup.ts")],
    include: [
      "test/app/**/*.real.e2e.test.ts",
      "test/app/**/*.live.e2e.test.ts",
    ],
    exclude: ["dist/**", "**/node_modules/**"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
