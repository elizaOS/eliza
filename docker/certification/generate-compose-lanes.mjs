#!/usr/bin/env node
/**
 * Generates docker/certification/compose.yml from the test runner's live plan
 * (#14549). Lane services derive from `run-all-tests.mjs --plan=json --all` —
 * the runner's own lane/shard model — plus the pinned GPU model set from
 * scripts/gpu-vision; there is no lane list in this directory to fall out of
 * sync. The output is committed, and `--check` fails when the committed file
 * no longer matches a fresh regeneration (the drift gate the tests run).
 *
 * Usage:
 *   node docker/certification/generate-compose-lanes.mjs [--check] [--print]
 *     [--cores N] [--unit-shards N] [--e2e-shards N] [--gpu-parallel N]
 */

import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_SETS, parseArgs } from "../../scripts/gpu-vision/lib.mjs";
import {
  buildComposeModel,
  renderCompose,
  resolveParams,
} from "./compose-lanes-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../..");
export const composePath = path.join(here, "compose.yml");

/**
 * Run the planner with lane/shard/filter env stripped so the derived topology
 * never depends on what happens to be exported in the invoking shell.
 */
export function readPlan() {
  const env = { ...process.env };
  for (const key of [
    "TEST_SHARD",
    "TEST_PACKAGE_FILTER",
    "TEST_SCRIPT_FILTER",
    "TEST_START_AT",
  ]) {
    delete env[key];
  }
  env.TEST_LANE = "pr";
  // The planner exits before an OS pipe drains, truncating large plans at one
  // pipe buffer — a file fd is flushed synchronously, so stdout goes to a temp
  // file instead of being captured over a pipe.
  const outDir = mkdtempSync(path.join(os.tmpdir(), "eliza-cert-plan-"));
  const outPath = path.join(outDir, "plan.json");
  const outFd = openSync(outPath, "w");
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, "packages/scripts/run-all-tests.mjs"),
        "--plan=json",
        "--all",
      ],
      {
        cwd: repoRoot,
        env,
        encoding: "utf8",
        stdio: ["ignore", outFd, "pipe"],
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `[compose-lanes] run-all-tests.mjs --plan=json exited ${result.status}:\n${result.stderr}`,
      );
    }
    return JSON.parse(readFileSync(outPath, "utf8"));
  } finally {
    closeSync(outFd);
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** Full generation pipeline: plan → model → YAML text. */
export function generateComposeText(params) {
  return renderCompose(buildComposeModel(readPlan(), params, MODEL_SETS));
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2), {
    booleans: ["check", "print"],
  });
  const params = resolveParams(flags);
  const text = generateComposeText(params);

  if (flags.print === true) {
    process.stdout.write(text);
    return;
  }

  if (flags.check === true) {
    const committed = await fs.readFile(composePath, "utf8").catch((err) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (committed !== text) {
      process.stderr.write(
        "[compose-lanes] DRIFT: docker/certification/compose.yml does not match regeneration.\n" +
          "  Regenerate and commit: node docker/certification/generate-compose-lanes.mjs\n",
      );
      process.exit(1);
    }
    process.stdout.write("[compose-lanes] compose.yml matches regeneration\n");
    return;
  }

  await fs.writeFile(composePath, text, "utf8");
  process.stdout.write(
    `[compose-lanes] wrote ${path.relative(repoRoot, composePath)}\n`,
  );
}

// Library consumers (certify-parallel.mjs, tests) import the exports above
// without triggering a generation run.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}
