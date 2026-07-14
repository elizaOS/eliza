/**
 * Guards the real repository's release call graph, automatic writer count, and
 * SHA-bound manual recovery boundary without dispatching a publishing job.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

interface WorkflowInput {
  required?: boolean;
}

interface WorkflowCallTrigger {
  inputs?: Record<string, WorkflowInput>;
  secrets?: Record<string, WorkflowInput>;
}

interface WorkflowTriggers {
  workflow_call?: WorkflowCallTrigger;
  workflow_dispatch?: WorkflowCallTrigger;
  release?: { types?: string[] };
}

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
}

interface WorkflowJob {
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
  uses?: string;
  with?: Record<string, boolean | string>;
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
  on?: WorkflowTriggers;
  permissions?: Record<string, string>;
}

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const workflowsDirectory = join(repoRoot, ".github", "workflows");
const retiredWorkflows = ["flatpak-publish.yml", "release-all.yml"] as const;
const automaticManifestWorkflow = "elizaos-os-full-release.yml";
const recoveryWorkflow = "update-os-release-manifest.yml";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function workflowPath(name: string): string {
  return join(workflowsDirectory, name);
}

function parseWorkflow(name: string): Workflow {
  return Bun.YAML.parse(read(workflowPath(name))) as Workflow;
}

function workflowNames(): string[] {
  return readdirSync(workflowsDirectory)
    .filter((entry) => /\.ya?ml$/.test(entry))
    .sort();
}

function textFilesUnder(directory: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      paths.push(...textFilesUnder(path));
    } else if (/\.(?:md|ya?ml)$/.test(entry)) {
      paths.push(path);
    }
  }
  return paths;
}

function localReusableCalls(workflow: Workflow): string[] {
  return Object.values(workflow.jobs ?? {})
    .map((job) => job.uses)
    .filter(
      (uses): uses is string =>
        typeof uses === "string" &&
        uses.startsWith("./.github/workflows/") &&
        /\.ya?ml$/.test(uses),
    )
    .map((uses) => basename(uses))
    .sort();
}

function requestedWritePermissions(workflow: Workflow): Set<string> {
  const permissions = new Set<string>();
  for (const [name, access] of Object.entries(workflow.permissions ?? {})) {
    if (access === "write") permissions.add(name);
  }
  for (const job of Object.values(workflow.jobs ?? {})) {
    for (const [name, access] of Object.entries(job.permissions ?? {})) {
      if (access === "write") permissions.add(name);
    }
  }
  return permissions;
}

function namedStep(workflow: Workflow, name: string): WorkflowStep {
  const steps = Object.values(workflow.jobs ?? {}).flatMap(
    (job) => job.steps ?? [],
  );
  const step = steps.find((candidate) => candidate.name === name);
  expect(step).toBeDefined();
  return step as WorkflowStep;
}

describe("release workflow authority", () => {
  test("only proven dead competing entry points stay absent", () => {
    for (const workflow of retiredWorkflows) {
      expect(existsSync(workflowPath(workflow))).toBe(false);
    }
    expect(existsSync(workflowPath(recoveryWorkflow))).toBe(true);
    expect(
      existsSync(
        join(repoRoot, "packages", "os", "docs", "release-secrets-flathub.md"),
      ),
    ).toBe(false);
  });

  test("every local reusable call resolves to a callable workflow", () => {
    for (const callerName of workflowNames()) {
      for (const calleeName of localReusableCalls(parseWorkflow(callerName))) {
        expect(existsSync(workflowPath(calleeName))).toBe(true);
        expect(parseWorkflow(calleeName).on?.workflow_call).toBeDefined();
      }
    }
  });

  test("one automatic OS manifest writer is distinct from manual recovery", () => {
    const writers = workflowNames().filter((name) => {
      const source = read(workflowPath(name));
      return (
        /packages\/os\/scripts\/(?:update-release-manifest|update-manifest-checksums)\.mjs/.test(
          source,
        ) ||
        /packages\/os\/scripts\/generate-release-checksums\.mjs[\s\S]{0,500}--update-manifest/.test(
          source,
        )
      );
    });
    const automaticWriters = writers.filter((name) => {
      const triggers = Object.keys(parseWorkflow(name).on ?? {});
      return triggers.some((trigger) => trigger !== "workflow_dispatch");
    });

    expect(writers).toEqual([automaticManifestWorkflow, recoveryWorkflow]);
    expect(automaticWriters).toEqual([automaticManifestWorkflow]);
    expect(Object.keys(parseWorkflow(recoveryWorkflow).on ?? {})).toEqual([
      "workflow_dispatch",
    ]);
  });

  test("manual recovery binds an immutable asset inventory and opens an evidenced draft PR", () => {
    const workflow = parseWorkflow(recoveryWorkflow);
    const source = read(workflowPath(recoveryWorkflow));
    const dispatchInputs = workflow.on?.workflow_dispatch?.inputs ?? {};

    expect(Object.keys(dispatchInputs).sort()).toEqual([
      "expected_base_sha",
      "expected_tag_sha",
      "manifest_path",
      "tag",
    ]);
    for (const input of Object.values(dispatchInputs)) {
      expect(input.required).toBe(true);
    }

    expect(workflow.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });

    const identity = namedStep(
      workflow,
      "Bind base, tag, release, manifest, and asset identities",
    ).run;
    expect(identity).toContain("remote_base_sha");
    expect(identity).toContain('git rev-parse "FETCH_HEAD^{commit}"');
    expect(identity).toContain(`releases/tags/\${RELEASE_TAG}`);
    expect(identity).toContain(`releases/\${release_id}/assets?per_page=100`);
    expect(identity).toContain("release-asset-inventory.mjs capture");

    const download = namedStep(
      workflow,
      "Download and verify the captured release asset set",
    ).run;
    expect(download).toContain("release-asset-inventory.mjs plan");
    expect(download).toContain(`releases/assets/\${asset_id}`);
    expect(download).toContain("release-asset-inventory.mjs verify");
    expect(download).toContain('> "$ARTIFACT_DIR/$asset_name"');

    const checksum = namedStep(
      workflow,
      "Regenerate and verify every publishable checksum",
    ).run;
    expect(checksum).toContain("generate-release-checksums.mjs");
    expect(checksum).toContain("--update-manifest");
    expect(checksum).toContain("--require-publishable-checksums");
    expect(checksum).toContain("verify-release-checksums.mjs");

    const drift = namedStep(
      workflow,
      "Reject base, tag, release, and asset inventory drift",
    ).run;
    expect(drift).toContain("develop moved during recovery");
    expect(drift).toContain("release tag moved during recovery");
    expect(drift).toContain(`releases/\${post_release_id}/assets?per_page=100`);
    expect(drift).toContain("release-asset-inventory.mjs capture");
    expect(drift).toContain("release-asset-inventory.mjs compare");

    const openPullRequest = namedStep(
      workflow,
      "Open the draft checksum recovery pull request",
    ).run;
    expect(openPullRequest).toContain("release-asset-inventory.mjs render-pr");
    expect(openPullRequest).toContain("scripts/check-pr-evidence.mjs");
    expect(openPullRequest).toContain(
      `git push origin "HEAD:refs/heads/\${BRANCH}"`,
    );
    expect(openPullRequest).toContain("gh pr create");
    expect(openPullRequest).toContain("--draft");
    expect(openPullRequest).toContain('--body-file "$pr_body"');

    expect(
      existsSync(
        join(repoRoot, "packages/os/scripts/release-asset-inventory.mjs"),
      ),
    ).toBe(true);
    expect(source).not.toContain("gh release download");
    expect(source).not.toMatch(
      /git push(?:\s+origin)?\s+(?:develop|main|HEAD:(?:develop|main))/,
    );
    expect(source).not.toContain("update-manifest-checksums.mjs");
    expect(source).not.toContain("workflow_call:");
  });

  test("the blocked automatic OS path remains described as blocked", () => {
    const automatic = parseWorkflow(automaticManifestWorkflow);
    const callerWrites = new Set(
      Object.entries(automatic.permissions ?? {})
        .filter(([, access]) => access === "write")
        .map(([name]) => name),
    );
    const missingWriteCapabilities = new Set<string>();
    for (const calleeName of localReusableCalls(automatic)) {
      for (const capability of requestedWritePermissions(
        parseWorkflow(calleeName),
      )) {
        if (!callerWrites.has(capability))
          missingWriteCapabilities.add(capability);
      }
    }

    expect([...missingWriteCapabilities].sort()).toEqual([
      "attestations",
      "contents",
      "id-token",
      "pages",
    ]);
    const catalog = read(workflowPath("README.md"));
    expect(catalog).toContain("currently startup-invalid");
    expect(catalog).toContain("not a working release authority");
  });

  test("the retained package call and its actual secret identities stay documented", () => {
    const orchestrator = parseWorkflow("release-orchestrator.yml");
    const packageJob = orchestrator.jobs?.["publish-packages"];
    expect(packageJob?.uses).toBe("./.github/workflows/publish-packages.yml");
    expect(packageJob?.with).toMatchObject({
      apt: true,
      pypi: true,
      snap: true,
    });

    const packageWorkflow = parseWorkflow("publish-packages.yml");
    expect(
      Object.keys(packageWorkflow.on?.workflow_call?.secrets ?? {}).sort(),
    ).toEqual(["APT_REPO_TOKEN", "PYPI_API_TOKEN", "SNAP_STORE_CREDENTIALS"]);

    const standaloneSnap = parseWorkflow("snap-publish.yml");
    expect(
      Object.keys(standaloneSnap.on?.workflow_call?.secrets ?? {}),
    ).toEqual(["SNAPCRAFT_STORE_CREDENTIALS"]);

    const checklist = read(
      join(repoRoot, "packages", "os", "docs", "release-secrets-checklist.md"),
    );
    for (const secret of [
      "APT_REPO_TOKEN",
      "PYPI_API_TOKEN",
      "SNAP_STORE_CREDENTIALS",
      "SNAPCRAFT_STORE_CREDENTIALS",
    ]) {
      expect(checklist).toContain(secret);
    }
    expect(checklist).toContain("known fail-open completion defect");
  });

  test("workflow and OS documentation do not route to retired authorities", () => {
    const referenceFiles = [
      ...textFilesUnder(workflowsDirectory),
      ...textFilesUnder(join(repoRoot, "packages", "os", "docs")),
    ];

    for (const path of referenceFiles) {
      const content = read(path);
      for (const retiredWorkflow of retiredWorkflows) {
        expect(content).not.toContain(retiredWorkflow);
      }
      expect(content).not.toContain("FLATHUB_TOKEN");
    }
  });
});
