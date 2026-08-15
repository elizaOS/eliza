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
  "test/ui-smoke/**",
  "test/electrobun-packaged/**",
  // Script-level tests use Bun or Node test APIs and run through the package's
  // dedicated `bun test` phase, outside Vitest's jsdom transform.
  "scripts/**/*.test.{ts,tsx,mjs}",
];

export default defineConfig({
  ...baseConfig,
  root: here,
  resolve: {
    ...baseConfig.resolve,
    alias: [
      {
        // The renderer imports the public marketing entrypoints through the
        // same source boundary as the Vite build. Keep unit entrypoint tests
        // independent of a separately built homepage package.
        find: /^@homepage\//,
        replacement: `${path.resolve(here, "../homepage/src")}/`,
      },
      {
        // Entrypoint tests exercise the shipped iOS bridge import in source mode;
        // the changed-test lane intentionally builds core only, so they cannot
        // depend on a pre-existing app-core dist directory.
        find: /^@elizaos\/app-core\/api\/ios-local-agent-transport$/,
        replacement: path.join(
          here,
          "../app-core/src/api/ios-local-agent-transport.ts",
        ),
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
        find: /^@elizaos\/capacitor-llama$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-native-llama/src/index.ts",
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
        find: /^@elizaos\/plugin-task-coordinator\/register$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-task-coordinator/src/register.ts",
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
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    exclude: unitExcludes,
    coverage: {
      ...baseConfig.test?.coverage,
      include: ["src/**/*.{ts,tsx}"],
    },
  },
});
