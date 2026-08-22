/**
 * Keeps the package's Vitest unit lane separate from the Node-native browser
 * capture proof, which is exercised through the dedicated `test:e2e` script.
 * Workspace dependencies resolve from source so standalone tests cannot exercise
 * stale build output.
 */
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../packages/scripts/vitest/source-aliases.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const sharedSourceRoot = fileURLToPath(
  new URL("../../packages/shared/src", import.meta.url),
);
const workspaceSourceAliases = buildWorkspaceSourceAliases(repoRoot);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@elizaos\/shared\/(.+)$/,
        replacement: `${sharedSourceRoot}/$1`,
      },
      {
        find: /^@elizaos\/shared$/,
        replacement: `${sharedSourceRoot}/index.ts`,
      },
      ...workspaceSourceAliases,
    ],
  },
  test: {
    exclude: [
      ...configDefaults.exclude,
      "scripts/headless-capture-e2e.test.mjs",
    ],
  },
});
