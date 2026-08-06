#!/usr/bin/env node
/**
 * Spawn the resolved clawd-code binary/package with forwarded args.
 * Used by .mcp.json and monorepo verification so the plugin talks to the sibling CLI.
 */

import { spawn } from "node:child_process";
import { resolveClawdCode, resolveClawdPluginDir } from "./resolve-clawd-code.mjs";

const resolution = resolveClawdCode();
const forwarded = process.argv.slice(2);
const args = [...resolution.args, ...forwarded];

const child = spawn(resolution.command, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    CLAWD_PLUGIN_DIR: process.env.CLAWD_PLUGIN_DIR || resolveClawdPluginDir(),
    CLAWD_CODE_ROOT: resolution.root || process.env.CLAWD_CODE_ROOT || "",
  },
  shell: resolution.kind === "npx",
});

child.on("error", (err) => {
  console.error(
    `[clawd-plugin] failed to start clawd-code (${resolution.kind}):`,
    err.message,
  );
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
