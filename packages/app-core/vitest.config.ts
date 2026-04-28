import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fileDir = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(fileDir, "../..");
const appCoreSrc = path.join(fileDir, "src");
const agentSrc = path.join(monorepoRoot, "packages/agent/src");
const uiDir = path.join(monorepoRoot, "packages/ui");
const sharedSrc = path.join(monorepoRoot, "packages/shared/src");
const coreSrc = path.join(monorepoRoot, "packages/typescript/src");
const appLifeopsSrc = path.join(monorepoRoot, "apps/app-lifeops/src");
const appTaskCoordinatorSrc = path.join(
  monorepoRoot,
  "apps/app-task-coordinator/src",
);
const appCompanionSrc = path.join(monorepoRoot, "apps/app-companion/src");
const pluginSqlSrc = path.join(
  monorepoRoot,
  "plugins/plugin-sql/typescript",
);
const pluginEdgeTtsSrc = path.join(
  monorepoRoot,
  "plugins/plugin-edge-tts/typescript",
);
const reactPkg = path.join(fileDir, "node_modules/react");
const reactDomPkg = path.join(fileDir, "node_modules/react-dom");
const includeLiveE2e =
  process.env.MILADY_INCLUDE_LIVE_E2E === "1" ||
  process.env.ELIZA_INCLUDE_LIVE_E2E === "1";

/**
 * Real `react` / `react-dom` packages (not .d.ts stubs from tsconfig paths)
 * so Vite can execute files that import from workspace apps under tests.
 * Workspace `exports` and deep imports are mirrored here for Vitest’s resolver.
 */
export default defineConfig({
  test: {
    testTimeout: 15_000,
    server: { deps: { inline: [/@elizaos\//] } },
    // Heavy browser e2e — install `puppeteer-core` / `playwright-core` in this package to run
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "test/app/memory-relationships.real.e2e.test.ts",
      "test/app/qa-checklist.real.e2e.test.ts",
      "test/app/onboarding-companion.live.e2e.test.ts",
      ...(includeLiveE2e ? [] : ["test/live-agent/**/*.e2e.test.ts"]),
    ],
  },
  resolve: {
    alias: [
      { find: /^@elizaos\/app-core$/, replacement: path.join(appCoreSrc, "index.ts") },
      {
        find: /^@elizaos\/app-core\/(.+)$/,
        replacement: path.join(appCoreSrc, "$1"),
      },
      { find: /^@elizaos\/agent$/, replacement: path.join(agentSrc, "index.ts") },
      { find: /^@elizaos\/agent\/(.+)$/, replacement: path.join(agentSrc, "$1") },
      { find: /^@elizaos\/ui$/, replacement: path.join(uiDir, "src/index.ts") },
      { find: /^@elizaos\/ui\/(.+)$/, replacement: path.join(uiDir, "src/$1") },
      { find: /^@elizaos\/shared$/, replacement: path.join(sharedSrc, "index.ts") },
      { find: /^@elizaos\/shared\/(.+)$/, replacement: path.join(sharedSrc, "$1") },
      { find: /^@elizaos\/core$/, replacement: path.join(coreSrc, "index.node.ts") },
      { find: /^@elizaos\/core\/(.+)$/, replacement: path.join(coreSrc, "$1") },
      { find: /^@elizaos\/app-lifeops$/, replacement: path.join(appLifeopsSrc, "index.ts") },
      {
        find: /^@elizaos\/app-lifeops\/selfcontrol$/,
        replacement: path.join(
          monorepoRoot,
          "apps/app-lifeops/src/website-blocker/public.ts",
        ),
      },
      {
        find: /^@elizaos\/app-lifeops\/(.+)$/,
        replacement: path.join(appLifeopsSrc, "$1"),
      },
      { find: /^@elizaos\/app-companion$/, replacement: path.join(appCompanionSrc, "index.ts") },
      { find: /^@elizaos\/app-companion\/ui$/, replacement: path.join(appCompanionSrc, "ui.ts") },
      {
        find: /^@elizaos\/app-companion\/(.+)$/,
        replacement: path.join(appCompanionSrc, "$1"),
      },
      { find: /^@elizaos\/plugin-sql$/, replacement: path.join(pluginSqlSrc, "index.node.ts") },
      {
        find: /^@elizaos\/plugin-sql\/(.+)$/,
        replacement: path.join(pluginSqlSrc, "$1"),
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
