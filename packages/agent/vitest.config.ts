/** Configures the deterministic Vitest harness for packages/agent tests. */
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/scripts/vitest/default.config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const baseAliases = Array.isArray(baseConfig.resolve?.alias)
  ? baseConfig.resolve.alias
  : [];

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(packageRoot, "../..");
const srcRoot = path.join(packageRoot, "src");
const requireFromOrchestrator = createRequire(
  path.join(monorepoRoot, "plugins/plugin-agent-orchestrator/package.json"),
);
const octokitRestEntry = realpathSync(
  requireFromOrchestrator.resolve("@octokit/rest"),
);

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
      {
        find: /^@octokit\/rest$/,
        replacement: octokitRestEntry,
      },
      {
        find: /^@elizaos\/agent$/,
        replacement: path.join(srcRoot, "index.ts"),
      },
      {
        find: /^@elizaos\/agent\/(.+)$/,
        replacement: path.join(srcRoot, "$1"),
      },
      {
        find: /^@elizaos\/ui$/,
        replacement: path.join(monorepoRoot, "packages/ui/src/index.ts"),
      },
      {
        find: /^@elizaos\/ui\/(.+)$/,
        replacement: path.join(monorepoRoot, "packages/ui/src/$1"),
      },
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
      // These packages are exercised through source-level route tests. Put
      // their exact aliases before the base package aliases so subpaths cannot
      // be rewritten as an invalid suffix on an index.ts replacement.
      {
        find: /^@elizaos\/plugin-app-control$/,
        replacement: path.join(
          monorepoRoot,
          "plugins/plugin-app-control/src/index.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-app-control\/(.+)$/,
        replacement: path.join(
          monorepoRoot,
          "plugins/plugin-app-control/src/$1",
        ),
      },
      {
        find: /^@elizaos\/plugin-app-manager$/,
        replacement: path.join(
          monorepoRoot,
          "plugins/plugin-app-manager/src/index.ts",
        ),
      },
      {
        // Dedicated conversation imports depend on the plugin-owned Todo
        // schema and UI-free runtime subpaths. Unit tests run before workspace
        // dist builds, so these exact source exports must resolve together.
        find: /^@elizaos\/plugin-todos\/plugin$/,
        replacement: path.join(
          monorepoRoot,
          "plugins/plugin-todos/src/plugin.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-todos\/service$/,
        replacement: path.join(
          monorepoRoot,
          "plugins/plugin-todos/src/service.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-todos\/db\/schema$/,
        replacement: path.join(
          monorepoRoot,
          "plugins/plugin-todos/src/db/schema.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-wallet\/(.+)$/,
        replacement: path.join(monorepoRoot, "plugins/plugin-wallet/src/$1.ts"),
      },
      {
        find: /^@elizaos\/core\/atomic-json$/,
        replacement: path.join(
          monorepoRoot,
          "packages/core/src/utils/atomic-json.ts",
        ),
      },
      {
        find: /^@elizaos\/core\/node$/,
        replacement: path.join(monorepoRoot, "packages/core/src/index.node.ts"),
      },
      {
        find: /^@elizaos\/core\/edge$/,
        replacement: path.join(monorepoRoot, "packages/core/src/index.edge.ts"),
      },
      {
        find: /^@elizaos\/core\/security\/(.+)$/,
        replacement: path.join(monorepoRoot, "packages/core/src/security/$1"),
      },
      {
        find: /^@elizaos\/plugin-anthropic\/endpoint-config$/,
        replacement: path.join(
          monorepoRoot,
          "plugins/plugin-anthropic/utils/config.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-elizacloud\/endpoint-config$/,
        replacement: path.join(
          monorepoRoot,
          "plugins/plugin-elizacloud/src/utils/config.ts",
        ),
      },
      {
        // Keep this ahead of the prefix-matching `@elizaos/plugin-elizacloud`
        // alias (index.ts). Without it, `import(".../host-routes")` resolves
        // to `src/index.ts/host-routes` (ENOTDIR).
        find: /^@elizaos\/plugin-elizacloud\/host-routes$/,
        replacement: path.join(
          monorepoRoot,
          "plugins/plugin-elizacloud/src/host-routes.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-openai\/endpoint-config$/,
        replacement: path.join(
          monorepoRoot,
          "plugins/plugin-openai/utils/config.ts",
        ),
      },
      ...baseAliases,
      {
        find: /^@elizaos\/vault$/,
        replacement: path.join(monorepoRoot, "packages/vault/src/index.ts"),
      },
      {
        find: /^@elizaos\/vault\/(.+)$/,
        replacement: path.join(monorepoRoot, "packages/vault/src/$1"),
      },
      {
        find: /^@elizaos\/plugin-cli$/,
        replacement: path.join(
          repoRoot,
          "plugins",
          "plugin-cli",
          "typescript",
          "src",
          "index.ts",
        ),
      },
    ],
  },
  test: {
    ...baseConfig.test,
    environment: "node",
    // "forks" (not "vmForks"): the vmForks pool shares one worker process whose
    // VM-context module interception races across test files — vi.mock factories
    // nondeterministically leak into (or vanish from) a NEIGHBORING file's module
    // graph when several conversation-route suites run in one invocation. Seen as
    // conversation-failurekind-roundtrip losing its chat-routes mock (real
    // readChatRequestPayload → "text is required") and
    // conversation-greeting-idempotency inheriting a foreign no-op persist mock
    // (zero greeting rows). The forks pool keeps mock registries strictly
    // per-file, matching the root suite's pool.
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
    include: [
      "src/**/*.test.{ts,tsx}",
      "test/**/*.test.{ts,tsx}",
      "scripts/**/*.test.{ts,tsx}",
    ],
    exclude: [
      "dist/**",
      "**/node_modules/**",
      "**/*.e2e.test.{ts,tsx}",
      "**/*.integration.test.{ts,tsx}",
      "**/*.live.test.{ts,tsx}",
      "**/*.live.e2e.test.{ts,tsx}",
      "**/*.real.test.{ts,tsx}",
      "**/*-real.test.{ts,tsx}",
    ],
  },
});
