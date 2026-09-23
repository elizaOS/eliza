/** Vitest configuration for the DoorDash adapter and confirmation contract. */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/scripts/vitest/default.config";

const baseAliases = Array.isArray(baseConfig.resolve?.alias)
  ? baseConfig.resolve.alias
  : [];
const cryptoCompatSource = fileURLToPath(
  new URL("../../packages/core/src/utils/crypto-compat.ts", import.meta.url),
);

export default defineConfig({
  ...baseConfig,
  resolve: {
    ...baseConfig.resolve,
    conditions: ["node"],
    alias: [
      {
        find: /^@elizaos\/core\/utils\/crypto-compat$/,
        replacement: cryptoCompatSource,
      },
      ...baseAliases,
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 15_000,
    pool: "forks",
  },
});
