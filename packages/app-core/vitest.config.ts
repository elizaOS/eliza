/** Defines app-core vitest behavior for dashboard host and runtime integration. */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fileDir = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(fileDir, "../..");
const appCoreSrc = path.join(fileDir, "src");
const agentSrc = path.join(monorepoRoot, "packages/agent/src");
const authSrc = path.join(monorepoRoot, "packages/auth/src");
const uiDir = path.join(monorepoRoot, "packages/ui");
const sharedSrc = path.join(monorepoRoot, "packages/shared/src");
const coreSrc = path.join(monorepoRoot, "packages/core/src");
const loggerSrc = path.join(monorepoRoot, "packages/logger/src");
const vaultSrc = path.join(monorepoRoot, "packages/vault/src");
const cloudRoutingSrc = path.join(monorepoRoot, "packages/cloud/routing/src");
const cloudSdkSrc = path.join(monorepoRoot, "packages/cloud/sdk/src");
const appLifeopsSrc = path.join(
  monorepoRoot,
  "plugins/plugin-personal-assistant/src",
);
const appTaskCoordinatorSrc = path.join(
  monorepoRoot,
  "plugins/plugin-task-coordinator/src",
);
const toVitePath = (value: string): string => value.replaceAll("\\", "/");
const pluginAppManagerSrc = path.join(
  monorepoRoot,
  "plugins/plugin-app-manager/src",
);
const appWalletSrc = path.join(monorepoRoot, "plugins/plugin-wallet/src/ui");
const pluginSqlSrc = path.join(monorepoRoot, "plugins/plugin-sql/src");
const pluginTodosSrc = path.join(monorepoRoot, "plugins/plugin-todos/src");
const pluginAgentSkillsSrc = path.join(
  monorepoRoot,
  "plugins/plugin-agent-skills/src",
);
const pluginBrowserBridgeSrc = path.join(
  monorepoRoot,
  "plugins/plugin-browser/src",
);
const pluginAnthropicRoot = path.join(monorepoRoot, "plugins/plugin-anthropic");
const pluginCommandsSrc = path.join(
  monorepoRoot,
  "plugins/plugin-commands/src",
);
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
const pluginRegistrySrc = path.join(
  monorepoRoot,
  "plugins/plugin-registry/src",
);
const pluginVideoSrc = path.join(monorepoRoot, "plugins/plugin-video/src");
const pluginWalletSrc = path.join(monorepoRoot, "plugins/plugin-wallet/src");
const pluginWhatsappRoot = path.join(monorepoRoot, "plugins/plugin-whatsapp");
const pluginAgentOrchestratorSrc = path.join(
  monorepoRoot,
  "plugins/plugin-agent-orchestrator/src",
);
const pluginAppControlSrc = path.join(
  monorepoRoot,
  "plugins/plugin-app-control/src",
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
// packages/agent/src/runtime/optional-plugin-imports.generated.ts. The Windows
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
      "scripts/mobile-auth-simulator-smoke-endstate.test.mjs",
      "scripts/android-sms-gateway-template.test.mjs",
      "scripts/stage-android-agent.test.mjs",
      "scripts/stage-desktop-fused-lib-staleness.test.mjs",
      "scripts/ensure-fused-inference-install.test.mjs",
      "scripts/build-helpers/arm64-simd.test.mjs",
      "scripts/lib/electrobun-loopback-hardening.test.mjs",
      "scripts/lib/linux-artifact-permissions.test.mjs",
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
            "test/scripts/mobile-auth-simulator-smoke.test.ts",
          ]
        : []),
      ".claude/**",
      "test/app/memory-relationships.real.e2e.test.ts",
      "test/app/qa-checklist.real.e2e.test.ts",
      "test/helpers/__tests__/live-agent-test.smoke.test.ts",
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
      {
        find: /^@elizaos\/logger$/,
        replacement: path.join(loggerSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/app-core$/,
        replacement: path.join(appCoreSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/app-core\/(.+)$/,
        replacement: path.join(appCoreSrc, "$1"),
      },
      {
        find: /^@elizaos\/agent$/,
        replacement: path.join(agentSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/agent\/(.+)$/,
        replacement: path.join(agentSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-todos\/plugin$/,
        replacement: path.join(pluginTodosSrc, "plugin.ts"),
      },
      {
        find: /^@elizaos\/plugin-todos\/service$/,
        replacement: path.join(pluginTodosSrc, "service.ts"),
      },
      {
        find: /^@elizaos\/plugin-todos\/db\/schema$/,
        replacement: path.join(pluginTodosSrc, "db/schema.ts"),
      },
      {
        find: /^@elizaos\/auth$/,
        replacement: path.join(authSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/auth\/(.+)$/,
        replacement: path.join(authSrc, "$1"),
      },
      { find: /^@elizaos\/ui$/, replacement: path.join(uiDir, "src/index.ts") },
      {
        find: /^@elizaos\/ui\/api$/,
        replacement: path.join(uiDir, "src/api/index.ts"),
      },
      { find: /^@elizaos\/ui\/(.+)$/, replacement: path.join(uiDir, "src/$1") },
      {
        find: /^@elizaos\/shared$/,
        replacement: path.join(sharedSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/shared\/config$/,
        replacement: path.join(sharedSrc, "config/types.ts"),
      },
      {
        find: /^@elizaos\/shared\/(.+)$/,
        replacement: path.join(sharedSrc, "$1"),
      },
      {
        find: /^@elizaos\/core$/,
        replacement: path.join(coreSrc, "index.node.ts"),
      },
      {
        find: /^@elizaos\/core\/atomic-json$/,
        replacement: path.join(coreSrc, "utils/atomic-json.ts"),
      },
      {
        // Must precede the @elizaos/core/(.+) catch-all: aliases match in
        // array order, and the catch-all would rewrite core/edge to the
        // nonexistent src/edge (plugin-scheduling imports @elizaos/core/edge).
        find: /^@elizaos\/core\/edge$/,
        replacement: path.join(coreSrc, "index.edge.ts"),
      },
      { find: /^@elizaos\/core\/(.+)$/, replacement: path.join(coreSrc, "$1") },
      {
        find: /^@elizaos\/vault$/,
        replacement: path.join(vaultSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/vault\/(.+)$/,
        replacement: path.join(vaultSrc, "$1"),
      },
      {
        find: /^@elizaos\/cloud-routing$/,
        replacement: path.join(cloudRoutingSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/cloud-sdk$/,
        replacement: path.join(cloudSdkSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/app-lifeops$/,
        replacement: path.join(appLifeopsSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-personal-assistant$/,
        replacement: path.join(appLifeopsSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/app-lifeops\/selfcontrol$/,
        replacement: path.join(
          monorepoRoot,
          "plugins/plugin-personal-assistant/src/website-blocker/public.ts",
        ),
      },
      {
        find: /^@elizaos\/app-lifeops\/(.+)$/,
        replacement: path.join(appLifeopsSrc, "$1"),
      },
      {
        find: /^@elizaos\/app-wallet$/,
        replacement: path.join(appWalletSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/app-wallet\/ui$/,
        replacement: path.join(appWalletSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/app-wallet\/(.+)$/,
        replacement: path.join(appWalletSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-sql$/,
        replacement: path.join(pluginSqlSrc, "index.node.ts"),
      },
      {
        find: /^@elizaos\/plugin-sql\/(.+)$/,
        replacement: path.join(pluginSqlSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-agent-skills$/,
        replacement: path.join(pluginAgentSkillsSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-agent-skills\/(.+)$/,
        replacement: path.join(pluginAgentSkillsSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-browser$/,
        replacement: path.join(pluginBrowserBridgeSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-browser\/(.+)$/,
        replacement: path.join(pluginBrowserBridgeSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-anthropic$/,
        replacement: path.join(pluginAnthropicRoot, "index.node.ts"),
      },
      {
        find: /^@elizaos\/plugin-anthropic\/endpoint-config$/,
        replacement: path.join(pluginAnthropicRoot, "utils/config.ts"),
      },
      {
        find: /^@elizaos\/plugin-anthropic\/(.+)$/,
        replacement: path.join(pluginAnthropicRoot, "$1"),
      },
      {
        find: /^@elizaos\/plugin-app-manager$/,
        replacement: path.join(pluginAppManagerSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-app-manager\/(.+)$/,
        replacement: path.join(pluginAppManagerSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-task-coordinator$/,
        replacement: toVitePath(path.join(appTaskCoordinatorSrc, "index.ts")),
      },
      {
        find: /^@elizaos\/plugin-task-coordinator\/(.+)$/,
        replacement: `${toVitePath(appTaskCoordinatorSrc)}/$1`,
      },
      {
        find: /^@elizaos\/plugin-scheduling$/,
        replacement: path.join(pluginSchedulingSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-scheduling\/(.+)$/,
        replacement: path.join(pluginSchedulingSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-inbox$/,
        replacement: path.join(pluginInboxSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-inbox\/(.+)$/,
        replacement: path.join(pluginInboxSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-commands$/,
        replacement: path.join(pluginCommandsSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-computeruse$/,
        replacement: path.join(pluginComputerUseSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-coding-tools$/,
        replacement: path.join(pluginCodingToolsSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-coding-tools\/(.+)$/,
        replacement: path.join(pluginCodingToolsSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-discord$/,
        replacement: path.join(pluginDiscordRoot, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-elizacloud$/,
        replacement: path.join(pluginElizaCloudSrc, "index.node.ts"),
      },
      {
        find: /^@elizaos\/plugin-elizacloud\/endpoint-config$/,
        replacement: path.join(pluginElizaCloudSrc, "utils/config.ts"),
      },
      {
        find: /^@elizaos\/plugin-elizacloud\/(.+)$/,
        replacement: path.join(pluginElizaCloudSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-openai$/,
        replacement: path.join(pluginOpenAiSrc, "index.node.ts"),
      },
      {
        find: /^@elizaos\/plugin-openai\/endpoint-config$/,
        replacement: path.join(pluginOpenAiSrc, "utils/config.ts"),
      },
      {
        find: /^@elizaos\/plugin-openai\/(.+)$/,
        replacement: path.join(pluginOpenAiSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-imessage$/,
        replacement: path.join(pluginIMessageSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-imessage\/(.+)$/,
        replacement: path.join(pluginIMessageSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-mcp$/,
        replacement: path.join(pluginMcpSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-local-inference$/,
        replacement: path.join(pluginLocalInferenceSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-local-inference\/(.+)$/,
        replacement: path.join(pluginLocalInferenceSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-native-filesystem$/,
        replacement: path.join(pluginNativeFilesystemSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-pdf$/,
        replacement: path.join(pluginPdfSrc, "index.node.ts"),
      },
      {
        find: /^@elizaos\/plugin-pdf\/(.+)$/,
        replacement: path.join(pluginPdfSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-registry$/,
        replacement: path.join(pluginRegistrySrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-registry\/(.+)$/,
        replacement: path.join(pluginRegistrySrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-video$/,
        replacement: path.join(pluginVideoSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-wallet$/,
        replacement: path.join(pluginWalletSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-wallet\/(.+)$/,
        replacement: path.join(pluginWalletSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-whatsapp$/,
        replacement: path.join(pluginWhatsappRoot, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-agent-orchestrator$/,
        replacement: path.join(pluginAgentOrchestratorSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-app-control$/,
        replacement: path.join(pluginAppControlSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-gitpathologist$/,
        replacement: path.join(pluginGitpathologistSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-google-workspace$/,
        replacement: path.join(pluginGoogleSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-pty$/,
        replacement: path.join(pluginPtyRoot, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-vision$/,
        replacement: path.join(pluginVisionSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-agent-orchestrator\/(.+)$/,
        replacement: path.join(pluginAgentOrchestratorSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-workflow$/,
        replacement: path.join(pluginWorkflowSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-browser$/,
        replacement: path.join(pluginBrowserBridgeSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-browser\/(.+)$/,
        replacement: path.join(pluginBrowserBridgeSrc, "$1"),
      },
      {
        find: /^@elizaos\/app-task-coordinator$/,
        replacement: path.join(appTaskCoordinatorSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/app-task-coordinator\/(.+)$/,
        replacement: path.join(appTaskCoordinatorSrc, "$1"),
      },
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
    ],
  },
});
