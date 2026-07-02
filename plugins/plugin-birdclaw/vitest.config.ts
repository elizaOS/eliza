import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/test/vitest/default.config";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const baseAliases = Array.isArray(baseConfig.resolve?.alias)
  ? baseConfig.resolve.alias
  : [];

/**
 * Bun's isolated-store layout nests a react-router-dom copy under packages/ui
 * WITHOUT a sibling react-router, so its internal `require("react-router/dom")`
 * fails from inside the jsdom suite (the same pre-existing failure the other
 * view plugins' suites hit). The store copy under node_modules/.bun keeps its
 * dependencies as siblings and resolves cleanly — alias the bare specifier to
 * it so this plugin's suite runs green regardless of hoisting.
 */
function resolveStorePackageDir(packageName: string): string | null {
  const store = path.join(here, "../../node_modules/.bun");
  // Scoped packages are stored as "@scope+name@version".
  const prefix = `${packageName.replace("/", "+")}@`;
  try {
    const entry = readdirSync(store).find((dir) => dir.startsWith(prefix));
    return entry ? path.join(store, entry, "node_modules", packageName) : null;
  } catch {
    return null;
  }
}

const reactRouterAliases = (
  [
    ["react-router-dom", /^react-router-dom$/],
    ["@date-fns/tz", /^@date-fns\/tz$/],
  ] as const
)
  .map(([packageName, find]) => {
    const dir = resolveStorePackageDir(packageName);
    return dir ? { find, replacement: dir } : null;
  })
  .filter((alias): alias is { find: RegExp; replacement: string } =>
    Boolean(alias),
  );

// The unit suite covers the CLI runner seam, the service arg/parse logic, the
// route handlers, the BIRDCLAW action, and the view render states (jsdom via
// per-file directive). The base config supplies the @elizaos/* source aliases
// plugin.ts needs; the React aliases pin a single React copy so jsdom does not
// mix the workspace and hoisted peers (mirrors plugin-inbox).
//
// `birdclaw.real.test.ts` drives the REAL birdclaw CLI against a throwaway
// BIRDCLAW_HOME and is excluded from the default lane — run it with
// `bun run test:real` (requires the birdclaw binary).
const liveOnlyExcludes = [
  "dist/**",
  "**/node_modules/**",
  "**/*.live.test.{ts,tsx}",
  "**/*.live.e2e.test.{ts,tsx}",
  "**/*.real.test.{ts,tsx}",
  "**/*.real.e2e.test.{ts,tsx}",
  "**/*.integration.test.{ts,tsx}",
  "**/*.e2e.test.{ts,tsx}",
];

const realLaneRequested = process.env.BIRDCLAW_REAL_TESTS === "1";

export default defineConfig({
  ...baseConfig,
  resolve: {
    ...baseConfig.resolve,
    alias: [
      ...reactRouterAliases,
      {
        find: /^react$/,
        replacement: path.dirname(require.resolve("react/package.json")),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: require.resolve("react/jsx-runtime"),
      },
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: require.resolve("react/jsx-dev-runtime"),
      },
      {
        find: /^react-dom$/,
        replacement: path.dirname(require.resolve("react-dom/package.json")),
      },
      {
        find: /^react-dom\/client$/,
        replacement: require.resolve("react-dom/client"),
      },
      ...baseAliases,
    ],
  },
  test: {
    ...baseConfig.test,
    root: here,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: realLaneRequested
      ? liveOnlyExcludes.filter((glob) => !glob.includes(".real."))
      : liveOnlyExcludes,
  },
});
