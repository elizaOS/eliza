/**
 * Vitest config for the scenario-runner package. Aliases every workspace
 * `@elizaos/*` package to its TypeScript source so the scenario runtime resolves
 * optional plugins independent of build order (test:server only builds core); see
 * the inline note on the dynamic-import failure this avoids.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../scripts/vitest/source-aliases";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const workspaceSourceAliases = buildWorkspaceSourceAliases(repoRoot);

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/__tests__/**/*.test.ts"],
    exclude: ["dist/**", "**/node_modules/**"],
    testTimeout: 180_000,
    // Each worker transforms the full source-aliased runtime and personal-
    // assistant helper graph. Higher host-derived concurrency can starve the
    // helper-loading contract until its 180s timeout on shared CI runners.
    maxWorkers: 2,
  },
  resolve: {
    alias: [
      {
        find: /^zod$/,
        replacement: path.join(repoRoot, "node_modules/zod/v4/index.js"),
      },
      {
        find: /^@elizaos\/core\/testing$/,
        replacement: path.join(repoRoot, "packages/core/src/testing/index.ts"),
      },
      {
        find: /^@elizaos\/scenario-runner\/schema$/,
        replacement: path.join(
          repoRoot,
          "packages/scenario-runner/schema/index.js",
        ),
      },
      {
        find: /^@elizaos\/scenario-runner\/scenario-assertions$/,
        replacement: path.join(
          repoRoot,
          "packages/scenario-runner/src/scenario-assertions.ts",
        ),
      },
      {
        find: /^@elizaos\/scenario-runner\/missing-input-terminal-relay$/,
        replacement: path.join(
          repoRoot,
          "packages/scenario-runner/src/missing-input-terminal-relay.ts",
        ),
      },
      {
        find: /^@elizaos\/core\/node$/,
        replacement: path.join(repoRoot, "packages/core/src/index.node.ts"),
      },
      {
        find: /^@elizaos\/core\/atomic-json$/,
        replacement: path.join(
          repoRoot,
          "packages/core/src/utils/atomic-json.ts",
        ),
      },
      {
        find: /^@elizaos\/shared\/brand$/,
        replacement: path.join(repoRoot, "packages/shared/src/brand/index.ts"),
      },
      {
        find: /^@elizaos\/shared\/brand-classic$/,
        replacement: path.join(
          repoRoot,
          "packages/shared/src/brand-classic/index.ts",
        ),
      },
      {
        find: /^@elizaos\/shared\/steward-session-client$/,
        replacement: path.join(
          repoRoot,
          "packages/shared/src/steward-session-client/index.ts",
        ),
      },
      {
        find: /^@elizaos\/shared\/types$/,
        replacement: path.join(repoRoot, "packages/shared/src/types/index.ts"),
      },
      {
        find: /^@elizaos\/ui\/agent-surface$/,
        replacement: path.join(
          repoRoot,
          "packages/ui/src/agent-surface/index.ts",
        ),
      },
      {
        find: /^@elizaos\/ui\/components\/ui\/(.*)$/,
        replacement: path.join(
          repoRoot,
          "packages/ui/src/components/ui/$1.tsx",
        ),
      },
      ...workspaceSourceAliases,
    ].map((entry) => ({
      ...entry,
      // vite `resolve.alias` replacements must be POSIX forward-slash paths.
      // `path.join` yields backslashes on Windows, which break vite's alias
      // matching (specifiers like `@elizaos/shared/local-inference` then fall
      // through to Node and fail with "Cannot find package"). No-op on POSIX.
      replacement: entry.replacement.split("\\").join("/"),
    })),
  },
});
