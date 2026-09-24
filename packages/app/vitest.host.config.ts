/** Defines app vitest behavior for dashboard host and runtime integration. */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../scripts/vitest/source-aliases";

const fileDir = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(fileDir, "../..");
const appCoreSrc = path.join(fileDir, "src");
const agentSrc = path.join(monorepoRoot, "packages/agent/src");
const authSrc = path.join(monorepoRoot, "packages/auth/src/auth");
const uiDir = path.join(monorepoRoot, "packages/ui");
const sharedSrc = path.join(monorepoRoot, "packages/shared/src");
const coreSrc = path.join(monorepoRoot, "packages/core/src");
const vaultSrc = path.join(monorepoRoot, "packages/auth/src/vault");
const cloudRoutingSrc = path.join(monorepoRoot, "packages/cloud/routing/src");
const cloudSdkSrc = path.join(monorepoRoot, "packages/cloud/sdk/src");
const appLifeopsSrc = path.join(
  monorepoRoot,
  "plugins/plugin-personal-assistant/src",
);
const appTaskCoordinatorSrc = path.join(
  monorepoRoot,
  "plugins/plugin-agent-orchestrator/src/ui",
);
const toVitePath = (value: string): string => value.replaceAll("\\", "/");
const appWalletSrc = path.join(monorepoRoot, "plugins/plugin-wallet/src/ui");
const pluginSqlSrc = path.join(monorepoRoot, "plugins/plugin-sql/src");
const pluginTodosSrc = path.join(monorepoRoot, "plugins/plugin-todos/src");
const pluginBrowserBridgeSrc = path.join(
  monorepoRoot,
  "plugins/plugin-browser/src",
);
const pluginAnthropicRoot = path.join(monorepoRoot, "plugins/plugin-anthropic");
const pluginComputerUseSrc = path.join(
  monorepoRoot,
  "plugins/plugin-computeruse/src",
);
const pluginCodingToolsSrc = path.join(
  monorepoRoot,
  "plugins/plugin-coding-tools/src",
);
const pluginDiscordRoot = path.join(monorepoRoot, "plugins/plugin-discord");
const pluginElizaCloudSrc = path.join(
  monorepoRoot,
  "plugins/plugin-elizacloud",
  "src",
);
const pluginIMessageSrc = path.join(
  monorepoRoot,
  "plugins/plugin-imessage/src",
);
const pluginMcpSrc = path.join(monorepoRoot, "plugins/plugin-mcp/src");
const pluginLocalInferenceSrc = path.join(
  monorepoRoot,
  "plugins/plugin-local-inference/src",
);
const pluginNativeFilesystemSrc = path.join(
  monorepoRoot,
  "plugins/plugin-native-filesystem/src",
);
const pluginOpenAiSrc = path.join(monorepoRoot, "plugins/plugin-openai");
const pluginPdfSrc = path.join(monorepoRoot, "plugins/plugin-pdf");
const pluginVideoSrc = path.join(monorepoRoot, "plugins/plugin-video/src");
const pluginWalletSrc = path.join(monorepoRoot, "plugins/plugin-wallet/src");
const pluginAgentOrchestratorSrc = path.join(
  monorepoRoot,
  "plugins/plugin-agent-orchestrator/src",
);
const pluginGitpathologistSrc = path.join(
  monorepoRoot,
  "plugins/plugin-gitpathologist/src",
);
const pluginGoogleSrc = path.join(
  monorepoRoot,
  "plugins/plugin-google-workspace/src",
);
const pluginPtyRoot = path.join(monorepoRoot, "plugins/plugin-pty");
const pluginVisionSrc = path.join(monorepoRoot, "plugins/plugin-vision/src");
const pluginWorkflowSrc = path.join(
  monorepoRoot,
  "plugins/plugin-workflow/src",
);
// Optional static plugins imported by
// packages/agent/src/runtime/optional-plugin-imports.ts. The Windows
// CI app-and-cli shard runs vitest without a plugin build, so these must resolve
// to source here like every other package in OPTIONAL_PLUGIN_IMPORTERS —
// otherwise Vite fails the whole suite at `Failed to resolve entry for package`.
const pluginSchedulingSrc = path.join(
  monorepoRoot,
  "plugins/plugin-scheduling/src",
);
const pluginInboxSrc = path.join(monorepoRoot, "plugins/plugin-inbox/src");
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
      "scripts/android-native-plugins.test.mjs",
      "scripts/native-plugin-build.test.mjs",
      "scripts/verify-android-native-plugins.test.mjs",
      "scripts/lib/electrobun-file-dialog.test.mjs",
      "scripts/android-assistant-ime-lane.test.mjs",
      "scripts/android-cloud-onboarding-command.test.mjs",
      "scripts/android-e2e-build.test.mjs",
      "scripts/android-e2e-port-contract.test.mjs",
      "scripts/android-renderer-stamp.test.mjs",
      "scripts/audit-views-soak-navigation.test.mjs",
      "scripts/audit-views-soak-timing.test.mjs",
      "scripts/build.test.mjs",
      "scripts/capture-duration-entrypoint.test.mjs",
      "scripts/desktop-voice-hardware-capture.test.mjs",
      "scripts/dev-server-registry.test.mjs",
      "scripts/device-e2e-bundle.test.mjs",
      "scripts/device-evidence-workflows.test.mjs",
      "scripts/device-lease.test.mjs",
      "scripts/devices-status.test.mjs",
      "scripts/forced-host-mode-guard.test.mjs",
      "scripts/ios-device-lib.test.mjs",
      "scripts/ios-device-provision.test.mjs",
      "scripts/ios-e2e-lib.test.mjs",
      "scripts/ios-store-engine-gate.test.mjs",
      "scripts/ios-voice-selftest-lib.test.mjs",
      "scripts/lib/android-assistant-verify-lib.test.mjs",
      "scripts/lib/android-capture.test.mjs",
      "scripts/lib/android-device-apk.test.mjs",
      "scripts/lib/android-e2e-evidence-policy.test.mjs",
      "scripts/lib/audit-output.test.mjs",
      "scripts/lib/capture-output-backend-log-port.test.mjs",
      "scripts/lib/capture-output.test.mjs",
      "scripts/lib/chat-failure-strings.test.mjs",
      "scripts/lib/chat-history-persistence.node.test.mjs",
      "scripts/lib/chat-history-persistence.test.mjs",
      "scripts/lib/dev-vite-command.test.mjs",
      "scripts/lib/ffmpeg.test.mjs",
      "scripts/lib/host-agent.test.mjs",
      "scripts/lib/ios-deploy-ledger.test.mjs",
      "scripts/lib/ios-device-e2e-lib.test.mjs",
      "scripts/lib/ios-full-bun-smoke-contract.test.mjs",
      "scripts/lib/ios-mixed-content-smoke-contract.test.mjs",
      "scripts/lib/ios-simulator-app-product.test.mjs",
      "scripts/lib/local-inference-readiness.test.mjs",
      "scripts/lib/playwright-port.test.mjs",
      "scripts/lib/playwright-shard.test.mjs",
      "scripts/lib/visual-qa.test.ts",
      "scripts/macos-shortcuts/eliza-assistant-handoff.test.ts",
      "scripts/mobile-local-chat-smoke-port-policy.test.mjs",
      "scripts/mobile-local-chat-smoke.test.mjs",
      "scripts/mvp-visual-verify.test.mjs",
      "scripts/ocr-real-engine.test.ts",
      "scripts/patch-ios-plist.test.mjs",
      "scripts/playwright-audit-projects.test.mjs",
      "scripts/playwright-test-match.test.mjs",
      "scripts/run-ui-playwright-node-resolution.test.mjs",
      "scripts/verify-viewport-meta.test.mjs",
      "scripts/visual-qa-live.test.mjs",
      "scripts/voice-evidence-media.test.mjs",
      "scripts/walkthrough-device-matrix.test.mjs",
      "scripts/web-build-workspace-dependencies.test.mjs",
      "**/.git/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/*.e2e.test.{ts,tsx}",
      "**/*.e2e.spec.{ts,tsx}",
      "**/*.integration.test.{ts,tsx}",
      // #9310 §E: the guarded *.live.test.ts suite (opt-in gated, self-skips)
      // is invocable only in the post-merge lane, where run-all-tests.mjs
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
      "scripts/run-mobile-build-android-app-actions.test.mjs",
      "scripts/build-experimental-exact-window-helper.test.mjs",
      "scripts/aosp/compile-libllama-fused.test.mjs",
      "scripts/mas-smoke.test.mjs",
      // The runner-based suites above are excluded from vitest because they use
      // node:test/bun:test. They are executed by `bun run test:script-suites`
      // (chained from `test`) so the exclusion no longer means "runs nowhere".
      // Uses Node.js built-in test runner (node:test), not vitest.
      "scripts/build-experimental-exact-window-helper.test.mjs",
      "scripts/ensure-fused-inference-install.test.mjs",
      "scripts/android-sms-gateway-template.test.mjs",
      "scripts/stage-android-agent.test.mjs",
      "scripts/android-pglite-staging.test.mjs",
      "scripts/ensure-vision-deps-policy.test.mjs",
      "scripts/lib/dev-port-ownership.test.mjs",
      "scripts/lib/apk-runtime-provenance.test.mjs",
      "scripts/lib/android-runtime-packaging.test.mjs",
      "scripts/stage-desktop-fused-lib-staleness.test.mjs",
      "scripts/ensure-fused-inference-install.test.mjs",
      "scripts/build-helpers/arm64-simd.test.mjs",
      "scripts/lib/electrobun-loopback-hardening.test.mjs",
      "scripts/lib/linux-artifact-permissions.test.mjs",
      "scripts/lib/fused-artifact-integrity.test.mjs",
      "scripts/lib/ios-fused-slice-cache.test.mjs",
      "scripts/mobile/ios/overlay.test.mjs",
      // Uses Node.js built-in test runner (node:test), not vitest; runs in
      // `bun run test:script-suites` (node --test list).
      "scripts/store-listing-urls.test.mjs",
      // Uses bun:test, not vitest; runs in `bun run test:script-suites`.
      "scripts/voice/voice-models-publish-all.test.mjs",
      // Uses bun:test, not vitest.
      "scripts/aosp/stage-default-models.test.mjs",
      // Uses bun:test, not vitest.
      "scripts/aosp/compile-libllama-zig-pin.test.mjs",
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
            "scripts/lib/apple-entitlement-audit.test.mjs",
            "scripts/run-mobile-build-ios-engine-gate.test.mjs",
            "scripts/run-mobile-build-android-cloud-strip.test.mjs",
            "scripts/run-mobile-build-android-targets.test.mjs",
            "scripts/run-mobile-build-ios-identity.test.mjs",
            "scripts/run-mobile-build-plugin-manifest.test.mjs",
            "scripts/voice-interactive.test.mjs",
            "scripts/aosp/compile-libllama.test.mjs",
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
