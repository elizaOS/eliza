/**
 * Locks the direct transactional npm release to exact manual inputs,
 * credential-separated jobs, and an immutable candidate handoff.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validatePublicReleaseInputs } from "../lib/release-workflow.mjs";
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
      environment?: { name?: string } | string;
      steps?: Array<{
        name?: string;
        if?: string;
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
  if (!value) throw new Error(`Missing release step ${jobName}/${stepName}`);
  return value;
}

describe("transactional npm release workflow", () => {
  test("is direct, explicit, and globally serialized", () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    const inputs = workflow.on?.workflow_dispatch?.inputs;
    for (const name of [
      "source_sha",
      "source_ref",
      "version",
      "channel",
      "npm_publisher",
    ]) {
      expect(inputs?.[name]?.required).toBe(true);
    }
    expect(inputs?.candidate_run_id?.required).toBe(false);
    expect(workflow.concurrency).toEqual({
      group: "public-npm-release-transaction",
      "cancel-in-progress": false,
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  test("binds exact develop authority and separates credentials", () => {
    const authority = step(
      "authorize",
      "Require current protected release workflow",
    );
    expect(authority.env?.EXPECTED_CALLER_REF).toBe(
      "elizaOS/eliza/.github/workflows/release.yaml@refs/heads/develop",
    );
    expect(authority.run).toContain("/git/ref/heads/develop");
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
    expect(job("publish").environment).toEqual({
      name: "npm-public-release",
    });
    expect(workflowSource.match(/secrets\.NPM_TOKEN/g)).toHaveLength(1);
  });

  test("builds once and finalizes only after registry verification", () => {
    expect(step("candidate", "Build and pack once").if).toBe(
      "inputs.candidate_run_id == 0",
    );
    expect(
      step("publish", "Publish immutable tarballs and promote full cohort").run,
    ).not.toMatch(/\b(build|pack)\b/);
    const finalSteps = job("finalize").steps ?? [];
    const registry = finalSteps.findIndex(
      ({ name }) => name === "Reverify every npm version and public channel",
    );
    const tag = finalSteps.findIndex(
      ({ name }) => name === "Push only the exact planned Git tag",
    );
    const release = finalSteps.findIndex(
      ({ name }) => name === "Publish idempotent GitHub Release",
    );
    expect(registry).toBeGreaterThan(-1);
    expect(registry).toBeLessThan(tag);
    expect(tag).toBeLessThan(release);
  });
});

describe("public release input contract", () => {
  const sourceSha = "a".repeat(40);
  const identity = {
    sourceRef: "refs/heads/develop",
    repository: "elizaOS/eliza",
    registry: "https://registry.npmjs.org/",
    publisher: "release-bot",
  };

  test("binds channels to the matching semver class", () => {
    expect(
      validatePublicReleaseInputs({
        sourceSha,
        ...identity,
        version: "3.0.0-beta.1",
        channel: "beta",
      }),
    ).toMatchObject({ tag: "v3.0.0-beta.1", prerelease: true });
    expect(
      validatePublicReleaseInputs({
        sourceSha,
        ...identity,
        version: "3.0.0",
        channel: "latest",
      }),
    ).toMatchObject({ tag: "v3.0.0", prerelease: false });
  });

  test("writes validated values to GitHub output", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "release-inputs-"));
    const outputPath = path.join(root, "github-output");
    try {
      await releaseMain([
        "inputs",
        "--source-sha",
        sourceSha,
        "--source-ref",
        identity.sourceRef,
        "--repository",
        identity.repository,
        "--registry",
        identity.registry,
        "--publisher",
        identity.publisher,
        "--version",
        "3.0.0-beta.1",
        "--channel",
        "beta",
        "--github-output",
        outputPath,
      ]);
      expect(readFileSync(outputPath, "utf8")).toContain("tag=v3.0.0-beta.1\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
