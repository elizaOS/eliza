/** Defines app-core vitest app real e2e behavior for dashboard host and runtime integration. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import appCoreConfig from "./vitest.config";

// Real developer environment (real $HOME, network, disk) for the through-the-UI
// real e2e suite.
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
 * `src/`, so before this config existed nothing ran them — they were dark.
 * Invoke via the `test:app-real-e2e` script. The root `test:e2e:heavy` script
 * runs this config narrowed to the qa-checklist and memory-relationships files
 * for the release gate (`.github/workflows/release-electrobun.yml`); the full
 * suite here has no other scheduled CI caller yet.
 */
export default defineConfig({
  ...appCoreConfig,
  resolve: {
    ...appCoreConfig.resolve,
    preserveSymlinks: false,
  },
  test: {
    ...appCoreConfig.test,
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
      // Full HTTP conversation path with the fixture-driven text provider.
      // Embeddings remain explicitly disabled instead of being fabricated.
      "test/live-agent/conversation-deterministic.real.e2e.test.ts",
    ],
    exclude: ["dist/**", "**/node_modules/**"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
