/** Defines app vitest behavior for dashboard host and runtime integration. */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../scripts/vitest/source-aliases";

const fileDir = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(fileDir, "../..");
// Resolve react/react-dom from the location of this config file so the alias
// works whether react is hoisted to the monorepo root or installed locally.
// createRequire resolves through the normal Node resolution algorithm (walks up
// node_modules directories), so it finds the correct copy regardless of where
// the package manager decided to hoist it.
const _require = createRequire(import.meta.url);
const reactPkg = path.dirname(_require.resolve("react/package.json"));
const reactDomPkg = path.dirname(_require.resolve("react-dom/package.json"));
const includeLiveE2e = process.env.ELIZA_INCLUDE_LIVE_E2E === "1";

/**
 * Real `react` / `react-dom` packages (not .d.ts stubs from tsconfig paths)
 * so Vite can execute files that import from workspace apps under tests.
 * Workspace `exports` and deep imports are mirrored here for Vitest’s resolver.
 */
export default defineConfig({
  test: {
    include: [
      "src/connectors/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/config/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/security/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/platform/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/runtime/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/utils/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/cli/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/permissions/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/styles/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/diagnostics/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/registry/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/first-run/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/api/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "src/services/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/stubs/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/dev-stack/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/electrobun/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/app/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/browser-extension/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/live-agent/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/benchmarks/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/fixtures/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/automations/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/helpers/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/services/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "scripts/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "__tests__/**/*.{test,spec}.?(c|m)[jt]s?(x)",
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Keep the PGlite and RS256-heavy suites serial to cap resource pressure.
    // File isolation prevents mock state from leaking across the package and
    // avoids shared-module-registry deadlocks under concurrent repository runs.
    maxWorkers: 1,
    isolate: true,
    server: { deps: { inline: [/@elizaos\//] } },
    // Heavy browser e2e — install `puppeteer-core` / `playwright-core` in this package to run
    exclude: [
      "scripts/android-native-plugins.test.ts",
      "scripts/native-plugin-build.test.ts",
      "scripts/verify-android-native-plugins.test.ts",
      "scripts/lib/electrobun-file-dialog.test.ts",
      "scripts/android-assistant-ime-lane.test.ts",
      "scripts/android-cloud-onboarding-command.test.ts",
      "scripts/android-e2e-build.test.ts",
      "scripts/android-e2e-port-contract.test.ts",
      "scripts/android-renderer-stamp.test.ts",
      "scripts/audit-views-soak-navigation.test.ts",
      "scripts/audit-views-soak-timing.test.ts",
      "scripts/build.test.ts",
      "scripts/capture-duration-entrypoint.test.ts",
      "scripts/desktop-voice-hardware-capture.test.ts",
      "scripts/dev-server-registry.test.ts",
      "scripts/device-e2e-bundle.test.ts",
      "scripts/device-evidence-workflows.test.ts",
      "scripts/device-lease.test.ts",
      "scripts/devices-status.test.ts",
      "scripts/forced-host-mode-guard.test.ts",
      "scripts/ios-device-lib.test.ts",
      "scripts/ios-device-provision.test.ts",
      "scripts/ios-e2e-lib.test.ts",
      "scripts/ios-store-engine-gate.test.ts",
      "scripts/ios-voice-selftest-lib.test.ts",
      "scripts/lib/android-assistant-verify-lib.test.ts",
      "scripts/lib/android-capture.test.ts",
      "scripts/lib/android-device-apk.test.ts",
      "scripts/lib/android-e2e-evidence-policy.test.ts",
      "scripts/lib/audit-output.test.ts",
      "scripts/lib/capture-output-backend-log-port.test.ts",
      "scripts/lib/capture-output.test.ts",
      "scripts/lib/chat-failure-strings.test.ts",
      "scripts/lib/chat-history-persistence.node.test.ts",
      "scripts/lib/chat-history-persistence.test.ts",
      "scripts/lib/dev-vite-command.test.ts",
      "scripts/lib/ffmpeg.test.ts",
      "scripts/lib/host-agent.test.ts",
      "scripts/lib/ios-deploy-ledger.test.ts",
      "scripts/lib/ios-device-e2e-lib.test.ts",
      "scripts/lib/ios-full-bun-smoke-contract.test.ts",
      "scripts/lib/ios-mixed-content-smoke-contract.test.ts",
      "scripts/lib/ios-simulator-app-product.test.ts",
      "scripts/lib/local-inference-readiness.test.ts",
      "scripts/lib/playwright-port.test.ts",
      "scripts/lib/playwright-shard.test.ts",
      "scripts/lib/visual-qa.test.ts",
      "scripts/macos-shortcuts/eliza-assistant-handoff.test.ts",
      "scripts/mobile-local-chat-smoke-port-policy.test.ts",
      "scripts/mobile-local-chat-smoke.test.ts",
      "scripts/mvp-visual-verify.test.ts",
      "scripts/ocr-real-engine.test.ts",
      "scripts/patch-ios-plist.test.ts",
      "scripts/playwright-audit-projects.test.ts",
      "scripts/playwright-test-match.test.ts",
      "scripts/run-ui-playwright-node-resolution.test.ts",
      "scripts/verify-viewport-meta.test.ts",
      "scripts/visual-qa-live.test.ts",
      "scripts/voice-evidence-media.test.ts",
      "scripts/walkthrough-device-matrix.test.ts",
      "scripts/web-build-workspace-dependencies.test.ts",
      "**/.git/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/*.e2e.test.{ts,tsx}",
      "**/*.e2e.spec.{ts,tsx}",
      "**/*.integration.test.{ts,tsx}",
      // #9310 §E: the guarded *.live.test.ts suite (opt-in gated, self-skips)
      // is invocable only in the post-merge lane, where run-all-tests.ts
      // prints a named skip accounting.
      ...(process.env.VITEST_LANE === "post-merge"
        ? []
        : ["**/*.live.test.{ts,tsx}"]),
      "**/*.live.e2e.test.{ts,tsx}",
      "**/*.real.test.{ts,tsx}",
      "**/*.real.e2e.test.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
      "platforms/electrobun/**",
      "scripts/run-mobile-build-policy.test.mjs",
      "scripts/run-mobile-build-android-app-actions.test.ts",
      "scripts/build-experimental-exact-window-helper.test.ts",
      "scripts/aosp/compile-libllama-fused.test.mjs",
      "scripts/mas-smoke.test.ts",
      // The runner-based suites above are excluded from vitest because they use
      // node:test/bun:test. They are executed by `bun run test:script-suites`
      // (chained from `test`) so the exclusion no longer means "runs nowhere".
      // Uses Node.js built-in test runner (node:test), not vitest.
      "scripts/build-experimental-exact-window-helper.test.ts",
      "scripts/ensure-fused-inference-install.test.ts",
      "scripts/android-sms-gateway-template.test.mjs",
      "scripts/stage-android-agent.test.ts",
      "scripts/android-pglite-staging.test.ts",
      "scripts/ensure-vision-deps-policy.test.ts",
      "scripts/lib/dev-port-ownership.test.ts",
      "scripts/lib/apk-runtime-provenance.test.ts",
      "scripts/lib/android-runtime-packaging.test.ts",
      "scripts/stage-desktop-fused-lib-staleness.test.ts",
      "scripts/ensure-fused-inference-install.test.ts",
      "scripts/build-helpers/arm64-simd.test.ts",
      "scripts/lib/electrobun-loopback-hardening.test.ts",
      "scripts/lib/linux-artifact-permissions.test.ts",
      "scripts/lib/fused-artifact-integrity.test.ts",
      "scripts/lib/ios-fused-slice-cache.test.ts",
      "scripts/mobile/ios/overlay.test.ts",
      // Uses Node.js built-in test runner (node:test), not vitest; runs in
      // `bun run test:script-suites` (node --test list).
      "scripts/store-listing-urls.test.ts",
      "scripts/native-plugin-build.test.ts",
      "scripts/android-native-plugins.test.ts",
      "scripts/verify-android-native-plugins.test.ts",
      // Uses bun:test, not vitest; runs in `bun run test:script-suites`.
      "scripts/voice/voice-models-publish-all.test.ts",
      // Uses bun:test, not vitest.
      "scripts/aosp/stage-default-models.test.ts",
      // Uses bun:test, not vitest.
      "scripts/aosp/compile-libllama-zig-pin.test.ts",
      ...(process.platform === "win32"
        ? [
            // These suites fail ONLY on the GitHub-hosted windows-ci runner with
            // a bare "SyntaxError: Invalid or unexpected token" at transform /
            // collection time (each reports as a "0 test" failed suite). Every
            // file is valid (`node --check` passes), byte-identical to develop
            // (no BOM, no CRLF; content is not the trigger — the ones with zero
            // non-ASCII bytes fail identically, and the two with a byte only
            // carry an em-dash in a prose comment). Each passes on every Linux
            // lane and locally on Windows under bun stable AND canary, both
            // single-file and full-suite. Not reproducible off the CI runner →
            // a windows-ci transform/environment anomaly, not a logic failure.
            // Gated on Windows CI pending a root-cause that needs the runner
            // itself; every one of these still runs on Linux.
            "scripts/lib/apple-entitlement-audit.test.ts",
            "scripts/run-mobile-build-ios-engine-gate.test.ts",
            "scripts/run-mobile-build-android-cloud-strip.test.ts",
            "scripts/run-mobile-build-android-targets.test.ts",
            "scripts/run-mobile-build-ios-identity.test.ts",
            "scripts/run-mobile-build-plugin-manifest.test.ts",
            "scripts/voice-interactive.test.ts",
            "scripts/aosp/compile-libllama.test.ts",
          ]
        : []),
      ".claude/**",
      "test/app/memory-relationships.real.e2e.test.ts",
      "test/app/qa-checklist.real.e2e.test.ts",
      ...(includeLiveE2e
        ? []
        : [
            "src/services/local-inference/engine.e2e.test.ts",
            "test/live-agent/**/*.e2e.test.ts",
          ]),
    ],
  },
  resolve: {
    alias: [
      { find: "react", replacement: reactPkg },
      {
        find: "react/jsx-runtime",
        replacement: path.join(reactPkg, "jsx-runtime.js"),
      },
      {
        find: "react/jsx-dev-runtime",
        replacement: path.join(reactPkg, "jsx-dev-runtime.js"),
      },
      { find: "react-dom", replacement: reactDomPkg },
      {
        find: "react-dom/client",
        replacement: path.join(reactDomPkg, "client.js"),
      },
      {
        find: "node-llama-cpp",
        replacement: path.join(fileDir, "test-stubs/node-llama-cpp.ts"),
      },
      // Resolve remaining workspace plugins from source in a clean checkout.
      // Keep explicit host aliases and test doubles above these fallbacks.
      ...buildWorkspaceSourceAliases(monorepoRoot),
    ],
  },
});
