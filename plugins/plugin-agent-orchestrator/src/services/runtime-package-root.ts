/**
 * Resolves the installed orchestrator package through the launching program's
 * Node module graph. Explicit anchors let embedders identify a graph when the
 * process entrypoint and working directory are outside the installed package.
 */
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ElizaError } from "@elizaos/core";

const PACKAGE_NAME = "@elizaos/plugin-agent-orchestrator";

function defaultResolutionAnchors(): string[] {
  const entrypoint = process.argv[1];
  return [
    ...(entrypoint
      ? [isAbsolute(entrypoint) ? entrypoint : resolve(entrypoint)]
      : []),
    join(process.cwd(), "package.json"),
  ];
}

/**
 * Finds the package root through ordinary `node_modules` resolution without
 * depending on the source module's URL, which bundlers commonly replace with
 * an absolute build-machine path. Explicit anchors support relocation tests
 * and embedders whose application entrypoint is outside `process.cwd()`.
 */
export function resolveAgentOrchestratorPackageRoot(
  anchors: readonly string[] = defaultResolutionAnchors(),
): string {
  const packageManifest = `${PACKAGE_NAME}/package.json`;
  for (const anchor of anchors) {
    const searchPaths = createRequire(resolve(anchor)).resolve.paths(
      packageManifest,
    );
    for (const searchPath of searchPaths ?? []) {
      const candidate = join(searchPath, PACKAGE_NAME, "package.json");
      if (existsSync(candidate)) return realpathSync(dirname(candidate));
    }
  }

  throw new ElizaError("Unable to resolve the installed orchestrator package", {
    code: "ORCHESTRATOR_PACKAGE_ROOT_UNRESOLVED",
    context: { anchors },
    severity: "fatal",
  });
}
