/**
 * Static invariants for the general runner-farm systemd assets in
 * cloud/runners/. Deterministic file checks only — no host, systemd, or GitHub
 * access. They pin the process-lifetime policy whose regression caused the
 * eliza-robot-20 duplicate-listener diagnostic-page collision (#19708) and
 * keep the repair script shell-valid and scoped to a single slot.
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

  test("prod-ops hardened unit keeps the same reap policy", () => {
    const prodOps = readFileSync(
      join(
        import.meta.dir,
        "..",
        "cloud",
        "terraform",
        "hetzner",
        "prod-ops",
        "cloud-init",
        "bootstrap.yaml.tftpl",
      ),
      "utf8",
    );
    expect(prodOps).toContain("KillMode=control-group");
    expect(prodOps).not.toContain("KillMode=process");
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

  test("is dry-run by default and mutates only behind --apply", () => {
    expect(repair).toContain('= "--apply" ] && apply=true');
    expect(repair).toContain("DRY-RUN");
  });

  test("preserves the colliding diagnostic pages instead of deleting them", () => {
    expect(repair).toContain("pages.issue-19708-");
    expect(repair).not.toMatch(/rm\s+-rf?\s+[^\n]*pages/);
  });

  test("verifies exactly one listener owns the slot after repair", () => {
    expect(repair).toContain("expected exactly one listener");
  });

  test("never touches runner labels or the fleet gate", () => {
    expect(repair).not.toContain("--labels");
    expect(repair).not.toContain("HETZNER_FLEET_ONLINE=");
    expect(repair).not.toContain("gh api");
  });
});
