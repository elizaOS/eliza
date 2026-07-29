/**
 * Runs the Aomi plugin's unit and opt-in live contract suites against workspace source.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@elizaos/core",
        replacement: path.resolve(
          here,
          "../../packages/core/src/index.node.ts",
        ),
      },
      {
        find: "@elizaos/logger",
        replacement: path.resolve(here, "../../packages/logger/src/index.ts"),
      },
      {
        find: "@elizaos/plugin-wallet",
        replacement: path.resolve(here, "../plugin-wallet/src/index.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
