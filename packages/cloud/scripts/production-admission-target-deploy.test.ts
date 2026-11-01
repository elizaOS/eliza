/** The admission Worker's transfer upload plan; runs no Wrangler or Git. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runbookPhases } from "./production-admission-phase-audit.ts";
import { targetDeployPlan } from "./production-admission-target-deploy.ts";

const runbook = readFileSync(
  resolve(import.meta.dirname, "../admission-worker/PRODUCTION-TRANSFER.md"),
  "utf8",
);
const rows = Object.fromEntries(
  runbookPhases(runbook).map((row) => [row.phase, row.commit]),
);
const plan = (phase: string, deploy: boolean, commit = rows[phase]) =>
  targetDeployPlan({
    checkout: "/phase",
    commit: commit ?? "e".repeat(40),
    phase,
    outdir: "/out/bundle",
    deploy,
    runtime: "/bun",
    runbook,
  });

describe("admission Worker transfer uploads", () => {
  test("a phase upload validates, builds and deploys only the admission Worker", () => {
    const commit = rows["target-pending"];
    const wrangler = [
      "/bun",
      "/phase/packages/cloud/api/node_modules/wrangler/bin/wrangler.js",
      "deploy",
      "--config",
      "/phase/packages/cloud/admission-worker/wrangler.toml",
      "--env",
      "production",
    ];
    expect(plan("target-pending", true)).toEqual({
      validate: [
        "/bun",
        "/phase/packages/cloud/admission-worker/verify-staging-contract.ts",
        "--production",
        "--phase",
        "target-pending",
      ],
      dryRun: [...wrangler, "--dry-run", "--outdir", "/out/bundle"],
      deploy: [
        ...wrangler,
        "--var",
        `ELIZA_DEPLOY_COMMIT:${commit}`,
        "--tag",
        commit,
      ],
      cwd: "/phase/packages/cloud/api",
    });
    expect(plan("adopted", true).deploy).toContain(
      `ELIZA_DEPLOY_COMMIT:${rows.adopted}`,
    );
    // R2 is a reviewed reverse commit, not a runbook row.
    expect(plan("reverse-commit", true, "e".repeat(40)).deploy).toContain(
      "e".repeat(40),
    );
  });

  test("the API's phases may build the bundle check but never upload", () => {
    for (const phase of [
      "source-owned",
      "source-commit",
      "reverse-pending",
      "reverse-adopted",
    ]) {
      expect(() => plan(phase, true, "e".repeat(40))).toThrow(
        `${phase} does not upload the admission Worker`,
      );
      expect(plan(phase, false, "e".repeat(40)).deploy).toBeUndefined();
    }
  });

  test("a forward phase uploads only its runbook commit", () => {
    expect(() => plan("target-pending", true, rows.adopted)).toThrow(
      `target-pending deploys only the runbook commit ${rows["target-pending"]}`,
    );
    expect(() => plan("adopted", true, "e".repeat(40))).toThrow(
      "adopted deploys only the runbook commit",
    );
    expect(() => plan("bogus", false)).toThrow("Unknown admission phase");
    expect(() => plan("target-pending", false, "HEAD")).toThrow("full commit");
  });
});
