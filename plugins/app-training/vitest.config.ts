import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../test/vitest/default.config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
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
const vaultSrc = path.join(repoRoot, "packages", "vault", "src");
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
        find: /^@elizaos\/vault$/,
        replacement: path.join(vaultSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/vault\/(.+)$/,
        replacement: path.join(vaultSrc, "$1"),
      },
      ...baseAliases,
    ],
  },
  test: {
    ...baseConfig.test,
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    exclude: unitExcludes,
    globals: false,
    passWithNoTests: true,
    testTimeout: 30000,
  },
});
