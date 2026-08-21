/**
 * Static invariants for the general runner-farm systemd assets in
 * cloud/runners/. Deterministic file checks only — no host, systemd, or GitHub
 * access. They pin the process-lifetime policy whose regression caused the
 * eliza-robot-20 duplicate-listener diagnostic-page collision (#19708) and
 * keep the repair script shell-valid and scoped to a single slot. Everything
 * observable by running the script lives in runner-farm-repair.test.ts
 * instead; only invariants a source read can settle are asserted here.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const RUNNERS_DIR = join(import.meta.dir, "..", "cloud", "runners");
const UNIT_PATH = join(RUNNERS_DIR, "actions-runner@.service");
const REPAIR_PATH = join(RUNNERS_DIR, "repair-runner-slot.sh");

const unitRaw = readFileSync(UNIT_PATH, "utf8");
const unit = unitRaw
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");
const repair = readFileSync(REPAIR_PATH, "utf8");

describe("canonical actions-runner@.service template", () => {
  test("reaps the full runner cgroup on stop", () => {
    expect(unit).toContain("KillMode=control-group");
    expect(unit).not.toContain("KillMode=process");
  });

  test("is a per-slot template scoped to /opt/actions-runners/runner-<slot>", () => {
    expect(unit).toContain("WorkingDirectory=/opt/actions-runners/runner-%i");
    expect(unit).toContain(
      "ExecStart=/opt/actions-runners/runner-%i/runsvc.sh",
    );
    expect(unit).toContain("User=github-runner");
    expect(unit).toContain("Group=github-runner");
  });

  test("stops gracefully so an in-flight job can finish draining", () => {
    expect(unit).toContain("KillSignal=SIGINT");
    expect(unit).toContain("TimeoutStopSec=5min");
  });
});

describe("repair-runner-slot.sh", () => {
  test("passes bash syntax check", () => {
    const result = spawnSync("bash", ["-n", REPAIR_PATH], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  test("is executable and fails fast", () => {
    expect(statSync(REPAIR_PATH).mode & 0o111).not.toBe(0);
    expect(repair).toContain("set -euo pipefail");
  });

  test("never deletes the colliding diagnostic pages", () => {
    // The behavioral suite proves the timestamped sibling is created; this
    // guards the one idiom no fake host can observe after the fact.
    expect(repair).not.toMatch(/rm\s+-rf?\s+[^\n]*pages/);
  });

  // Asserted against the script with comment lines stripped, so the header
  // prose promising it never touches the fleet gate cannot satisfy the test
  // that enforces it. The needles are the shortest real forms: matching only
  // "HETZNER_FLEET_ONLINE=" would miss a read, and only "gh api" would miss
  // "gh variable set" — the two ways this script could start steering the
  // fleet rather than repairing one slot.
  test("never touches runner labels or the fleet gate", () => {
    const repairCode = repair
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

    expect(repairCode).not.toContain("--labels");
    expect(repairCode).not.toContain("HETZNER_FLEET_ONLINE");
    expect(repairCode).not.toContain("gh api");
    expect(repairCode).not.toContain("gh variable");
  });
});
