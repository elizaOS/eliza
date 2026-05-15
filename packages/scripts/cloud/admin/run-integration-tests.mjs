#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const integrationRoot = path.join(repoRoot, "packages/cloud-api/test/e2e");
const bun = process.env.BUN || process.env.npm_execpath || "bun";

const serverPreload = "packages/cloud-api/test/e2e/preload.ts";
const dbPreload = "packages/cloud-api/test/e2e/preload.ts";
const timeoutMs = process.env.CLOUD_INTEGRATION_TIMEOUT_MS || "120000";

const isolatedServerFiles = new Set(["packages/cloud-api/test/e2e/agent-token-flow.test.ts"]);
const isolatedDbFiles = new Set([]);

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(path.relative(repoRoot, fullPath));
    }
  }
  return files.sort();
}

function isDbOnlyFile(file) {
  return file.includes("/db/") || file.includes("/financial/") || file.includes("/services/");
}

function run(label, preload, files) {
  if (files.length === 0) {
    return;
  }

  console.log(
    `[cloud-integration] START ${label} (${files.length} file${files.length === 1 ? "" : "s"})`,
  );
  const result = spawnSync(
    bun,
    ["test", "--max-concurrency=1", "--preload", preload, ...files, "--timeout", timeoutMs],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  console.log(`[cloud-integration] PASS ${label}`);
}

const allFiles = walk(integrationRoot);
const serverFiles = allFiles.filter(
  (file) => !isDbOnlyFile(file) && !isolatedServerFiles.has(file) && !isolatedDbFiles.has(file),
);
const dbFiles = allFiles.filter(
  (file) => isDbOnlyFile(file) && !isolatedServerFiles.has(file) && !isolatedDbFiles.has(file),
);

run("server-backed integration", serverPreload, serverFiles);
for (const file of isolatedServerFiles) {
  run(file, serverPreload, [file]);
}
run("db/service integration", dbPreload, dbFiles);
for (const file of isolatedDbFiles) {
  run(file, dbPreload, [file]);
}
