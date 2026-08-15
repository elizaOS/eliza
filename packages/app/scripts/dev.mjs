#!/usr/bin/env node

/**
 * Starts direct app development through the shared Node-backed Vite command.
 * Keeping package scripts on the orchestrator's resolver gives every dev entry
 * point the same workspace export conditions while preserving Vite CLI flags.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveViteCommand } from "../../app-core/scripts/lib/dev-ui-vite.mjs";
import { spawnMirroredChild } from "./lib/spawn-mirrored-child.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viteCommand = resolveViteCommand({
  appDir,
  viteArgs: process.argv.slice(2),
});
spawnMirroredChild(viteCommand.command, viteCommand.args, {
  cwd: appDir,
  env: process.env,
  stdio: "inherit",
});
