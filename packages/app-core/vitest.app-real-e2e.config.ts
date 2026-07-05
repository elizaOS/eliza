/** Defines app-core vitest app real e2e behavior for dashboard host and runtime integration. */
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
 * suite (qa-checklist, memory-relationships,
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
  resolve: {
    ...baseConfig.resolve,
    preserveSymlinks: false,
  },
  test: {
    ...baseConfig.test,
    setupFiles: [path.join(here, "test/setup.ts")],
    include: [
      "test/app/**/*.real.e2e.test.ts",
      "test/app/**/*.live.e2e.test.ts",
      // Keyless-but-heavyweight wire coverage: boots the full real runtime +
      // HTTP/WS server, so it lives in this nightly full-build lane rather
      // than the PR unit lane (which excludes live-agent e2e wholesale). It
      // has no provider-key gate — it runs on every nightly invocation.
      "test/live-agent/views-interact-ws-roundtrip.real.e2e.test.ts",
      // #13692 production auth path: boots the real runtime + HTTP server and
      // drives the pair-code → machine-session handshake, cookie persistence,
      // and the token-gated remote connect. Keyless (deterministic LLM proxy),
      // so it runs on every nightly invocation with no provider gate.
      "test/live-agent/auth-pairing-remote-connect.real.e2e.test.ts",
    ],
    exclude: ["dist/**", "**/node_modules/**"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
