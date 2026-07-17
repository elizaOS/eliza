#!/usr/bin/env node
/**
 * Validate live-scenario shard prerequisites and verify each shard's complete
 * evidence contract before the workflow's aggregate authority can pass.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const defaultManifest = path.join(
  repoRoot,
  "packages/scripts/live-scenario-shards.json",
);

export function loadShard(manifestPath, shardId) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const shard = manifest.shards?.find((entry) => entry.id === shardId);
  if (!shard) throw new Error(`unknown live scenario shard: ${shardId}`);
  return { manifest, shard };
}

export function evaluatePrerequisites(shard, env) {
  const missing = (shard.requiredSecrets ?? []).filter(
    (name) => !env[name]?.trim(),
  );
  const missingAny = (shard.requiredAnySecrets ?? [])
    .filter((group) => !group.some((name) => env[name]?.trim()))
    .map((group) => [...group]);
  return {
    status:
      missing.length === 0 && missingAny.length === 0
        ? "ready"
        : "prerequisite_unavailable",
    missing,
    missingAny,
  };
}

export function writeOutcome({ shard, result, outputPath, sha, runId }) {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const outcome = {
    schema: "eliza_live_scenario_prerequisite_v1",
    shard: shard.id,
    root: shard.root,
    status: result.status,
    missing: result.missing,
    missingAny: result.missingAny,
    artifactContract: shard.artifactContract,
    provenance: { sha: sha || null, runId: runId || null },
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(outputPath, `${JSON.stringify(outcome, null, 2)}\n`);
  return outcome;
}

export function verifyEvidence(shard, root = repoRoot) {
  const required = [
    shard.report,
    path.join(shard.runDir, "matrix.json"),
    path.join(shard.runDir, "viewer/index.html"),
    path.join(shard.runDir, "native.jsonl"),
    path.join(shard.runDir, "runner.log"),
  ];
  const missing = required.filter(
    (entry) => !existsSync(path.resolve(root, entry)),
  );
  return {
    status: missing.length === 0 ? "evidence_complete" : "evidence_incomplete",
    missing,
  };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const [command, shardId] = argv;
  if (!command || !shardId)
    throw new Error(
      "usage: live-scenario-contract.mjs <preflight|verify> <shard-id>",
    );
  const manifestPath = env.LIVE_SCENARIO_MANIFEST || defaultManifest;
  const { shard } = loadShard(manifestPath, shardId);
  const outcomePath = path.resolve(
    repoRoot,
    env.LIVE_SCENARIO_OUTCOME || path.join(shard.runDir, "prerequisite.json"),
  );
  if (command === "preflight") {
    const result = evaluatePrerequisites(shard, env);
    writeOutcome({
      shard,
      result,
      outputPath: outcomePath,
      sha: env.GITHUB_SHA,
      runId: env.GITHUB_RUN_ID,
    });
    if (result.status !== "ready") {
      console.error(
        `[live-scenario-contract] ${shard.id}: prerequisite_unavailable; missing=${result.missing.join(",") || "none"}; missingAny=${result.missingAny.map((group) => group.join("|")).join(",") || "none"}`,
      );
      return 2;
    }
    console.log(`[live-scenario-contract] ${shard.id}: ready`);
    return 0;
  }
  if (command === "verify") {
    const result = verifyEvidence(shard);
    if (result.status !== "evidence_complete") {
      console.error(
        `[live-scenario-contract] ${shard.id}: evidence_incomplete; missing=${result.missing.join(",")}`,
      );
      return 3;
    }
    console.log(`[live-scenario-contract] ${shard.id}: evidence_complete`);
    return 0;
  }
  throw new Error(`unknown command: ${command}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
