/**
 * The packaged macOS smoke step is advisory (`continue-on-error: true`) while
 * the Linux and Windows packaged smokes fail the job. That asymmetry made the
 * macOS diagnostics upload unreachable for the only failure it exists to
 * capture: `continue-on-error` keeps `failure()` false, so a condition on
 * `failure()` alone could fire only when some *other* step failed.
 *
 * These pin the wiring, not the gating decision: if the smoke test is ever made
 * to fail the job, `failure()` covers it and these assertions still hold.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const workflow = Bun.YAML.parse(
  readFileSync(
    join(repoRoot, ".github", "workflows", "release-electrobun.yml"),
    "utf8",
  ),
) as {
  jobs: Record<
    string,
    {
      steps?: {
        name?: string;
        id?: string;
        if?: string;
        "continue-on-error"?: unknown;
      }[];
    }
  >;
};

const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
const byName = (name: string) => {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step)
    throw new Error(`step "${name}" is missing from release-electrobun.yml`);
  return step;
};

const SMOKE_ID = "macos-packaged-smoke";
const smoke = byName("Smoke test packaged macOS app");
const upload = byName("Upload macOS smoke diagnostics");

describe("packaged macOS smoke diagnostics stay reachable", () => {
  test("the smoke step keeps a referable id", () => {
    expect(smoke.id).toBe(SMOKE_ID);
  });

  test("the diagnostics upload keys off the smoke step's own outcome", () => {
    const condition = String(upload.if ?? "").replace(/\s+/g, " ");
    expect(condition).toContain(`steps.${SMOKE_ID}.outcome == 'failure'`);
  });

  test("an advisory smoke failure is reported rather than silent", () => {
    const report = byName("Report advisory macOS smoke failure");
    expect(String(report.if ?? "").replace(/\s+/g, " ")).toContain(
      `steps.${SMOKE_ID}.outcome == 'failure'`,
    );
  });

  test("the Linux and Windows packaged smokes still fail the job", () => {
    for (const name of [
      "Smoke test packaged Linux desktop",
      "Smoke test packaged Windows app",
    ]) {
      expect(byName(name)["continue-on-error"], name).toBeUndefined();
    }
  });
});
