#!/usr/bin/env node
/**
 * Launches an @elizaos/app-core script for this consumer project.
 *
 * In local source mode (nested monorepo or ./eliza checkout) the script is
 * started under `bun --conditions=eliza-source` so workspace package exports
 * resolve to TypeScript source. Published package mode uses plain Node.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getElizaSourceMode,
  isLocalElizaDisabled,
} from "./lib/eliza-source-mode.mjs";
import { resolveElizaAppCoreScript } from "./lib/resolve-eliza-app-core-script.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const [scriptName, ...scriptArgs] = process.argv.slice(2);

if (!scriptName) {
  console.error(
    "usage: node scripts/run-eliza-app-core-script.mjs <script-name> [...args]",
  );
  process.exit(1);
}

const sourceMode = getElizaSourceMode({ repoRoot });
const preferLocal = !isLocalElizaDisabled({ repoRoot });
const scriptPath = resolveElizaAppCoreScript(scriptName, {
  repoRoot,
  preferLocal,
});

const elizaRoot = path.join(repoRoot, "eliza");
const monorepoNodeModules = path.join(elizaRoot, "node_modules");
const env = { ...process.env, ELIZA_SOURCE: sourceMode };

// Local mode needs monorepo node_modules on NODE_PATH so app-core scripts can
// resolve workspace packages when cwd is the consumer project.
if (preferLocal && fs.existsSync(monorepoNodeModules)) {
  const existing = env.NODE_PATH ?? "";
  env.NODE_PATH = existing
    ? `${monorepoNodeModules}${path.delimiter}${existing}`
    : monorepoNodeModules;
}

const useBunSource =
  preferLocal &&
  (fs.existsSync(path.join(elizaRoot, "packages", "app-core", "package.json")) ||
    fs.existsSync(path.join(elizaRoot, "package.json")));

const command = useBunSource ? "bun" : process.execPath;
const args = useBunSource
  ? ["--no-install", "--conditions=eliza-source", scriptPath, ...scriptArgs]
  : [scriptPath, ...scriptArgs];

const child = spawn(command, args, {
  cwd: repoRoot,
  env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(
    `[elizaos] Failed to start ${scriptName}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[elizaos] ${scriptName} exited due to signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
