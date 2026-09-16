/**
 * Exercises real Bun install and postinstall lifecycles using the CI actions'
 * environment, so generic jobs skip native setup and desktop owners enter it.
 * An unsupported probe platform rejects before any host or network mutation.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Step = {
  name?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
};
type Workflow = { jobs: Record<string, { steps: Step[] }> };
type Action = {
  inputs: Record<string, { default: string }>;
  runs: { steps: Step[] };
};
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function readYaml(relativePath: string): Record<string, unknown> {
  return Bun.YAML.parse(
    readFileSync(`${repoRoot}${relativePath}`, "utf8"),
  ) as Record<string, unknown>;
}

// This restricted grammar has the same string truthiness and short-circuit
// behavior in JavaScript and GitHub Actions; other syntax fails explicitly.
function resolveSkip(
  value: string | undefined,
  input: string,
): string | undefined {
  if (value === undefined || !value.startsWith("${{")) return value;
  const parts =
    /^\$\{\{ inputs\.setup-fused-inference (==|!=) 'true' && '([^']*)' \|\| '([^']*)' \}\}$/.exec(
      value,
    );
  if (!parts) throw new Error(`Unsupported setup expression: ${value}`);
  const matches = input.toLowerCase() === "true";
  const condition = parts[1] === "==" ? matches : !matches;
  return (condition && parts[2]) || parts[3];
}

function runLifecycle(
  step: Step,
  input: string,
  command: string[],
  enabled: boolean,
): void {
  const fixture = mkdtempSync(join(tmpdir(), "ci-fused-lifecycle-"));
  try {
    writeFileSync(
      join(fixture, "package.json"),
      JSON.stringify({
        name: "ci-fused-lifecycle-fixture",
        private: true,
        scripts: { postinstall: "bun probe.mjs" },
      }),
    );
    const installer = new URL(
      "../../app-core/scripts/ensure-fused-inference-install.mjs",
      import.meta.url,
    ).href;
    writeFileSync(
      join(fixture, "probe.mjs"),
      `import { ensureFusedInferenceInstall } from ${JSON.stringify(installer)};\nawait ensureFusedInferenceInstall({ platform: "ci-contract" });\n`,
    );
    const env = { ...process.env };
    delete env.ELIZA_SKIP_FUSED_INFERENCE_SETUP;
    const skip = resolveSkip(step.env?.ELIZA_SKIP_FUSED_INFERENCE_SETUP, input);
    if (skip !== undefined) env.ELIZA_SKIP_FUSED_INFERENCE_SETUP = skip;
    const result = spawnSync(process.execPath, command, {
      cwd: fixture,
      env,
      encoding: "utf8",
      timeout: 20_000,
    });
    if (result.error) throw result.error;
    const output = result.stdout + result.stderr;
    if (enabled) {
      expect(result.status).not.toBe(0);
      expect(output).toContain(
        "unsupported desktop platform for fused inference: ci-contract",
      );
    } else {
      expect(result.status).toBe(0);
      expect(output).toContain("skipped by ELIZA_SKIP_FUSED_INFERENCE_SETUP=1");
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function workspaceSetup(workflowPath: string, jobName: string): Step {
  const workflow = readYaml(workflowPath) as Workflow;
  const step = workflow.jobs[jobName]?.steps.find(
    (candidate) => candidate.uses === "./.github/actions/setup-bun-workspace",
  );
  if (!step)
    throw new Error(`${workflowPath}:${jobName} has no workspace setup`);
  return step;
}

function namedStep(
  workflowPath: string,
  jobName: string,
  stepName: string,
): Step {
  const workflow = readYaml(workflowPath) as Workflow;
  const step = workflow.jobs[jobName]?.steps.find(
    (candidate) => candidate.name === stepName,
  );
  if (!step) throw new Error(`${workflowPath}:${jobName} has no ${stepName}`);
  return step;
}

describe("CI fused inference setup ownership", () => {
  const action = readYaml(
    ".github/actions/setup-bun-workspace/action.yml",
  ) as Action;
  for (const [name, command] of [
    ["Install dependencies", ["install"]],
    ["Run repository postinstall", ["run", "postinstall"]],
  ] as const) {
    for (const input of [undefined, "false", "true"]) {
      test(`${name} respects desktop opt-in ${input ?? "default"}`, () => {
        const step = action.runs.steps.find(
          (candidate) => candidate.name === name,
        );
        if (!step) throw new Error(`Missing setup step: ${name}`);
        runLifecycle(
          step,
          input ?? action.inputs["setup-fused-inference"].default,
          [...command],
          input === "true",
        );
      });
    }
  }

  test("cloud setup skips native provisioning during its install lifecycle", () => {
    const cloud = readYaml(
      ".github/actions/cloud-setup-test-env/action.yml",
    ) as Action;
    const install = cloud.runs.steps.find(
      (step) => step.name === "Install dependencies",
    );
    if (!install) throw new Error("Cloud setup has no install step");
    runLifecycle(install, "false", ["install", "--no-save"], false);
  });

  test("desktop artifact owners enter the installer", () => {
    for (const [workflow, job] of [
      [".github/workflows/test.yml", "desktop-contract"],
      [".github/workflows/electrobun-contract.yml", "flatpak-e2e"],
    ]) {
      const input = workspaceSetup(workflow, job).with?.[
        "setup-fused-inference"
      ];
      const install = action.runs.steps.find(
        (step) => step.name === "Install dependencies",
      );
      if (!install) throw new Error("Workspace setup has no install step");
      runLifecycle(
        install,
        input ?? action.inputs["setup-fused-inference"].default,
        ["install"],
        true,
      );
    }
    runLifecycle(
      namedStep(
        ".github/workflows/release-electrobun.yml",
        "build",
        "Run repository postinstall patches",
      ),
      "true",
      ["run", "postinstall"],
      true,
    );
  });
});
