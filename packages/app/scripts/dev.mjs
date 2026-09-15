#!/usr/bin/env node

/**
 * Starts direct app development through the shared Node-backed Vite command.
 * Keeping package scripts on the orchestrator's resolver gives every dev entry
 * point the same workspace export conditions while preserving Vite CLI flags.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRendererOnlyDevCloudTargetSupported,
  configureDevCloudEnvironment,
} from "../../app-core/scripts/lib/dev-cloud-target.mjs";
import { resolveViteCommand } from "../../app-core/scripts/lib/dev-ui-vite.mjs";
import { spawnMirroredChild } from "./lib/spawn-mirrored-child.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const devCloud = configureDevCloudEnvironment(
  process.argv.slice(2),
  process.env,
);
assertRendererOnlyDevCloudTargetSupported(devCloud, "packages/app dev");
const viteCommand = resolveViteCommand({
  appDir,
  viteArgs: devCloud.passthroughArgs,
});
console.log(
  `[dev] Cloud target=${devCloud.effectiveTarget} (${devCloud.source})`,
);
spawnMirroredChild(viteCommand.command, viteCommand.args, {
  cwd: appDir,
  env: devCloud.env,
  stdio: "inherit",
});
