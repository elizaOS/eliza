/**
 * Locks the transactional npm workflow to exact manual/called inputs, one
 * global mutation queue, credential-separated jobs, immutable artifact handoff,
 * and the explicit runtime-closed package cohort. No workflow is dispatched.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validatePublicReleaseInputs } from "../lib/release-workflow.mjs";
import { expandWorkspaceGlobs, listPackages } from "../lib/workspaces.mjs";
import { main as releaseMain } from "../release-candidate.mjs";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const workflowSource = readFileSync(
  path.join(repoRoot, ".github/workflows/release.yaml"),
  "utf8",
);
const workflow = Bun.YAML.parse(workflowSource) as {
  on?: Record<string, { inputs?: Record<string, { required?: boolean }> }>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      needs?: string | string[];
      permissions?: Record<string, string>;
      steps?: Array<{
        name?: string;
        if?: string;
        uses?: string;
        run?: string;
        env?: Record<string, string>;
        with?: Record<string, unknown>;
      }>;
    }
  >;
};

function job(name: string) {
  const value = workflow.jobs?.[name];
  if (!value) throw new Error(`Missing release workflow job ${name}`);
  return value;
}

function step(jobName: string, stepName: string) {
  const value = job(jobName).steps?.find(({ name }) => name === stepName);
  if (!value)
    throw new Error(`Missing release workflow step ${jobName}/${stepName}`);
  return value;
}

describe("transactional npm release workflow", () => {
  test("accepts only explicit exact release inputs and uses one global queue", () => {
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual([
      "workflow_call",
      "workflow_dispatch",
    ]);
    for (const trigger of ["workflow_call", "workflow_dispatch"]) {
      const inputs = workflow.on?.[trigger]?.inputs;
      for (const name of ["source_sha", "version", "channel"]) {
        expect(inputs?.[name]?.required).toBe(true);
      }
      expect(inputs?.candidate_run_id?.required).toBe(false);
    }
    expect(workflow.concurrency).toEqual({
      group: "public-npm-release-transaction",
      "cancel-in-progress": false,
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  test("keeps credentials out of candidate work and source mutation out of publication", () => {
    expect(job("candidate").permissions).toEqual({
      actions: "read",
      contents: "read",
    });
    expect(job("publish").permissions).toEqual({
      actions: "read",
      contents: "read",
    });
    expect(job("finalize").permissions).toEqual({
      actions: "read",
      contents: "write",
    });
    expect(
      step("candidate", "Checkout exact source").with?.["persist-credentials"],
    ).toBe(false);
    expect(
      step("publish", "Checkout exact source without Git credentials").with?.[
        "persist-credentials"
      ],
    ).toBe(false);
    expect(step("publish", "Checkout trusted release tooling").with?.ref).toBe(
      "$" + "{{ github.workflow_sha }}",
    );
    expect(
      step("publish", "Checkout exact source without Git credentials").with
        ?.path,
    ).toBe("release-source");
    expect(step("finalize", "Checkout trusted release tooling").with?.ref).toBe(
      "$" + "{{ github.workflow_sha }}",
    );
    expect(workflowSource.match(/secrets\.NPM_TOKEN/g)).toHaveLength(1);
    expect(
      step("publish", "Publish immutable tarballs and promote full cohort").env
        ?.NODE_AUTH_TOKEN,
    ).toBe("$" + "{{ secrets.NPM_TOKEN }}");

    for (const forbidden of [
      "lerna publish",
      "git add -A",
      "--follow-tags",
      "-X theirs",
      "HEAD:develop",
      "HEAD:main",
      "replace-workspace-versions",
      "restore-workspace-refs",
      "release-set-public-access",
    ]) {
      expect(workflowSource).not.toContain(forbidden);
    }
    expect(
      step("publish", "Publish immutable tarballs and promote full cohort").run,
    ).not.toMatch(/\b(build|pack)\b/);
  });

  test("resumes an existing candidate without rebuilding and gates finalization on npm", () => {
    expect(step("candidate", "Download prior immutable candidate").if).toBe(
      "inputs.candidate_run_id != 0",
    );
    expect(
      step("candidate", "Verify release source before first pack").if,
    ).toBe("inputs.candidate_run_id == 0");
    expect(step("candidate", "Test release source before first pack").if).toBe(
      "inputs.candidate_run_id == 0",
    );
    expect(step("candidate", "Test release source before first pack").run).toBe(
      "bun run test",
    );
    expect(step("candidate", "Build and pack once").if).toBe(
      "inputs.candidate_run_id == 0",
    );
    expect(job("publish").needs).toBe("candidate");
    expect(job("finalize").needs).toEqual(["candidate", "publish"]);

    const finalSteps = job("finalize").steps ?? [];
    const registryIndex = finalSteps.findIndex(
      ({ name }) => name === "Reverify every npm version and public channel",
    );
    const tagIndex = finalSteps.findIndex(
      ({ name }) => name === "Push only the exact planned Git tag",
    );
    const releaseIndex = finalSteps.findIndex(
      ({ name }) => name === "Publish idempotent GitHub Release",
    );
    expect(registryIndex).toBeGreaterThan(-1);
    expect(registryIndex).toBeLessThan(tagIndex);
    expect(tagIndex).toBeLessThan(releaseIndex);
    expect(
      step("finalize", "Push only the exact planned Git tag").run,
    ).toContain("push-tag");
  });

  test("the allowlist is sorted, unique, and closes legacy runtime workspaces", () => {
    const cohort = JSON.parse(
      readFileSync(
        path.join(repoRoot, "packages/scripts/release-cohort.json"),
        "utf8",
      ),
    ) as { schemaVersion: number; packages: string[] };
    expect(cohort.schemaVersion).toBe(1);
    expect(cohort.packages).toEqual([...cohort.packages].sort());
    expect(new Set(cohort.packages).size).toBe(cohort.packages.length);

    const lerna = JSON.parse(
      readFileSync(path.join(repoRoot, "lerna.json"), "utf8"),
    ) as { packages: string[] };
    const workspaces = listPackages({ repoRoot });
    const byName = new Map(workspaces.map((entry) => [entry.name, entry]));
    const lernaDirectories = new Set(
      expandWorkspaceGlobs(lerna.packages, { repoRoot }),
    );
    const expected = new Set(
      workspaces
        .filter(
          ({ dir, packageJson }) =>
            lernaDirectories.has(dir) && packageJson.private !== true,
        )
        .map(({ name }) => name),
    );
    for (const packageName of expected) {
      const manifest = byName.get(packageName)?.packageJson;
      for (const section of ["dependencies", "optionalDependencies"]) {
        for (const dependency of Object.keys(manifest?.[section] ?? {})) {
          if (byName.has(dependency)) expected.add(dependency);
        }
      }
    }
    expect(cohort.packages).toEqual([...expected].sort());
    expect(cohort.packages).toContain("@elizaos/plugin-remote-manifest");
    expect(cohort.packages).toContain("@elizaos/plugin-worker-runtime");
    expect(cohort.packages).toContain("@elizaos/cloud-shared");
  });
});

describe("public release input contract", () => {
  const sourceSha = "a".repeat(40);

  test("binds beta and latest to the matching semver class", () => {
    expect(
      validatePublicReleaseInputs({
        sourceSha,
        version: "3.0.0-beta.1",
        channel: "beta",
      }),
    ).toMatchObject({
      tag: "v3.0.0-beta.1",
      prerelease: true,
    });
    expect(
      validatePublicReleaseInputs({
        sourceSha,
        version: "3.0.0",
        channel: "latest",
      }),
    ).toMatchObject({ tag: "v3.0.0", prerelease: false });
    expect(() =>
      validatePublicReleaseInputs({
        sourceSha,
        version: "3.0.0",
        channel: "beta",
      }),
    ).toThrow("beta requires a prerelease version");
    expect(() =>
      validatePublicReleaseInputs({
        sourceSha,
        version: "3.0.0-beta.1",
        channel: "latest",
      }),
    ).toThrow("latest requires a stable version");
    expect(() =>
      validatePublicReleaseInputs({
        sourceSha,
        version: "3.0.0-beta.1",
        channel: "next",
      }),
    ).toThrow("beta or latest");
  });

  test("writes validated values to the real GitHub output file boundary", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "release-inputs-"));
    const outputPath = path.join(root, "github-output");
    try {
      await releaseMain([
        "inputs",
        "--source-sha",
        sourceSha,
        "--version",
        "3.0.0-beta.1",
        "--channel",
        "beta",
        "--github-output",
        outputPath,
      ]);
      const output = readFileSync(outputPath, "utf8");
      expect(output).toContain(`source_sha=${sourceSha}\n`);
      expect(output).toContain("tag=v3.0.0-beta.1\n");
      expect(output).toContain("artifact_name=npm-release-candidate-");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
