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
 * ELIZA_DEPLOY_COMMIT and the version tag, and only after a live readback
 * proves the step before it fully rolled out, with the API on `--api-commit`.
 * Phase 1 first runs the audit's before-phase-1 source check on that commit.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  commitFiles,
  liveSourceFacts,
  liveSourceProblems,
  runbookPhases,
  runValidator,
} from "./production-admission-phase-audit.ts";
import {
  type CloudflareRead,
  LIVE_PHASES,
  type LivePhase,
  productionAccount,
  verifyProductionAdmission,
} from "./production-admission-readback.ts";

const RUNBOOK = resolve(
  import.meta.dirname,
  "../admission-worker/PRODUCTION-TRANSFER.md",
);

const FULL_COMMIT = /^[0-9a-f]{40}$/;
const PHASE_ORDER = Object.keys(LIVE_PHASES) as LivePhase[];

/** The live state an upload starts from, and the commit each Worker serves. */
export interface Predecessor {
  phase: LivePhase;
  commits: { api: string; target?: string };
}

/**
 * The commands for one step, in order. `deploy` only when requested, with
 * the predecessor the live state must prove first: the step before it, the
 * API on `apiCommit`, and before phase 3 the target still on phase 1.
 */
export function targetDeployPlan(input: {
  checkout: string;
  commit: string;
  phase: string;
  outdir: string;
  deploy: boolean;
  apiCommit?: string;
  runtime: string;
  runbook: string;
}) {
  const live = LIVE_PHASES[input.phase as LivePhase];
  if (!live) throw new Error(`Unknown admission phase ${input.phase}`);
  if (!FULL_COMMIT.test(input.commit))
    throw new Error("The checkout must be at a full commit");
  let predecessor: Predecessor | undefined;
  if (input.deploy) {
    if (live.deploys !== "target")
      throw new Error(`${input.phase} does not upload the admission Worker`);
    const rows = runbookPhases(input.runbook);
    const row = rows.find(
      (item) => item.phase === input.phase && item.phase !== "source-owned",
    );
    if (row && row.commit !== input.commit)
      throw new Error(
        `${input.phase} deploys only the runbook commit ${row.commit}`,
      );
    if (!input.apiCommit || !FULL_COMMIT.test(input.apiCommit))
      throw new Error(
        "--deploy requires --api-commit, the full commit the API serves now",
      );
    const phase =
      PHASE_ORDER[PHASE_ORDER.indexOf(input.phase as LivePhase) - 1];
    const pending = rows.find((item) => item.phase === "target-pending");
    predecessor = {
      phase,
      commits: {
        api: input.apiCommit,
        ...(phase === "source-commit" ? { target: pending?.commit } : {}),
      },
    };
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
    deploy: predecessor && {
      predecessor,
      command: [
        ...wrangler,
        "--var",
        `ELIZA_DEPLOY_COMMIT:${input.commit}`,
        "--tag",
        input.commit,
      ],
    },
    cwd: api,
  };
}

/**
 * The API commit must be a tree of the predecessor phase. Cloudflare shows
 * `adopted` and `reverse-pending` with the same bindings; only the API's
 * committed declaration tells them apart. The live source predates the
 * production validator, so before phase 1 the API commit must instead pass
 * the audit's before-phase-1 source check against the runbook's chain: phase
 * 1 cannot be undone with these tools.
 */
export function requireApiPhase(predecessor: Predecessor, runbook: string) {
  if (predecessor.phase === "source-owned") {
    const problems = liveSourceProblems(
      liveSourceFacts(runbookPhases(runbook), predecessor.commits.api),
    );
    if (problems.length)
      throw new Error(
        `API commit ${predecessor.commits.api} does not match the phase chain; regenerate it:\n${problems.join("\n")}`,
      );
    return;
  }
  const result = runValidator(commitFiles(predecessor.commits.api), [
    "--production",
    "--phase",
    predecessor.phase,
  ]);
  if (!result.ok)
    throw new Error(
      `API commit ${predecessor.commits.api} is not ${predecessor.phase}: ${result.output}`,
    );
}

/**
 * Uploads only after the live readback proves the predecessor: the step
 * before this one, fully rolled out (one version at 100% on each Worker), on
 * the commits it names. A failed readback uploads nothing.
 */
export async function uploadFromLivePredecessor(
  deploy: { predecessor: Predecessor; command: string[] },
  account: { read: CloudflareRead; api: string; target: string },
  upload: (command: string[]) => void,
) {
  const receipt = await verifyProductionAdmission(account.read, {
    api: account.api,
    target: account.target,
    ...deploy.predecessor,
  });
  upload(deploy.command);
  return receipt;
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
        "api-commit": { type: "string" },
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
    const runbook = readFileSync(RUNBOOK, "utf8");
    const plan = targetDeployPlan({
      checkout,
      commit,
      phase,
      outdir,
      deploy: values.deploy,
      apiCommit: values["api-commit"],
      runtime: process.execPath,
      runbook,
    });
    if (plan.deploy) requireApiPhase(plan.deploy.predecessor, runbook);
    run(plan.validate, checkout);
    run(plan.dryRun, plan.cwd);
    const bundleSHA256 = createHash("sha256")
      .update(readFileSync(join(outdir, "index.js")))
      .digest("hex");
    if (expected && bundleSHA256 !== expected)
      throw new Error(
        `Admission bundle ${bundleSHA256} differs from the expected ${expected}`,
      );
    const predecessor = plan.deploy
      ? await uploadFromLivePredecessor(
          plan.deploy,
          productionAccount(),
          (command) => run(command, plan.cwd),
        )
      : null;
    console.log(
      JSON.stringify({
        phase,
        commit,
        bundleSHA256,
        predecessor,
        deployed: !!plan.deploy,
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
