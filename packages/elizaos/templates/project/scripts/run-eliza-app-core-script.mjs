#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const scriptPath = resolveElizaAppCoreScript(scriptName, { repoRoot });
const child = spawn(process.execPath, [scriptPath, ...scriptArgs], {
  cwd: repoRoot,
  env: process.env,
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
