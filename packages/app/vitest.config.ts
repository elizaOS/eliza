/**
 * Configures the app package Vitest suite, including jsdom setup and
 * package-local test boundaries.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/scripts/vitest/default.config";

const here = path.dirname(fileURLToPath(import.meta.url));

const unitExcludes = [
  "dist/**",
  "**/node_modules/**",
  "**/*.live.test.{ts,tsx}",
  "**/*.real.test.{ts,tsx}",
  "**/*.integration.test.{ts,tsx}",
  "**/*.e2e.test.{ts,tsx}",
  "**/*.e2e.spec.{ts,tsx}",
  "**/*.spec.{ts,tsx}",
  // Script-level tests use Bun or Node test APIs and run through the package's
  // dedicated `bun test` phase, outside Vitest's jsdom transform.
  "scripts/**/*.test.{ts,tsx,mjs}",
];

export default defineConfig({
  ...baseConfig,
  root: here,
  plugins: [
    ...(baseConfig.plugins ?? []),
    {
      name: "renderer-cold-boot",
      enforce: "pre",
      transform(source, id) {
        if (id.split("?")[0] !== path.join(here, "src/main.tsx")) return;
        // Composition tests boot the shipped renderer without a dev server.
        // Vitest's Vite-client stub lacks hot.data; the dedicated main-bootstrap
        // suite separately exercises real HMR persistence with a complete context.
        return {
          code: source.replaceAll("import.meta.hot", "undefined"),
          map: null,
        };
      },
    },
  ],
  resolve: {
    ...baseConfig.resolve,
    alias: [
      {
        // Entrypoint tests exercise the shipped iOS bridge import in source mode;
        // the changed-test lane intentionally builds core only, so they cannot
        // depend on a pre-existing app dist directory.
        find: /^@elizaos\/app\/api\/ios-local-agent-transport$/,
        replacement: path.join(
          here,
          "../app/src/api/ios-local-agent-transport.ts",
        ),
      },
      {
        // Same source-mode rule for the desktop-shell subpath the entrypoint
        // tests import (runIosFullBunSmokeIfRequested): the export maps to
        // app's dist, which the changed-test lane never builds.
        find: /^@elizaos\/app\/desktop-shell$/,
        replacement: path.join(here, "../app/src/desktop-shell.ts"),
      },
      {
        // main.tsx imports "@elizaos/ui/styles"; the ui package otherwise
        // resolves to its built dist, whose externalized styles.js makes Node
        // load raw .css. Aliasing to source keeps the stylesheet inside vite's
        // pipeline, where the test css handling stubs it.
        find: /^@elizaos\/ui\/styles$/,
        replacement: path.join(here, "../ui/src/styles.ts"),
      },
      {
        // Dev-gated ui platform helpers (e.g. onboarding-replay) read
        // `import.meta.env.DEV`, which only exists when the module runs through
        // vite's pipeline. Resolve ui subpath imports from source so the suite
        // exercises the same dev semantics the renderer build ships.
        find: /^@elizaos\/ui\/api$/,
        replacement: path.join(here, "../ui/src/api/index.ts"),
      },
      {
        find: /^@elizaos\/ui\/(.+)$/,
        replacement: path.join(here, "../ui/src/$1"),
      },
      {
        find: /^@elizaos\/ui$/,
        replacement: path.join(here, "../ui/src/index.ts"),
      },
      {
        // Entrypoint tests import the device-bridge types/loader from source;
        // the package's published exports point at a dist directory this lane
        // never builds.
        find: /^@elizaos\/plugin-native-inference\/llama$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-native-inference/src/llama/index.ts",
        ),
      },
      {
        // Vite resolves this browser-safe dynamic import from source as well;
        // matching that boundary keeps fresh entrypoint tests independent of
        // plugin-blocker's generated dist directory.
        find: /^@elizaos\/plugin-blocker\/native$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-blocker/src/native.ts",
        ),
      },
      {
        find: /^@elizaos\/cloud-ui$/,
        replacement: path.join(here, "../cloud-ui/src/index.ts"),
      },
      {
        find: /^@elizaos\/cloud-ui\/(.+)$/,
        replacement: path.join(here, "../cloud-ui/src/$1"),
      },
      {
        find: /^@elizaos\/plugin-agent-orchestrator\/ui\/register$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-agent-orchestrator/src/ui/register.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-relationships\/register$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-relationships/src/register.ts",
        ),
      },
      ...(Array.isArray(baseConfig.resolve?.alias)
        ? baseConfig.resolve.alias
        : []),
    ],
  },
  test: {
    ...baseConfig.test,
    environment: "jsdom",
    setupFiles: [path.join(here, "test/setup.ts")],
    include: [
      "src/types/**/*.test.{ts,tsx,mjs}",
      "src/native/**/*.test.{ts,tsx,mjs}",
      "src/public-web-entry.test.tsx",
      "src/__tests__/**/*.test.{ts,tsx,mjs}",
      "src/shims/**/*.test.{ts,tsx,mjs}",
      "src/renderer-build-manifest-plugin.test.ts",
      "test/vite-source-resolution.test.ts",
      "test/android-browser/**/*.test.{ts,tsx,mjs}",
      "test/hmr/**/*.test.{ts,tsx,mjs}",
      "test/utils/**/*.test.{ts,tsx,mjs}",
      "test/ui-smoke/**/*.test.{ts,tsx,mjs}",
      "test/view-screenshots/**/*.test.{ts,tsx,mjs}",
      "test/electrobun-packaged/**/*.test.{ts,tsx,mjs}",
      "test/audit/**/*.test.{ts,tsx,mjs}",
      "test/android/**/*.test.{ts,tsx,mjs}",
      "test/main-bootstrap.test.tsx",
      "test/fixtures/**/*.test.{ts,tsx,mjs}",
      "test/dev-auth/**/*.test.{ts,tsx,mjs}",
      "test/design-review/**/*.test.{ts,tsx,mjs}",
      "test/pages-middleware-serving.test.ts",
      "test/dev-http-proxy.test.ts",
    ],
    exclude: unitExcludes,
    coverage: {
      ...baseConfig.test?.coverage,
      include: ["src/**/*.{ts,tsx}"],
    },
  },
});
