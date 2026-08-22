#!/usr/bin/env node
/**
 * Builds the root-cause briefing that the CI auto-heal agent reads before it
 * touches a single line of code, and decides whether healing should run at all.
 *
 * The agent is only as good as what it is shown: a raw job log is megabytes of
 * setup noise around a few decisive lines, and a model handed the tail alone
 * will "fix" whatever error happened to be printed last. So this module
 * extracts every error-bearing region of every failed step, keeps them in file
 * order with their surrounding context, and states explicitly what it dropped.
 *
 * It is also the safety interlock. Auto-heal opens pull requests without a
 * human in the loop, so the guards here — heal only branches we own, one open
 * heal per workflow, a hard attempt ceiling — are what stop a wrong diagnosis
 * from becoming an unbounded loop of pull requests. `decide()` is pure and
 * exhaustively unit-tested for that reason; the network layer around it is a
 * thin shell.
 *
 * Consumed by .github/workflows/claude-ci-autoheal.yml.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Branches auto-heal is allowed to act on. */
export const HEALABLE_BASE_BRANCH = "develop";
export const AUTOHEAL_BRANCH_PREFIX = "claude/autoheal/";
export const AUTOHEAL_LABEL = "ci-autoheal";

/** Default ceiling on consecutive heal attempts for one workflow. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Character budget for the log excerpts embedded in the briefing. */
export const DEFAULT_LOG_BUDGET = 120_000;

/**
 * Parses a complete positive safe-integer decimal string. Partial suffixes,
 * signs, fractions, whitespace-only, zero, and non-finite values throw so
 * operator typos cannot silently disable the heal attempt ceiling or empty the
 * log budget (`Number("abc")` is `NaN`, and `attempt > NaN` is always false).
 *
 * @param {string | number | undefined | null} value
 * @param {string} label
 * @returns {number}
 */
export function parsePositiveSafeInteger(value, label) {
  const received =
    typeof value === "number"
      ? JSON.stringify(value)
      : JSON.stringify(String(value ?? ""));
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(
        `${label} must be a positive safe-integer decimal (received ${received})`,
      );
    }
    return value;
  }
  const raw = String(value ?? "");
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${label} must be a positive safe-integer decimal (received ${received})`,
    );
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `${label} must be a positive safe-integer decimal (received ${received})`,
    );
  }
  return parsed;
}

/**
 * Resolve auto-heal attempt ceiling and log budget from env. Unset and empty
 * values keep historical defaults. Explicit overrides fail closed so a typo,
 * including surrounding whitespace, cannot disable the attempt ceiling or
 * empty log excerpts.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {{ maxAttempts: number, logBudget: number }}
 */
export function resolveAutohealPolicy(env = process.env) {
  const maxAttemptsRaw = env.AUTOHEAL_MAX_ATTEMPTS;
  const logBudgetRaw = env.AUTOHEAL_LOG_BUDGET;

  const maxAttempts =
    maxAttemptsRaw == null || maxAttemptsRaw === ""
      ? DEFAULT_MAX_ATTEMPTS
      : parsePositiveSafeInteger(maxAttemptsRaw, "AUTOHEAL_MAX_ATTEMPTS");

  const logBudget =
    logBudgetRaw == null || logBudgetRaw === ""
      ? DEFAULT_LOG_BUDGET
      : parsePositiveSafeInteger(logBudgetRaw, "AUTOHEAL_LOG_BUDGET");

  return { maxAttempts, logBudget };
}

/**
 * Lines that mark the decisive region of a failed step. GitHub's own
 * `##[error]` annotation is the strongest signal; the rest catch the common
 * shapes this repo's toolchain emits (vitest, tsc, biome, bun, node).
 *
 * Deliberately case-sensitive: an insensitive `FAIL` also matches
 * `fail-on-cache-miss: false` in every actions/cache setup dump, which floods
 * the excerpt budget with healthy-run noise (observed live on run 30607730414).
 */
const ERROR_LINE_RE =
  /(##\[error\]|^\s*(error|Error|ERROR|fatal|FATAL|panic)\b|\berror TS\d+\b|\bFAIL\b|\bAssertionError\b|^\s*✗|^\s*×|Traceback \(most recent call last\)|\b[Ee]xit(?:ed)? with (?:code|status) [1-9]|\bnpm ERR!|\bELIFECYCLE\b|\bSegmentation fault\b|^\s*at .*\(.*:\d+:\d+\)\s*$)/;

/**
 * ANSI color/style escapes survive into the raw job log and would otherwise be
 * shipped verbatim to the healing agent; vitest failure blocks are heavy with
 * them.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the ESC byte is the anchor of every ANSI sequence
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Lines of context kept before and after each error hit. */
const CONTEXT_BEFORE = 12;
const CONTEXT_AFTER = 8;

/** Trailing lines always kept, because failures often surface only at the end. */
const TAIL_LINES = 60;

/**
 * Turns a workflow display name into a branch-safe slug. Distinct names must
 * not collide, because the slug is the dedupe key for "is this workflow already
 * being healed".
 */
export function slugifyWorkflow(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!slug) throw new Error(`workflow name produced an empty slug: ${name}`);
  return slug;
}

/** The deterministic heal branch for a workflow. One branch, one open PR. */
export function healBranchFor(workflowName) {
  return `${AUTOHEAL_BRANCH_PREFIX}${slugifyWorkflow(workflowName)}`;
}

/**
 * Strips the ISO-8601 timestamp GitHub prefixes onto every raw log line. The
 * timestamps are pure noise to a reader and consume roughly a fifth of the
 * character budget.
 */
export function stripLogTimestamps(text) {
  return text
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/gm, "")
    .replace(ANSI_ESCAPE_RE, "");
}

/**
 * Selects the decisive regions of a job log: a window around every error-ish
 * line plus the tail, merged in file order and truncated to `budget`.
 *
 * Returns the excerpt along with what was dropped, so the briefing can say
 * "there is more" instead of letting the agent assume it saw everything.
 */
export function excerptFailureLog(rawLog, budget = DEFAULT_LOG_BUDGET) {
  const lines = stripLogTimestamps(rawLog).split("\n");
  const keep = new Set();

  for (const [index, line] of lines.entries()) {
    if (!ERROR_LINE_RE.test(line)) continue;
    const start = Math.max(0, index - CONTEXT_BEFORE);
    const end = Math.min(lines.length - 1, index + CONTEXT_AFTER);
    for (let i = start; i <= end; i += 1) keep.add(i);
  }
  for (
    let i = Math.max(0, lines.length - TAIL_LINES);
    i < lines.length;
    i += 1
  ) {
    keep.add(i);
  }

  const ordered = [...keep].sort((a, b) => a - b);
  const segments = [];
  let previous = -2;
  for (const index of ordered) {
    if (index !== previous + 1) segments.push([]);
    segments.at(-1).push(`${index + 1}\t${lines[index]}`);
    previous = index;
  }

  const rendered = segments.map((segment) => segment.join("\n")).join("\n…\n");
  const truncated = rendered.length > budget;
  return {
    excerpt: truncated
      ? `${rendered.slice(0, budget)}\n…[excerpt truncated]`
      : rendered,
    truncated,
    keptLines: ordered.length,
    totalLines: lines.length,
    matchedErrors: lines.filter((line) => ERROR_LINE_RE.test(line)).length,
  };
}

/**
 * The guard decision. Pure so every refusal path is unit-testable: auto-heal
 * that misfires costs real pull requests and real review attention.
 */
export function decide({
  run,
  openHealPr,
  attempt,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  if (run.status !== "completed") {
    return { proceed: false, reason: `run is ${run.status}, not completed` };
  }
  if (run.conclusion !== "failure") {
    return {
      proceed: false,
      reason: `run concluded ${run.conclusion}, only failure is healed`,
    };
  }
  const onBase = run.head_branch === HEALABLE_BASE_BRANCH;
  const onHealBranch = String(run.head_branch ?? "").startsWith(
    AUTOHEAL_BRANCH_PREFIX,
  );
  if (!onBase && !onHealBranch) {
    return {
      proceed: false,
      reason: `branch ${run.head_branch} is not healable (only ${HEALABLE_BASE_BRANCH} and ${AUTOHEAL_BRANCH_PREFIX}*)`,
    };
  }
  if (attempt > maxAttempts) {
    return {
      proceed: false,
      reason: `attempt ${attempt} exceeds the ceiling of ${maxAttempts}; a human must look at this failure`,
    };
  }
  // A heal PR already open for this workflow means the previous diagnosis is
  // still under review. Opening a second one would race it and split context.
  if (openHealPr && !onHealBranch) {
    return {
      proceed: false,
      reason: `pull request #${openHealPr.number} is already healing this workflow`,
    };
  }
  return { proceed: true, reason: "" };
}

/** Renders the briefing the agent reads. */
export function renderBriefing({
  run,
  failures,
  attempt,
  maxAttempts,
  priorPr,
}) {
  const lines = [
    `# CI failure briefing: ${run.name}`,
    "",
    `- Workflow: **${run.name}** (\`${run.path ?? "unknown"}\`)`,
    `- Run: ${run.html_url} (attempt ${run.run_attempt ?? 1})`,
    `- Branch: \`${run.head_branch}\` at \`${run.head_sha}\``,
    `- Trigger event: \`${run.event}\``,
    `- Heal attempt: ${attempt} of ${maxAttempts}`,
  ];
  if (priorPr) {
    lines.push(
      `- Prior heal attempt: #${priorPr.number} (${priorPr.state}) — read it before repeating a failed diagnosis.`,
    );
  }
  lines.push("", `## Failed jobs (${failures.length})`, "");

  for (const failure of failures) {
    lines.push(
      `### ${failure.jobName}`,
      "",
      `- Job: ${failure.jobUrl}`,
      `- Failed steps: ${failure.failedSteps.length ? failure.failedSteps.join(", ") : "none reported by the API"}`,
    );
    if (failure.log) {
      lines.push(
        `- Log: ${failure.log.keptLines} of ${failure.log.totalLines} lines kept, ${failure.log.matchedErrors} error-matching lines${failure.log.truncated ? ", excerpt truncated" : ""}`,
        "",
        "```text",
        failure.log.excerpt,
        "```",
      );
    } else {
      lines.push("", `- Log unavailable: ${failure.logError}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Network shell
// ---------------------------------------------------------------------------

function requireEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function createClient(token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  return {
    async json(path) {
      const response = await fetch(`https://api.github.com${path}`, {
        headers,
      });
      if (!response.ok) {
        throw new Error(
          `GitHub API ${response.status} for ${path}: ${await response.text()}`,
        );
      }
      return response.json();
    },
    async text(path) {
      const response = await fetch(`https://api.github.com${path}`, {
        headers,
      });
      if (!response.ok)
        throw new Error(`GitHub API ${response.status} for ${path}`);
      return response.text();
    },
  };
}

async function collectFailures(client, repo, runId, budget) {
  const failures = [];
  for (let page = 1; ; page += 1) {
    const payload = await client.json(
      `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}&filter=latest`,
    );
    const jobs = payload.jobs ?? [];
    for (const job of jobs) {
      if (job.conclusion !== "failure") continue;
      const failedSteps = (job.steps ?? [])
        .filter((step) => step.conclusion === "failure")
        .map((step) => step.name);
      let log = null;
      let logError = "";
      try {
        const raw = await client.text(
          `/repos/${repo}/actions/jobs/${job.id}/logs`,
        );
        log = excerptFailureLog(raw, budget);
      } catch (error) {
        // error-policy:J4 a log this agent cannot read is reported as missing in
        // the briefing rather than aborting the heal; the other failed jobs may
        // still carry the decisive evidence.
        logError = error instanceof Error ? error.message : String(error);
      }
      failures.push({
        jobName: job.name,
        jobUrl: job.html_url,
        failedSteps,
        log,
        logError,
      });
    }
    if (jobs.length < 100) return failures;
  }
}

async function findOpenHealPr(client, repo, branch) {
  const owner = repo.split("/")[0];
  const prs = await client.json(
    `/repos/${repo}/pulls?state=open&head=${owner}:${branch}&per_page=1`,
  );
  return prs[0] ?? null;
}

/**
 * Consecutive heal attempts for this workflow: how many heal pull requests
 * (open or closed) already exist for the branch. A merged heal resets nothing
 * on its own — the ceiling exists to stop repeated failed diagnoses, so closed
 * unmerged attempts are what count.
 */
async function countPriorAttempts(client, repo, branch) {
  const owner = repo.split("/")[0];
  const prs = await client.json(
    `/repos/${repo}/pulls?state=all&head=${owner}:${branch}&per_page=100&sort=created&direction=desc`,
  );
  const unmergedFailures = prs.filter(
    (pr) => pr.state === "closed" && !pr.merged_at,
  );
  return { attempts: unmergedFailures.length, latest: prs[0] ?? null };
}

function writeOutputs(outputPath, outputs) {
  if (!outputPath) return;
  const body = Object.entries(outputs)
    .map(([key, value]) => `${key}=${String(value).replace(/\n/g, " ")}`)
    .join("\n");
  appendFileSync(outputPath, `${body}\n`);
}

export async function main(env = process.env) {
  // Fail closed on operator knobs before any GitHub call so a typo cannot open
  // an unbounded heal loop or empty the agent briefing.
  const { maxAttempts, logBudget: budget } = resolveAutohealPolicy(env);
  const repo = requireEnv(env, "GITHUB_REPOSITORY");
  const token = requireEnv(env, "GITHUB_TOKEN");
  const runId = requireEnv(env, "RUN_ID");
  const outDir = env.AUTOHEAL_OUT_DIR ?? ".autoheal";

  const client = createClient(token);
  const run = await client.json(`/repos/${repo}/actions/runs/${runId}`);
  const branch = healBranchFor(run.name);
  const openHealPr = await findOpenHealPr(client, repo, branch);
  const { attempts, latest } = await countPriorAttempts(client, repo, branch);
  const attempt = attempts + 1;

  const decision = decide({ run, openHealPr, attempt, maxAttempts });
  if (!decision.proceed) {
    console.log(`auto-heal skipped: ${decision.reason}`);
    writeOutputs(env.GITHUB_OUTPUT, {
      proceed: "false",
      skip_reason: decision.reason,
      workflow_name: run.name,
      branch,
    });
    return { proceed: false, reason: decision.reason };
  }

  const failures = await collectFailures(client, repo, runId, budget);
  if (failures.length === 0) {
    // A failed run with no failed job means the failure is in the workflow
    // definition or infrastructure, not in a step an agent can read.
    const reason = "run failed but no job reported a failure conclusion";
    console.log(`auto-heal skipped: ${reason}`);
    writeOutputs(env.GITHUB_OUTPUT, {
      proceed: "false",
      skip_reason: reason,
      workflow_name: run.name,
      branch,
    });
    return { proceed: false, reason };
  }

  const briefing = renderBriefing({
    run,
    failures,
    attempt,
    maxAttempts,
    priorPr: latest,
  });
  mkdirSync(outDir, { recursive: true });
  const briefingPath = `${outDir}/briefing.md`;
  writeFileSync(briefingPath, briefing);

  writeOutputs(env.GITHUB_OUTPUT, {
    proceed: "true",
    skip_reason: "",
    workflow_name: run.name,
    workflow_slug: slugifyWorkflow(run.name),
    branch,
    head_sha: run.head_sha,
    head_branch: run.head_branch,
    run_url: run.html_url,
    attempt: String(attempt),
    max_attempts: String(maxAttempts),
    briefing_path: briefingPath,
    failed_job_count: String(failures.length),
  });
  console.log(
    `auto-heal briefing written to ${briefingPath} (${failures.length} failed jobs)`,
  );
  return { proceed: true, briefingPath, failures, briefing };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
