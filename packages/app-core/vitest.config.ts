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
const appLifeopsSrc = path.join(monorepoRoot, "plugins/app-lifeops/src");
const appTaskCoordinatorSrc = path.join(
  monorepoRoot,
  "plugins/app-task-coordinator/src",
);
const appCompanionSrc = path.join(monorepoRoot, "plugins/app-companion/src");
const appWalletSrc = path.join(monorepoRoot, "plugins/app-wallet/src");
const pluginSqlSrc = path.join(monorepoRoot, "plugins/plugin-sql/typescript");
const pluginAgentSkillsSrc = path.join(
  monorepoRoot,
  "plugins/plugin-agent-skills/src",
);
const pluginBrowserBridgeSrc = path.join(
  monorepoRoot,
  "plugins/plugin-browser/src",
);
const pluginElizaCloudSrc = path.join(
  monorepoRoot,
  "plugins/plugin-elizacloud",
);
const pluginEdgeTtsSrc = path.join(monorepoRoot, "plugins/plugin-edge-tts");
const pluginIMessageSrc = path.join(monorepoRoot, "plugins/plugin-imessage/src");
const pluginOpenAiSrc = path.join(monorepoRoot, "plugins/plugin-openai");
const pluginPdfSrc = path.join(monorepoRoot, "plugins/plugin-pdf");
const reactPkg = path.join(fileDir, "node_modules/react");
const reactDomPkg = path.join(fileDir, "node_modules/react-dom");
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
    maxWorkers: 2,
    // Bootstrap-token tests spin up a real PGlite database + jose-signed
    // RS256 key material per test, and have intermittently exited the
    // vitest worker fork unexpectedly on CI (Worker exited unexpectedly /
    // Worker forks emitted error). Forcing a single fork serializes the
    // heavy native + WASM init across the file boundary and removes the
    // class of crash.
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    server: { deps: { inline: [/@elizaos\//] } },
    // Heavy browser e2e — install `puppeteer-core` / `playwright-core` in this package to run
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ".claude/**",
      "test/app/memory-relationships.real.e2e.test.ts",
      "test/app/qa-checklist.real.e2e.test.ts",
      "test/app/onboarding-companion.live.e2e.test.ts",
      ...(includeLiveE2e ? [] : ["test/live-agent/**/*.e2e.test.ts"]),
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
        find: /^@elizaos\/app-lifeops$/,
        replacement: path.join(appLifeopsSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/app-lifeops\/selfcontrol$/,
        replacement: path.join(
          monorepoRoot,
          "plugins/app-lifeops/src/website-blocker/public.ts",
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
        find: /^@elizaos\/plugin-pdf$/,
        replacement: path.join(pluginPdfSrc, "index.node.ts"),
      },
      {
        find: /^@elizaos\/plugin-pdf\/(.+)$/,
        replacement: path.join(pluginPdfSrc, "$1"),
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
    ],
  },
});
