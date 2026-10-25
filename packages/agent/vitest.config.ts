/** Configures the deterministic Vitest harness for packages/agent tests. */
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../scripts/vitest/default.config";
import {
  agentTestExclude,
  agentTestInclude,
} from "./scripts/run-vitest-batches.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const baseAliases = Array.isArray(baseConfig.resolve?.alias)
  ? baseConfig.resolve.alias
  : [];

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(packageRoot, "../..");
const requireFromOrchestrator = createRequire(
  path.join(monorepoRoot, "plugins/plugin-agent-orchestrator/package.json"),
);
let octokitRestEntry: string | undefined;
try {
  octokitRestEntry = realpathSync(
    requireFromOrchestrator.resolve("@octokit/rest"),
  );
} catch (error) {
  // error-policy:J4 Suites which do not import Octokit remain runnable in a
  // light install; suites that require it still fail visibly at import time.
  if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
}

export default defineConfig({
  ...baseConfig,
  root: here,
  resolve: {
    ...baseConfig.resolve,
    // Plugin-resolution tests import the same workspace packages the runtime
    // loads through Bun. Canonicalizing their symlinks keeps each third-party
    // package beside its own isolated transitive dependencies.
    preserveSymlinks: false,
    alias: [
      // Resolve Octokit from its physical Bun store path so its own transitive
      // dependencies remain visible while workspace source aliases preserve symlinks.
      ...(octokitRestEntry
        ? [
            {
              find: /^@octokit\/rest$/,
              replacement: octokitRestEntry,
            },
          ]
        : []),
      // Explicitly pin react/react-dom to the workspace copies in the bun-managed
      // flat hoisted structure. Without this, bun's module resolver can walk up
      // to parent directories and pick up a different react version (e.g., a
      // react@19.2.6 from ~/.../milaidy/node_modules when the workspace has
      // react@19.2.5), which breaks the React hook dispatcher interface.
      // These MUST come before ...baseAliases because the base config's
      // resolveInstalledPackageRoot("react") walks up to the parent repo and
      // picks up react@19.2.6, producing a wrong alias that would otherwise win.
      {
        find: /^react$/,
        replacement: path.join(
          repoRoot,
          "node_modules/.bun/node_modules/react/index.js",
        ),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: path.join(
          repoRoot,
          "node_modules/.bun/node_modules/react/jsx-runtime.js",
        ),
      },
      {
        find: /^react-dom$/,
        replacement: path.join(
          repoRoot,
          "node_modules/.bun/node_modules/react-dom/index.js",
        ),
      },
      {
        find: /^react-dom\/client$/,
        replacement: path.join(
          repoRoot,
          "node_modules/.bun/node_modules/react-dom/client.js",
        ),
      },
      ...baseAliases,
    ],
  },
  test: {
    ...baseConfig.test,
    environment: "node",
    // Separate processes isolate host state and database lifecycles.
    pool: "forks",
    setupFiles: ["test/setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
    server: {
      deps: {
        inline: [/@elizaos\//, /\/plugins\/plugin-/],
      },
    },
    include: agentTestInclude,
    exclude: agentTestExclude,
  },
});
