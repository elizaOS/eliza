import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// GitHub compiles the full workflow_call graph before evaluating any job
// `if`, and refuses the run at startup when a nested job requests a
// GITHUB_TOKEN permission its caller chain does not grant. That validation
// is static and transitive, so a permission added deep inside a reusable
// workflow silently breaks every caller — develop CI startup-failed on every
// push when device-e2e.yml's schedule-only notifier gained
// actions:read/issues:write (#22527) and canonical ci.yml still granted its
// device caller only the workflow default. This suite replays the same
// validation over every local workflow_call chain so the break surfaces in
// a test run instead of on the next push to develop.

const WORKFLOWS_DIR = join(import.meta.dir, "../../..", ".github", "workflows");

type Permissions = Record<string, string>;

interface WorkflowJob {
  if?: string;
  permissions?: Permissions | string;
  uses?: string;
}

interface Workflow {
  permissions?: Permissions | string;
  jobs?: Record<string, WorkflowJob>;
}

const workflows = new Map<string, Workflow>();
for (const entry of readdirSync(WORKFLOWS_DIR)) {
  if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
  const parsed = Bun.YAML.parse(
    readFileSync(join(WORKFLOWS_DIR, entry), "utf8"),
  );
  if (parsed && typeof parsed === "object") {
    workflows.set(entry, parsed as Workflow);
  }
}

/** Normalize `read-all` / `write-all` shorthands into scoped maps. */
function normalize(
  perms: Permissions | string | undefined,
): Permissions | undefined {
  if (perms === undefined) return undefined;
  if (perms === "read-all") return { "*": "read" };
  if (perms === "write-all") return { "*": "write" };
  if (typeof perms === "string") return {};
  return perms;
}

function rank(level: string | undefined): number {
  if (level === "write") return 2;
  if (level === "read") return 1;
  return 0;
}

function covers(granted: Permissions, scope: string, level: string): boolean {
  return rank(granted[scope] ?? granted["*"]) >= rank(level);
}

function calleeFile(uses: string): string | undefined {
  const match = uses.match(/^\.\/\.github\/workflows\/([^@]+)$/);
  return match?.[1];
}

/**
 * Walk one called workflow with the permissions its caller job granted,
 * collecting every nested request the grant does not cover. `granted` is
 * undefined when no caller in the chain restricted the token, in which case
 * the default token applies and validation cannot fail.
 */
function checkCalledWorkflow(
  file: string,
  granted: Permissions | undefined,
  chain: string[],
  violations: string[],
  depth: number,
): void {
  // GitHub allows four levels of nesting; a longer chain means a cycle.
  expect(depth).toBeLessThanOrEqual(4);
  const workflow = workflows.get(file);
  if (!workflow)
    throw new Error(`${chain.join(" -> ")} calls missing workflow ${file}`);
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    const requested =
      normalize(job.permissions) ?? normalize(workflow.permissions);
    if (granted && requested) {
      for (const [scope, level] of Object.entries(requested)) {
        if (!covers(granted, scope, level)) {
          violations.push(
            `${chain.join(" -> ")} grants '${scope}: ${
              granted[scope] ?? granted["*"] ?? "none"
            }' but ${file} job '${jobName}' requests '${scope}: ${level}'`,
          );
        }
      }
    }
    const nested = job.uses ? calleeFile(job.uses) : undefined;
    if (nested) {
      checkCalledWorkflow(
        nested,
        requested ?? granted,
        [...chain, `${file}#${jobName}`],
        violations,
        depth + 1,
      );
    }
  }
}

describe("workflow_call permission validation (static, transitive)", () => {
  test("every local workflow_call chain grants what its nested jobs request", () => {
    const violations: string[] = [];
    let chains = 0;
    for (const [file, workflow] of workflows) {
      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        const callee = job.uses ? calleeFile(job.uses) : undefined;
        if (!callee) continue;
        chains += 1;
        const granted =
          normalize(job.permissions) ?? normalize(workflow.permissions);
        checkCalledWorkflow(
          callee,
          granted,
          [`${file}#${jobName}`],
          violations,
          1,
        );
      }
    }
    // The repo currently has local workflow_call chains; a zero count means
    // this suite stopped seeing them and needs its discovery fixed.
    expect(chains).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
