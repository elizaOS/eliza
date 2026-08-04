/** Vitest config for the unit suite — aliases sibling plugin and package `src` dirs so tests resolve them from source. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));
const toVitePath = (value: string): string => value.replaceAll("\\", "/");
const coreSrc = resolve(rootDir, "../../packages/core/src");
const pluginBrowserSrc = resolve(rootDir, "../plugin-browser/src");
const pluginCommandsSrc = resolve(rootDir, "../plugin-commands/src");
const sharedSrc = resolve(rootDir, "../../packages/shared/src");

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
      // plugin-browser is already redirected to source below.
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
      // Tests mock the public UI barrel as the client boundary. Resolve the
      // optimized API subpath to that same module id so those mocks continue to
      // intercept requests after production imports moved off the root barrel.
      {
        find: /^@elizaos\/ui\/api$/,
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
