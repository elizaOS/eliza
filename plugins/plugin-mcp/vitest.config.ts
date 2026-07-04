/**
 * Vitest config for plugin-mcp: aliases @elizaos/* to workspace source so tests
 * run against live package code, discovers the root and colocated test suites,
 * and runs them in a Node environment.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@elizaos/security/mcp-server-config",
        replacement: path.resolve(rootDir, "../../packages/security/src/mcp-server-config.ts"),
      },
      {
        find: "@elizaos/security",
        replacement: path.resolve(rootDir, "../../packages/security/src/index.ts"),
      },
      {
        find: "@elizaos/core",
        replacement: path.resolve(rootDir, "../../packages/core/src/index.node.ts"),
      },
      {
        find: "@elizaos/logger",
        replacement: path.resolve(rootDir, "../../packages/logger/src/index.ts"),
      },
    ],
  },
  test: {
    include: ["__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    globals: true,
    environment: "node",
  },
});
