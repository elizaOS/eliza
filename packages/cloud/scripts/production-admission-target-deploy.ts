/**
 * Root's only path for the admission Worker's transfer uploads: phase 1
 * (`target-pending`), phase 3 (`adopted`) and reverse R2 (`reverse-commit`).
 * It also builds the gate 2 bundle check from the phase 2 `main` commit.
 *
 * Run it with Bun from the reviewed tip, against a clean checkout of the
 * step's commit with built workspace dependencies. It runs that tree's
 * validator for the phase, then builds the admission Worker with that tree's
 * Wrangler. Every Wrangler call names the admission configuration, so it can
 * never deploy the API. The bundle must match `--bundle-sha256`, the phase 1
 * bundle. Only `--deploy` uploads, publishing the commit as
 * ELIZA_DEPLOY_COMMIT and the version tag.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runbookPhases } from "./production-admission-phase-audit.ts";
import {
  LIVE_PHASES,
  type LivePhase,
} from "./production-admission-readback.ts";

const RUNBOOK = resolve(
  import.meta.dirname,
  "../admission-worker/PRODUCTION-TRANSFER.md",
);

/** The commands for one step, in order; `deploy` only when requested. */
export function targetDeployPlan(input: {
  checkout: string;
  commit: string;
  phase: string;
  outdir: string;
  deploy: boolean;
  runtime: string;
  runbook: string;
}) {
  const live = LIVE_PHASES[input.phase as LivePhase];
  if (!live) throw new Error(`Unknown admission phase ${input.phase}`);
  if (!/^[0-9a-f]{40}$/.test(input.commit))
    throw new Error("The checkout must be at a full commit");
  if (input.deploy) {
    if (live.deploys !== "target")
      throw new Error(`${input.phase} does not upload the admission Worker`);
    const row = runbookPhases(input.runbook).find(
      (item) => item.phase === input.phase && item.phase !== "source-owned",
    );
    if (row && row.commit !== input.commit)
      throw new Error(
        `${input.phase} deploys only the runbook commit ${row.commit}`,
      );
  }
  const checkout = resolve(input.checkout);
  const api = join(checkout, "packages/cloud/api");
  const wrangler = [
    input.runtime,
    join(api, "node_modules/wrangler/bin/wrangler.js"),
    "deploy",
    "--config",
    join(checkout, "packages/cloud/admission-worker/wrangler.toml"),
    "--env",
    "production",
  ];
  return {
    validate: [
      input.runtime,
      join(
        checkout,
        "packages/cloud/admission-worker/verify-staging-contract.ts",
      ),
      "--production",
      "--phase",
      input.phase,
    ],
    dryRun: [...wrangler, "--dry-run", "--outdir", resolve(input.outdir)],
    deploy: input.deploy
      ? [
          ...wrangler,
          "--var",
          `ELIZA_DEPLOY_COMMIT:${input.commit}`,
          "--tag",
          input.commit,
        ]
      : undefined,
    cwd: api,
  };
}

function run(command: string[], cwd: string, capture = false) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : ["ignore", "inherit", "inherit"],
  });
  if (result.status !== 0)
    throw new Error(
      `${command.slice(1, 3).join(" ")} failed (exit ${result.status})`,
    );
  return result.stdout?.trim() ?? "";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { values } = parseArgs({
      options: {
        checkout: { type: "string" },
        phase: { type: "string" },
        outdir: { type: "string" },
        "bundle-sha256": { type: "string" },
        deploy: { type: "boolean", default: false },
      },
    });
    const { checkout, phase, outdir } = values;
    const expected = values["bundle-sha256"];
    if (!checkout || !phase || !outdir)
      throw new Error("Pass --checkout, --phase and --outdir");
    if (existsSync(outdir))
      throw new Error("--outdir must not exist yet, so no old bundle is read");
    if (expected !== undefined && !/^[0-9a-f]{64}$/.test(expected))
      throw new Error("--bundle-sha256 must be a SHA-256 hex digest");
    if (values.deploy && !expected)
      throw new Error("--deploy requires the expected --bundle-sha256");
    const commit = run(["git", "rev-parse", "HEAD"], checkout, true);
    if (
      run(
        ["git", "status", "--porcelain", "--untracked-files=no"],
        checkout,
        true,
      )
    )
      throw new Error("The checkout has uncommitted changes");
    const plan = targetDeployPlan({
      checkout,
      commit,
      phase,
      outdir,
      deploy: values.deploy,
      runtime: process.execPath,
      runbook: readFileSync(RUNBOOK, "utf8"),
    });
    run(plan.validate, checkout);
    run(plan.dryRun, plan.cwd);
    const bundleSHA256 = createHash("sha256")
      .update(readFileSync(join(outdir, "index.js")))
      .digest("hex");
    if (expected && bundleSHA256 !== expected)
      throw new Error(
        `Admission bundle ${bundleSHA256} differs from the expected ${expected}`,
      );
    if (plan.deploy) run(plan.deploy, plan.cwd);
    console.log(
      JSON.stringify({ phase, commit, bundleSHA256, deployed: !!plan.deploy }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
