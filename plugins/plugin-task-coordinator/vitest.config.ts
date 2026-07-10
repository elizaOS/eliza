/** Vitest config for the unit suite — aliases sibling plugin and package `src` dirs so tests resolve them from source. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));
const toVitePath = (value: string): string => value.replaceAll("\\", "/");
const coreSrc = resolve(rootDir, "../../packages/core/src");
const pluginBrowserSrc = resolve(rootDir, "../plugin-browser/src");
const pluginCommandsSrc = resolve(rootDir, "../plugin-commands/src");
const pluginTrainingSrc = resolve(rootDir, "../plugin-training/src");
const sharedSrc = resolve(rootDir, "../../packages/shared/src");
const importConversationsSrc = resolve(
  rootDir,
  "../../packages/import-conversations/src",
);

export default defineConfig({
  resolve: {
    alias: [
      // Changed-test coverage runs before workspace builds, so command imports
      // must resolve core from source rather than an absent dist entrypoint.
      {
        find: /^@elizaos\/core$/,
        replacement: toVitePath(resolve(coreSrc, "index.ts")),
      },
      {
        find: /^@elizaos\/core\/(.+)$/,
        replacement: `${toVitePath(coreSrc)}/$1`,
      },
      // `@elizaos/ui` is aliased to source (below). Its module graph imports many
      // `@elizaos/shared/*` subpaths (voice-eot, transcripts, contracts/*, …) that
      // only ship from `dist/`, which is frequently stale or unbuilt when this
      // package's suite runs standalone — causing the whole suite to fail to load.
      // Resolve `@elizaos/shared` to source too (this suite runs in the `node`
      // environment, so node-only shared modules load fine), mirroring how ui,
      // plugin-browser, and plugin-training are already redirected to source above.
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
        find: /^@elizaos\/ui\/(.+)$/,
        replacement: `${toVitePath(resolve(rootDir, "../../packages/ui/src"))}/$1`,
      },
      // `@elizaos/ui` (aliased to source above) pulls MemoryViewerView, which
      // imports the `@elizaos/import-conversations/browser` subpath. That subpath
      // only resolves to source through the package's `eliza-source` export
      // condition, which vitest does not apply — bare resolution falls through to
      // `./dist`, absent when this suite runs standalone (the Windows CI lane
      // builds only core/shared). Anchor it to source; import-conversations/src
      // has no external deps, so this is self-contained.
      {
        find: /^@elizaos\/import-conversations$/,
        replacement: toVitePath(resolve(importConversationsSrc, "index.ts")),
      },
      {
        find: /^@elizaos\/import-conversations\/(.+)$/,
        replacement: `${toVitePath(importConversationsSrc)}/$1`,
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
