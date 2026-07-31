#!/usr/bin/env node
/**
 * Validate live-scenario shard prerequisites and verify each shard's complete
 * evidence contract before the workflow's aggregate authority can pass.
 *
 * Also owns the shard fan-out that `.github/workflows/live-scenarios.yml`
 * consumes: `matrix` resolves the requested shards into a job matrix, and
 * `gate` re-asserts every requested shard's outcome from the downloaded
 * artifacts so a shard that failed — or was reaped mid-run — can never be read
 * as an overall pass.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
    path.join(shard.runDir, "native.manifest.json"),
    path.join(shard.runDir, "native.privacy-attestation.json"),
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

/**
 * Resolve the shards a run must execute into a `strategy.matrix` payload.
 *
 * A scheduled run always executes every shard. A manual run executes the one
 * selected shard, and a `scenario_filter` may name its shard by prefix so an
 * exact-head dispatch can target a shard the default branch's input schema does
 * not know yet.
 */
export function resolveShardMatrix(manifest, env) {
  const ids = manifest.shards.map((entry) => entry.id);
  const filter = (env.SCENARIO_FILTER ?? "").trim();
  let selected = (env.SCENARIO_SHARD ?? "").trim() || "all";
  if (env.EVENT_NAME === "schedule") selected = "all";
  else {
    const prefixed = ids.find((id) => filter.startsWith(`${id}:`));
    if (prefixed) selected = prefixed;
  }
  if (selected !== "all" && !ids.includes(selected))
    throw new Error(`unknown scenario_shard: ${selected}`);
  if (filter && selected === "all")
    throw new Error(
      "scenario_filter requires one named scenario_shard; 'all' is ambiguous",
    );
  const requested =
    selected === "all"
      ? manifest.shards
      : manifest.shards.filter((entry) => entry.id === selected);
  return {
    include: requested.map((shard) => ({
      shard: shard.id,
      root: shard.root,
      report: shard.report,
      run_dir: shard.runDir,
      timeout_minutes: shard.timeoutMinutes,
      lane_args: shard.lane ? `--lane ${shard.lane}` : "",
      // An unfiltered shard runs its declared default; a shard that owns a
      // bounded subset of a mixed-purpose catalog carries that subset here.
      scenario_filter: filter || (shard.scenarioIds ?? []).join(","),
    })),
  };
}

/**
 * Assert that every requested shard published a successful outcome record.
 *
 * Reads the per-shard artifacts rather than trusting job conclusions alone: a
 * shard cancelled by the zombie janitor leaves no outcome file, which must read
 * as a lane failure and not as a shard that had nothing to say.
 */
export function gateShardOutcomes(expectedShards, artifactDir) {
  // Indexed by the record's own `shard` field rather than by path: the artifact
  // download layout varies with how many artifacts matched the pattern, so the
  // outcome file's depth under artifactDir is not something to depend on.
  const published = new Map();
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.name === "shard-outcome.json") {
        const outcome = JSON.parse(readFileSync(entryPath, "utf8"));
        published.set(outcome.shard, outcome.status || "unknown");
      }
    }
  };
  walk(artifactDir);

  const failures = expectedShards
    .map((shard) => [shard, published.get(shard) ?? "no-outcome-artifact"])
    .filter(([, status]) => status !== "success")
    .map(([shard, status]) => `${shard}=${status}`);
  return { status: failures.length === 0 ? "pass" : "fail", failures };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const [command, shardId] = argv;
  const manifestPath = env.LIVE_SCENARIO_MANIFEST || defaultManifest;

  if (command === "matrix") {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const matrix = resolveShardMatrix(manifest, env);
    const serialized = JSON.stringify(matrix);
    console.log(serialized);
    if (env.GITHUB_OUTPUT)
      writeFileSync(
        env.GITHUB_OUTPUT,
        `matrix=${serialized}\nshards=${matrix.include.map((entry) => entry.shard).join(",")}\n`,
        { flag: "a" },
      );
    return 0;
  }

  if (command === "gate") {
    const expected = (env.EXPECTED_SHARDS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (expected.length === 0) throw new Error("gate requires EXPECTED_SHARDS");
    const artifactDir = env.ARTIFACT_DIR || "artifacts/shard-outcomes";
    const present = existsSync(artifactDir) ? readdirSync(artifactDir) : [];
    console.log(
      `[live-scenario-contract] gate: expected=${expected.join(",")} artifacts=${present.join(",") || "none"}`,
    );
    const result = gateShardOutcomes(expected, artifactDir);
    if (result.status !== "pass") {
      console.error(
        `[live-scenario-contract] gate: lane failed; ${result.failures.join(", ")}`,
      );
      return 4;
    }
    console.log("[live-scenario-contract] gate: all requested shards passed");
    return 0;
  }

  if (!command || !shardId)
    throw new Error(
      "usage: live-scenario-contract.mjs <preflight|verify|matrix|gate> [shard-id]",
    );
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
