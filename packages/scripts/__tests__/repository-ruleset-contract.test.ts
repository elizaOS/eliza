/** Proves the canonical CI aggregate, no-bypass ruleset manifest, and read-only drift workflow remain one fail-closed repository contract. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");
const ci = Bun.YAML.parse(read(".github/workflows/ci.yml")) as Record<
  string,
  any
>;
const drift = Bun.YAML.parse(
  read(".github/workflows/repository-ruleset-drift.yml"),
) as Record<string, any>;
const manifest = JSON.parse(
  read(".github/rulesets/required-branches.json"),
) as Record<string, any>;
const helper = read("scripts/security/apply-branch-protection.sh");

describe("repository ruleset contract", () => {
  test("publishes one stable fail-closed aggregate for PR and merge candidates", () => {
    expect(ci.on.pull_request).toEqual({
      branches: ["develop", "main"],
      types: [
        "opened",
        "synchronize",
        "reopened",
        "ready_for_review",
        "labeled",
        "unlabeled",
      ],
    });
    expect(ci.on.merge_group).toEqual({ types: ["checks_requested"] });
    expect(ci.jobs.required.name).toBe("All Tests Passed");
    expect(ci.jobs.required.if).toBe("always()");
    expect(ci.jobs.required.needs).toEqual([
      "changes",
      "quality",
      "tests",
      "tests_server",
      "tests_client",
      "tests_plugins",
      "smoke",
      "smoke_lanes",
      "android_aab",
      "secrets",
    ]);
    expect(ci.jobs.required.steps[0].run).toContain(
      'if [ "$result" != "success" ]',
    );
  });

  test("requires the aggregate on main and develop without bypass actors", () => {
    expect(manifest.enforcement).toBe("active");
    expect(manifest.target).toBe("branch");
    expect(manifest.bypass_actors).toEqual([]);
    expect(manifest.conditions.ref_name).toEqual({
      include: ["refs/heads/develop", "refs/heads/main"],
      exclude: [],
    });
    const status = manifest.rules.find(
      (rule: Record<string, any>) => rule.type === "required_status_checks",
    );
    expect(status.parameters).toEqual({
      do_not_enforce_on_create: true,
      required_status_checks: [{ context: "All Tests Passed" }],
      strict_required_status_checks_policy: true,
    });
    expect(
      manifest.rules.map((rule: Record<string, any>) => rule.type),
    ).toEqual(
      expect.arrayContaining([
        "deletion",
        "non_fast_forward",
        "pull_request",
        "required_linear_history",
        "required_signatures",
      ]),
    );
  });

  test("keeps mutation explicit and semantic readback as the default", () => {
    expect(helper).toContain('MODE="check"');
    expect(helper).toContain('--apply) MODE="apply"');
    expect(helper).toContain("repos/$REPO/rulesets");
    expect(helper).not.toContain("/branches/${branch}/protection");
    expect(helper).toContain("repository ruleset drift detected");
  });

  test("runs readback on schedule, manual request, and external dispatch", () => {
    expect(Object.keys(drift.on).sort()).toEqual([
      "repository_dispatch",
      "schedule",
      "workflow_dispatch",
    ]);
    expect(drift.on.repository_dispatch.types).toEqual([
      "repository_ruleset_drift",
    ]);
    expect(drift.permissions).toEqual({ contents: "read" });
    expect(drift.jobs.readback.steps.at(-1).run).toContain("--check");
    expect(drift.jobs.readback.steps.at(-1).run).not.toContain("--apply");
  });
});
