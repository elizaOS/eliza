/**
 * Locks the transactional npm workflow to exact manual/called inputs, one
 * global mutation queue, credential-separated jobs, immutable artifact handoff,
 * and the explicit runtime-closed package cohort. No workflow is dispatched.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
      environment?: { name?: string } | string;
      permissions?: Record<string, string>;
      uses?: string;
      with?: Record<string, unknown>;
      secrets?: unknown;
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
const orchestratorPath = path.join(
  repoRoot,
  ".github/workflows/release-orchestrator.yml",
);
const orchestratorSource = readFileSync(orchestratorPath, "utf8");
const orchestrator = Bun.YAML.parse(orchestratorSource) as {
  on?: Record<string, { inputs?: Record<string, { required?: boolean }> }>;
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      needs?: string | string[];
      if?: string;
      permissions?: Record<string, string>;
      uses?: string;
      with?: Record<string, unknown>;
      secrets?: unknown;
    }
  >;
};
const candidateProofSource = readFileSync(
  path.join(repoRoot, ".github/workflows/release-candidate-pr.yml"),
  "utf8",
);
const candidateProof = Bun.YAML.parse(candidateProofSource) as {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      permissions?: Record<string, string>;
      steps?: Array<{
        name?: string;
        uses?: string;
        env?: Record<string, string>;
        with?: Record<string, unknown>;
      }>;
    }
  >;
};

function needs(jobValue: { needs?: string | string[] }) {
  if (!jobValue.needs) return [];
  return Array.isArray(jobValue.needs) ? jobValue.needs : [jobValue.needs];
}

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
    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_call"]);
    const inputs = workflow.on?.workflow_call?.inputs;
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
    expect(workflowSource).not.toContain("overwrite: true");
  });

  test("keeps credentials out of candidate work and source mutation out of publication", () => {
    expect(job("candidate").needs).toBe("authorize");
    expect(job("candidate").permissions).toEqual({
      actions: "read",
      contents: "read",
    });
    expect(needs(job("publish"))).toEqual(["authorize", "candidate"]);
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
      step("candidate", "Setup credential-free workspace").with?.[
        "run-postinstall"
      ],
    ).toBe("false");
    expect(
      step("publish", "Checkout exact source without Git credentials").with?.[
        "persist-credentials"
      ],
    ).toBe(false);
    expect(step("publish", "Checkout trusted release tooling").with?.ref).toBe(
      "$" + "{{ needs.authorize.outputs.tooling_sha }}",
    );
    expect(
      step("publish", "Checkout exact source without Git credentials").with
        ?.path,
    ).toBe("release-source");
    expect(step("finalize", "Checkout trusted release tooling").with?.ref).toBe(
      "$" + "{{ needs.authorize.outputs.tooling_sha }}",
    );
    expect(job("publish").environment).toEqual({
      name: "npm-public-release",
    });
    expect(job("finalize").environment).toEqual({
      name: "npm-public-release",
    });
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
    expect(step("candidate", "Bind source ref and repository").run).toContain(
      "release-candidate.mjs source",
    );
    expect(step("candidate", "Verify immutable candidate bytes").run).toContain(
      '--github-output "$GITHUB_OUTPUT"',
    );
    for (const jobName of ["publish", "finalize"]) {
      const source = (job(jobName).steps ?? [])
        .map(({ run }) => run ?? "")
        .join("\n");
      expect(source).toContain("--plan-integrity");
      expect(source).toContain("--source-ref");
      expect(source).toContain("--publisher");
    }
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
    expect(needs(job("publish"))).toEqual(["authorize", "candidate"]);
    expect(needs(job("finalize"))).toEqual([
      "candidate",
      "publish",
      "authorize",
    ]);

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

  test("binds credentialed tooling to the current protected orchestrator SHA", () => {
    const authority = step(
      "authorize",
      "Require current protected orchestrator",
    );
    expect(authority.env?.EXPECTED_CALLER_REF).toBe(
      "elizaOS/eliza/.github/workflows/release-orchestrator.yml@refs/heads/develop",
    );
    expect(authority.run).toContain('"$OBSERVED_REF" != "refs/heads/develop"');
    expect(authority.run).toContain(
      '"$OBSERVED_SOURCE_REF" != "refs/heads/develop"',
    );
    expect(authority.run).toContain(
      '"$OBSERVED_WORKFLOW_REF" != "$EXPECTED_CALLER_REF"',
    );
    expect(authority.run).toContain('"$OBSERVED_SHA" != "$protected_sha"');
    expect(authority.run).toContain(
      '"$OBSERVED_SOURCE_SHA" != "$protected_sha"',
    );
    expect(authority.run).toContain(
      '"$OBSERVED_WORKFLOW_SHA" != "$protected_sha"',
    );
    expect(authority.run).toContain("/git/ref/heads/develop");
    expect(workflowSource).not.toContain("workflow_dispatch:");
    expect(workflow.on?.workflow_call).not.toHaveProperty("secrets");
  });

  test("the real tree has one schema-complete caller and no shell dispatches", () => {
    const callInputs = workflow.on?.workflow_call?.inputs ?? {};
    const requiredInputs = Object.entries(callInputs)
      .filter(([, value]) => value.required)
      .map(([name]) => name)
      .sort();
    const workflowDirectory = path.join(repoRoot, ".github/workflows");
    const workflowFiles = readdirSync(workflowDirectory).filter((name) =>
      /\.ya?ml$/.test(name),
    );
    const callers: Array<{
      file: string;
      job: string;
      with: Record<string, unknown>;
    }> = [];
    const shellDispatches: string[] = [];

    for (const file of workflowFiles) {
      const source = readFileSync(path.join(workflowDirectory, file), "utf8");
      const parsed = Bun.YAML.parse(source) as {
        jobs?: Record<
          string,
          {
            uses?: string;
            with?: Record<string, unknown>;
            steps?: Array<{ run?: string }>;
          }
        >;
      };
      for (const [jobName, jobValue] of Object.entries(parsed.jobs ?? {})) {
        if (
          jobValue.uses === "./.github/workflows/release.yaml" ||
          /\/\.github\/workflows\/release\.yaml@/.test(jobValue.uses ?? "")
        ) {
          callers.push({
            file,
            job: jobName,
            with: jobValue.with ?? {},
          });
        }
        for (const candidateStep of jobValue.steps ?? []) {
          const normalizedRun = (candidateStep.run ?? "")
            .replace(/\\\r?\n/g, " ")
            .replace(/\s+/g, " ");
          if (
            /gh workflow run (?:[^ ]+ )*release\.yaml/.test(normalizedRun) ||
            /actions\/workflows\/release\.yaml\/dispatches/.test(normalizedRun)
          ) {
            shellDispatches.push(`${file}:${jobName}`);
          }
        }
      }
    }

    expect(shellDispatches).toEqual([]);
    expect(workflowFiles).not.toContain("develop-staging-beta.yml");
    expect(workflowFiles).not.toContain("release-all.yml");
    expect(workflowFiles).not.toContain("flatpak-publish.yml");
    expect(callers).toHaveLength(1);
    expect(callers[0]).toMatchObject({
      file: "release-orchestrator.yml",
      job: "publish-npm",
    });
    expect(Object.keys(callers[0]?.with ?? {}).sort()).toEqual(
      Object.keys(callInputs).sort(),
    );
    expect(
      requiredInputs.every((name) =>
        Object.hasOwn(callers[0]?.with ?? {}, name),
      ),
    ).toBe(true);
  });

  test("the orchestrator gates every distribution on transactional npm output", () => {
    expect(Object.keys(orchestrator.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(orchestrator.permissions).toEqual({ contents: "read" });
    expect(orchestrator.on?.workflow_dispatch?.inputs).not.toHaveProperty(
      "publish_npm",
    );
    const npm = orchestrator.jobs?.["publish-npm"];
    expect(npm?.uses).toBe("./.github/workflows/release.yaml");
    expect(npm?.if).toBeUndefined();
    expect(npm?.secrets).toBeUndefined();
    expect(npm?.permissions).toEqual({ actions: "read", contents: "write" });

    for (const jobName of [
      "publish-packages",
      "publish-android",
      "publish-apple",
      "publish-desktop",
      "update-homebrew",
      "deploy-homepage",
    ]) {
      const downstream = orchestrator.jobs?.[jobName];
      expect(needs(downstream ?? {})).toContain("publish-npm");
      expect(downstream?.if).toContain("registry_verified == 'true'");
    }
    const homepage = orchestrator.jobs?.["deploy-homepage"];
    for (const prerequisite of [
      "publish-packages",
      "publish-android",
      "publish-apple",
      "publish-desktop",
    ]) {
      expect(homepage?.if).toContain(
        `needs.${prerequisite}.result == 'success'`,
      );
    }
    expect(orchestratorSource).not.toMatch(/^ {2}release:\s*$/m);
    expect(orchestratorSource).not.toContain("types: [published]");
  });

  test("the exact-head candidate proof is credential-free and preserves source bytes", () => {
    expect(Object.keys(candidateProof.on ?? {})).toEqual(["pull_request"]);
    expect(candidateProof.permissions).toEqual({ contents: "read" });
    const proofJob = candidateProof.jobs?.candidate;
    const proofSteps = proofJob?.steps ?? [];
    const proofStep = (name: string) => {
      const value = proofSteps.find((candidate) => candidate.name === name);
      if (!value) throw new Error(`Missing candidate proof step ${name}`);
      return value;
    };
    expect(
      proofStep("Checkout exact pull-request head").with?.[
        "persist-credentials"
      ],
    ).toBe(false);
    expect(
      proofStep("Setup credential-free workspace").with?.["run-postinstall"],
    ).toBe("false");
    expect(candidateProofSource).not.toMatch(/\$\{\{\s*secrets\./);
    expect(candidateProofSource).toContain(
      'test -z "$(git status --porcelain=v1 --untracked-files=all)"',
    );
    expect(
      proofStep("Exercise candidate and real local transports").env
        ?.RELEASE_EVIDENCE_DIR,
    ).toBe("$" + "{{ runner.temp }}/release-evidence");
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
  const identity = {
    sourceRef: "refs/heads/develop",
    repository: "elizaOS/eliza",
    registry: "https://registry.npmjs.org/",
    publisher: "release-bot",
  };

  test("binds beta and latest to the matching semver class", () => {
    expect(
      validatePublicReleaseInputs({
        sourceSha,
        ...identity,
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
        ...identity,
        version: "3.0.0",
        channel: "latest",
      }),
    ).toMatchObject({ tag: "v3.0.0", prerelease: false });
    expect(() =>
      validatePublicReleaseInputs({
        sourceSha,
        ...identity,
        version: "3.0.0",
        channel: "beta",
      }),
    ).toThrow("beta requires a prerelease version");
    expect(() =>
      validatePublicReleaseInputs({
        sourceSha,
        ...identity,
        version: "3.0.0-beta.1",
        channel: "latest",
      }),
    ).toThrow("latest requires a stable version");
    expect(() =>
      validatePublicReleaseInputs({
        sourceSha,
        ...identity,
        version: "3.0.0-beta.1",
        channel: "next",
      }),
    ).toThrow("beta or latest");
    expect(() =>
      validatePublicReleaseInputs({
        sourceSha,
        ...identity,
        registry: "https://registry.example/",
        version: "3.0.0-beta.1",
        channel: "beta",
      }),
    ).toThrow("require https://registry.npmjs.org/");
    expect(() =>
      validatePublicReleaseInputs({
        sourceSha,
        ...identity,
        publisher: "Not Canonical",
        version: "3.0.0-beta.1",
        channel: "beta",
      }),
    ).toThrow("Invalid npm publisher");
  });

  test("writes validated values to the real GitHub output file boundary", async () => {
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
      const output = readFileSync(outputPath, "utf8");
      expect(output).toContain(`source_sha=${sourceSha}\n`);
      expect(output).toContain(`source_ref=${identity.sourceRef}\n`);
      expect(output).toContain(`repository=${identity.repository}\n`);
      expect(output).toContain("tag=v3.0.0-beta.1\n");
      expect(output).toContain("artifact_name=npm-release-candidate-");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
