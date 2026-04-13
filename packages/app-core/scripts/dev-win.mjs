#!/usr/bin/env node
/**
 * Windows-compatible dev server launcher for Eliza.
 *
 * Usage:
 *   node eliza/packages/app-core/scripts/dev-win.mjs [--ui-only]
 */
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";

const here = import.meta.dirname;
const rootDir = resolve(here, "../../../..");

const extraArgs = process.argv.slice(2).join(" ");

try {
  const devScript = join(here, "dev-ui.mjs");
  execSync(`bun "${devScript}" ${extraArgs}`, {
    stdio: "inherit",
    shell: true,
    cwd: rootDir,
  });
} catch (e) {
  process.exit(e.status || 1);
}
