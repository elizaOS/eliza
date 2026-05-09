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
