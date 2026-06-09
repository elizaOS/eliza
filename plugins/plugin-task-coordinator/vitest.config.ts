import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const elizaRoot = path.resolve(here, "../..");
const contractsSrc = path.resolve(elizaRoot, "packages/contracts/src");
const coreSrc = path.resolve(elizaRoot, "packages/core/src");
const loggerSrc = path.resolve(elizaRoot, "packages/logger/src");
const promptsSrc = path.resolve(elizaRoot, "packages/prompts/src");
const sharedSrc = path.resolve(elizaRoot, "packages/shared/src");
const uiSrc = path.resolve(elizaRoot, "packages/ui/src");
const hostExternalStub = path.resolve(
  elizaRoot,
  "packages/ui/test/stubs/host-external.ts",
);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@elizaos\/core$/,
        replacement: path.resolve(coreSrc, "index.node.ts"),
      },
      {
        find: /^@elizaos\/core\/(.+)$/,
        replacement: path.resolve(coreSrc, "$1"),
      },
      {
        find: /^@elizaos\/contracts$/,
        replacement: path.resolve(contractsSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/contracts\/(.+)$/,
        replacement: path.resolve(contractsSrc, "$1"),
      },
      {
        find: /^@elizaos\/logger$/,
        replacement: path.resolve(loggerSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/logger\/(.+)$/,
        replacement: path.resolve(loggerSrc, "$1"),
      },
      {
        find: /^@elizaos\/prompts$/,
        replacement: path.resolve(promptsSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/prompts\/(.+)$/,
        replacement: path.resolve(promptsSrc, "$1"),
      },
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
        find: /^@elizaos\/app-core(?:\/browser|\/ui-compat)?$/,
        replacement: hostExternalStub,
      },
      {
        find: /^@elizaos\/capacitor-(contacts|messages|mobile-signals|phone|system)$/,
        replacement: hostExternalStub,
      },
      {
        find: /^@elizaos\/plugin-browser$/,
        replacement: hostExternalStub,
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
      {
        find: /^@elizaos\/plugin-training$/,
        replacement: hostExternalStub,
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
        inline: [
          "@elizaos/contracts",
          "@elizaos/core",
          "@elizaos/logger",
          "@elizaos/prompts",
          "@elizaos/shared",
        ],
      },
    },
  },
});
