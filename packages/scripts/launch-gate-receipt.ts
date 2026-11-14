#!/usr/bin/env node
/**
 * Writes the privacy-safe terminal receipts for the composed staging launch
 * gate (`.github/workflows/staging-launch-gate.yml`, #29922).
 *
 *   lane     one closed receipt per lane (front-door, first-turn, reload,
 *            messaging, routing)
 *   compose  folds the lane receipts into one launch-gate receipt, appends a
 *            step summary, and exits non-zero unless every lane passed
 *
 * The schema is closed: exact public commit SHAs, GitHub run identity, lane
 * ids, outcomes, timings, the owning tracker for each lane, and at most one
 * integer or enum metric per lane. Tokens, account or user identifiers,
 * message content, URLs with parameters, and raw provider output can never be
 * written because no argument accepts free text.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { testOutputPath } from "./lib/test-output.ts";

export const LANE_RECEIPT_SCHEMA = "elizaos.launch-gate.lane/v1";
export const LAUNCH_GATE_RECEIPT_SCHEMA = "elizaos.launch-gate/v1";

/** Fixed lane order and the tracker that owns a failure in each lane. */
export const LAUNCH_GATE_LANES = Object.freeze([
  Object.freeze({
    id: "front-door",
    owner: "#29918",
    proves:
      "exact-SHA Pages/Worker release authority and anonymous Steward sign-in discovery",
  }),
  Object.freeze({
    id: "first-turn",
    owner: "#22552",
    proves:
      "deployed renderer resolves Personal Eliza and settles one live first turn",
  }),
  Object.freeze({
    id: "reload",
    owner: "#29921",
    proves:
      "server history and identity survive reload and a fresh browser context",
  }),
  Object.freeze({
    id: "messaging",
    owner: "#29919",
    proves:
      "the staging messaging provider identity and gateway configuration are live",
  }),
  Object.freeze({
    id: "routing",
    owner: "#29922",
    proves: "every staging domain is answered by the staging environment",
  }),
]);

const LANE_IDS = new Set(LAUNCH_GATE_LANES.map((lane) => lane.id));
const OUTCOMES = new Set(["success", "failure"]);
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export class LaunchGateReceiptError extends Error {
  constructor(message) {
    super(`[launch-gate-receipt] ${message}`);
    this.name = "LaunchGateReceiptError";
    this.code = "LAUNCH_GATE_RECEIPT_INVALID";
  }
}

function fail(message) {
  throw new LaunchGateReceiptError(message);
}

function parseFlags(argv, allowed) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      fail("arguments must be --name value pairs");
    }
    const name = flag.slice(2);
    if (!allowed.has(name)) fail(`unsupported argument: ${flag}`);
    if (values.has(name)) fail(`duplicate argument: ${flag}`);
    values.set(name, value);
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (value === undefined) fail(`missing argument: --${name}`);
  return value;
}

function sha(value, name) {
  if (!SHA_PATTERN.test(value ?? "")) {
    fail(`${name} must be an exact lowercase 40-hex commit SHA`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(value ?? "")) {
    fail(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${name} exceeds the safe range`);
  return parsed;
}

function timestamp(value, name) {
  if (!/^\d{13}$/.test(value ?? "")) {
    fail(`${name} must be a 13-digit Unix timestamp in milliseconds`);
  }
  return Number(value);
}

function laneDefinition(id) {
  const lane = LAUNCH_GATE_LANES.find((candidate) => candidate.id === id);
  if (!lane) fail(`unknown lane: ${id}`);
  return lane;
}

function identity(values) {
  return {
    sourceSha: sha(required(values, "source-sha"), "source-sha"),
    deployedSha: sha(required(values, "deployed-sha"), "deployed-sha"),
    workflow: {
      runId: positiveInteger(required(values, "run-id"), "run-id"),
      runAttempt: positiveInteger(
        required(values, "run-attempt"),
        "run-attempt",
      ),
    },
  };
}

/**
 * Builds one closed lane receipt from CLI arguments.
 * @param {string[]} argv
 */
export function createLaneReceipt(argv) {
  const values = parseFlags(
    argv,
    new Set([
      "lane",
      "outcome",
      "source-sha",
      "deployed-sha",
      "run-id",
      "run-attempt",
      "started-ms",
      "completed-ms",
      "first-turn-latency-ms",
      "continuity",
      "output-dir",
    ]),
  );
  const lane = laneDefinition(required(values, "lane"));
  const outcome = required(values, "outcome");
  if (!OUTCOMES.has(outcome)) fail("outcome must be success or failure");
  const base = identity(values);
  if (base.sourceSha !== base.deployedSha) {
    fail("the launch gate certifies only a deployed tree equal to its source");
  }
  const startedAtMs = timestamp(required(values, "started-ms"), "started-ms");
  const completedAtMs = timestamp(
    required(values, "completed-ms"),
    "completed-ms",
  );
  if (completedAtMs < startedAtMs) {
    fail("completed-ms must not precede started-ms");
  }

  const metrics = {};
  const latency = values.get("first-turn-latency-ms");
  const continuity = values.get("continuity");
  if (latency !== undefined && lane.id !== "first-turn") {
    fail("first-turn-latency-ms belongs only to the first-turn lane");
  }
  if (continuity !== undefined && lane.id !== "reload") {
    fail("continuity belongs only to the reload lane");
  }
  if (lane.id === "first-turn") {
    if (outcome === "success") {
      metrics.firstTurnLatencyMs = positiveInteger(
        latency,
        "first-turn-latency-ms",
      );
      if (metrics.firstTurnLatencyMs > completedAtMs - startedAtMs) {
        fail("first-turn latency must not exceed the lane duration");
      }
    } else {
      metrics.firstTurnLatencyMs = null;
    }
  }
  if (lane.id === "reload") {
    if (outcome === "success" && continuity !== "verified") {
      fail("a successful reload lane requires continuity verified");
    }
    metrics.continuity = outcome === "success" ? "verified" : "unavailable";
  }

  return {
    schema: LANE_RECEIPT_SCHEMA,
    lane: lane.id,
    owner: lane.owner,
    proves: lane.proves,
    ...base,
    outcome,
    startedAtMs,
    completedAtMs,
    durationMs: completedAtMs - startedAtMs,
    metrics,
  };
}

function readLaneReceipt(file, expected) {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // error-policy:J3 a malformed lane receipt is reported as invalid, never
    // as a pass or an empty lane.
    return { status: "invalid" };
  }
  if (
    parsed?.schema !== LANE_RECEIPT_SCHEMA ||
    !LANE_IDS.has(parsed.lane) ||
    !OUTCOMES.has(parsed.outcome) ||
    parsed.sourceSha !== expected.sourceSha ||
    parsed.deployedSha !== expected.deployedSha ||
    parsed.workflow?.runId !== expected.workflow.runId ||
    parsed.workflow?.runAttempt !== expected.workflow.runAttempt ||
    typeof parsed.startedAtMs !== "number" ||
    typeof parsed.completedAtMs !== "number" ||
    (parsed.outcome === "success" &&
      ((parsed.lane === "first-turn" &&
        typeof parsed.metrics?.firstTurnLatencyMs !== "number") ||
        (parsed.lane === "reload" &&
          typeof parsed.metrics?.continuity !== "string")))
  ) {
    return { status: "invalid" };
  }
  // Downloaded JSON must satisfy the same closed contract as the producer.
  // Identity and a success flag alone do not prove timings or lane metrics.
  try {
    const args = [
      "--lane",
      parsed.lane,
      "--outcome",
      parsed.outcome,
      "--source-sha",
      parsed.sourceSha,
      "--deployed-sha",
      parsed.deployedSha,
      "--run-id",
      String(parsed.workflow.runId),
      "--run-attempt",
      String(parsed.workflow.runAttempt),
      "--started-ms",
      String(parsed.startedAtMs),
      "--completed-ms",
      String(parsed.completedAtMs),
    ];
    if (parsed.lane === "first-turn" && parsed.outcome === "success") {
      args.push(
        "--first-turn-latency-ms",
        String(parsed.metrics?.firstTurnLatencyMs),
      );
    }
    if (parsed.lane === "reload" && parsed.outcome === "success") {
      args.push("--continuity", String(parsed.metrics?.continuity));
    }
    if (!isDeepStrictEqual(parsed, createLaneReceipt(args))) {
      return { status: "invalid" };
    }
  } catch (error) {
    // error-policy:J3 producer-contract failures invalidate the downloaded lane.
    if (!(error instanceof LaunchGateReceiptError)) throw error;
    return { status: "invalid" };
  }
  return { status: parsed.outcome, receipt: parsed };
}

/**
 * Folds lane receipts from `lanesDir` into the composed launch-gate receipt.
 * Missing lanes are `not-run`; foreign or malformed receipts are `invalid`.
 * @param {string[]} argv
 */
export function composeLaunchGateReceipt(argv) {
  const values = parseFlags(
    argv,
    new Set([
      "source-sha",
      "deployed-sha",
      "run-id",
      "run-attempt",
      "preflight",
      "lanes-dir",
      "output",
    ]),
  );
  // A rejected dispatch input never reaches a lane; the composed receipt then
  // records the deployed SHA as unverified instead of echoing the input.
  const unverifiedDeployment = values.get("deployed-sha") === "unverified";
  const expected = identity(
    unverifiedDeployment
      ? new Map([...values, ["deployed-sha", required(values, "source-sha")]])
      : values,
  );
  if (unverifiedDeployment) expected.deployedSha = null;
  const preflight = required(values, "preflight");
  if (!["success", "failure", "cancelled", "skipped"].includes(preflight)) {
    fail("preflight must be a GitHub job result");
  }
  const lanesDir = values.get("lanes-dir") ?? testOutputPath("launch-gate");
  const lanes = LAUNCH_GATE_LANES.map((lane) => {
    const file = path.join(lanesDir, `${lane.id}.json`);
    const read = fs.existsSync(file)
      ? readLaneReceipt(file, expected)
      : { status: "not-run" };
    if (read.receipt && read.receipt.lane !== lane.id) {
      return { lane: lane.id, owner: lane.owner, outcome: "invalid" };
    }
    return {
      lane: lane.id,
      owner: lane.owner,
      outcome: read.status,
      durationMs: read.receipt?.durationMs ?? null,
      metrics: read.receipt?.metrics ?? {},
    };
  });
  const firstUnpassed = lanes.find((lane) => lane.outcome !== "success");
  const passed =
    preflight === "success" && !unverifiedDeployment && !firstUnpassed;
  return {
    schema: LAUNCH_GATE_RECEIPT_SCHEMA,
    environment: "staging",
    ...expected,
    preflight,
    outcome: passed ? "success" : "failure",
    // The first lane that did not pass names the tracker that owns the
    // failure; a failed preflight belongs to the certification epic.
    owningIssue: passed
      ? null
      : preflight !== "success"
        ? "#29922"
        : (firstUnpassed?.owner ?? "#29922"),
    failedLane: passed
      ? null
      : preflight !== "success"
        ? "preflight"
        : (firstUnpassed?.lane ?? null),
    lanes,
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function summaryMarkdown(receipt) {
  const rows = receipt.lanes.map(
    (lane) =>
      `| ${lane.lane} | ${lane.outcome} | ${lane.owner} | ${lane.durationMs ?? "-"} |`,
  );
  return [
    `## Staging launch gate: ${receipt.outcome === "success" ? "PASS" : "FAIL"}`,
    "",
    `- Source SHA: \`${receipt.sourceSha}\``,
    `- Deployed SHA: \`${receipt.deployedSha ?? "unverified"}\``,
    `- Preflight: ${receipt.preflight}`,
    receipt.owningIssue
      ? `- Failed lane: ${receipt.failedLane}; owner: ${receipt.owningIssue}`
      : "- Every lane passed.",
    "",
    "| Lane | Outcome | Owner | Duration (ms) |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "lane") {
    const outputDir =
      parseFlags(
        rest,
        new Set([
          "lane",
          "outcome",
          "source-sha",
          "deployed-sha",
          "run-id",
          "run-attempt",
          "started-ms",
          "completed-ms",
          "first-turn-latency-ms",
          "continuity",
          "output-dir",
        ]),
      ).get("output-dir") ?? testOutputPath("launch-gate");
    const receipt = createLaneReceipt(rest);
    writeJson(path.join(outputDir, `${receipt.lane}.json`), receipt);
    console.log(`[launch-gate-receipt] ${receipt.lane}: ${receipt.outcome}`);
    return;
  }
  if (command === "compose") {
    const values = parseFlags(
      rest,
      new Set([
        "source-sha",
        "deployed-sha",
        "run-id",
        "run-attempt",
        "preflight",
        "lanes-dir",
        "output",
      ]),
    );
    const receipt = composeLaunchGateReceipt(rest);
    const output =
      values.get("output") ??
      testOutputPath("launch-gate", "launch-gate-receipt.json");
    writeJson(output, receipt);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) fs.appendFileSync(summary, summaryMarkdown(receipt));
    console.log(
      `[launch-gate-receipt] launch gate ${receipt.outcome}` +
        (receipt.owningIssue
          ? ` (lane ${receipt.failedLane}, owner ${receipt.owningIssue})`
          : ""),
    );
    if (receipt.outcome !== "success") process.exitCode = 1;
    return;
  }
  fail("usage: launch-gate-receipt.ts lane|compose --name value ...");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    // error-policy:J1 argument validation failures are fatal and never
    // produce a receipt.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
