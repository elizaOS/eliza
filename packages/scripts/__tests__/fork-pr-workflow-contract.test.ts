/**
 * Guards the fork pull-request CI boundary: outside code stays on disposable
 * runners, receives every distinct validation surface, and does not pay for
 * checks already supplied by canonical CI.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");
const workflow = (name: string): string =>
  readFileSync(join(repositoryRoot, ".github/workflows", name), "utf8");

const trustedPullRequest =
  "github.event.pull_request.head.repo.fork == false && github.actor != 'dependabot[bot]'";
const trustedPullRequestOrPush =
  `github.event_name != 'pull_request' || (${trustedPullRequest})`;

function jobCondition(contents: string, jobName: string): string {
  const lines = contents.split("\n");
  const jobStart = lines.findIndex((line) => line === `  ${jobName}:`);
  expect(jobStart).toBeGreaterThanOrEqual(0);

  for (const line of lines.slice(jobStart + 1)) {
    if (/^  \S/u.test(line)) break;
    const condition = line.match(/^    if: (.+)$/u)?.[1];
    if (condition) return condition;
  }

  throw new Error(`job ${jobName} has no condition`);
}

type WorkflowEvent = {
  eventName: "pull_request" | "push";
  actor: string;
  headRepositoryFork?: boolean;
};

function trustedPullRequestJobRuns(event: WorkflowEvent): boolean {
  return (
    event.eventName === "pull_request" &&
    event.headRepositoryFork === false &&
    event.actor !== "dependabot[bot]"
  );
}

function gitleaksJobRuns(event: WorkflowEvent): boolean {
  return (
    event.eventName !== "pull_request" || trustedPullRequestJobRuns(event)
  );
}

describe("fork pull-request workflow policy", () => {
  test("canonical CI is entirely GitHub-hosted and read-only", () => {
    const canonical = workflow("ci.yml");

    expect(canonical).toContain("permissions:\n  contents: read");
    expect(canonical).not.toContain("self-hosted");
    expect(
      canonical.match(/runs-on: ubuntu-24\.04/g)?.length,
    ).toBeGreaterThanOrEqual(7);
  });

  test("each duplicate develop PR job uses the complete trust predicate", () => {
    const developPr = workflow("develop-pr.yml");

    for (const job of ["lint", "typecheck", "build", "plugin-tests"]) {
      expect(jobCondition(developPr, job)).toBe(trustedPullRequest);
    }
  });

  test("standalone gitleaks uses the same trust boundary and preserves pushes", () => {
    const gitleaks = workflow("gitleaks.yml");

    expect(jobCondition(gitleaks, "gitleaks")).toBe(trustedPullRequestOrPush);
    expect(gitleaks).toContain('push:\n    branches: ["main", "develop"]');
  });

  test("trust truth table separates forks, Dependabot, trusted PRs, and pushes", () => {
    const cases: Array<{
      event: WorkflowEvent;
      developPr: boolean;
      gitleaks: boolean;
    }> = [
      {
        event: {
          eventName: "pull_request",
          actor: "outside-contributor",
          headRepositoryFork: true,
        },
        developPr: false,
        gitleaks: false,
      },
      {
        event: {
          eventName: "pull_request",
          actor: "dependabot[bot]",
          headRepositoryFork: false,
        },
        developPr: false,
        gitleaks: false,
      },
      {
        event: {
          eventName: "pull_request",
          actor: "trusted-contributor",
          headRepositoryFork: false,
        },
        developPr: true,
        gitleaks: true,
      },
      {
        event: { eventName: "push", actor: "maintainer" },
        developPr: false,
        gitleaks: true,
      },
    ];

    for (const scenario of cases) {
      expect(trustedPullRequestJobRuns(scenario.event)).toBe(
        scenario.developPr,
      );
      expect(gitleaksJobRuns(scenario.event)).toBe(scenario.gitleaks);
    }
  });

  test("distinct fork checks remain available", () => {
    for (const name of [
      "cloud-tests.yml",
      "pr.yaml",
      "ui-e2e-gate.yml",
      "ui-fixture-e2e.yml",
    ]) {
      const contents = workflow(name);
      expect(contents).toContain("pull_request:");
      expect(contents).not.toContain(trustedPullRequest);
    }
  });

  test("fork-capable optional fleet jobs fail safe to hosted runners", () => {
    for (const name of ["cloud-tests.yml", "gitleaks.yml", "ui-e2e-gate.yml"]) {
      const contents = workflow(name);
      expect(contents).toContain("vars.HETZNER_FLEET_ONLINE != 'true'");
      expect(contents).not.toContain("vars.HETZNER_FLEET_ONLINE == 'false'");
    }
  });
});
