#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const filterArg = args.find(
  (arg) => arg === "--filter" || arg.startsWith("--filter="),
);
const filter =
  filterArg === "--filter"
    ? args[args.indexOf(filterArg) + 1]
    : filterArg?.slice("--filter=".length);
async function findViewConfigs() {
  const pluginsDir = path.join(repoRoot, "plugins");
  const entries = await readdir(pluginsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(pluginsDir, entry.name, "vite.config.views.ts"))
    .filter((configPath) => existsSync(configPath))
    .filter((configPath) => {
      if (!filter) return true;
      const pluginName = path.basename(path.dirname(configPath));
      return pluginName.includes(filter) || `@elizaos/${pluginName}` === filter;
    })
    .sort();
}

const configs = await findViewConfigs();
if (configs.length === 0) {
  console.log("[build-views] no view configs found");
  process.exit(0);
}

async function buildView(configPath) {
  const cwd = path.dirname(configPath);
  const label = path.relative(repoRoot, cwd);
  const { status, output } = await runBun(["run", "build:views"], cwd);
  return { label, status: status ?? 1, output };
}

function runBun(buildArgs, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", buildArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ status: code, output: Buffer.concat(chunks) });
    });
  });
}

const concurrency = Math.min(
  configs.length,
  Math.max(1, os.cpus().length - 1),
);

const failures = [];
let nextIndex = 0;

async function worker() {
  while (true) {
    const index = nextIndex++;
    if (index >= configs.length) return;
    const configPath = configs[index];
    const result = await buildView(configPath);
    console.log(`[build-views] ${result.label}`);
    if (result.output.length > 0) {
      process.stdout.write(result.output);
    }
    if (result.status !== 0) {
      failures.push(result);
    }
  }
}

await Promise.all(
  Array.from({ length: concurrency }, () => worker()),
);

if (failures.length > 0) {
  console.error(
    `[build-views] ${failures.length} view build(s) failed: ${failures
      .map((failure) => failure.label)
      .join(", ")}`,
  );
  const exitStatus = failures.find((failure) => failure.status > 0)?.status ?? 1;
  process.exit(exitStatus);
}
