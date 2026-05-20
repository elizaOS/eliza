import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/test/vitest/default.config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const pluginElizaCloudSrc = path.join(
  repoRoot,
  "plugins",
  "plugin-elizacloud",
  "src",
);
const pluginIMessageSrc = path.join(
  repoRoot,
  "plugins",
  "plugin-imessage",
  "src",
);
const pluginCodingToolsSrc = path.join(
  repoRoot,
  "plugins",
  "plugin-coding-tools",
  "src",
);
const pluginAppManagerSrc = path.join(
  repoRoot,
  "plugins",
  "plugin-app-manager",
  "src",
);
const vaultSrc = path.join(repoRoot, "packages", "vault", "src");
const agentSrc = path.join(repoRoot, "packages", "agent", "src");
const baseAliases = Array.isArray(baseConfig.resolve?.alias)
  ? baseConfig.resolve.alias
  : [];

const unitExcludes = [
  "dist/**",
  "**/node_modules/**",
  "**/*.live.test.{ts,tsx}",
  "**/*.live.e2e.test.{ts,tsx}",
  "**/*.real.test.{ts,tsx}",
  "**/*.real.e2e.test.{ts,tsx}",
  "**/*.integration.test.{ts,tsx}",
  "**/*.e2e.test.{ts,tsx}",
  "**/*.e2e.spec.{ts,tsx}",
];

export default defineConfig({
  ...baseConfig,
  resolve: {
    ...baseConfig.resolve,
    alias: [
      {
        find: /^@elizaos\/plugin-elizacloud$/,
        replacement: path.join(pluginElizaCloudSrc, "index.node.ts"),
      },
      {
        find: /^@elizaos\/plugin-elizacloud\/(.+)$/,
        replacement: path.join(pluginElizaCloudSrc, "$1"),
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
        find: /^@elizaos\/plugin-discord$/,
        replacement: path.join(here, "test", "plugin-discord.stub.ts"),
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
        find: /^@elizaos\/plugin-app-manager$/,
        replacement: path.join(pluginAppManagerSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-app-manager\/(.+)$/,
        replacement: path.join(pluginAppManagerSrc, "$1"),
      },
      {
        find: /^@elizaos\/vault$/,
        replacement: path.join(vaultSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/vault\/(.+)$/,
        replacement: path.join(vaultSrc, "$1"),
      },
      {
        find: /^@elizaos\/agent\/(.+)$/,
        replacement: path.join(agentSrc, "$1"),
      },
      {
        find: /^@elizaos\/ui$/,
        replacement: path.join(repoRoot, "packages/ui/src/index.ts"),
      },
      {
        find: /^react$/,
        replacement: path.dirname(require.resolve("react/package.json")),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: require.resolve("react/jsx-runtime"),
      },
      {
        find: /^react-dom$/,
        replacement: path.dirname(require.resolve("react-dom/package.json")),
      },
      {
        find: /^react-dom\/client$/,
        replacement: require.resolve("react-dom/client"),
      },
      ...baseAliases,
    ],
  },
  test: {
    ...baseConfig.test,
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: unitExcludes,
    globals: false,
    passWithNoTests: true,
    testTimeout: 30000,
  },
});
