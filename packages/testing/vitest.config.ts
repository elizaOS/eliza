/** Test fixtures execute against the current workspace runtime. */
import { defineConfig, mergeConfig } from "vitest/config";
import coreConfig from "../core/vitest.config";
export default mergeConfig(
  coreConfig,
  defineConfig({
    resolve: {
      alias: [
        {
          find: /^@elizaos\/core$/,
          replacement: new URL("../core/src/index.ts", import.meta.url)
            .pathname,
        },
      ],
    },
    test: {
      include: ["src/**/*.test.ts"],
      testTimeout: 60000,
      hookTimeout: 60000,
    },
  }),
);
