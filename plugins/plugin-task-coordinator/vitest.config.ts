import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const elizaRoot = path.resolve(here, "../..");
const sharedSrc = path.resolve(elizaRoot, "packages/shared/src");
const uiSrc = path.resolve(elizaRoot, "packages/ui/src");

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@elizaos\/shared$/,
        replacement: path.resolve(sharedSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/shared\/(.+)$/,
        replacement: path.resolve(sharedSrc, "$1"),
      },
      {
        find: /^@elizaos\/ui$/,
        replacement: path.resolve(uiSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/ui\/api$/,
        replacement: path.resolve(uiSrc, "api/index.ts"),
      },
      {
        find: /^@elizaos\/ui\/(.+)$/,
        replacement: path.resolve(uiSrc, "$1"),
      },
      {
        // DynamicViewLoader imports this browser-safe helper as a host external;
        // resolve it to source so this package's UI tests do not require a
        // prebuilt plugin-health dist on clean checkouts.
        find: /^@elizaos\/plugin-health\/screen-time\/mobile-signal-setup$/,
        replacement: path.resolve(
          elizaRoot,
          "plugins/plugin-health/src/screen-time/mobile-signal-setup.ts",
        ),
      },
    ],
  },
  test: {
    environment: "node",
    include: [
      "__tests__/**/*.test.ts",
      "__tests__/**/*.test.tsx",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "src/__tests__/**/*.test.ts",
      "src/__tests__/**/*.test.tsx",
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    server: {
      deps: {
        inline: ["@elizaos/shared"],
      },
    },
  },
});
