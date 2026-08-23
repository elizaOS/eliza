/** Verifies the read-only platform smoke workflow remains callable, manually dispatchable, and cross-platform. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(
  new URL("../../../.github/workflows/platform-smoke.yml", import.meta.url),
);
const workflowSource = readFileSync(workflowPath, "utf8");
type SourceShaInput = {
  description?: string;
  required?: boolean;
  type?: string;
  default?: string;
};
const workflow = Bun.YAML.parse(workflowSource) as {
  "run-name"?: string;
  on?: {
    workflow_call?: { inputs?: Record<string, SourceShaInput> };
    workflow_dispatch?: {
      inputs?: Record<string, SourceShaInput>;
    };
  };
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      environment?: unknown;
      permissions?: Record<string, string>;
      secrets?: unknown;
      strategy?: { matrix?: { os?: string[] } };
      "runs-on"?: string;
      steps?: Array<{
        name?: string;
        uses?: string;
        if?: string;
        env?: Record<string, string>;
        run?: string;
        with?: Record<string, unknown>;
      }>;
    }
  >;
};

const platformJob = workflow.jobs?.["platform-smoke"];
const steps = platformJob?.steps ?? [];

describe("Platform Smoke workflow", () => {
  test("exposes only reusable and manual entry points with read-only contents", () => {
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual([
      "workflow_call",
      "workflow_dispatch",
    ]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.on?.workflow_call?.inputs ?? {})).toEqual([
      "source_sha",
    ]);
    expect(Object.keys(workflow.on?.workflow_dispatch?.inputs ?? {})).toEqual([
      "source_sha",
    ]);
    expect(workflow.on?.workflow_call?.inputs?.source_sha).toEqual({
      description: "Optional exact commit SHA for a trusted caller",
      required: false,
      type: "string",
      default: "",
    });
    expect(workflow.on?.workflow_dispatch?.inputs?.source_sha).toEqual({
      description: "Exact 40-character commit SHA to validate",
      required: true,
      type: "string",
    });
  });

  test("keeps one secretless, deployment-free cross-platform job", () => {
    expect(Object.keys(workflow.jobs ?? {})).toEqual(["platform-smoke"]);
    expect(platformJob?.strategy?.matrix?.os).toEqual([
      "macos-15",
      "windows-2025",
    ]);
    expect(platformJob?.["runs-on"]).toBe("$" + "{{ matrix.os }}");
    expect(platformJob?.permissions).toBeUndefined();
    expect(platformJob?.environment).toBeUndefined();
    expect(platformJob?.secrets).toBeUndefined();
    expect(workflowSource).not.toMatch(/\bsecrets\s*(?:[:.]|\[)/);
  });

  test("dispatches the trusted definition and checks out only the exact SHA", () => {
    const expectedRef = "$" + "{{ inputs.source_sha || github.sha }}";
    expect(workflow["run-name"]).toBe(`Platform Smoke (${expectedRef})`);
    const validation = steps.find(
      (step) => step.name === "Validate manual source request",
    );
    expect(validation?.if).toBe("inputs.source_sha != ''");
    expect(validation?.env).toEqual({
      SOURCE_SHA: "$" + "{{ inputs.source_sha }}",
    });
    expect(validation?.run).toContain(
      '[ "$GITHUB_REF" != "refs/heads/develop" ]',
    );
    expect(validation?.run).toContain("^[0-9a-f]{40}$");

    const checkout = steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with).toEqual({
      ref: expectedRef,
      "fetch-depth": 1,
      "persist-credentials": false,
      submodules: false,
    });

    const verification = steps.find(
      (step) => step.name === "Verify exact source checkout",
    );
    expect(verification?.env).toEqual({ EXPECTED_SHA: expectedRef });
    expect(verification?.run).toContain("git rev-parse HEAD");
    expect(verification?.run).toContain('[ "$actual_sha" != "$EXPECTED_SHA" ]');
    expect(verification?.run).toContain("$GITHUB_STEP_SUMMARY");
  });

  test("preserves the focused watchdog and core commands", () => {
    expect(steps.map((step) => step.name ?? step.uses?.split("@")[0])).toEqual([
      "Validate manual source request",
      "actions/checkout",
      "Verify exact source checkout",
      "oven-sh/setup-bun",
      "actions/setup-node",
      "Run batch watchdog process-tree self-test",
      "Install dependencies",
      "Build core",
      "Run core tests",
    ]);
    const namedCommands = Object.fromEntries(
      steps
        .filter((step) => step.name && step.run)
        .map((step) => [step.name, step.run]),
    );
    expect(Object.keys(namedCommands)).toEqual([
      "Validate manual source request",
      "Verify exact source checkout",
      "Run batch watchdog process-tree self-test",
      "Install dependencies",
      "Build core",
      "Run core tests",
    ]);
    expect(namedCommands).toMatchObject({
      "Run batch watchdog process-tree self-test":
        "node packages/scripts/test-cloud-run-watchdog.self-test.mjs",
      "Install dependencies": "bun install --frozen-lockfile --ignore-scripts",
      "Build core": "bun run build:core",
      "Run core tests": "bun run test:core",
    });
  });
});
