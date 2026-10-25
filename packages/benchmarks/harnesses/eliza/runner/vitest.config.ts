/** Resolve benchmark tests through the repository's canonical workspace source aliases. */
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../../../scripts/vitest/source-aliases.ts";

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    server: { deps: { inline: [/@elizaos\//] } },
  },
  resolve: { alias: buildWorkspaceSourceAliases() },
});
