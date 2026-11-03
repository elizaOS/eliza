import { defaultExternalConditions, defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../scripts/vitest/source-aliases.ts";
export default defineConfig({
  // Vitest's transformed and bare external imports use separate SSR conditions.
  // Match its server defaults; retain Vite's external defaults, including module-sync.
  ssr: {
    resolve: {
      conditions: [
        "eliza-source",
        ...defaultServerConditions.filter((condition) => condition !== "module"),
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
