import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));
const toVitePath = (value: string): string => value.replaceAll("\\", "/");
const pluginBrowserSrc = resolve(rootDir, "../plugin-browser/src");
const pluginTrainingSrc = resolve(rootDir, "../plugin-training/src");

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@elizaos\/ui$/,
        replacement: toVitePath(
          resolve(rootDir, "../../packages/ui/src/index.ts"),
        ),
      },
      {
        find: /^@elizaos\/ui\/(.+)$/,
        replacement: `${toVitePath(resolve(rootDir, "../../packages/ui/src"))}/$1`,
      },
      {
        find: /^@elizaos\/plugin-health\/screen-time\/mobile-signal-setup$/,
        replacement: toVitePath(
          resolve(
            rootDir,
            "../plugin-health/src/screen-time/mobile-signal-setup.ts",
          ),
        ),
      },
      {
        find: /^@elizaos\/plugin-browser$/,
        replacement: toVitePath(resolve(pluginBrowserSrc, "index.ts")),
      },
      {
        find: /^@elizaos\/plugin-browser\/(.+)$/,
        replacement: `${toVitePath(pluginBrowserSrc)}/$1`,
      },
      {
        find: /^@elizaos\/plugin-training$/,
        replacement: toVitePath(resolve(pluginTrainingSrc, "index.ts")),
      },
      {
        find: /^@elizaos\/plugin-training\/(.+)$/,
        replacement: `${toVitePath(pluginTrainingSrc)}/$1`,
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
  },
});
