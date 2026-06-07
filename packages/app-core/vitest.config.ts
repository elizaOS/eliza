import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fileDir = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(fileDir, "../..");
const appCoreSrc = path.join(fileDir, "src");
const agentSrc = path.join(monorepoRoot, "packages/agent/src");
const uiDir = path.join(monorepoRoot, "packages/ui");
const sharedSrc = path.join(monorepoRoot, "packages/shared/src");
const coreSrc = path.join(monorepoRoot, "packages/core/src");
const vaultSrc = path.join(monorepoRoot, "packages/vault/src");
const cloudRoutingSrc = path.join(monorepoRoot, "packages/cloud-routing/src");
const cloudSdkSrc = path.join(monorepoRoot, "packages/cloud-sdk/src");
const appLifeopsSrc = path.join(
  monorepoRoot,
  "plugins/plugin-personal-assistant/src",
);
const appTaskCoordinatorSrc = path.join(
  monorepoRoot,
  "plugins/plugin-task-coordinator/src",
);
const pluginAppManagerSrc = path.join(
  monorepoRoot,
  "plugins/plugin-app-manager/src",
);
const appCompanionSrc = path.join(monorepoRoot, "plugins/plugin-companion/src");
const appWalletSrc = path.join(monorepoRoot, "plugins/plugin-wallet-ui/src");
const pluginSqlSrc = path.join(monorepoRoot, "plugins/plugin-sql/src");
const pluginAgentSkillsSrc = path.join(
  monorepoRoot,
  "plugins/plugin-agent-skills/src",
);
const pluginBrowserBridgeSrc = path.join(
  monorepoRoot,
  "plugins/plugin-browser/src",
);
const pluginCapacitorBridgeSrc = path.join(
  monorepoRoot,
  "plugins/plugin-capacitor-bridge/src",
);
const pluginAnthropicRoot = path.join(monorepoRoot, "plugins/plugin-anthropic");
const pluginBackgroundRunnerSrc = path.join(
  monorepoRoot,
  "plugins/plugin-background-runner/src",
);
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
const pluginEdgeTtsSrc = path.join(monorepoRoot, "plugins/plugin-edge-tts");
const pluginIMessageSrc = path.join(
  monorepoRoot,
  "plugins/plugin-imessage/src",
);
const pluginLocalInferenceSrc = path.join(
  monorepoRoot,
  "plugins/plugin-local-inference/src",
);
const pluginMcpSrc = path.join(monorepoRoot, "plugins/plugin-mcp/src");
const pluginOllamaRoot = path.join(monorepoRoot, "plugins/plugin-ollama");
const pluginOpenAiSrc = path.join(monorepoRoot, "plugins/plugin-openai");
const pluginPdfSrc = path.join(monorepoRoot, "plugins/plugin-pdf");
const pluginRegistrySrc = path.join(
  monorepoRoot,
  "plugins/plugin-registry/src",
);
const pluginSignalSrc = path.join(monorepoRoot, "plugins/plugin-signal/src");
const pluginShellRoot = path.join(monorepoRoot, "plugins/plugin-shell");
const pluginStreamingSrc = path.join(
  monorepoRoot,
  "plugins/plugin-streaming/src",
);
const pluginVideoSrc = path.join(monorepoRoot, "plugins/plugin-video/src");
const pluginWalletSrc = path.join(monorepoRoot, "plugins/plugin-wallet/src");
const pluginWhatsappRoot = path.join(monorepoRoot, "plugins/plugin-whatsapp");
const pluginAgentOrchestratorSrc = path.join(
  monorepoRoot,
  "plugins/plugin-agent-orchestrator/src",
);
const pluginRemoteManifestSrc = path.join(
  monorepoRoot,
  "packages/plugin-remote-manifest/src",
);
const pluginWorkerRuntimeSrc = path.join(
  monorepoRoot,
  "packages/plugin-worker-runtime/src",
);
const pluginWorkflowSrc = path.join(
  monorepoRoot,
  "plugins/plugin-workflow/src",
);
const pluginX402Src = path.join(monorepoRoot, "plugins/plugin-x402/src");
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
    maxWorkers: 1,
    // Bootstrap-token tests spin up a real PGlite database + jose-signed
    // RS256 key material per test, and have intermittently exited the
    // vitest worker fork unexpectedly on CI (Worker exited unexpectedly /
    // Worker forks emitted error). In Vitest 4 the former forks.singleFork
    // setting is represented by maxWorkers: 1 plus isolate: false.
    isolate: false,
    server: { deps: { inline: [/@elizaos\//] } },
    // Heavy browser e2e — install `puppeteer-core` / `playwright-core` in this package to run
    exclude: [
      "**/.git/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/*.e2e.test.{ts,tsx}",
      "**/*.e2e.spec.{ts,tsx}",
      "**/*.integration.test.{ts,tsx}",
      "**/*.live.test.{ts,tsx}",
      "**/*.live.e2e.test.{ts,tsx}",
      "**/*.real.test.{ts,tsx}",
      "**/*.real.e2e.test.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
      "platforms/electrobun/**",
      "scripts/run-mobile-build-policy.test.mjs",
      "scripts/run-mobile-build-android-app-actions.test.mjs",
      "scripts/aosp/compile-libllama-fused.test.mjs",
      "scripts/mas-smoke.test.mjs",
      // Uses Node.js built-in test runner (node:test), not vitest.
      "scripts/android-sms-gateway-template.test.mjs",
      "scripts/stage-android-agent.test.mjs",
      ".claude/**",
      "test/app/memory-relationships.real.e2e.test.ts",
      "test/app/qa-checklist.real.e2e.test.ts",
      "test/app/first-run-companion.live.e2e.test.ts",
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
        find: /^@elizaos\/app-companion$/,
        replacement: path.join(appCompanionSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/app-companion\/ui$/,
        replacement: path.join(appCompanionSrc, "ui.ts"),
      },
      {
        find: /^@elizaos\/app-companion\/(.+)$/,
        replacement: path.join(appCompanionSrc, "$1"),
      },
      {
        find: /^@elizaos\/app-wallet$/,
        replacement: path.join(appWalletSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/app-wallet\/ui$/,
        replacement: path.join(appWalletSrc, "ui.ts"),
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
        replacement: path.join(appTaskCoordinatorSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-task-coordinator\/(.+)$/,
        replacement: path.join(appTaskCoordinatorSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-capacitor-bridge$/,
        replacement: path.join(pluginCapacitorBridgeSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-background-runner$/,
        replacement: path.join(pluginBackgroundRunnerSrc, "index.ts"),
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
        find: /^@elizaos\/plugin-elizacloud\/(.+)$/,
        replacement: path.join(pluginElizaCloudSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-openai$/,
        replacement: path.join(pluginOpenAiSrc, "index.node.ts"),
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
        find: /^@elizaos\/plugin-local-inference$/,
        replacement: path.join(pluginLocalInferenceSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-local-inference\/runtime$/,
        replacement: path.join(pluginLocalInferenceSrc, "runtime", "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-local-inference\/routes$/,
        replacement: path.join(pluginLocalInferenceSrc, "routes", "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-local-inference\/services$/,
        replacement: path.join(pluginLocalInferenceSrc, "services", "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-mcp$/,
        replacement: path.join(pluginMcpSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-ollama$/,
        replacement: path.join(pluginOllamaRoot, "index.node.ts"),
      },
      {
        find: /^@elizaos\/plugin-ollama\/(.+)$/,
        replacement: path.join(pluginOllamaRoot, "$1"),
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
        find: /^@elizaos\/plugin-signal$/,
        replacement: path.join(pluginSignalSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-shell$/,
        replacement: path.join(pluginShellRoot, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-shell\/(.+)$/,
        replacement: path.join(pluginShellRoot, "$1"),
      },
      {
        find: /^@elizaos\/plugin-streaming$/,
        replacement: path.join(pluginStreamingSrc, "index.ts"),
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
        find: /^@elizaos\/plugin-agent-orchestrator\/(.+)$/,
        replacement: path.join(pluginAgentOrchestratorSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-remote-manifest$/,
        replacement: path.join(pluginRemoteManifestSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-remote-manifest\/(.+)$/,
        replacement: path.join(pluginRemoteManifestSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-worker-runtime$/,
        replacement: path.join(pluginWorkerRuntimeSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-worker-runtime\/(.+)$/,
        replacement: path.join(pluginWorkerRuntimeSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-workflow$/,
        replacement: path.join(pluginWorkflowSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-x402$/,
        replacement: path.join(pluginX402Src, "index.ts"),
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
        find: /^@elizaos\/plugin-edge-tts\/node$/,
        replacement: path.join(pluginEdgeTtsSrc, "index.node.ts"),
      },
      {
        find: /^@elizaos\/plugin-edge-tts$/,
        replacement: path.join(pluginEdgeTtsSrc, "src/index.ts"),
      },
      {
        find: /^@elizaos\/plugin-edge-tts\/(.+)$/,
        replacement: path.join(pluginEdgeTtsSrc, "$1"),
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
