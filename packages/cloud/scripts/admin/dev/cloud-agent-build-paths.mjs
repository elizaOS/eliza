/** Resolves the Docker build paths for the local Cloud agent image. */

import path from "node:path";

export function resolveCloudAgentBuildPaths(scriptDirectory) {
  const elizaRoot = path.resolve(scriptDirectory, "../../../../..");
  const contextRoot = path.dirname(elizaRoot);
  const dockerfile = path.join(
    elizaRoot,
    "packages/app-core/deploy/Dockerfile.cloud-agent",
  );
  return {
    elizaRoot,
    contextRoot,
    dockerfile,
    dockerfileRelToContext: path.relative(contextRoot, dockerfile),
  };
}
