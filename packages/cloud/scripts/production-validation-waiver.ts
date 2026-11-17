/** One release only: the protected environment binds the final source after review. */
import { execFileSync } from "../../scripts/lib/spawn-sync-captured.ts";
import { canonicalJson } from "../../scripts/develop-impact-evidence.ts";

export const WAIVER_BASELINE = "917d41f57202cf3c02d4024b753afcbfdb9b31a6";
export const WAIVER_RUN = 44023249532;
const ALLOWED_CHANGES = new Set([
  ".github/workflows/cloud-cf-release.yml",
  "packages/cloud/scripts/production-effect-certification.ts",
  "packages/cloud/scripts/production-validation-waiver.ts",
  "packages/cloud/scripts/staging-release-certification.test.ts",
]);
export const WAIVER_JOBS = {
  "133837406902": {
    name: "Exact-input impact plan",
    conclusion: "success",
  },
  "133838131531": {
    name: "ui-core / changes",
    conclusion: "success",
  },
  "133838131565": {
    name: "canonical / Select affected validation",
    conclusion: "success",
  },
  "133838131580": {
    name: "cloud / changes",
    conclusion: "success",
  },
  "133838131679": {
    name: "canonical / Quint (1/4)",
    conclusion: "cancelled",
  },
  "133838131698": {
    name: "canonical / Quint (2/4)",
    conclusion: "cancelled",
  },
  "133838131726": {
    name: "canonical / Quint (4/4)",
    conclusion: "failure",
  },
  "133838131880": {
    name: "canonical / Quint (3/4)",
    conclusion: "cancelled",
  },
  "133838132027": {
    name: "canonical / secret-scan / Commit-range secret scan",
    conclusion: "success",
  },
  "133838133077": {
    name: "cloud / startup-profile",
    conclusion: "skipped",
  },
  "133838484425": {
    name: "cloud / integration-tests",
    conclusion: "success",
  },
  "133838484433": {
    name: "cloud / polyglot-services",
    conclusion: "success",
  },
  "133838484447": {
    name: "cloud / e2e-tests",
    conclusion: "success",
  },
  "133838484517": {
    name: "cloud / lint-and-types",
    conclusion: "success",
  },
  "133838484522": {
    name: "cloud / stack-e2e-tests",
    conclusion: "success",
  },
  "133838485000": {
    name: "cloud / agent-stability / deterministic-keyless",
    conclusion: "success",
  },
  "133838487448": {
    name: "cloud / agent-stability / real-model-mock-services",
    conclusion: "skipped",
  },
  "133838588671": {
    name: "ui-core / fixture-e2e",
    conclusion: "success",
  },
  "133838588718": {
    name: "ui-core / ui-core-fixture-e2e",
    conclusion: "success",
  },
  "133838708414": {
    name: "canonical / Login browser and PostgreSQL integration",
    conclusion: "success",
  },
  "133838708419": {
    name: "canonical / Zero-Key scenario runner",
    conclusion: "success",
  },
  "133838708426": {
    name: "canonical / Agent transport and persistence integration",
    conclusion: "success",
  },
  "133838708473": {
    name: "canonical / Remote capability integration contracts",
    conclusion: "success",
  },
  "133838708515": {
    name: "canonical / Consolidated Frontend Build",
    conclusion: "success",
  },
  "133838708524": {
    name: "canonical / Provider integration (discord)",
    conclusion: "success",
  },
  "133838708541": {
    name: "canonical / Local provisioning and chat contracts",
    conclusion: "success",
  },
  "133838708572": {
    name: "canonical / Zero-Key accounts UI e2e (real API + pool + disk)",
    conclusion: "success",
  },
  "133838708575": {
    name: "canonical / Provider integration (anthropic)",
    conclusion: "success",
  },
  "133838708578": {
    name: "canonical / Provider integration (embeddings)",
    conclusion: "success",
  },
  "133838708587": {
    name: "canonical / Quality",
    conclusion: "success",
  },
  "133838708608": {
    name: "canonical / Provider integration (openai)",
    conclusion: "success",
  },
  "133838709125": {
    name: "canonical / OS verification / Native OTA trust compatibility",
    conclusion: "success",
  },
  "133838709132": {
    name: "canonical / OS verification / verify",
    conclusion: "success",
  },
  "133838709134": {
    name: "canonical / OS verification / ota-publisher",
    conclusion: "success",
  },
  "133849612169": {
    name: "canonical / Complete Quint coverage",
    conclusion: "cancelled",
  },
  "133849613034": {
    name: "canonical / All Tests Passed",
    conclusion: "cancelled",
  },
  "133849614189": {
    name: "Complete manifest",
    conclusion: "cancelled",
  },
  "133849614754": {
    name: "Hand off exact green SHA for durable reconciliation",
    conclusion: "cancelled",
  },
};

export function verifyReleaseWaiver({
  record,
  repository,
  sourceSha,
  treeSha,
  changedPaths,
  run,
  jobs,
  now = new Date(),
}) {
  const fail = (message) => {
    throw new Error(`Production validation waiver rejected: ${message}`);
  };
  const fields = [
    "schema",
    "approval",
    "baselineSha",
    "baselineRunId",
    "baselineRunAttempt",
    "sourceSha",
    "treeSha",
    "issuedAt",
    "expiresAt",
  ];
  if (
    !record ||
    canonicalJson(Object.keys(record).sort()) !==
      canonicalJson(fields.sort()) ||
    record.schema !== "eliza.production-validation-waiver/v1" ||
    record.approval !== "approved"
  )
    fail("record shape");
  if (
    record.baselineSha !== WAIVER_BASELINE ||
    record.baselineRunId !== WAIVER_RUN ||
    record.baselineRunAttempt !== 1 ||
    record.sourceSha !== sourceSha ||
    record.treeSha !== treeSha ||
    !/^[a-f0-9]{40}$/.test(sourceSha) ||
    !/^[a-f0-9]{40}$/.test(treeSha) ||
    sourceSha === WAIVER_BASELINE
  )
    fail("source binding");
  const issued = Date.parse(record.issuedAt),
    expires = Date.parse(record.expiresAt),
    at = now.getTime();
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    issued > at ||
    expires <= at ||
    expires - issued > 24 * 60 * 60 * 1000 ||
    expires <= issued
  )
    fail("expiry");
  if (
    !Array.isArray(changedPaths) ||
    changedPaths.length === 0 ||
    changedPaths.some((path) => !ALLOWED_CHANGES.has(path))
  )
    fail("unreviewed source change");
  if (
    run.repository?.full_name !== repository ||
    run.id !== WAIVER_RUN ||
    run.run_attempt !== 1 ||
    run.head_sha !== WAIVER_BASELINE ||
    run.head_branch !== "main" ||
    run.path !== ".github/workflows/develop-full.yml" ||
    !["push", "workflow_dispatch"].includes(run.event) ||
    run.status !== "completed" ||
    run.conclusion !== "cancelled"
  )
    fail("baseline run");
  if (!Array.isArray(jobs) || jobs.length !== Object.keys(WAIVER_JOBS).length)
    fail("job inventory");
  const observed = {};
  for (const job of jobs) {
    if (observed[job.id] || job.status !== "completed")
      fail("duplicate or active job");
    observed[job.id] = { name: job.name, conclusion: job.conclusion };
  }
  if (canonicalJson(observed) !== canonicalJson(WAIVER_JOBS))
    fail("job results changed");
  return {
    validationKind: "owner-waiver",
    sourceSha,
    treeSha,
    baselineSourceSha: WAIVER_BASELINE,
    runId: WAIVER_RUN,
    runAttempt: 1,
    waivedJobs: jobs
      .filter((job) => job.conclusion !== "success")
      .map((job) => ({
        id: job.id,
        name: job.name,
        conclusion: job.conclusion,
      })),
    expiresAt: record.expiresAt,
  };
}

export function verifyFinalWaiverJobs(jobs) {
  const permitted = new Map(
    Object.values(WAIVER_JOBS).map((job) => [job.name, job.conclusion]),
  );
  const seen = new Set();
  for (const job of jobs) {
    if (seen.has(job.name) || job.status !== "completed")
      throw Error("Final waiver validation is active or ambiguous");
    seen.add(job.name);
    if (
      job.conclusion !== "success" &&
      job.conclusion !== permitted.get(job.name)
    )
      throw Error("Final waiver has a new nonwaived failure");
  }
}

export async function requireReleaseWaiver({
  api,
  repository,
  sourceSha,
  repoRoot,
  record,
  now = new Date(),
}) {
  const git = (args) =>
    execFileSync("git", ["--no-replace-objects", "-C", repoRoot, ...args], {
      encoding: "utf8",
      timeout: 30000,
    }).trim();
  // Artifact-only deployment checkouts contain the release commit, but may omit
  // its parent. Fetch only the fixed reviewed baseline before comparing trees.
  try {
    git(["cat-file", "-e", `${WAIVER_BASELINE}^{commit}`]);
  } catch {
    git(["fetch", "--no-tags", "--depth=1", "origin", WAIVER_BASELINE]);
    git(["cat-file", "-e", `${WAIVER_BASELINE}^{commit}`]);
  }
  const treeSha = git(["rev-parse", `${sourceSha}^{tree}`]);
  const changedPaths = git([
    "diff",
    "--name-only",
    WAIVER_BASELINE,
    sourceSha,
    "--",
  ])
    .split("\n")
    .filter(Boolean);
  const read = async () => {
    const run = await api.request("GET", `/actions/runs/${WAIVER_RUN}`);
    const inventory = await api.request(
      "GET",
      `/actions/workflows/develop-full.yml/runs?branch=main&head_sha=${WAIVER_BASELINE}&per_page=100`,
    );
    if (
      !Array.isArray(inventory.workflow_runs) ||
      inventory.total_count !== inventory.workflow_runs.length ||
      inventory.workflow_runs.length !== 1 ||
      inventory.workflow_runs[0].id !== WAIVER_RUN ||
      inventory.workflow_runs[0].run_attempt !== 1
    )
      throw Error("Production waiver baseline run was replaced or rerun");
    const result = await api.request(
      "GET",
      `/actions/runs/${WAIVER_RUN}/attempts/1/jobs?per_page=100`,
    );
    if (
      !Array.isArray(result.jobs) ||
      result.total_count !== result.jobs.length
    )
      throw Error("Production waiver job inventory is incomplete");
    return verifyReleaseWaiver({
      record,
      repository,
      sourceSha,
      treeSha,
      changedPaths,
      run,
      jobs: result.jobs,
      now,
    });
  };
  const proof = await read();
  // A final-source Full run may exist but cannot be active while production mutates.
  const readFinal = async () => {
    const current = await api.request(
      "GET",
      `/actions/workflows/develop-full.yml/runs?branch=main&head_sha=${sourceSha}&per_page=100`,
    );
    if (
      !Array.isArray(current.workflow_runs) ||
      current.total_count !== current.workflow_runs.length ||
      current.workflow_runs.length >= 100 ||
      current.workflow_runs.some(
        (run) =>
          run.status !== "completed" ||
          run.head_sha !== sourceSha ||
          run.head_branch !== "main",
      )
    )
      throw Error(
        "Production waiver final-source validation is active or ambiguous",
      );
    for (const run of current.workflow_runs) {
      const result = await api.request(
        "GET",
        `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
      );
      if (
        !Array.isArray(result.jobs) ||
        result.total_count !== result.jobs.length
      )
        throw Error("Final waiver job inventory is incomplete");
      verifyFinalWaiverJobs(result.jobs);
    }
    return current;
  };
  const finalRuns = await readFinal();
  if (canonicalJson(await read()) !== canonicalJson(proof))
    throw Error("Production waiver changed during admission");
  if (canonicalJson(await readFinal()) !== canonicalJson(finalRuns))
    throw Error("Final waiver validation changed during admission");
  return proof;
}
