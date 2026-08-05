/**
 * Vitest config for plugin-app-manager: layers package-specific host stubs over
 * the shared workspace source aliases so tests never require sibling dist
 * artifacts.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/scripts/vitest/default.config";

const fromHere = (relativePath: string) =>
  fileURLToPath(new URL(relativePath, import.meta.url));
const baseAliases = Array.isArray(baseConfig.resolve?.alias)
  ? baseConfig.resolve.alias
  : [];

export default defineConfig({
  resolve: {
    ...baseConfig.resolve,
    alias: [
      {
        find: "@elizaos/agent/config/paths",
        replacement: fromHere("../../packages/agent/src/config/paths.ts"),
      },
      {
        find: "@elizaos/agent/services/app-package-modules",
        replacement: fromHere("test/stubs/agent-app-package-modules.ts"),
      },
      {
        find: "@elizaos/agent/services/overlay-app-presence",
        replacement: fromHere("test/stubs/agent-overlay-app-presence.ts"),
      },
      {
        find: "@elizaos/agent/services/registry-client-queries",
        replacement: fromHere("test/stubs/agent-registry-client-queries.ts"),
      },
      {
        find: "@elizaos/core/atomic-json",
        replacement: fromHere("../../packages/core/src/utils/atomic-json.ts"),
      },
      {
        find: "@elizaos/plugin-registry",
        replacement: fromHere("../plugin-registry/src/index.ts"),
      },
      ...baseAliases,
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
