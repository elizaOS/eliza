import { readFileSync } from "node:fs";

type Step = {
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
};

type Job = {
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  steps?: unknown;
};

type Run = {
  databaseId?: unknown;
  event?: unknown;
  status?: unknown;
  conclusion?: unknown;
  jobs?: unknown;
};

type Failure = {
  path: string;
  message: string;
};

const OBSERVED_EVENTS = new Set(["workflow_dispatch", "schedule"]);

const REQUIRED_JOBS = [
  {
    name: "Cloud Live E2E (Eliza Cloud)",
    steps: [
      "Remote capability cloud sandbox live smoke",
      "Validate remote capability cloud live report",
      "Upload remote capability cloud live report",
    ],
  },
  {
    name: "Remote Capability Provider Live E2E",
    steps: [
      "Remote capability URL-backed provider live smoke",
      "Validate remote capability provider live reports",
      "Upload remote capability provider live report",
    ],
  },
] as const;

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const source =
    options.path === "-"
      ? readFileSync(0, "utf8")
      : readFileSync(options.path, "utf8");
  const failures = validateGithubLiveEvidence(parseRun(source, options.path), {
    allowUnobserved: options.allowUnobserved,
  });
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`${failure.path}: ${failure.message}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("Capability-router GitHub live evidence validated.");
}

export function validateGithubLiveEvidence(
  run: Run,
  options: { allowUnobserved?: boolean } = {},
): Failure[] {
  const failures: Failure[] = [];
  const event = requireString(run.event, "event", failures);
  const runId = optionalDisplay(run.databaseId) ?? "<run>";
  if (!OBSERVED_EVENTS.has(event)) {
    if (!options.allowUnobserved) {
      failures.push({
        path: String(runId),
        message:
          "run event must be workflow_dispatch or schedule to prove live artifacts.",
      });
    }
    return failures;
  }
  requireEqual(run.status, "completed", "status", failures);
  requireEqual(run.conclusion, "success", "conclusion", failures);

  const jobs = Array.isArray(run.jobs) ? (run.jobs as Job[]) : [];
  if (jobs.length === 0) {
    failures.push({ path: String(runId), message: "jobs must be non-empty." });
    return failures;
  }

  for (const requiredJob of REQUIRED_JOBS) {
    const job = jobs.find((candidate) => candidate.name === requiredJob.name);
    if (!job) {
      failures.push({
        path: `${runId}.${requiredJob.name}`,
        message: "required live job is missing.",
      });
      continue;
    }
    requireEqual(
      job.status,
      "completed",
      `${runId}.${requiredJob.name}.status`,
      failures,
    );
    requireEqual(
      job.conclusion,
      "success",
      `${runId}.${requiredJob.name}.conclusion`,
      failures,
    );
    const steps = Array.isArray(job.steps) ? (job.steps as Step[]) : [];
    for (const stepName of requiredJob.steps) {
      const step = steps.find((candidate) => candidate.name === stepName);
      if (!step) {
        failures.push({
          path: `${runId}.${requiredJob.name}.${stepName}`,
          message: "required live evidence step is missing.",
        });
        continue;
      }
      requireEqual(
        step.status,
        "completed",
        `${runId}.${requiredJob.name}.${stepName}.status`,
        failures,
      );
      requireEqual(
        step.conclusion,
        "success",
        `${runId}.${requiredJob.name}.${stepName}.conclusion`,
        failures,
      );
    }
  }

  return failures;
}

function parseArgs(args: string[]): { allowUnobserved: boolean; path: string } {
  let allowUnobserved = false;
  let path: string | undefined;
  for (const arg of args) {
    if (arg === "--allow-unobserved") {
      allowUnobserved = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (path) throw new Error("Only one run JSON path may be provided.");
    path = arg;
  }
  if (!path) {
    throw new Error(
      "Usage: bun packages/scripts/validate-capability-router-github-live-evidence.ts [--allow-unobserved] <run-json|- >",
    );
  }
  return { allowUnobserved, path };
}

function parseRun(source: string, path: string): Run {
  try {
    const parsed = JSON.parse(source) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("run JSON must be an object.");
    }
    return parsed as Run;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${path}: invalid JSON: ${error.message}`);
    }
    throw error;
  }
}

function requireString(
  value: unknown,
  path: string,
  failures: Failure[],
): string {
  if (typeof value !== "string" || value.length === 0) {
    failures.push({ path, message: "must be a non-empty string." });
    return "";
  }
  return value;
}

function requireEqual(
  value: unknown,
  expected: string,
  path: string,
  failures: Failure[],
): void {
  if (value !== expected) {
    failures.push({ path, message: `must be "${expected}".` });
  }
}

function optionalDisplay(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

if (import.meta.main) {
  main();
}
