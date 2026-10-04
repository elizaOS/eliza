/**
 * Vitest configuration for the orchestrator package. Workspace source aliases
 * keep clean-checkout tests independent of prebuilt peer-package artifacts.
 */

import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../packages/scripts/vitest/source-aliases.ts";
export default defineConfig({
  resolve: {
    conditions: ["eliza-source"],
    alias: buildWorkspaceSourceAliases(),
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
