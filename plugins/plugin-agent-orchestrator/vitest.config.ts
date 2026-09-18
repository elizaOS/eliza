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
        "@elizaos/shared/db/raw-sql": fileURLToPath(
          new URL("../../packages/shared/src/db/raw-sql.ts", import.meta.url),
        ),
        "@elizaos/shared/host-execution-env": fileURLToPath(
          new URL(
            "../../packages/shared/src/host-execution-env.ts",
            import.meta.url,
          ),
        ),
        "@elizaos/credentials/auth/token-expiry": fileURLToPath(
          new URL(
            "../../packages/credentials/src/auth/token-expiry.ts",
            import.meta.url,
          ),
        ),
        "@elizaos/credentials/auth": new URL(
          "../../packages/credentials/src/auth/index.ts",
          import.meta.url,
        ).pathname,
        // The auth source alias pulls in @elizaos/credentials/vault, which resolves only
        // through its built dist; pin it to source for clean-checkout runs.
        "@elizaos/credentials/vault": fileURLToPath(
          new URL(
            "../../packages/credentials/src/vault/index.ts",
            import.meta.url,
          ),
        ),
        "@elizaos/plugin-sql": fileURLToPath(
          new URL("../plugin-sql/src/index.ts", import.meta.url),
        ),
        "@elizaos/shared": fileURLToPath(
          new URL("./__tests__/shared-runtime-env.ts", import.meta.url),
        ),
      }).map(([find, replacement]) => ({
        find: find === "@elizaos/shared" ? /^@elizaos\/shared$/ : find,
        replacement,
      })),
      {
        find: /^@elizaos\/shared\/(.+)$/,
        replacement:
          fileURLToPath(
            new URL("../../packages/shared/src/", import.meta.url),
          ) + "$1",
      },
    ],
  },
  test: {
    environment: "node",
    setupFiles: ["./__tests__/setup.ts"],
    include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
