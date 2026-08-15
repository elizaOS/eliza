/**
 * Executable contract for Cloud release workflow source-path admission.
 * The harness reads the real workspace manifests and workflows so a
 * source-form runtime dependency cannot change an artifact without creating
 * the corresponding Cloud or agent-image build candidate.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_BUILD_PACKAGES } from "../build-core-packages.mjs";

const repoRoot = new URL("../../../", import.meta.url);
const repoRootPath = fileURLToPath(repoRoot);

interface Manifest {
  dependencies?: Record<string, string>;
  name?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  workspaces?: string[];
}

interface Workflow {
  on?: {
    pull_request?: { paths?: string[] };
    push?: { paths?: string[] };
  };
}

interface WorkspacePackage {
  directory: string;
  manifest: Manifest;
}

const rootManifest = JSON.parse(
  readFileSync(new URL("package.json", repoRoot), "utf8"),
) as Manifest;

function readWorkspacePackages(): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();
  for (const workspace of rootManifest.workspaces ?? []) {
    const glob = new Bun.Glob(`${workspace}/package.json`);
    for (const manifestPath of glob.scanSync({
      cwd: repoRootPath,
      onlyFiles: true,
    })) {
      const manifest = JSON.parse(
        readFileSync(new URL(manifestPath, repoRoot), "utf8"),
      ) as Manifest;
      if (!manifest.name) continue;
      packages.set(manifest.name, {
        directory: dirname(manifestPath),
        manifest,
      });
    }
  }
  return packages;
}

function runtimeWorkspaceClosure(
  packages: Map<string, WorkspacePackage>,
  roots: string[],
): WorkspacePackage[] {
  const visited = new Set<string>();
  const pending = [...roots];

  while (pending.length > 0) {
    const packageName = pending.pop();
    if (!packageName || visited.has(packageName)) continue;
    const workspacePackage = packages.get(packageName);
    if (!workspacePackage) {
      throw new Error(`Missing release workspace ${packageName}`);
    }
    visited.add(packageName);
    const dependencies = {
      ...workspacePackage.manifest.dependencies,
      ...workspacePackage.manifest.optionalDependencies,
      ...workspacePackage.manifest.peerDependencies,
    };
    for (const dependencyName of Object.keys(dependencies)) {
      if (packages.has(dependencyName) && !visited.has(dependencyName)) {
        pending.push(dependencyName);
      }
    }
  }

  return [...visited]
    .map((packageName) => packages.get(packageName))
    .filter((value): value is WorkspacePackage => value !== undefined)
    .sort((left, right) => left.directory.localeCompare(right.directory));
}

function pathMatchesDirectory(pattern: string, directory: string): boolean {
  if (!pattern.endsWith("/**")) return false;
  const prefix = pattern.slice(0, -3);
  return directory === prefix || directory.startsWith(`${prefix}/`);
}

function rootReleaseScriptPaths(): string[] {
  const commands = [
    rootManifest.scripts?.postinstall,
    rootManifest.scripts?.["build:core"],
  ].filter((command): command is string => command !== undefined);
  return [
    ...new Set(
      commands.flatMap((command) =>
        [...command.matchAll(/packages\/scripts\/[A-Za-z0-9_./-]+\.mjs/gu)].map(
          (match) => match[0],
        ),
      ),
    ),
  ].sort();
}

function scriptDependencyClosure(entryPaths: string[]): string[] {
  const visited = new Set<string>();
  const pending = [...entryPaths];
  while (pending.length > 0) {
    const scriptPath = pending.pop();
    if (!scriptPath || visited.has(scriptPath)) continue;
    visited.add(scriptPath);
    const source = readFileSync(join(repoRootPath, scriptPath), "utf8");
    for (const match of source.matchAll(
      /(?:from\s+|import\s*)["'](\.[^"']+)["']/gu,
    )) {
      const dependencyPath = relative(
        repoRootPath,
        join(repoRootPath, dirname(scriptPath), match[1]),
      )
        .split(sep)
        .join("/");
      if (dependencyPath.endsWith(".mjs") && !visited.has(dependencyPath)) {
        pending.push(dependencyPath);
      }
    }
  }
  return [...visited].sort();
}

const cloudWorkflowSource = readFileSync(
  new URL(".github/workflows/cloud-cf-deploy.yml", repoRoot),
  "utf8",
);
const cloudWorkflow = Bun.YAML.parse(cloudWorkflowSource) as Workflow;
const imageWorkflowSource = readFileSync(
  new URL(".github/workflows/build-agent-image.yml", repoRoot),
  "utf8",
);
const imageWorkflow = Bun.YAML.parse(imageWorkflowSource) as Workflow;

function filteredWorkspacePackages(source: string): string[] {
  return [...source.matchAll(/--filter=(@elizaos\/[A-Za-z0-9_-]+)/gu)].map(
    (match) => match[1],
  );
}

describe("Cloud release dependency trigger contract", () => {
  const cloudPushPaths = cloudWorkflow.on?.push?.paths ?? [];
  const cloudPullRequestPaths = cloudWorkflow.on?.pull_request?.paths ?? [];
  const imagePushPaths = imageWorkflow.on?.push?.paths ?? [];
  const packages = readWorkspacePackages();
  const cloudReleaseClosure = runtimeWorkspaceClosure(packages, [
    "@elizaos/app",
    "@elizaos/cloud-api",
    "@elizaos/homepage-source",
  ]);
  const imageReleaseClosure = runtimeWorkspaceClosure(packages, [
    ...CORE_BUILD_PACKAGES,
    ...filteredWorkspacePackages(imageWorkflowSource),
  ]);

  test("keeps push and pull-request source admission identical", () => {
    expect(cloudPullRequestPaths).toEqual(cloudPushPaths);
  });

  test("covers every Cloud CF source-form runtime workspace dependency", () => {
    const uncovered = cloudReleaseClosure
      .map(({ directory }) => directory)
      .filter(
        (directory) =>
          !cloudPushPaths.some((pattern) =>
            pathMatchesDirectory(pattern, directory),
          ),
      );

    expect(uncovered).toEqual([]);
    expect(cloudReleaseClosure.map(({ directory }) => directory)).toContain(
      "packages/core",
    );
    expect(cloudReleaseClosure.map(({ directory }) => directory)).toContain(
      "packages/agent",
    );
    expect(
      cloudReleaseClosure.some(({ directory }) =>
        directory.startsWith("plugins/"),
      ),
    ).toBe(true);
  });

  test("covers every agent-image source-form runtime workspace dependency", () => {
    const uncovered = imageReleaseClosure
      .map(({ directory }) => directory)
      .filter(
        (directory) =>
          !imagePushPaths.some((pattern) =>
            pathMatchesDirectory(pattern, directory),
          ),
      );

    expect(uncovered).toEqual([]);
    expect(imageReleaseClosure.map(({ directory }) => directory)).toContain(
      "packages/shared",
    );
    expect(imageReleaseClosure.map(({ directory }) => directory)).toContain(
      "plugins/plugin-coding-tools",
    );
  });

  test("does not turn unrelated packages into Cloud releases", () => {
    const cloudReleaseDirectories = cloudReleaseClosure.map(
      ({ directory }) => directory,
    );
    const imageReleaseDirectories = imageReleaseClosure.map(
      ({ directory }) => directory,
    );
    expect(cloudReleaseDirectories).not.toContain("packages/docs");
    expect(imageReleaseDirectories).not.toContain("packages/docs");
    expect(
      cloudPushPaths.some((pattern) =>
        pathMatchesDirectory(pattern, "packages/docs"),
      ),
    ).toBe(false);
    expect(
      imagePushPaths.some((pattern) =>
        pathMatchesDirectory(pattern, "packages/docs"),
      ),
    ).toBe(false);
  });

  test("covers dependency resolution and the scripts that build the artifact", () => {
    const requiredPaths = new Set([
      "bun.lock",
      "bunfig.toml",
      "package.json",
      "patches/**",
      "tsconfig.base.json",
      "tsconfig.build.template.json",
      "tsconfig.json",
      "turbo.json",
      "packages/scripts/build-core-packages.mjs",
      "packages/scripts/build-core.mjs",
      "packages/scripts/ensure-workspace-symlinks.mjs",
      "packages/scripts/run-turbo.mjs",
      ...scriptDependencyClosure(rootReleaseScriptPaths()),
    ]);
    for (const requiredPath of requiredPaths) {
      expect(cloudPushPaths).toContain(requiredPath);
      expect(imagePushPaths).toContain(requiredPath);
    }
  });
});
