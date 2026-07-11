/**
 * Vitest configuration for the orchestrator package. Workspace source aliases
 * keep clean-checkout tests independent of prebuilt peer-package artifacts.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@elizaos/auth/token-expiry": fileURLToPath(
        new URL("../../packages/auth/src/token-expiry.ts", import.meta.url),
      ),
      "@elizaos/auth": new URL(
        "../../packages/auth/src/index.ts",
        import.meta.url,
      ).pathname,
      "@elizaos/shared": fileURLToPath(
        new URL("./__tests__/shared-runtime-env.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./__tests__/setup.ts"],
    include: ["__tests__/**/*.test.ts", "src/__tests__/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
