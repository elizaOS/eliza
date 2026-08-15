/**
 * Vitest configuration for todos action, provider, and view tests with Node
 * resolution conditions.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/scripts/vitest/default.config";

const baseAliases = Array.isArray(baseConfig.resolve?.alias)
  ? baseConfig.resolve.alias
  : [];
const coreEdgeSource = fileURLToPath(
  new URL("../../packages/core/src/index.edge.ts", import.meta.url),
);

export default defineConfig({
  resolve: {
    ...baseConfig.resolve,
    conditions: ["node"],
    alias: [
      { find: /^@elizaos\/core\/edge$/, replacement: coreEdgeSource },
      ...baseAliases,
    ],
  },
  ssr: {
    resolve: {
      conditions: ["node"],
    },
  },
  test: {
    environment: "node",
    include: [
      "__tests__/**/*.{test,spec}.{ts,tsx}",
      "src/**/*.{test,spec}.{ts,tsx}",
      "test/**/*.{test,spec}.{ts,tsx}",
    ],
    testTimeout: 15_000,
    pool: "forks",
    server: {
      deps: {
        inline: ["@elizaos/core"],
      },
    },
  },
});
