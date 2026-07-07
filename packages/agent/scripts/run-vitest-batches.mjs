/**
 * Runs the agent Vitest suite one file per process so package-level tests do
 * not share leaked module state or a long-lived transform heap. The file
 * selection mirrors vitest.config.ts and keeps `bun run --cwd packages/agent
 * test` as the single package entrypoint.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const batchSize = Number.parseInt(process.env.AGENT_TEST_BATCH_SIZE ?? "1", 10);
const roots = ["src", "test"];

const excludedPatterns = [
  /\.e2e\.test\.[cm]?tsx?$/,
  /\.integration\.test\.[cm]?tsx?$/,
  /\.live\.test\.[cm]?tsx?$/,
  /\.live\.e2e\.test\.[cm]?tsx?$/,
  /\.real\.test\.[cm]?tsx?$/,
  /-real\.test\.[cm]?tsx?$/,
];

function walk(relativeDir, out) {
  const absoluteDir = path.join(packageRoot, relativeDir);
  for (const entry of readdirSync(absoluteDir)) {
    const relativePath = path.join(relativeDir, entry);
    const absolutePath = path.join(packageRoot, relativePath);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      if (entry === "dist" || entry === "node_modules") continue;
      walk(relativePath, out);
      continue;
    }
    if (!stat.isFile()) continue;
    if (!/\.test\.[cm]?tsx?$/.test(entry)) continue;
    if (excludedPatterns.some((pattern) => pattern.test(relativePath))) {
      continue;
    }
    out.push(relativePath);
  }
}

const files = roots.flatMap((root) => {
  const out = [];
  walk(root, out);
  return out;
});
files.sort();

if (files.length === 0) {
  console.error("[agent-test] No test files matched the package Vitest config.");
  process.exit(1);
}

if (!Number.isFinite(batchSize) || batchSize < 1) {
  console.error("[agent-test] AGENT_TEST_BATCH_SIZE must be a positive integer.");
  process.exit(1);
}

const inheritedNodeOptions = process.env.NODE_OPTIONS ?? "";
const nodeOptions = inheritedNodeOptions.includes("--max-old-space-size")
  ? inheritedNodeOptions
  : `${inheritedNodeOptions} --max-old-space-size=8192`.trim();

for (let start = 0; start < files.length; start += batchSize) {
  const batch = files.slice(start, start + batchSize);
  const batchNumber = Math.floor(start / batchSize) + 1;
  const batchCount = Math.ceil(files.length / batchSize);
  console.log(
    `[agent-test] batch ${batchNumber}/${batchCount}: ${batch.length} file(s)`,
  );
  const result = spawnSync(
    "bunx",
    ["vitest", "run", "--config", "vitest.config.ts", ...batch],
    {
      cwd: packageRoot,
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
      stdio: "inherit",
    },
  );
  if (result.error) {
    console.error(`[agent-test] Failed to start Vitest: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
