#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [scriptName, ...scriptArgs] = process.argv.slice(2);
if (!scriptName) {
  console.error("Usage: run-eliza-app-core-script.mjs <script> [...args]");
  process.exit(2);
}

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "../../..");
const scriptPath = resolve(scriptsDir, scriptName);

if (!scriptPath.startsWith(`${scriptsDir}/`) || !existsSync(scriptPath)) {
  console.error(`App-core script not found: ${scriptName}`);
  process.exit(2);
}

const ext = extname(scriptPath);
const nodeArgs =
  ext === ".ts" || ext === ".tsx"
    ? ["--import", "tsx", scriptPath, ...scriptArgs]
    : [scriptPath, ...scriptArgs];
const result = spawnSync(process.execPath, nodeArgs, {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
