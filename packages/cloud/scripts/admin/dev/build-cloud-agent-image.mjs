#!/usr/bin/env node
/**
 * Build the local eliza-cloud-agent Docker image so LocalDockerSandboxProvider
 * has something to spawn.
 *
 *   bun run --cwd packages/cloud/api agent:build
 *
 * The build context root is one level above this repo so
 * the Dockerfile's `COPY eliza/packages/...` paths resolve. The tag is
 * `eliza-cloud-agent:local` to match the default `ELIZA_AGENT_IMAGE` used
 * by the local provider.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCloudAgentBuildPaths } from "./cloud-agent-build-paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { contextRoot, dockerfile, dockerfileRelToContext } =
  resolveCloudAgentBuildPaths(__dirname);

if (!existsSync(dockerfile)) {
  console.error(`[agent:build] Dockerfile not found at ${dockerfile}`);
  process.exit(1);
}

const tag = process.env.ELIZA_AGENT_IMAGE_TAG ?? "eliza-cloud-agent:local";
const platform =
  process.env.ELIZA_AGENT_IMAGE_PLATFORM ??
  (process.arch === "arm64" ? "linux/arm64" : "linux/amd64");

console.log(`[agent:build] tag=${tag} platform=${platform}`);
console.log(`[agent:build] context=${contextRoot}`);
console.log(`[agent:build] dockerfile=${dockerfileRelToContext}`);

const result = spawnSync(
  "docker",
  [
    "build",
    "-f",
    dockerfileRelToContext,
    "-t",
    tag,
    "--platform",
    platform,
    ".",
  ],
  {
    cwd: contextRoot,
    stdio: "inherit",
  },
);

if (result.status !== 0) {
  console.error(`[agent:build] docker build failed with exit ${result.status}`);
  process.exit(result.status ?? 1);
}

console.log(`[agent:build] built ${tag}`);
