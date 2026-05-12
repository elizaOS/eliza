#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cloudRoot = path.resolve(here, "../..");
const integrationRoot = path.join(cloudRoot, "packages/tests/integration");
const bun = process.env.BUN || process.env.npm_execpath || "bun";

const serverPreload = "./packages/tests/e2e/preload.ts";
const dbPreload = "./packages/tests/load-env.ts";
const timeoutMs = process.env.CLOUD_INTEGRATION_TIMEOUT_MS || "120000";

const isolatedServerFiles = new Set([
  "packages/tests/integration/oauth-api.test.ts",
]);
const isolatedDbFiles = new Set([
  "packages/tests/integration/services/organizations.service.test.ts",
]);

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(path.relative(cloudRoot, fullPath));
    }
  }
  return files.sort();
}

function isDbOnlyFile(file) {
  return (
    file.includes("/db/") ||
    file.includes("/financial/") ||
    file.includes("/services/")
  );
}

function run(label, preload, files) {
  if (files.length === 0) {
    return;
  }

  console.log(`[cloud-integration] START ${label} (${files.length} file${files.length === 1 ? "" : "s"})`);
  const result = spawnSync(
    bun,
    [
      "test",
      "--max-concurrency=1",
      "--preload",
      preload,
      ...files,
      "--timeout",
      timeoutMs,
    ],
    {
      cwd: cloudRoot,
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
  (file) =>
    !isDbOnlyFile(file) &&
    !isolatedServerFiles.has(file) &&
    !isolatedDbFiles.has(file),
);
const dbFiles = allFiles.filter(
  (file) =>
    isDbOnlyFile(file) &&
    !isolatedServerFiles.has(file) &&
    !isolatedDbFiles.has(file),
);

run("server-backed integration", serverPreload, serverFiles);
for (const file of isolatedServerFiles) {
  run(file, serverPreload, [file]);
}
run("db/service integration", dbPreload, dbFiles);
for (const file of isolatedDbFiles) {
  run(file, dbPreload, [file]);
}
