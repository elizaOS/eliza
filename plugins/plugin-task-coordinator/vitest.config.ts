/** Vitest config for the unit suite — aliases sibling plugin and package `src` dirs so tests resolve them from source. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));
const toVitePath = (value: string): string => value.replaceAll("\\", "/");
const pluginBrowserSrc = resolve(rootDir, "../plugin-browser/src");
const pluginCommandsSrc = resolve(rootDir, "../plugin-commands/src");
const pluginTrainingSrc = resolve(rootDir, "../plugin-training/src");
const tuiSrc = resolve(rootDir, "../../packages/tui/src");
const sharedSrc = resolve(rootDir, "../../packages/shared/src");

export default defineConfig({
  resolve: {
    alias: [
      // `@elizaos/ui` is aliased to source (below). Its module graph imports many
      // `@elizaos/shared/*` subpaths (voice-eot, transcripts, contracts/*, …) that
      // only ship from `dist/`, which is frequently stale or unbuilt when this
      // package's suite runs standalone — causing the whole suite to fail to load.
      // Resolve `@elizaos/shared` to source too (this suite runs in the `node`
      // environment, so node-only shared modules load fine), mirroring how ui/tui/
      // plugin-browser/plugin-training are already redirected to source above.
      {
        find: /^@elizaos\/shared$/,
        replacement: toVitePath(resolve(sharedSrc, "index.ts")),
      },
      {
        find: /^@elizaos\/shared\/(.+)$/,
        replacement: `${toVitePath(sharedSrc)}/$1`,
      },
      {
        find: /^@elizaos\/ui$/,
        replacement: toVitePath(
          resolve(rootDir, "../../packages/ui/src/index.ts"),
        ),
      },
      {
        find: /^@elizaos\/tui$/,
        replacement: toVitePath(resolve(tuiSrc, "index.ts")),
      },
      {
        find: /^@elizaos\/tui\/(.+)$/,
        replacement: `${toVitePath(tuiSrc)}/$1`,
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
        // `src/index.ts` now contributes a slash command via
        // `@elizaos/plugin-commands`. Resolve it to source (it ships no prebuilt
        // dist when the suite runs standalone), mirroring the redirects above.
        find: /^@elizaos\/plugin-commands$/,
        replacement: toVitePath(resolve(pluginCommandsSrc, "index.ts")),
      },
      {
        find: /^@elizaos\/plugin-commands\/(.+)$/,
        replacement: `${toVitePath(pluginCommandsSrc)}/$1`,
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
