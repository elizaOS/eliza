import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
// Reuse @elizaos/ui's test config wholesale: it already resolves the exact
// module graph this package's cloud surfaces pull (react dedupe, @elizaos/ui
// source aliases, @elizaos/shared / cloud-shared / core, etc.). We only add the
// `@elizaos/cloud-ui` self-alias and repoint the root-relative test fields at
// this package.
import uiConfig from "../ui/vitest.config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, "../ui");

const merged = mergeConfig(uiConfig, {
  resolve: {
    alias: [
      {
        find: /^@elizaos\/cloud-ui$/,
        replacement: resolve(here, "src/index.ts"),
      },
      {
        find: /^@elizaos\/cloud-ui\/(.+)$/,
        replacement: resolve(here, "src/$1"),
      },
    ],
  },
});

// `mergeConfig` concatenates arrays and keeps root-relative strings from the ui
// config; override the fields that must resolve against THIS package.
merged.root = here;
merged.test = {
  ...merged.test,
  root: here,
  setupFiles: [resolve(uiRoot, "vitest.setup.ts")],
  include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  exclude: ["node_modules", "dist"],
};

export default merged;
