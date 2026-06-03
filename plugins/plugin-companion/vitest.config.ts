import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/test/vitest/default.config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const baseAliases = Array.isArray(baseConfig.resolve?.alias)
  ? baseConfig.resolve.alias
  : [];

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

export default defineConfig({
  ...baseConfig,
  resolve: {
    ...baseConfig.resolve,
    alias: [
      // Companion view components import lean primitives, the API client, event
      // names, hooks, and state from `@elizaos/ui` subpaths (`/components`,
      // `/api`, `/events`, `/hooks`, `/state`, `/utils`). The `/components`
      // subpath (src/components/index.ts) re-exports the entire cloud-ui
      // frontend surface (code/react-syntax-highlighter, docs/react-router-dom,
      // react-day-picker, ...), whose dist builds use bare deep imports that are
      // bun-hoisted under node_modules/.bun and not resolvable from this
      // plugin's context — vite's import-analysis then fails to load the test
      // files. The companion tests `vi.mock("@elizaos/ui")` with the exports
      // these components consume, so resolve those subpaths to the same module
      // id as the bare barrel: the mock then covers them and the heavy source
      // barrel (with its cloud-ui subtree) is never transformed. Subpaths the
      // tests do NOT mock (e.g. `/agent-surface`) stay resolved to real source.
      {
        find: /^@elizaos\/ui(\/(components|api|events|hooks|state|utils))?$/,
        replacement: path.join(repoRoot, "packages/ui/src/index.ts"),
      },
      {
        find: /^@elizaos\/ui\/(.+)$/,
        replacement: path.join(repoRoot, "packages/ui/src/$1"),
      },
      {
        find: /^react$/,
        replacement: path.dirname(require.resolve("react/package.json")),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: require.resolve("react/jsx-runtime"),
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
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    exclude: liveOnlyExcludes,
  },
});
