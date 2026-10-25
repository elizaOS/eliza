/** Opt-in live provider lane using the shared workspace source resolver. */
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../packages/scripts/vitest/source-aliases.ts";

export default defineConfig({
  resolve: { alias: buildWorkspaceSourceAliases() },
  test: {
    environment: "node",
    include: ["__tests__/**/*.live.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
