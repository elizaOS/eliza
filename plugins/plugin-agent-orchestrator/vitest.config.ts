/**
 * Vitest configuration for the orchestrator package. Workspace source aliases
 * keep clean-checkout tests independent of prebuilt peer-package artifacts.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: [
      ...Object.entries({
        "@elizaos/plugin-sql/database-utils/pglite-storage": fileURLToPath(
          new URL(
            "../plugin-sql/src/database-utils/pglite-storage.ts",
            import.meta.url,
          ),
        ),
        "@elizaos/plugin-sql/database-utils/raw-sql": fileURLToPath(
          new URL(
            "../plugin-sql/src/database-utils/raw-sql.ts",
            import.meta.url,
          ),
        ),
        "@elizaos/core/host-execution-env": fileURLToPath(
          new URL(
            "../../packages/core/src/host-execution-env.ts",
            import.meta.url,
          ),
        ),
        "@elizaos/auth/auth/token-expiry": fileURLToPath(
          new URL(
            "../../packages/auth/src/auth/token-expiry.ts",
            import.meta.url,
          ),
        ),
        "@elizaos/auth/auth": new URL(
          "../../packages/auth/src/auth/index.ts",
          import.meta.url,
        ).pathname,
        // The auth source alias pulls in @elizaos/auth/vault, which resolves only
        // through its built dist; pin it to source for clean-checkout runs.
        "@elizaos/auth/vault": fileURLToPath(
          new URL("../../packages/auth/src/vault/index.ts", import.meta.url),
        ),
        "@elizaos/plugin-sql": fileURLToPath(
          new URL("../plugin-sql/src/index.ts", import.meta.url),
        ),
      }).map(([find, replacement]) => ({
        find: new RegExp(`^${find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
        replacement,
      })),
    ],
  },
  test: {
    environment: "node",
    setupFiles: ["./__tests__/setup.ts"],
    include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["src/ui/**"],
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
