/**
 * Configures the app package Vitest suite, including jsdom setup and
 * package-local test boundaries.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/scripts/vitest/default.config";

const here = path.dirname(fileURLToPath(import.meta.url));

const unitExcludes = [
  "dist/**",
  "**/node_modules/**",
  "**/*.live.test.{ts,tsx}",
  "**/*.real.test.{ts,tsx}",
  "**/*.integration.test.{ts,tsx}",
  "**/*.e2e.test.{ts,tsx}",
  "**/*.e2e.spec.{ts,tsx}",
  "**/*.spec.{ts,tsx}",
  // Script-level tests use Bun or Node test APIs and run through the package's
  // dedicated `bun test` phase, outside Vitest's jsdom transform.
  "scripts/**/*.test.{ts,tsx,mjs}",
];

export default defineConfig({
  ...baseConfig,
  root: here,
  plugins: [
    ...(baseConfig.plugins ?? []),
    {
      name: "renderer-cold-boot",
      enforce: "pre",
      transform(source, id) {
        if (id.split("?")[0] !== path.join(here, "src/main.tsx")) return;
        // Composition tests boot the shipped renderer without a dev server.
        // Vitest's Vite-client stub lacks hot.data; the dedicated main-bootstrap
        // suite separately exercises real HMR persistence with a complete context.
        return {
          code: source.replaceAll("import.meta.hot", "undefined"),
          map: null,
        };
      },
    },
  ],
  resolve: {
    ...baseConfig.resolve,
    alias: [
      {
        // Entrypoint tests exercise the shipped iOS bridge import in source mode;
        // the changed-test lane intentionally builds core only, so they cannot
        // depend on a pre-existing app dist directory.
        find: /^@elizaos\/app\/api\/ios-local-agent-transport$/,
        replacement: path.join(
          here,
          "../app/src/api/ios-local-agent-transport.ts",
        ),
      },
      {
        // Same source-mode rule for the desktop-shell subpath the entrypoint
        // tests import (runIosFullBunSmokeIfRequested): the export maps to
        // app's dist, which the changed-test lane never builds.
        find: /^@elizaos\/app\/desktop-shell$/,
        replacement: path.join(here, "../app/src/desktop-shell.ts"),
      },
      {
        // main.tsx imports "@elizaos/ui/styles"; the ui package otherwise
        // resolves to its built dist, whose externalized styles.js makes Node
        // load raw .css. Aliasing to source keeps the stylesheet inside vite's
        // pipeline, where the test css handling stubs it.
        find: /^@elizaos\/ui\/styles$/,
        replacement: path.join(here, "../ui/src/styles.ts"),
      },
      {
        // Dev-gated ui platform helpers (e.g. onboarding-replay) read
        // `import.meta.env.DEV`, which only exists when the module runs through
        // vite's pipeline. Resolve ui subpath imports from source so the suite
        // exercises the same dev semantics the renderer build ships.
        find: /^@elizaos\/ui\/api$/,
        replacement: path.join(here, "../ui/src/api/index.ts"),
      },
      {
        find: /^@elizaos\/ui\/(.+)$/,
        replacement: path.join(here, "../ui/src/$1"),
      },
      {
        find: /^@elizaos\/ui$/,
        replacement: path.join(here, "../ui/src/index.ts"),
      },
      {
        // Entrypoint tests import the device-bridge types/loader from source;
        // the package's published exports point at a dist directory this lane
        // never builds.
        find: /^@elizaos\/plugin-native-inference\/llama$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-native-inference/src/llama/index.ts",
        ),
      },
      {
        // Vite resolves this browser-safe dynamic import from source as well;
        // matching that boundary keeps fresh entrypoint tests independent of
        // plugin-blocker's generated dist directory.
        find: /^@elizaos\/plugin-blocker\/native$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-blocker/src/native.ts",
        ),
      },
      {
        find: /^@elizaos\/cloud-ui$/,
        replacement: path.join(here, "../cloud-ui/src/index.ts"),
      },
      {
        find: /^@elizaos\/cloud-ui\/(.+)$/,
        replacement: path.join(here, "../cloud-ui/src/$1"),
      },
      {
        find: /^@elizaos\/plugin-agent-orchestrator\/ui\/register$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-agent-orchestrator/src/ui/register.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-relationships\/register$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-relationships/src/register.ts",
        ),
      },
      ...(Array.isArray(baseConfig.resolve?.alias)
        ? baseConfig.resolve.alias
        : []),
    ],
  },
  test: {
    ...baseConfig.test,
    environment: "jsdom",
    setupFiles: [path.join(here, "test/setup.ts")],
    include: [
      "src/main.ios-interactive-entrypoint.test.ts",
      "src/desktop-fn-hold-policy.test.ts",
      "src/main.ios-full-bun-entrypoint.test.ts",
      "src/ios-full-bun-entrypoint.test.ts",
      "src/types/**/*.test.{ts,tsx,mjs}",
      "src/ios-runtime.test.ts",
      "src/native/**/*.test.{ts,tsx,mjs}",
      "src/deep-link-handler.test.ts",
      "src/public-web-entry.test.tsx",
      "src/ios-attachment-smoke.surrogate.test.ts",
      "src/web-ws-base-fix.test.ts",
      "src/desktop-hotkey.test.ts",
      "src/plugin-registrations.test.ts",
      "src/mobile-lifecycle.keyboard-guard.test.ts",
      "src/remote-controller-deep-link.test.ts",
      "src/web-entry-policy.test.ts",
      "src/sw-fetch.test.ts",
      "src/packaged-shell-storage-test-bridge.test.ts",
      "src/runtime-chooser-override.test.ts",
      "src/mobile-remote-fallback.test.ts",
      "src/deep-link-routing.test.ts",
      "src/sw-push.test.ts",
      "src/sw-registration.test.ts",
      "src/__tests__/**/*.test.{ts,tsx,mjs}",
      "src/ios-voice-selftest-smoke.test.ts",
      "src/embed-bootstrap.test.ts",
      "src/shims/**/*.test.{ts,tsx,mjs}",
      "src/native-transcript-bridge.test.ts",
      "src/renderer-shell-scope.test.ts",
      "src/main.network-fallback.test.ts",
      "src/brand-env.test.ts",
      "src/keyboard-dictation.test.ts",
      "src/main.android-entrypoint.test.ts",
      "src/public-web-boot-config.test.ts",
      "src/renderer-build-manifest-plugin.test.ts",
      "src/url-trust-policy.cloud-only.test.ts",
      "src/main.web-entrypoint.test.ts",
      "src/cloud-only-branding.test.ts",
      "test/ios-sim-defaults-hygiene.test.ts",
      "test/vite-source-resolution.test.ts",
      "test/screenshot-quality.test.ts",
      "test/android-browser/**/*.test.{ts,tsx,mjs}",
      "test/service-worker-cache-strategies.test.ts",
      "test/viewport-zoom-a11y.test.ts",
      "test/index-html-desktop-preboot.test.ts",
      "test/boot-failure.test.ts",
      "test/native-voice-capture.test.ts",
      "test/boot-voice-load.test.ts",
      "test/cloud-live-chat-correlation.test.ts",
      "test/pages-csp.test.ts",
      "test/ios-renderer-stamp.test.ts",
      "test/hmr/**/*.test.{ts,tsx,mjs}",
      "test/android-renderer-stamp.test.ts",
      "test/capacitor-plugin-selection.test.ts",
      "test/ios-cloud-onboarding-smoke.test.ts",
      "test/utils/**/*.test.{ts,tsx,mjs}",
      "test/url-trust-policy.test.ts",
      "test/interaction-observation.test.ts",
      "test/first-run-boot-patches.test.ts",
      "test/ui-smoke/**/*.test.{ts,tsx,mjs}",
      "test/index-html-fetch-bridge.test.ts",
      "test/background-runner.test.ts",
      "test/view-screenshots/**/*.test.{ts,tsx,mjs}",
      "test/service-worker-runtime.test.ts",
      "test/electrobun-packaged/**/*.test.{ts,tsx,mjs}",
      "test/verify-chunk-safety.test.ts",
      "test/audit/**/*.test.{ts,tsx,mjs}",
      "test/mobile-smoke-scripts.test.ts",
      "test/privacy-safe-liveness-diagnostic-artifact.test.ts",
      "test/cloud-live-browser-auth.test.ts",
      "test/android/**/*.test.{ts,tsx,mjs}",
      "test/cloud-live-trajectory-diagnostic.test.ts",
      "test/main-bootstrap.test.tsx",
      "test/native-module-stub-plugin.test.ts",
      "test/liveness-contract.test.ts",
      "test/journey-accounts-fixture.test.ts",
      "test/staging-cloud-chat-latency-evidence.test.ts",
      "test/url-scheme-registration.test.ts",
      "test/fixtures/**/*.test.{ts,tsx,mjs}",
      "test/dev-smoke/**/*.test.{ts,tsx,mjs}",
      "test/wallet-optimized-chunk-matcher.test.ts",
      "test/cloud-pair-session-token.test.ts",
      "test/design-review/**/*.test.{ts,tsx,mjs}",
      "test/service-worker-auth-bypass.test.ts",
      "test/pages-middleware-serving.test.ts",
      "test/mobile-lifecycle.test.ts",
      "test/app-config-vps-sidecar.test.ts",
      "test/cloud-live-continuity-contract.test.ts",
      "test/cloud-live-origin.test.ts",
      "test/ios-app-intents-registration.test.ts",
      "test/dev-http-proxy.test.ts",
      "test/cloud-live-renderer-api-readiness.test.ts",
      "test/sw-build-rev-plugin.test.ts",
    ],
    exclude: unitExcludes,
    coverage: {
      ...baseConfig.test?.coverage,
      include: ["src/**/*.{ts,tsx}"],
    },
  },
});
