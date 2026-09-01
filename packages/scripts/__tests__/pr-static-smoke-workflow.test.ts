/** Verifies PR admission combines source contracts, affected static checks, billing replay, and Windows security. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listPackages } from "../lib/workspaces.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const source = readFileSync(
  join(repoRoot, ".github/workflows/pr-static-smoke.yml"),
  "utf8",
);
const workflowReadme = readFileSync(
  join(repoRoot, ".github/workflows/README.md"),
  "utf8",
);
const workflow = Bun.YAML.parse(source) as {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<
    string,
    {
      name?: string;
      uses?: string;
      "runs-on"?: string;
      needs?: string[];
      steps?: Array<{
        id?: string;
        name?: string;
        env?: Record<string, string>;
        run?: string;
      }>;
    }
  >;
};

function splitWords(value: string | undefined): string[] {
  return value?.trim().split(/\s+/).filter(Boolean) ?? [];
}

function workspaceClosure(seedDirs: readonly string[]): Set<string> {
  const workspaces = listPackages({ repoRoot });
  const byName = new Map(
    workspaces
      .filter(
        (workspace): workspace is typeof workspace & { name: string } =>
          typeof workspace.name === "string" && workspace.name.length > 0,
      )
      .map((workspace) => [workspace.name, workspace]),
  );
  const seeds = workspaces.filter(({ dir }) => seedDirs.includes(dir));
  expect(seeds.map(({ dir }) => dir).sort()).toEqual([...seedDirs].sort());

  const closure = new Set<string>();
  const pending = seeds.map(({ name }) => name);
  while (pending.length > 0) {
    const name = pending.pop();
    if (!name) continue;
    const workspace = byName.get(name);
    if (!workspace || closure.has(workspace.dir)) continue;
    closure.add(workspace.dir);
    for (const dependency of Object.keys({
      ...workspace.packageJson.dependencies,
      ...workspace.packageJson.optionalDependencies,
      ...workspace.packageJson.peerDependencies,
    })) {
      if (byName.has(dependency)) pending.push(dependency);
    }
  }
  return closure;
}

describe("PR Static Smoke workflow", () => {
  test("owns cancelable source, billing replay, and Windows lanes behind the stable admission context", () => {
    expect(workflow.concurrency?.group).toContain(
      "github.event.pull_request.number",
    );
    expect(workflow.concurrency?.["cancel-in-progress"]).toBeTrue();
    expect(Object.keys(workflow.jobs ?? {})).toEqual([
      "source-smoke",
      "billing-payment-replay-e2e",
      "browser-bridge-windows-security",
      "static-smoke",
    ]);
    expect(workflow.jobs?.["browser-bridge-windows-security"]?.uses).toBe(
      "./.github/workflows/browser-bridge-windows-security.yml",
    );
    expect(workflow.jobs?.["static-smoke"]?.needs).toEqual([
      "source-smoke",
      "browser-bridge-windows-security",
      "billing-payment-replay-e2e",
    ]);
    expect(workflow.jobs?.["static-smoke"]?.name).toBe("All Tests Passed");
  });

  test("runs billing replay in parallel and fails closed over its contract surface", () => {
    const billingJob = workflow.jobs?.["billing-payment-replay-e2e"];
    expect(billingJob?.needs).toBeUndefined();

    const workspaceSeeds = splitWords(
      billingJob?.env?.BILLING_REPLAY_WORKSPACE_SEEDS,
    );
    expect(workspaceSeeds).toEqual([
      "packages/cloud/api",
      "packages/cloud/e2e",
      "packages/cloud/shared",
      "packages/ui",
    ]);
    const closure = workspaceClosure(workspaceSeeds);
    expect([...closure]).toEqual(
      expect.arrayContaining([
        "packages/cloud/api",
        "packages/cloud/e2e",
        "packages/cloud/shared",
        "packages/core",
        "packages/logger",
        "packages/prompts",
        "packages/registry",
        "packages/shared",
        "packages/ui",
        "plugins/plugin-cloud-apps",
        "plugins/plugin-elizacloud",
        "plugins/plugin-sql",
      ]),
    );

    const explicitInputs = splitWords(
      billingJob?.env?.BILLING_REPLAY_PATH_INPUTS,
    );
    expect(explicitInputs).toEqual(
      expect.arrayContaining([
        "packages/cloud",
        "packages/app",
        "packages/app-core",
        "packages/scripts",
        ".github/actions/cloud-setup-test-env",
        ".github/develop-surface-graph.json",
        ".github/workflows/develop-full.yml",
        ".github/workflows/pr-static-smoke.yml",
        ".github/workflows/cloud-tests.yml",
      ]),
    );

    const detect = billingJob?.steps?.find(
      (step) => step.id === "billing-diff",
    )?.run;
    expect(detect).toContain("listPackages");
    expect(detect).toContain('git(["merge-base", baseSha, headSha], [0])');
    expect(detect).toContain("...manifest.dependencies");
    expect(detect).toContain("...manifest.optionalDependencies");
    expect(detect).toContain("...manifest.peerDependencies");
    expect(detect).toContain(
      "if (byName.has(dependency)) pending.push(dependency)",
    );
    expect(detect).toContain('["diff", "--quiet"');
    expect(detect).toContain("[0, 1]");
    expect(detect).toContain('appendFileSync(requiredEnv("GITHUB_OUTPUT")');
    expect(detect).toContain("diff.status === 1");

    const replay = billingJob?.steps?.find(
      (step) => step.name === "Run billing payment replay spec",
    )?.run;
    expect(replay).toContain("billing-payment-replay\\.spec\\.ts$");

    const admission = workflow.jobs?.["static-smoke"]?.steps?.find(
      (step) => step.name === "Require every admission lane",
    );
    expect(admission?.env?.RESULTS).toContain("billing-payment-replay-e2e=${{");
    expect(admission?.run).not.toContain('result" = "skipped');
  });

  test("fails closed over mergeability, secrets, workflows, and affected static checks", () => {
    expect(workflow.jobs?.["source-smoke"]?.["runs-on"]).toBe("ubuntu-24.04");
    const commands = (workflow.jobs?.["source-smoke"]?.steps ?? [])
      .map((step) => step.run ?? "")
      .join("\n");
    expect(commands).toContain("git merge-tree --write-tree");
    expect(commands).toContain("git diff --check");
    expect(commands).toContain("gitleaks detect");
    expect(commands).toContain("actionlint");
    expect(commands).toContain(
      "packages/cloud/shared/scripts/messaging-gateway-preflight.test.mjs",
    );
    expect(commands).toContain(
      "packages/scripts/__tests__/pr-static-smoke-workflow.test.ts",
    );
    expect(commands).toContain("bun run build:core");
    expect(commands).toContain("run lint:check --concurrency=4 --affected");
    expect(commands).toContain("run typecheck --concurrency=4 --affected");
    expect(commands).toContain("run build --concurrency=4 --affected");
  });

  test("does not acquire effect credentials or run live qualification", () => {
    expect(source).not.toMatch(/\bsecrets\.[A-Z0-9_]+/);
    expect(source).not.toContain("test:e2e");
    expect(source).not.toContain("test:server");
    expect(source).not.toContain("test:client");
    expect(source).not.toContain("test:plugins");
    expect(source).not.toContain("environment:");
    expect(source).not.toContain("self-hosted");
  });

  test("documents the required keyless Billing replay lane", () => {
    expect(workflowReadme).toContain(
      "mock-backed payment replay Playwright proof",
    );
    expect(workflowReadme).not.toMatch(/does\s+not run tests/);
  });
});
