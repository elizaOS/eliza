/** Verifies the read-only workflow used to obtain staging identity receipts. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

interface Step {
  "continue-on-error"?: boolean | string;
  env?: Record<string, string>;
  if?: boolean | string;
  name?: string;
  run?: string;
  shell?: string;
  uses?: string;
  with?: Record<string, string | number | boolean>;
  "working-directory"?: string;
}

interface Workflow {
  name: string;
  on: {
    workflow_dispatch: {
      inputs: Record<
        string,
        { description: string; required: boolean; type: string }
      >;
    };
  };
  permissions: Record<string, string>;
  jobs: {
    admission: {
      "continue-on-error"?: boolean | string;
      env?: Record<string, string>;
      environment?: string;
      "runs-on": string;
      steps: Step[];
      "timeout-minutes": number;
    };
    report: {
      "continue-on-error"?: boolean | string;
      concurrency: { group: string; "cancel-in-progress": boolean };
      env: Record<string, string>;
      environment: string;
      if: string;
      needs: string;
      "runs-on": string;
      steps: Step[];
      "timeout-minutes": number;
    };
  };
}

const repoRoot = resolve(import.meta.dirname, "../../../..");
const workflowPath = resolve(
  repoRoot,
  ".github/workflows/database-identity-staging-report.yml",
);
const workflowSource = readFileSync(workflowPath, "utf8");
const railwayGuide = readFileSync(
  resolve(repoRoot, "packages/cloud/infra/cloud/RAILWAY.md"),
  "utf8",
);
const workflow = parse(workflowSource) as Workflow;
const admission = workflow.jobs.admission;
const job = workflow.jobs.report;

function expression(body: string): string {
  return ["$", "{{ ", body, " }}"].join("");
}

const EXPECTED_WORKFLOW: Workflow = {
  name: "Database identity staging report",
  on: {
    workflow_dispatch: {
      inputs: {
        expected_cloud_commit: {
          description: "Exact 40-character develop commit to inspect",
          required: true,
          type: "string",
        },
      },
    },
  },
  permissions: { contents: "read" },
  jobs: {
    admission: {
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 2,
      steps: [
        {
          name: "Reject untrusted source",
          env: {
            EXPECTED_COMMIT: expression("inputs.expected_cloud_commit"),
            CHECKED_OUT_COMMIT: expression("github.sha"),
            SOURCE_REF: expression("github.ref"),
          },
          shell: "bash",
          run: [
            "set -euo pipefail",
            'if [[ "$SOURCE_REF" != "refs/heads/develop" ]]; then',
            '  echo "::error::database identity report requires the trusted develop source"',
            "  exit 1",
            "fi",
            'if [[ ! "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] || [[ "$EXPECTED_COMMIT" != "$CHECKED_OUT_COMMIT" ]]; then',
            '  echo "::error::database identity report requires the exact checked-out commit"',
            "  exit 1",
            "fi",
            "",
          ].join("\n"),
        },
      ],
    },
    report: {
      needs: "admission",
      if: "needs.admission.result == 'success' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/develop'",
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 10,
      environment: "staging",
      concurrency: {
        group: "database-identity-staging-report",
        "cancel-in-progress": false,
      },
      env: {
        DATABASE_IDENTITY_GATE_MODE: "report",
        DATABASE_IDENTITY_ENVIRONMENT: "staging",
      },
      steps: [
        {
          name: "Checkout exact workflow commit",
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          with: {
            "fetch-depth": 1,
            submodules: false,
            "persist-credentials": false,
          },
        },
        {
          name: "Setup Bun workspace",
          uses: "./.github/actions/setup-bun-workspace",
          with: {
            "bun-version": "1.3.14",
            "setup-python": "false",
            "install-protoc": "false",
            "install-native-deps": "false",
            "run-postinstall": "false",
          },
        },
        {
          name: "Build required linked runtime",
          run: [
            "bun run --cwd packages/prompts build:package",
            "bun run --cwd packages/shared build",
            "bun run --cwd packages/core build",
            "",
          ].join("\n"),
        },
        {
          name: "Probe fixed runtime dependencies",
          run: "bun run packages/cloud/scripts/admin/preflight-database-identity.ts --probe-dependencies",
        },
        {
          name: "Validate identity reporter contracts",
          run: "bun test packages/cloud/scripts/admin/preflight-database-identity.test.ts packages/cloud/scripts/admin/database-identity-staging-report-workflow.test.ts",
        },
        {
          name: "Emit redacted staging identity receipts",
          env: {
            DATABASE_URL: expression("secrets.DATABASE_URL"),
          },
          run: "bun run packages/cloud/scripts/admin/preflight-database-identity.ts",
        },
      ],
    },
  },
};

function expressionBodyReferencesSecretsContext(body: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < body.length; ) {
    const character = body[index];
    if (quote) {
      if (character === quote) {
        if (quote === "'" && body[index + 1] === "'") {
          index += 2;
          continue;
        }
        quote = undefined;
      }
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      index += 1;
      continue;
    }
    if (!character || !/[A-Za-z_]/.test(character)) {
      index += 1;
      continue;
    }

    let identifierEnd = index + 1;
    while (
      identifierEnd < body.length &&
      /[A-Za-z0-9_]/.test(body[identifierEnd] ?? "")
    ) {
      identifierEnd += 1;
    }
    let previousIndex = index - 1;
    while (previousIndex >= 0 && /\s/.test(body[previousIndex] ?? "")) {
      previousIndex -= 1;
    }
    if (
      body.slice(index, identifierEnd).toLowerCase() === "secrets" &&
      body[previousIndex] !== "."
    ) {
      return true;
    }
    index = identifierEnd;
  }
  return false;
}

function referencesSecretsContext(value: string): boolean {
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const expressionStart = value.indexOf("${{", searchFrom);
    if (expressionStart === -1) return false;

    const bodyStart = expressionStart + 3;
    let quote: "'" | '"' | undefined;
    let expressionEnd = bodyStart;
    for (; expressionEnd < value.length; expressionEnd += 1) {
      const character = value[expressionEnd];
      if (quote) {
        if (character === quote) {
          if (quote === "'" && value[expressionEnd + 1] === "'") {
            expressionEnd += 1;
            continue;
          }
          quote = undefined;
        }
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        continue;
      }
      if (character === "}" && value[expressionEnd + 1] === "}") break;
    }

    if (expressionEnd >= value.length) return false;
    if (
      expressionBodyReferencesSecretsContext(
        value.slice(bodyStart, expressionEnd),
      )
    ) {
      return true;
    }
    searchFrom = expressionEnd + 2;
  }
  return false;
}

function assertExactWorkflowContract(candidate: Workflow): void {
  expect(candidate).toStrictEqual(EXPECTED_WORKFLOW);
}

function sensitiveDatabaseUrlPaths(root: unknown): {
  databaseUrlKeys: string[];
  secretReferences: string[];
} {
  const databaseUrlKeys: string[] = [];
  const secretReferences: string[] = [];

  function visit(
    value: unknown,
    path: string,
    ancestors: ReadonlySet<object>,
  ): void {
    if (typeof value === "string" && referencesSecretsContext(value)) {
      secretReferences.push(path);
    }
    if (value === null || typeof value !== "object") return;
    if (ancestors.has(value)) throw new Error(`Cyclic YAML alias at ${path}`);

    const branchAncestors = new Set(ancestors);
    branchAncestors.add(value);
    if (Array.isArray(value)) {
      value.forEach((child, index) => {
        visit(child, `${path}[${index}]`, branchAncestors);
      });
      return;
    }

    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const childPath = `${path}.${key}`;
      if (key === "DATABASE_URL") databaseUrlKeys.push(childPath);
      visit(child, childPath, branchAncestors);
    }
  }

  visit(root, "$", new Set());
  return { databaseUrlKeys, secretReferences };
}

function assertFinalReporterSecretReferenceScope(candidate: Workflow): void {
  const candidateJob = candidate.jobs.report;
  const reporterIndexes = candidateJob.steps.flatMap((step, index) =>
    step.name === "Emit redacted staging identity receipts" ? [index] : [],
  );
  if (
    reporterIndexes.length !== 1 ||
    reporterIndexes[0] !== candidateJob.steps.length - 1
  ) {
    throw new Error(
      "The database identity reporter must be the unique final step",
    );
  }

  const reporterIndex = reporterIndexes[0];
  if (reporterIndex === undefined) throw new Error("Missing reporter step");
  const reporter = candidateJob.steps[reporterIndex];
  if (!reporter) throw new Error("Missing reporter step");
  if (
    !reporter.env ||
    Object.keys(reporter.env).length !== 1 ||
    reporter.env?.DATABASE_URL !== expression("secrets.DATABASE_URL") ||
    reporter["continue-on-error"] !== undefined ||
    reporter.if !== undefined ||
    reporter.shell !== undefined
  ) {
    throw new Error("The final reporter step does not fail closed");
  }

  const expectedPath = `$.jobs.report.steps[${reporterIndex}].env.DATABASE_URL`;
  const observedPaths = sensitiveDatabaseUrlPaths(candidate);
  if (
    JSON.stringify(observedPaths.databaseUrlKeys) !==
      JSON.stringify([expectedPath]) ||
    JSON.stringify(observedPaths.secretReferences) !==
      JSON.stringify([expectedPath])
  ) {
    throw new Error(
      "Declared secret references must be limited to the final reporter DATABASE_URL",
    );
  }
}

function reportStep(name: string): Step {
  const value = job.steps.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`Missing workflow step: ${name}`);
  return value;
}

function admissionStep(name: string): Step {
  const value = admission.steps.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`Missing admission step: ${name}`);
  return value;
}

describe("database identity staging report workflow", () => {
  test("does not overstate source review or Environment approval", () => {
    for (const source of [workflowSource, railwayGuide]) {
      expect(source).not.toContain("exact reviewed develop SHA");
      expect(source).not.toContain("staging Environment approval");
    }
    expect(workflowSource).toContain("it does not prove reviewer approval");
    expect(railwayGuide).toMatch(
      /proves neither human review nor Environment\s+reviewer approval/,
    );
  });

  test("pins the complete parsed workflow execution envelope", () => {
    expect(() => assertExactWorkflowContract(workflow)).not.toThrow();
  });

  test("rejects inherited and local execution-envelope overrides", () => {
    const prerequisite = (candidate: Workflow): Step => {
      const step = candidate.jobs.report.steps.find(
        (value) => value.name === "Build required linked runtime",
      );
      if (!step) throw new Error("Missing prerequisite step");
      return step;
    };
    const reporter = (candidate: Workflow): Step => {
      const step = candidate.jobs.report.steps.find(
        (value) => value.name === "Emit redacted staging identity receipts",
      );
      if (!step) throw new Error("Missing reporter step");
      return step;
    };
    const mutations: Array<{
      mutate: (candidate: Workflow) => void;
      name: string;
    }> = [
      {
        name: "workflow environment",
        mutate: (candidate) => {
          (candidate as unknown as Record<string, unknown>).env = {
            BASH_ENV: "/tmp/untrusted-profile",
          };
        },
      },
      {
        name: "workflow run defaults",
        mutate: (candidate) => {
          (candidate as unknown as Record<string, unknown>).defaults = {
            run: { shell: "bash", "working-directory": "/tmp" },
          };
        },
      },
      {
        name: "report job run defaults",
        mutate: (candidate) => {
          (
            candidate.jobs.report as unknown as Record<string, unknown>
          ).defaults = {
            run: { shell: "bash", "working-directory": "/tmp" },
          };
        },
      },
      {
        name: "report job container",
        mutate: (candidate) => {
          (
            candidate.jobs.report as unknown as Record<string, unknown>
          ).container = "ubuntu:latest";
        },
      },
      {
        name: "report job services",
        mutate: (candidate) => {
          (
            candidate.jobs.report as unknown as Record<string, unknown>
          ).services = { postgres: { image: "postgres:latest" } };
        },
      },
      {
        name: "report job strategy matrix",
        mutate: (candidate) => {
          (
            candidate.jobs.report as unknown as Record<string, unknown>
          ).strategy = { matrix: { shard: [1, 2] } };
        },
      },
      {
        name: "report job PATH override",
        mutate: (candidate) => {
          candidate.jobs.report.env.PATH = "/tmp/bin";
        },
      },
      {
        name: "report job expected digest override",
        mutate: (candidate) => {
          candidate.jobs.report.env.DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256 =
            "0".repeat(64);
        },
      },
      {
        name: "reporter working directory",
        mutate: (candidate) => {
          reporter(candidate)["working-directory"] = "/tmp";
        },
      },
      {
        name: "prerequisite condition",
        mutate: (candidate) => {
          prerequisite(candidate).if = expression("always()");
        },
      },
      {
        name: "prerequisite shell",
        mutate: (candidate) => {
          prerequisite(candidate).shell = "bash";
        },
      },
      {
        name: "prerequisite working directory",
        mutate: (candidate) => {
          prerequisite(candidate)["working-directory"] = "/tmp";
        },
      },
      {
        name: "prerequisite environment",
        mutate: (candidate) => {
          prerequisite(candidate).env = { BASH_ENV: "/tmp/profile" };
        },
      },
      {
        name: "prerequisite continue-on-error",
        mutate: (candidate) => {
          prerequisite(candidate)["continue-on-error"] = true;
        },
      },
      {
        name: "commented prerequisite command",
        mutate: (candidate) => {
          const step = prerequisite(candidate);
          step.run = `${step.run ?? ""}# no-op\n`;
        },
      },
    ];

    for (const mutation of mutations) {
      const candidate = structuredClone(workflow);
      mutation.mutate(candidate);
      expect(
        () => assertExactWorkflowContract(candidate),
        mutation.name,
      ).toThrow();
    }
  });

  test("admits only manual develop runs before attaching staging", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs).sort()).toEqual(["admission", "report"]);
    expect(admission["continue-on-error"]).toBeUndefined();
    expect(admission.environment).toBeUndefined();
    expect(admission.env).toBeUndefined();
    expect(admission["runs-on"]).toBe("ubuntu-24.04");
    expect(admission["timeout-minutes"]).toBe(2);
    expect(job.needs).toBe("admission");
    expect(job["continue-on-error"]).toBeUndefined();
    expect(job.if).toBe(
      "needs.admission.result == 'success' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/develop'",
    );
    expect(job.environment).toBe("staging");
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job["timeout-minutes"]).toBe(10);
    expect(job.concurrency).toEqual({
      group: "database-identity-staging-report",
      "cancel-in-progress": false,
    });
    for (const [jobName, steps] of [
      ["admission", admission.steps],
      ["report", job.steps],
    ] as const) {
      for (const step of steps) {
        expect(
          step["continue-on-error"],
          `${jobName} step ${step.name ?? "<unnamed>"}`,
        ).toBeUndefined();
      }
    }
  });

  test("keeps direct DATABASE_URL injection out of earlier step environments", () => {
    expect(job.env).not.toHaveProperty("DATABASE_URL");
    expect(job.env.DATABASE_IDENTITY_GATE_MODE).toBe("report");
    expect(job.env.DATABASE_IDENTITY_ENVIRONMENT).toBe("staging");
    expect(job.env).not.toHaveProperty(
      "DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256",
    );
    expect(job.env).not.toHaveProperty(
      "DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256",
    );

    const reporterIndexes = job.steps.flatMap((candidate, index) =>
      candidate.name === "Emit redacted staging identity receipts"
        ? [index]
        : [],
    );
    expect(reporterIndexes).toEqual([job.steps.length - 1]);
    const reporterIndex = reporterIndexes[0];
    if (reporterIndex === undefined) throw new Error("Missing reporter step");
    const reporter = job.steps[reporterIndex];
    if (!reporter) throw new Error("Missing reporter step");
    // This proves declared workflow scoping, not isolation from malicious code
    // in earlier steps. Those steps share the mutable job and remain part of
    // the operator-confirmed source and external admission trusted computing
    // base; this step-level assertion proves neither review nor isolation.
    for (const earlierStep of job.steps.slice(0, reporterIndex)) {
      expect(earlierStep.env).not.toHaveProperty("DATABASE_URL");
    }
    expect(reporter.env).toEqual({
      DATABASE_URL: expression("secrets.DATABASE_URL"),
    });
    expect(reporter["continue-on-error"]).toBeUndefined();
    expect(reporter.if).toBeUndefined();
    expect(reporter.shell).toBeUndefined();

    const expectedPath = `$.jobs.report.steps[${reporterIndex}].env.DATABASE_URL`;
    expect(sensitiveDatabaseUrlPaths(workflow)).toEqual({
      databaseUrlKeys: [expectedPath],
      secretReferences: [expectedPath],
    });
    expect(() =>
      assertFinalReporterSecretReferenceScope(workflow),
    ).not.toThrow();
  });

  test("does not collapse aliased sensitive scopes during validation", () => {
    const aliased = parse(
      [
        "steps:",
        "  - &reporter",
        "    name: Emit redacted staging identity receipts",
        "    env:",
        `      DATABASE_URL: ${expression("secrets.DATABASE_URL")}`,
        "  - *reporter",
      ].join("\n"),
    ) as { steps: Step[] };

    expect(aliased.steps[0]).toBe(aliased.steps[1]);
    expect(sensitiveDatabaseUrlPaths(aliased)).toEqual({
      databaseUrlKeys: [
        "$.steps[0].env.DATABASE_URL",
        "$.steps[1].env.DATABASE_URL",
      ],
      secretReferences: [
        "$.steps[0].env.DATABASE_URL",
        "$.steps[1].env.DATABASE_URL",
      ],
    });
  });

  test("detects sensitive keys and references across every workflow scope", () => {
    const misplaced = {
      env: {
        DATABASE_URL: expression("env.INDIRECT_DATABASE_URL"),
        INDIRECT_DATABASE_URL: expression("secrets.DATABASE_URL"),
      },
      jobs: {
        report: {
          container: {
            env: {
              DATABASE_URL: expression("secrets.DATABASE_URL"),
            },
            volumes: [expression("secrets.DATABASE_URL")],
          },
          env: {
            DATABASE_URL: expression("env.INDIRECT_DATABASE_URL"),
          },
          services: {
            postgres: {
              env: {
                DATABASE_URL: expression(`secrets["DATABASE_URL"]`),
              },
            },
          },
          steps: [
            {
              with: {
                connection: expression("secrets.DATABASE_URL"),
              },
            },
          ],
        },
      },
    };

    expect(sensitiveDatabaseUrlPaths(misplaced)).toEqual({
      databaseUrlKeys: [
        "$.env.DATABASE_URL",
        "$.jobs.report.container.env.DATABASE_URL",
        "$.jobs.report.env.DATABASE_URL",
        "$.jobs.report.services.postgres.env.DATABASE_URL",
      ],
      secretReferences: [
        "$.env.INDIRECT_DATABASE_URL",
        "$.jobs.report.container.env.DATABASE_URL",
        "$.jobs.report.container.volumes[0]",
        "$.jobs.report.services.postgres.env.DATABASE_URL",
        "$.jobs.report.steps[0].with.connection",
      ],
    });
  });

  test("ignores benign secrets prose outside a context reference", () => {
    const benign = {
      env: {
        DESCRIPTION: "no secrets are accessed",
        QUOTED_EXPRESSION: expression("'no secrets are accessed'"),
        QUOTED_DELIMITERS: expression("'no secrets }} are accessed'"),
      },
      run: "echo no secrets are accessed",
    };

    expect(sensitiveDatabaseUrlPaths(benign)).toEqual({
      databaseUrlKeys: [],
      secretReferences: [],
    });
  });

  test("rejects dynamic, whole-context, and aliased secret references", () => {
    const mutations: Array<{
      mutate: (candidate: Workflow) => void;
      name: string;
    }> = [
      {
        name: "dynamic env-name index",
        mutate: (candidate) => {
          candidate.jobs.admission.env = {
            INDIRECT_SECRET: expression("secrets[env.SECRET_NAME]"),
          };
        },
      },
      {
        name: "formatted dynamic index",
        mutate: (candidate) => {
          candidate.jobs.report.env.INDIRECT_SECRET = expression(
            "secrets[format('{0}', env.SECRET_NAME)]",
          );
        },
      },
      {
        name: "whole secrets context",
        mutate: (candidate) => {
          const checkout = candidate.jobs.report.steps[0];
          if (!checkout) throw new Error("Missing checkout step");
          checkout.with = {
            ...checkout.with,
            "secret-context": expression("toJSON(secrets)"),
          };
        },
      },
      {
        name: "quoted closing delimiters before a secrets reference",
        mutate: (candidate) => {
          candidate.jobs.admission.env = {
            INDIRECT_SECRET: expression(
              "contains('}}', '}}') && secrets.DATABASE_URL",
            ),
          };
        },
      },
      {
        name: "aliased alternate step path",
        mutate: (candidate) => {
          const alias: Step = {
            name: "Aliased secret consumer",
            env: {
              INDIRECT_SECRET: expression("secrets[env.SECRET_NAME]"),
            },
          };
          candidate.jobs.report.steps.splice(1, 0, alias, alias);
        },
      },
    ];

    for (const mutation of mutations) {
      const candidate = structuredClone(workflow);
      mutation.mutate(candidate);
      expect(
        () => assertFinalReporterSecretReferenceScope(candidate),
        mutation.name,
      ).toThrow(
        "Declared secret references must be limited to the final reporter DATABASE_URL",
      );
    }
  });

  test("rejects reporter conditions that can bypass earlier step failures", () => {
    for (const condition of ["always()", "failure()", "cancelled()"] as const) {
      const candidate = structuredClone(workflow);
      const reporter = candidate.jobs.report.steps.find(
        (step) => step.name === "Emit redacted staging identity receipts",
      );
      if (!reporter) throw new Error("Missing reporter step");
      reporter.if = expression(condition);

      expect(
        () => assertFinalReporterSecretReferenceScope(candidate),
        condition,
      ).toThrow("The final reporter step does not fail closed");
    }
  });

  test("rejects reporter environment and shell overrides", () => {
    const mutations: Array<{
      mutate: (reporter: Step) => void;
      name: string;
    }> = [
      {
        name: "gate mode off",
        mutate: (reporter) => {
          if (!reporter.env) throw new Error("Missing reporter environment");
          reporter.env.DATABASE_IDENTITY_GATE_MODE = "off";
        },
      },
      {
        name: "identity environment override",
        mutate: (reporter) => {
          if (!reporter.env) throw new Error("Missing reporter environment");
          reporter.env.DATABASE_IDENTITY_ENVIRONMENT = "production";
        },
      },
      {
        name: "shell override",
        mutate: (reporter) => {
          reporter.shell = "bash";
        },
      },
    ];

    for (const mutation of mutations) {
      const candidate = structuredClone(workflow);
      const reporter = candidate.jobs.report.steps.find(
        (step) => step.name === "Emit redacted staging identity receipts",
      );
      if (!reporter) throw new Error("Missing reporter step");
      mutation.mutate(reporter);

      expect(
        () => assertFinalReporterSecretReferenceScope(candidate),
        mutation.name,
      ).toThrow("The final reporter step does not fail closed");
    }
  });

  test("rejects an untrusted ref or commit without attaching staging", () => {
    const guard = admissionStep("Reject untrusted source");
    expect(guard["continue-on-error"]).toBeUndefined();
    expect(guard.shell).toBe("bash");
    expect(guard.env?.EXPECTED_COMMIT).toBe(
      expression("inputs.expected_cloud_commit"),
    );
    expect(guard.env?.CHECKED_OUT_COMMIT).toBe(expression("github.sha"));
    expect(guard.env?.SOURCE_REF).toBe(expression("github.ref"));
    expect(guard.run).toContain('"refs/heads/develop"');
    expect(guard.run).toContain('"$EXPECTED_COMMIT" != "$CHECKED_OUT_COMMIT"');
    expect(guard.run).toContain("^[0-9a-f]{40}$");
    expect(guard.run).not.toContain("secrets.");

    const trustedCommit = "a".repeat(40);
    const cases = [
      {
        name: "trusted exact develop commit",
        expectedExit: 0,
        expectedCommit: trustedCommit,
        checkedOutCommit: trustedCommit,
        sourceRef: "refs/heads/develop",
      },
      {
        name: "wrong source ref",
        expectedExit: 1,
        expectedCommit: trustedCommit,
        checkedOutCommit: trustedCommit,
        sourceRef: "refs/heads/feature",
      },
      {
        name: "malformed expected commit",
        expectedExit: 1,
        expectedCommit: "deadbeef",
        checkedOutCommit: trustedCommit,
        sourceRef: "refs/heads/develop",
      },
      {
        name: "mismatched checked-out commit",
        expectedExit: 1,
        expectedCommit: trustedCommit,
        checkedOutCommit: "b".repeat(40),
        sourceRef: "refs/heads/develop",
      },
    ] as const;

    for (const scenario of cases) {
      const result = Bun.spawnSync(["/bin/bash", "-c", guard.run ?? ""], {
        env: {
          CHECKED_OUT_COMMIT: scenario.checkedOutCommit,
          EXPECTED_COMMIT: scenario.expectedCommit,
          SOURCE_REF: scenario.sourceRef,
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(result.exitCode, scenario.name).toBe(scenario.expectedExit);
      expect(result.stderr.toString(), scenario.name).toBe("");
      expect(result.stdout.toString(), scenario.name).not.toMatch(
        /[0-9a-f]{40}/,
      );
    }
  });

  test("runs only contract checks and the read-only reporter", () => {
    const setup = reportStep("Setup Bun workspace");
    expect(setup.uses).toBe("./.github/actions/setup-bun-workspace");
    expect(setup.with).toMatchObject({
      "bun-version": "1.3.14",
      "setup-python": "false",
      "install-protoc": "false",
      "install-native-deps": "false",
      "run-postinstall": "false",
    });
    const linkedBuild = reportStep("Build required linked runtime").run;
    expect(linkedBuild).toContain(
      "bun run --cwd packages/prompts build:package",
    );
    expect(linkedBuild).toContain("bun run --cwd packages/shared build");
    expect(linkedBuild).toContain("bun run --cwd packages/core build");
    expect(reportStep("Probe fixed runtime dependencies").run).toBe(
      "bun run packages/cloud/scripts/admin/preflight-database-identity.ts --probe-dependencies",
    );
    const buildIndex = job.steps.findIndex(
      (candidate) => candidate.name === "Build required linked runtime",
    );
    const probeIndex = job.steps.findIndex(
      (candidate) => candidate.name === "Probe fixed runtime dependencies",
    );
    const reporterIndex = job.steps.findIndex(
      (candidate) =>
        candidate.name === "Emit redacted staging identity receipts",
    );
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(probeIndex).toBeGreaterThan(buildIndex);
    expect(reporterIndex).toBeGreaterThan(probeIndex);
    expect(reportStep("Validate identity reporter contracts").run).toContain(
      "preflight-database-identity.test.ts",
    );
    expect(reportStep("Emit redacted staging identity receipts").run).toBe(
      "bun run packages/cloud/scripts/admin/preflight-database-identity.ts",
    );
  });
});
