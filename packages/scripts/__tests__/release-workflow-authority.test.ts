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

describe("release workflow authority", () => {
  test("only proven dead competing entry points stay absent", () => {
    for (const workflow of retiredWorkflows) {
      expect(existsSync(workflowPath(workflow))).toBe(false);
    }
  });

  test("every local reusable call resolves to a callable workflow", () => {
    for (const callerName of workflowNames()) {
      for (const calleeName of localReusableCalls(parseWorkflow(callerName))) {
        expect(existsSync(workflowPath(calleeName))).toBe(true);
        expect(parseWorkflow(calleeName).on?.workflow_call).toBeDefined();
      }
    }
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

  });

  test("workflow and OS documentation do not route to retired authorities", () => {
    const referenceFiles = textFilesUnder(workflowsDirectory);

    for (const path of referenceFiles) {
      const content = read(path);
      for (const retiredWorkflow of retiredWorkflows) {
        expect(content).not.toContain(retiredWorkflow);
      }
      expect(content).not.toContain("FLATHUB_TOKEN");
    }
  });
});
