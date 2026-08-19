/** Configures the mock fixture Vitest project for deterministic external-service tests. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../../scripts/vitest/source-aliases.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const packagesRoot = path.resolve(here, "../..");
const repoRoot = path.resolve(here, "../../../..");

export default defineConfig({
  root: packagesRoot,
  resolve: {
    alias: buildWorkspaceSourceAliases(repoRoot),
    dedupe: ["@elizaos/core"],
  },
  test: {
    include: ["test/mocks/__tests__/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "threads",
    threads: { singleThread: true },
  },
});
