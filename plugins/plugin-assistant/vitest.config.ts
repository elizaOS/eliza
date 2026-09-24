/** Runs assistant source contracts against the real workspace runtime and SQL adapter. */
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../packages/scripts/vitest/source-aliases.ts";
export default defineConfig({
  resolve: {
    conditions: ["eliza-source", "node"],
    alias: [
      {
        find: /^@elizaos\/core\/media$/,
        replacement: new URL(
          "../../packages/core/src/media/index.ts",
          import.meta.url,
        ).pathname,
      },
      ...buildWorkspaceSourceAliases(),
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: [
      ...(process.env.VITEST_LANE === "post-merge"
        ? ["src/features/trust/should-respond-risk-gate.real.test.ts"]
        : ["**/*.live.test.ts", "**/*.real.test.ts"]),
      "**/*.e2e.test.ts",
      "**/dist/**",
      "**/node_modules/**",
    ],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
