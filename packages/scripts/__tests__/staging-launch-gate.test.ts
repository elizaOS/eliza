/**
 * Exercises the composed staging launch gate (#29922): the real receipt CLI
 * writes closed lane receipts and one composed receipt that names the owning
 * tracker of the first failed lane, and the workflow stays manual-only,
 * least-privilege, SHA-pinned, ordered, and free of input interpolation in
 * shell scripts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  composeLaunchGateReceipt,
  createLaneReceipt,
  LAUNCH_GATE_LANES,
  LaunchGateReceiptError,
} from "../launch-gate-receipt.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cli = resolve(repoRoot, "packages/scripts/launch-gate-receipt.ts");
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "launch-gate-"));
  dirs.push(dir);
  return dir;
}

function identityArgs(sha = SHA): string[] {
  return [
    "--source-sha",
    sha,
    "--deployed-sha",
    sha,
    "--run-id",
    "42",
    "--run-attempt",
    "1",
  ];
}

function writeLane(
  dir: string,
  lane: string,
  outcome: string,
  extra: string[] = [],
) {
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "lane",
      "--lane",
      lane,
      "--outcome",
      outcome,
      ...identityArgs(),
      "--started-ms",
      "1700000000000",
      "--completed-ms",
      "1700000060000",
      "--output-dir",
      dir,
      ...extra,
    ],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(0);
}

function compose(dir: string, preflight = "success") {
  const output = join(dir, "launch-gate-receipt.json");
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "compose",
      ...identityArgs(),
      "--preflight",
      preflight,
      "--lanes-dir",
      dir,
      "--output",
      output,
    ],
    { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } },
  );
  return {
    status: result.status,
    receipt: JSON.parse(readFileSync(output, "utf8")),
  };
}

function writePassingLanes(dir: string) {
  writeLane(dir, "front-door", "success");
  writeLane(dir, "first-turn", "success", ["--first-turn-latency-ms", "4200"]);
  writeLane(dir, "reload", "success", ["--continuity", "verified"]);
  writeLane(dir, "messaging", "success");
  writeLane(dir, "routing", "success");
}

describe("launch-gate receipt CLI", () => {
  test("composes a passing receipt only when every ordered lane passed", () => {
    const dir = tempDir();
    writePassingLanes(dir);
    const { status, receipt } = compose(dir);
    expect(status).toBe(0);
    expect(receipt.outcome).toBe("success");
    expect(receipt.owningIssue).toBeNull();
    expect(receipt.lanes.map((lane: { lane: string }) => lane.lane)).toEqual([
      "front-door",
      "first-turn",
      "reload",
      "messaging",
      "routing",
    ]);
    expect(receipt.lanes[1].metrics).toEqual({ firstTurnLatencyMs: 4200 });
    expect(receipt.lanes[2].metrics).toEqual({ continuity: "verified" });
  });

  test("names the owner of the first failed lane and marks later lanes not-run", () => {
    const dir = tempDir();
    writeLane(dir, "front-door", "success");
    writeLane(dir, "first-turn", "failure");
    const { status, receipt } = compose(dir);
    expect(status).toBe(1);
    expect(receipt.outcome).toBe("failure");
    expect(receipt.failedLane).toBe("first-turn");
    expect(receipt.owningIssue).toBe(
      LAUNCH_GATE_LANES.find((lane) => lane.id === "first-turn")?.owner,
    );
    expect(
      receipt.lanes.slice(2).map((lane: { outcome: string }) => lane.outcome),
    ).toEqual(["not-run", "not-run", "not-run"]);
  });

  test("a failed preflight is owned by the certification epic", () => {
    const dir = tempDir();
    const { status, receipt } = compose(dir, "failure");
    expect(status).toBe(1);
    expect(receipt.failedLane).toBe("preflight");
    expect(receipt.owningIssue).toBe("#29922");
  });

  test("rejects foreign lane receipts instead of counting them", () => {
    const dir = tempDir();
    writePassingLanes(dir);
    const receipt = composeLaunchGateReceipt([
      "--source-sha",
      OTHER,
      "--deployed-sha",
      OTHER,
      "--run-id",
      "42",
      "--run-attempt",
      "1",
      "--preflight",
      "success",
      "--lanes-dir",
      dir,
    ]);
    expect(receipt.outcome).toBe("failure");
    expect(new Set(receipt.lanes.map((lane) => lane.outcome))).toEqual(
      new Set(["invalid"]),
    );
  });

  test("rejects incomplete or altered downloaded receipts before composition", () => {
    const dir = tempDir();
    writePassingLanes(dir);
    const file = join(dir, "first-turn.json");
    const original = JSON.parse(readFileSync(file, "utf8"));
    const malformed = [
      { ...original, metrics: {} },
      { ...original, metrics: { firstTurnLatencyMs: 60_001 } },
      { ...original, metrics: { firstTurnLatencyMs: "4200" } },
      { ...original, startedAtMs: undefined },
      { ...original, startedAtMs: { toString: "invalid" } },
      { ...original, completedAtMs: original.startedAtMs - 1 },
      { ...original, durationMs: 1 },
      { ...original, owner: "#1" },
      { ...original, proves: "unverified assertion" },
      { ...original, extra: "unexpected field" },
      {
        ...original,
        metrics: { firstTurnLatencyMs: 4200, extra: "unexpected field" },
      },
      { ...original, workflow: { ...original.workflow, extra: true } },
    ];
    for (const receipt of malformed) {
      writeFileSync(file, JSON.stringify(receipt));
      const result = compose(dir);
      expect(result.status).toBe(1);
      expect(result.receipt.failedLane).toBe("first-turn");
      expect(result.receipt.lanes[1].outcome).toBe("invalid");
      expect(result.receipt.lanes[1].metrics).toEqual({});
    }
    writeFileSync(file, JSON.stringify(original));
    expect(compose(dir).status).toBe(0);

    const reloadFile = join(dir, "reload.json");
    const reload = JSON.parse(readFileSync(reloadFile, "utf8"));
    writeFileSync(
      reloadFile,
      JSON.stringify({ ...reload, metrics: { continuity: "unavailable" } }),
    );
    expect(compose(dir).receipt.failedLane).toBe("reload");
  });

  test("refuses free text, split trees, and unproven success metrics", () => {
    const base = [
      ...identityArgs(),
      "--started-ms",
      "1700000000000",
      "--completed-ms",
      "1700000060000",
    ];
    expect(() =>
      createLaneReceipt([
        "--lane",
        "routing",
        "--outcome",
        "success",
        "--note",
        "x",
        ...base,
      ]),
    ).toThrow(LaunchGateReceiptError);
    expect(() =>
      createLaneReceipt([
        "--lane",
        "routing",
        "--outcome",
        "success",
        "--source-sha",
        SHA,
        "--deployed-sha",
        OTHER,
        "--run-id",
        "42",
        "--run-attempt",
        "1",
        "--started-ms",
        "1700000000000",
        "--completed-ms",
        "1700000060000",
      ]),
    ).toThrow(/deployed tree equal to its source/);
    expect(() =>
      createLaneReceipt([
        "--lane",
        "first-turn",
        "--outcome",
        "success",
        ...base,
      ]),
    ).toThrow(/first-turn-latency-ms/);
    expect(() =>
      createLaneReceipt(["--lane", "reload", "--outcome", "success", ...base]),
    ).toThrow(/continuity verified/);
  });
});

describe("staging launch-gate workflow contract", () => {
  const source = readFileSync(
    resolve(repoRoot, ".github/workflows/staging-launch-gate.yml"),
    "utf8",
  );
  const workflow = Bun.YAML.parse(source) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<
      string,
      {
        needs?: string | string[];
        environment?: string;
        steps: { uses?: string; run?: string }[];
      }
    >;
  };

  test("is manual-only with read-only token permissions", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  test("orders lanes front door -> first turn/reload -> messaging -> routing", () => {
    const needs = (job: string) => [workflow.jobs[job].needs ?? []].flat();
    expect(needs("front-door")).toEqual(["preflight"]);
    expect(needs("first-turn-and-reload")).toContain("front-door");
    expect(needs("messaging")).toContain("first-turn-and-reload");
    expect(needs("routing")).toContain("messaging");
    expect(needs("compose")).toEqual([
      "preflight",
      "front-door",
      "first-turn-and-reload",
      "messaging",
      "routing",
    ]);
  });

  test("preflight performs no lane work and checks the exact pinned SHA", () => {
    const preflight = workflow.jobs.preflight.steps
      .map((step) => step.run ?? "")
      .join("\n");
    expect(preflight).toContain('"$EXPECTED_DEPLOY_SHA" != "$GITHUB_SHA"');
    expect(preflight).toContain("refs/heads/staging");
    expect(workflow.jobs.preflight.steps.every((step) => !step.uses)).toBe(
      true,
    );
  });

  test("pins every action and never interpolates inputs into shell", () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) {
        if (step.uses && !step.uses.startsWith("./")) {
          expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
        }
        expect(step.run ?? "").not.toContain("${{");
      }
    }
  });
});
