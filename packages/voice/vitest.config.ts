import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../scripts/vitest/source-aliases.ts";

export default defineConfig({
  resolve: {
    conditions: ["eliza-source"],
    alias: buildWorkspaceSourceAliases(),
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
