#!/usr/bin/env node
/**
 * Single-machine parallel certification orchestrator (#14549): regenerates the
 * lane topology from the live test plan, brings the compose cpu profile (and,
 * at --tier full, the gpu profile) up, collects per-lane exit codes and wall
 * times from docker, and writes a timings.json whose `timings` record is
 * BundleMeta.timings-compatible (packages/evidence: Record<phase, ms>) so a
 * certification bundle can absorb it verbatim.
 *
 * Degradation is deterministic and loud, never silent: no docker → the serial
 * native fallback is printed and the process exits with EXIT_NO_DOCKER;
 * default-params drift between compose.yml and regeneration → EXIT_DRIFT with
 * the regenerate command; lane failure → EXIT_LANE_FAILED after timings are
 * still written; wall-clock timeout → EXIT_TIMEOUT. macOS certifiers keep the
 * native path (bun run test + scripts/gpu-vision/serve.mjs) — compose is the
 * Linux/vast lane.
 *
 * Usage:
 *   node docker/certification/certify-parallel.mjs [--tier cpu|full]
 *     [--cores N] [--unit-shards N] [--e2e-shards N] [--gpu-parallel N]
 *     [--timeout-min N] [--out timings.json] [--keep-up] [--dry-run]
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_SETS, parseArgs } from "../../scripts/gpu-vision/lib.mjs";
import {
  buildComposeModel,
  paramsAreDefault,
  renderCompose,
  resolveParams,
} from "./compose-lanes-lib.mjs";
import { composePath, readPlan } from "./generate-compose-lanes.mjs";

export const EXIT_LANE_FAILED = 1;
export const EXIT_NO_DOCKER = 4;
export const EXIT_DRIFT = 5;
export const EXIT_TIMEOUT = 6;

const here = path.dirname(fileURLToPath(import.meta.url));
const POLL_MS = 5000;

function log(message) {
  process.stdout.write(`[certify-parallel] ${message}\n`);
}

function dockerAvailable() {
  // Timed probe: a wedged docker daemon/desktop reads as unavailable (and the
  // serial fallback prints) rather than hanging the orchestrator at step zero.
  const probe = spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return !probe.error && probe.status === 0;
}

function compose(fileArg, args, { capture = false } = {}) {
  const result = spawnSync(
    "docker",
    ["compose", "-f", fileArg, "--project-directory", here, ...args],
    {
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  return result;
}

/** `docker compose ps -a --format json` emits one JSON object per line. */
function composePs(fileArg, profiles) {
  const result = compose(
    fileArg,
    [
      ...profiles.flatMap((p) => ["--profile", p]),
      "ps",
      "-a",
      "--format",
      "json",
    ],
    {
      capture: true,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `[certify-parallel] docker compose ps failed:\n${result.stderr}`,
    );
  }
  return result.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function inspectContainer(id) {
  const result = spawnSync("docker", ["inspect", id], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `[certify-parallel] docker inspect ${id} failed:\n${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout)[0];
}

async function queueDrained(queueDir) {
  for (const sub of ["pending", "processing"]) {
    const entries = await fs.readdir(path.join(queueDir, sub)).catch((err) => {
      if (err.code === "ENOENT") return [];
      throw err;
    });
    if (entries.filter((name) => name.endsWith(".json")).length > 0)
      return false;
  }
  return true;
}

/**
 * Assemble the timings report. `timings` is deliberately a flat
 * Record<string, number> of milliseconds so packages/evidence can merge it
 * verbatim into BundleMeta.timings; everything richer (exit codes, ISO
 * stamps, skips) lives beside it.
 */
export function buildTimingsReport({
  tier,
  params,
  startedAt,
  finishedAt,
  lanes,
  timedOut,
}) {
  const timings = { wall: finishedAt.getTime() - startedAt.getTime() };
  for (const [lane, record] of Object.entries(lanes)) {
    timings[`lane:${lane}`] = record.durationMs;
  }
  const skipped = [];
  if (tier === "cpu") {
    skipped.push({
      lane: "gpu",
      reason: "tier=cpu — gpu profile not started; queue jobs remain pending",
    });
  }
  return {
    schema: 1,
    tier,
    params,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    wallClockMs: timings.wall,
    timings,
    lanes,
    skipped,
    timedOut,
  };
}

function printSerialFallback() {
  process.stdout.write(
    [
      "[certify-parallel] docker compose is not available on this host.",
      "Falling back is manual and serial — run the native path instead:",
      "  bun run test                                # all cpu lanes, serial",
      "  node scripts/gpu-vision/setup.mjs --with-vlm  # pinned model blobs",
      "  node scripts/gpu-vision/serve.mjs             # resident OCR llama-server",
      "  node scripts/gpu-vision/serve.mjs --vlm       # resident Qwen3-VL llama-server",
      "This is the supported macOS certifier path; compose is the Linux/vast lane.",
      `Exiting with code ${EXIT_NO_DOCKER} (EXIT_NO_DOCKER) so callers can tell "degraded" from "failed".`,
      "",
    ].join("\n"),
  );
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2), {
    booleans: ["keep-up", "dry-run"],
  });
  const params = resolveParams(flags);
  const tier = flags.tier === undefined ? "cpu" : flags.tier;
  if (tier !== "cpu" && tier !== "full") {
    throw new Error(`[certify-parallel] --tier must be cpu|full, got: ${tier}`);
  }
  const timeoutMin =
    flags["timeout-min"] === undefined ? 90 : Number(flags["timeout-min"]);
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) {
    throw new Error(
      `[certify-parallel] --timeout-min must be positive, got: ${flags["timeout-min"]}`,
    );
  }
  const outPath = path.resolve(
    flags.out === undefined ? path.join(here, "timings.json") : flags.out,
  );

  if (!dockerAvailable()) {
    printSerialFallback();
    process.exit(EXIT_NO_DOCKER);
  }

  log("deriving lanes from run-all-tests.mjs --plan=json --all");
  const model = buildComposeModel(readPlan(), params, MODEL_SETS);
  const text = renderCompose(model);

  // The committed compose.yml is the reviewed artifact; with default params it
  // must match regeneration or the board is being certified against a stale
  // topology. Non-default params legitimately diverge and use a temp file.
  if (paramsAreDefault(params)) {
    const committed = await fs.readFile(composePath, "utf8").catch(() => null);
    if (committed !== text) {
      process.stderr.write(
        "[certify-parallel] compose.yml drift: committed file does not match the current plan.\n" +
          "  Regenerate and commit: node docker/certification/generate-compose-lanes.mjs\n",
      );
      process.exit(EXIT_DRIFT);
    }
  }
  const composeFile = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "eliza-cert-")),
    "compose.yml",
  );
  await fs.writeFile(composeFile, text, "utf8");

  const profiles = tier === "full" ? ["cpu", "gpu"] : ["cpu"];
  const laneServices = model.services.filter(
    (service) => service.lane !== undefined,
  );
  log(
    `tier=${tier} lanes=${laneServices.length} (${laneServices.map((s) => s.lane).join(", ")})`,
  );

  if (flags["dry-run"] === true) {
    log(`dry run — compose file at ${composeFile}, not starting containers`);
    return;
  }

  const queueDir = path.join(
    here,
    process.env.ELIZA_CERT_QUEUE_HOST ?? "queue",
  );
  await fs.mkdir(queueDir, { recursive: true });

  const startedAt = new Date();
  const up = compose(composeFile, [
    ...profiles.flatMap((p) => ["--profile", p]),
    "up",
    "-d",
  ]);
  if (up.status !== 0) {
    throw new Error(`[certify-parallel] docker compose up exited ${up.status}`);
  }

  // Poll until every cpu lane container exits (and, at full tier, the GPU
  // queue drains — pipelining means the queue usually empties moments after
  // the last capture lane finishes).
  const deadline = Date.now() + timeoutMin * 60_000;
  const lanes = {};
  let timedOut = false;
  for (;;) {
    const ps = composePs(composeFile, profiles);
    const byService = new Map(ps.map((entry) => [entry.Service, entry]));
    let allExited = true;
    for (const service of laneServices) {
      const entry = byService.get(service.name);
      if (entry?.State !== "exited") {
        allExited = false;
        continue;
      }
      if (lanes[service.lane]) continue;
      const inspected = inspectContainer(entry.ID);
      const started = new Date(inspected.State.StartedAt);
      const finished = new Date(inspected.State.FinishedAt);
      lanes[service.lane] = {
        service: service.name,
        exitCode: inspected.State.ExitCode,
        startedAt: started.toISOString(),
        finishedAt: finished.toISOString(),
        durationMs: Math.max(0, finished.getTime() - started.getTime()),
      };
      log(
        `lane ${service.lane}: exit ${inspected.State.ExitCode} in ${lanes[service.lane].durationMs}ms`,
      );
    }
    const drained = tier === "full" ? await queueDrained(queueDir) : true;
    if (allExited && drained) break;
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const finishedAt = new Date();

  if (flags["keep-up"] !== true) {
    compose(composeFile, [
      ...profiles.flatMap((p) => ["--profile", p]),
      "down",
      "--remove-orphans",
    ]);
  }

  const report = buildTimingsReport({
    tier,
    params,
    startedAt,
    finishedAt,
    lanes,
    timedOut,
  });
  await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  log(`timings written to ${outPath}`);

  if (timedOut) {
    const missing = laneServices
      .filter((s) => !lanes[s.lane])
      .map((s) => s.lane);
    process.stderr.write(
      `[certify-parallel] TIMEOUT after ${timeoutMin}min — lanes still running: ${missing.join(", ") || "(none; queue not drained)"}\n`,
    );
    process.exit(EXIT_TIMEOUT);
  }
  const failed = Object.entries(lanes).filter(
    ([, record]) => record.exitCode !== 0,
  );
  if (failed.length > 0) {
    process.stderr.write(
      `[certify-parallel] ${failed.length} lane(s) failed: ${failed
        .map(([lane, record]) => `${lane} (exit ${record.exitCode})`)
        .join(", ")}\n`,
    );
    process.exit(EXIT_LANE_FAILED);
  }
  log(`all ${laneServices.length} lanes passed in ${report.wallClockMs}ms`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}
