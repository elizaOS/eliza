/** Verifies the local Cloud-agent build keeps the Dockerfile's eliza/ source prefix in context. */

import assert from "node:assert/strict";
import test from "node:test";
import { resolveCloudAgentBuildPaths } from "./cloud-agent-build-paths.mjs";

test("uses the parent of the eliza checkout as Docker context", () => {
  const paths = resolveCloudAgentBuildPaths(
    "/workspace/eliza/packages/cloud/scripts/admin/dev",
  );

  assert.equal(paths.elizaRoot, "/workspace/eliza");
  assert.equal(paths.contextRoot, "/workspace");
  assert.equal(
    paths.dockerfileRelToContext,
    "eliza/packages/app-core/deploy/Dockerfile.cloud-agent",
  );
});
