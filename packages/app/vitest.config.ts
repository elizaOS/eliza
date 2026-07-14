/**
 * Configures the app package Vitest suite, including jsdom setup and
 * package-local test boundaries.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/test/vitest/default.config";

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
  "test/ui-smoke/**",
  "test/electrobun-packaged/**",
  // Script-level tests use Bun or Node test APIs and run through the package's
  // dedicated `bun test` phase, outside Vitest's jsdom transform.
  "scripts/**/*.test.{ts,tsx,mjs}",
];

export default defineConfig({
  ...baseConfig,
  root: here,
  resolve: {
    ...baseConfig.resolve,
    alias: [
      {
        find: /^@elizaos\/cloud-ui$/,
        replacement: path.join(here, "../cloud-ui/src/index.ts"),
      },
      {
        find: /^@elizaos\/cloud-ui\/(.+)$/,
        replacement: path.join(here, "../cloud-ui/src/$1"),
      },
      {
        find: /^@elizaos\/app-model-tester$/,
        replacement: path.join(
          here,
          "../../plugins/app-model-tester/src/index.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-task-coordinator\/register$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-task-coordinator/src/register.ts",
        ),
      },
      {
        find: /^@elizaos\/capacitor-appblocker$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-native-appblocker/src/index.ts",
        ),
      },
      {
        find: /^@elizaos\/capacitor-llama$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-native-llama/src/index.ts",
        ),
      },
      {
        find: /^@elizaos\/capacitor-mobile-agent-bridge$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-native-mobile-agent-bridge/src/index.ts",
        ),
      },
      {
        find: /^@elizaos\/capacitor-websiteblocker$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-native-websiteblocker/src/index.ts",
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
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    exclude: unitExcludes,
    coverage: {
      ...baseConfig.test?.coverage,
      include: ["src/**/*.{ts,tsx}"],
    },
  },
});
