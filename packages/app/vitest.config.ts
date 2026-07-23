/**
 * Configures the app package Vitest suite, including jsdom setup and
 * package-local test boundaries.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/test/vitest/default.config";

const here = path.dirname(fileURLToPath(import.meta.url));

// Bun's isolated linker exposes packages through per-package symlink dirs;
// vitest resolves requires against the preserved symlink path, so a CJS
// package requiring a sibling (react-router-dom → react-router/dom) cannot see
// it. Anchor the specifiers to the real store paths (same recipe as
// plugins/plugin-feed/vitest.config.ts) so nested resolution works.
function resolveStorePackageDir(packageName: string): string | null {
  const store = path.join(here, "../../node_modules/.bun");
  const prefix = `${packageName.replace("/", "+")}@`;
  try {
    const entry = readdirSync(store).find((dir) => dir.startsWith(prefix));
    return entry ? path.join(store, entry, "node_modules", packageName) : null;
  } catch {
    return null;
  }
}

function storePackageAliases(packageName: string): Array<{
  find: RegExp;
  replacement: string;
}> {
  const dir = resolveStorePackageDir(packageName);
  if (!dir) return [];
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    { find: new RegExp(`^${escaped}$`), replacement: dir },
    {
      find: new RegExp(`^${escaped}/(.+)$`),
      replacement: path.join(dir, "$1"),
    },
  ];
}

// The @elizaos/ui browser dependencies that break under preserved-symlink
// resolution — the same set plugin-feed pins for its view tests.
const uiStoreDependencyAliases = [
  ...storePackageAliases("react-router-dom"),
  ...storePackageAliases("@date-fns/tz"),
  ...storePackageAliases("react-syntax-highlighter"),
  ...(() => {
    const refractorDir = resolveStorePackageDir("refractor");
    return refractorDir
      ? [
          {
            find: /^refractor\/bash$/,
            replacement: path.join(refractorDir, "lang/bash.js"),
          },
        ]
      : [];
  })(),
];

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
      ...uiStoreDependencyAliases,
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
        find: /^@elizaos\/app-model-tester$/,
        replacement: path.join(
          here,
          "../../plugins/app-model-tester/src/index.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-task-coordinator\/register$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-task-coordinator/src/register.ts",
        ),
      },
      {
        // Mirror the production renderer resolution (vite.config.ts aliases the
        // PA root specifier to its browser facade) so the registration-entry
        // identity test evaluates the same module the built app loads. The
        // /register and capture subpaths anchor to source for the same test;
        // tsc sees them only as the ambient declarations in
        // src/types/app-plugin-modules.d.ts, keeping PA's server graph out of
        // the app TS program.
        find: /^@elizaos\/plugin-personal-assistant$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-personal-assistant/src/ui.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-personal-assistant\/register$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-personal-assistant/src/register.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-personal-assistant\/lifeops\/activity-signals-capture$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-personal-assistant/src/lifeops/activity-signals-capture.ts",
        ),
      },
      {
        find: /^@elizaos\/capacitor-mobile-signals$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-native-mobile-signals/src/index.ts",
        ),
      },
      {
        // plugin-calendar subpaths the PA renderer facade side-effect-imports;
        // resolve from source exactly like the production build (vite.config.ts)
        // so the test does not require plugin-calendar's dist.
        find: /^@elizaos\/plugin-calendar\/api\/client-calendar$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-calendar/src/api/client-calendar.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-calendar\/ui$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-calendar/src/ui.ts",
        ),
      },
      {
        find: /^@elizaos\/capacitor-appblocker$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-native-appblocker/src/index.ts",
        ),
      },
      {
        find: /^@elizaos\/capacitor-llama$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-native-llama/src/index.ts",
        ),
      },
      {
        find: /^@elizaos\/capacitor-mobile-agent-bridge$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-native-mobile-agent-bridge/src/index.ts",
        ),
      },
      {
        find: /^@elizaos\/capacitor-websiteblocker$/,
        replacement: path.join(
          here,
          "../../plugins/plugin-native-websiteblocker/src/index.ts",
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
