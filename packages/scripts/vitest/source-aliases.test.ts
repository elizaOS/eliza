/**
 * Exercises actual Vite dependency resolution through workspace source aliases.
 * Explicitly blocked package exports must remain unavailable while legitimate
 * runtime testing imports still resolve to their owning source.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { buildWorkspaceSourceAliases, workspaceRepoRoot } from "./source-aliases.ts";

test("source aliases preserve the package's blocked installation identity export", async () => {
  const server = await createServer({
    configFile: false,
    root: workspaceRepoRoot,
    server: { middlewareMode: true, watch: null },
    resolve: { alias: buildWorkspaceSourceAliases(workspaceRepoRoot) },
  });
  try {
    const resolver = server.environments.ssr.pluginContainer;
    const importer = path.join(workspaceRepoRoot, "packages/scenario-runner/src/stability-executor.ts");
    const permitted = await resolver.resolveId("@elizaos/core/testing", importer);
    assert.equal(permitted?.id, path.join(workspaceRepoRoot, "packages/core/src/testing/index.ts"));
    await assert.rejects(
      resolver.resolveId("@elizaos/agent/runtime/runtime-installation-id", importer),
      /specifier|export|resolve/i,
    );
  } finally {
    await server.close();
  }
});
