import { defaultExternalConditions, defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../scripts/vitest/source-aliases.ts";
export default defineConfig({
  // Preserve Vitest server defaults and Vite's separate bare-external defaults.
  ssr: {
    resolve: {
      conditions: [
        "eliza-source",
        ...defaultServerConditions.filter(
          (condition) => condition !== "module",
        ),
      ],
      externalConditions: ["eliza-source", ...defaultExternalConditions],
    },
  },
  resolve: {
    conditions: ["eliza-source"],
    alias: buildWorkspaceSourceAliases(),
  },
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
