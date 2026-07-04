/**
 * Vitest configuration for plugin-computeruse: aliases core/logger to source and
 * excludes the live/real/e2e lanes from the default run.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const coreSrcRoot = path.resolve(__dirname, "../../packages/core/src");
const loggerSrcRoot = path.resolve(__dirname, "../../packages/logger/src");

const testExcludes = [
  "dist/**",
  "**/node_modules/**",
  "**/*.live.test.{ts,tsx}",
  "**/*.live.e2e.test.{ts,tsx}",
  "**/*.real.test.{ts,tsx}",
  "**/*.real.e2e.test.{ts,tsx}",
  "**/*.e2e.test.{ts,tsx}",
  "**/*.e2e.spec.{ts,tsx}",
];

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@elizaos\/core$/,
        replacement: path.join(coreSrcRoot, "index.node.ts"),
      },
      {
        find: /^@elizaos\/core\/(.*)$/,
        replacement: path.join(coreSrcRoot, "$1"),
      },
      {
        find: /^@elizaos\/logger$/,
        replacement: path.join(loggerSrcRoot, "index.ts"),
      },
      {
        find: /^@elizaos\/logger\/(.*)$/,
        replacement: path.join(loggerSrcRoot, "$1"),
      },
    ],
  },
  test: {
    testTimeout: 90_000,
    hookTimeout: 30_000,
    environment: "node",
    exclude: testExcludes,
    fileParallelism: false,
    maxWorkers: 1,
    sequence: {
      concurrent: false,
    },
  },
});
