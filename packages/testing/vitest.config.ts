/** Test fixtures execute against the current workspace runtime. */

import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import coreConfig from "../core/vitest.config.ts";
import { buildWorkspaceSourceAliases } from "../scripts/vitest/source-aliases.ts";
export default mergeConfig(
  coreConfig,
  defineConfig({
    resolve: {
      conditions: ["eliza-source"],
      alias: [
        ...buildWorkspaceSourceAliases(
          fileURLToPath(new URL("../..", import.meta.url)),
        ),
        {
          find: /^@elizaos\/core$/,
          replacement: new URL("../core/src/index.ts", import.meta.url)
            .pathname,
        },
      ],
    },
    test: {
      include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
      testTimeout: 60000,
      hookTimeout: 60000,
    },
  }),
);
