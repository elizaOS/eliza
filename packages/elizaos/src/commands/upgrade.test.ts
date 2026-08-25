/**
 * Upgrade command tests drive the real command against real temporary
 * projects: template rendering, managed-file hashing, metadata read/write,
 * and conflict classification all run for real on disk; only the interactive
 * @clack output layer, the two git-submodule executors, and process.exit are
 * stubbed.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import os from "node:os";
import path from "node:path";
import * as clack from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTemplateById, getTemplatesDir } from "../manifest.js";
import { getCliVersion } from "../package-info.js";
import {
  ProjectMetadataError,
  readProjectMetadata,
  writeProjectMetadata,
} from "../project-metadata.js";
import {
  getTemplateReplacementEntries,
  hydrateGitSubmoduleWorkspace,
  renderTemplateTree,
  resolveTemplateSourceDir,
  updateGitSubmodule,
} from "../scaffold.js";
import type { ProjectTemplateMetadata, TemplateDefinition } from "../types.js";
import { upgrade } from "./upgrade";

vi.mock("@clack/prompts", () => ({
  cancel: vi.fn(),
  intro: vi.fn(),
  note: vi.fn(),
  spinner: vi.fn(() => ({ message: vi.fn(), start: vi.fn(), stop: vi.fn() })),
}));

// Keep the whole rendering/diff engine real; only the two functions that
// execute git against an upstream checkout are stubbed so tests never shell out.
vi.mock("../scaffold.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scaffold.js")>();
  return {
    ...actual,
    hydrateGitSubmoduleWorkspace: vi.fn(),
    updateGitSubmodule: vi.fn(),
  };
});

// Default stays the real lookup; individual tests layer one-shot overrides.
vi.mock("../manifest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../manifest.js")>();
  return { ...actual, getTemplateById: vi.fn(actual.getTemplateById) };
});

class ProcessExitError extends Error {}

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = { ...process.env };
const CREATED_AT = "2020-01-01T00:00:00.000Z";
const STALE_UPDATED_AT = "2020-01-02T00:00:00.000Z";

const PLUGIN_VALUES: Record<string, string> = {
  displayName: "Test Plugin",
  elizaVersion: "1.0.0",
  githubUsername: "tester",
  pluginBaseName: "test-plugin",
  pluginDescription: "A test plugin",
  pluginSnake: "test_plugin",
  repoUrl: "https://github.com/tester/test-plugin",
};

const PROJECT_VALUES: Record<string, string> = {
  appName: "Test App",
  appUrl: "https://app.example.test",
  bugReportUrl: "https://example.test/issues",
  bundleId: "dev.example.test.app",
  docsUrl: "https://docs.example.test",
  elizaVersion: "1.0.0",
  fileExtension: "ts",
  hashtag: "elizaos",
  orgName: "tester",
  packageScope: "@test",
  projectSlug: "test-app",
  releaseBaseUrl: "https://example.test/releases",
  repoName: "test-app",
};

let projectDir = "";
let exitCode: number | string | null | undefined;

const sha256 = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

function pluginSourceDir(): string {
  const template = getTemplateById("plugin");
  if (!template) {
    throw new Error("plugin template missing from CLI manifest");
  }
  return resolveTemplateSourceDir({
    template,
    templatesDir: getTemplatesDir(),
  });
}

function pluginReplacements(): Array<[string, string]> {
  return getTemplateReplacementEntries({
    templateId: "plugin",
    values: PLUGIN_VALUES,
  });
}

/** Seeds a real scaffolded plugin project and returns its rendered hash map plus a pristine reference render. */
function seedPluginProject(): {
  managedFiles: Record<string, string>;
  referenceDir: string;
} {
  const managedFiles = renderTemplateTree({
    destinationDir: projectDir,
    replacements: pluginReplacements(),
    sourceDir: pluginSourceDir(),
  });
  const referenceDir = mkdtempSync(
    path.join(os.tmpdir(), "elizaos-upgrade-ref-"),
  );
  // Pristine re-render used as the expected-content oracle for update/create
  // assertions; the hash map of this render is intentionally unused.
  renderTemplateTree({
    destinationDir: referenceDir,
    replacements: pluginReplacements(),
    sourceDir: pluginSourceDir(),
  });
  return { managedFiles, referenceDir };
}

function writeMetadata(metadata: ProjectTemplateMetadata): void {
  writeProjectMetadata(projectDir, metadata);
}

function metadataFixture(
  managedFiles: Record<string, string>,
  templateId: string,
  values: Record<string, string>,
): ProjectTemplateMetadata {
  return {
    cliVersion: "0.0.0-test",
    createdAt: CREATED_AT,
    language: "typescript",
    managedFiles,
    templateId: templateId as ProjectTemplateMetadata["templateId"],
    templateVersion: 1,
    updatedAt: STALE_UPDATED_AT,
    values,
  };
}

function metadataOnDisk(): ProjectTemplateMetadata {
  return readProjectMetadata(projectDir) as ProjectTemplateMetadata;
}

async function expectUpgradeExit(
  cancelledMessage: string | RegExp,
): Promise<void> {
  await expect(upgrade({})).rejects.toThrow(ProcessExitError);
  expect(exitCode).toBe(1);
  expect(clack.cancel).toHaveBeenCalledWith(
    expect.stringMatching(cancelledMessage),
  );
}

beforeEach(() => {
  exitCode = undefined;
  delete process.env.ELIZAOS_UPSTREAM_REPO;
  delete process.env.ELIZAOS_UPSTREAM_BRANCH;
  projectDir = mkdtempSync(path.join(os.tmpdir(), "elizaos-upgrade-project-"));
  process.chdir(projectDir);
  // macOS resolves /var/... to /private/var/...; compare against what the
  // command itself will observe via process.cwd().
  projectDir = process.cwd();
  vi.spyOn(process, "exit").mockImplementation(((
    code?: number | string | null | undefined,
  ) => {
    exitCode = code ?? undefined;
    throw new ProcessExitError(`process.exit(${String(code)})`);
  }) as unknown as typeof process.exit);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  process.env = { ...ORIGINAL_ENV };
  rmSync(projectDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.mocked(clack.cancel).mockClear();
  vi.mocked(clack.intro).mockClear();
  vi.mocked(clack.note).mockClear();
  vi.mocked(clack.spinner).mockClear();
  vi.mocked(getTemplateById).mockClear();
  vi.mocked(updateGitSubmodule).mockClear();
  vi.mocked(hydrateGitSubmoduleWorkspace).mockClear();
});

describe("upgrade failure paths", () => {
  it("fails closed with exit 1 when no .elizaos/template.json exists", async () => {
    await expectUpgradeExit(
      "No .elizaos/template.json metadata found in the current directory.",
    );
    // The run must stop before any upgrade work begins.
    expect(clack.intro).not.toHaveBeenCalled();
    expect(clack.note).not.toHaveBeenCalled();
  });

  it("cancels corrupt metadata with the ProjectMetadataError message and exits 1", async () => {
    mkdirSync(path.join(projectDir, ".elizaos"));
    writeFileSync(
      path.join(projectDir, ".elizaos", "template.json"),
      "{not-json",
    );

    await expectUpgradeExit(/Corrupt project metadata at .*template\.json/);
    expect(clack.intro).not.toHaveBeenCalled();
    expect(clack.note).not.toHaveBeenCalled();
  });

  it("cancels template ids that this CLI build does not ship and exits 1", async () => {
    const { managedFiles } = seedPluginProject();
    writeMetadata(
      metadataFixture(managedFiles, "ghost-template", PLUGIN_VALUES),
    );

    await expectUpgradeExit(
      "Template 'ghost-template' is not available in this CLI build.",
    );
    expect(clack.intro).not.toHaveBeenCalled();
    expect(clack.note).not.toHaveBeenCalled();
  });

  it("rethrows unexpected metadata failures instead of exiting or cancelling", async () => {
    const projectMetadata = await import("../project-metadata.js");
    const boom = new Error("disk exploded");
    vi.spyOn(projectMetadata, "readProjectMetadata").mockImplementation(() => {
      throw boom;
    });

    await expect(upgrade({})).rejects.toThrow(boom);
    expect(exitCode).toBeUndefined();
    expect(clack.cancel).not.toHaveBeenCalled();
  });

  it("surfaces ProjectMetadataError as a distinct error type for callers", () => {
    const error = new ProjectMetadataError(
      "/tmp/x/template.json",
      "invalid JSON",
    );
    expect(error.name).toBe("ProjectMetadataError");
    expect(error.metadataPath).toBe("/tmp/x/template.json");
  });
});

describe("upgrade applies the rendered template", () => {
  it("reports zero counts for an already up-to-date project and refreshes metadata", async () => {
    const { managedFiles } = seedPluginProject();
    writeMetadata(metadataFixture(managedFiles, "plugin", PLUGIN_VALUES));

    await upgrade({});

    expect(clack.note).toHaveBeenCalledWith(
      ["Updated: 0", "Created: 0", "Deleted: 0", "Conflicts: 0"].join("\n"),
      "Upgrade result",
    );
    const onDisk = metadataOnDisk();
    expect(onDisk.managedFiles).toEqual(managedFiles);
    // createdAt survives the rewrite; the freshness stamps do not.
    expect(onDisk.createdAt).toBe(CREATED_AT);
    expect(onDisk.updatedAt).not.toBe(STALE_UPDATED_AT);
    expect(onDisk.cliVersion).toBe(getCliVersion());
    expect(onDisk.values).toEqual(PLUGIN_VALUES);
    expect(console.log).not.toHaveBeenCalledWith(
      "Skipped files with local changes:",
    );
  });

  it("rewrites a drifted managed file on disk and records the new hash", async () => {
    const { managedFiles, referenceDir } = seedPluginProject();
    const target = "src/index.ts";
    const drifted = "// local drift that still matches the stale ledger\n";
    writeFileSync(path.join(projectDir, target), drifted);
    managedFiles[target] = sha256(drifted);
    writeMetadata(metadataFixture(managedFiles, "plugin", PLUGIN_VALUES));

    await upgrade({});

    const expected = readFileSync(path.join(referenceDir, target), "utf-8");
    expect(readFileSync(path.join(projectDir, target), "utf-8")).toBe(expected);
    expect(metadataOnDisk().managedFiles[target]).toBe(sha256(expected));
    expect(clack.note).toHaveBeenCalledWith(
      expect.stringContaining("Updated: 1"),
      "Upgrade result",
    );
  });

  it("creates a managed file missing from the project", async () => {
    const { managedFiles, referenceDir } = seedPluginProject();
    const target = "src/plugin.ts";
    rmSync(path.join(projectDir, target));
    delete managedFiles[target];
    writeMetadata(metadataFixture(managedFiles, "plugin", PLUGIN_VALUES));

    await upgrade({});

    const expected = readFileSync(path.join(referenceDir, target), "utf-8");
    expect(readFileSync(path.join(projectDir, target), "utf-8")).toBe(expected);
    expect(metadataOnDisk().managedFiles[target]).toBe(sha256(expected));
    expect(clack.note).toHaveBeenCalledWith(
      expect.stringContaining("Created: 1"),
      "Upgrade result",
    );
  });

  it("deletes a managed file the template no longer ships", async () => {
    const { managedFiles } = seedPluginProject();
    const removed = "legacy-removed.txt";
    writeFileSync(path.join(projectDir, removed), "old shipped content\n");
    managedFiles[removed] = sha256("old shipped content\n");
    writeMetadata(metadataFixture(managedFiles, "plugin", PLUGIN_VALUES));

    await upgrade({});

    expect(existsSync(path.join(projectDir, removed))).toBe(false);
    expect(metadataOnDisk().managedFiles[removed]).toBeUndefined();
    expect(clack.note).toHaveBeenCalledWith(
      expect.stringContaining("Deleted: 1"),
      "Upgrade result",
    );
  });

  it("leaves locally modified managed files untouched and reports them as conflicts", async () => {
    const { managedFiles, referenceDir } = seedPluginProject();
    const target = "README.md";
    const localContent = "# locally hacked readme\n";
    writeFileSync(path.join(projectDir, target), localContent);
    // Ledger still claims the pristine render while both the project copy and
    // the fresh render differ from it: the definition of a conflict.
    writeMetadata(metadataFixture(managedFiles, "plugin", PLUGIN_VALUES));
    const conflictedRendered = readFileSync(
      path.join(referenceDir, target),
      "utf-8",
    );

    await upgrade({});

    expect(readFileSync(path.join(projectDir, target), "utf-8")).toBe(
      localContent,
    );
    expect(conflictedRendered).not.toBe(localContent);
    expect(metadataOnDisk().managedFiles[target]).toBeUndefined();
    expect(clack.note).toHaveBeenCalledWith(
      expect.stringContaining("Conflicts: 1"),
      "Upgrade result",
    );
    expect(console.log).toHaveBeenCalledWith(
      "Skipped files with local changes:",
    );
    expect(console.log).toHaveBeenCalledWith(`  - ${target}`);
  });
});

describe.each([
  ["check", { check: true }],
  ["dryRun", { dryRun: true }],
] as const)("upgrade in %s mode", (_label, options) => {
  it("reports without touching project files or the metadata ledger", async () => {
    const { managedFiles } = seedPluginProject();
    const target = "src/index.ts";
    const drifted = "// local drift that still matches the stale ledger\n";
    writeFileSync(path.join(projectDir, target), drifted);
    managedFiles[target] = sha256(drifted);
    writeMetadata(metadataFixture(managedFiles, "plugin", PLUGIN_VALUES));
    const ledgerBefore = readFileSync(
      path.join(projectDir, ".elizaos", "template.json"),
    );
    const fileBefore = readFileSync(path.join(projectDir, target));

    await upgrade(options);

    expect(readFileSync(path.join(projectDir, target))).toEqual(fileBefore);
    expect(
      readFileSync(path.join(projectDir, ".elizaos", "template.json")),
    ).toEqual(ledgerBefore);
    expect(clack.note).toHaveBeenCalledWith(
      expect.stringContaining("Updated: 1"),
      "Upgrade check",
    );
    const spinnerStop = vi.mocked(clack.spinner).mock.results[0]?.value.stop;
    expect(spinnerStop).toHaveBeenCalledWith("Upgrade check complete.");
  });
});

describe("upstream submodule handling", () => {
  const UPSTREAM_REPO = "https://github.com/elizaOS/eliza.git";

  /** Points the lookup at a project template that declares an upstream checkout. */
  function declareUpstreamTemplate(): void {
    const base = getTemplateById("project") as TemplateDefinition;
    vi.mocked(getTemplateById).mockImplementationOnce(() => ({
      ...base,
      upstream: {
        branch: "develop",
        mode: "git-submodule",
        path: "eliza",
        repo: UPSTREAM_REPO,
      },
    }));
  }

  function seedProjectLedger(): void {
    const managedFiles = renderTemplateTree({
      destinationDir: projectDir,
      replacements: getTemplateReplacementEntries({
        templateId: "project",
        values: PROJECT_VALUES,
      }),
      sourceDir: resolveTemplateSourceDir({
        template: getTemplateById("project") as TemplateDefinition,
        templatesDir: getTemplatesDir(),
      }),
    });
    writeMetadata(metadataFixture(managedFiles, "project", PROJECT_VALUES));
  }

  it("updates and hydrates the declared upstream with resolved repo settings", async () => {
    seedProjectLedger();
    declareUpstreamTemplate();

    await upgrade({});

    expect(updateGitSubmodule).toHaveBeenCalledTimes(1);
    // Observed: with neither --check nor --dry-run, the flags pass through as
    // undefined rather than a coerced false.
    expect(updateGitSubmodule).toHaveBeenCalledWith({
      branch: "develop",
      dryRun: undefined,
      projectRoot: projectDir,
      repo: UPSTREAM_REPO,
      submodulePath: "eliza",
    });
    expect(hydrateGitSubmoduleWorkspace).toHaveBeenCalledTimes(1);
    expect(hydrateGitSubmoduleWorkspace).toHaveBeenCalledWith({
      dryRun: undefined,
      projectRoot: projectDir,
      upstream: {
        branch: "develop",
        mode: "git-submodule",
        path: "eliza",
        repo: UPSTREAM_REPO,
      },
    });
    expect(clack.note).toHaveBeenCalledWith(
      expect.anything(),
      "Upgrade result",
    );
  });

  it("runs upstream work in dry-run mode when --check or --dry-run is set", async () => {
    seedProjectLedger();
    declareUpstreamTemplate();

    await upgrade({ check: true });

    expect(updateGitSubmodule).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
    expect(hydrateGitSubmoduleWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });

  it("skips upstream work entirely when skipUpstream is set", async () => {
    seedProjectLedger();
    declareUpstreamTemplate();

    await upgrade({ skipUpstream: true });

    expect(updateGitSubmodule).not.toHaveBeenCalled();
    expect(hydrateGitSubmoduleWorkspace).not.toHaveBeenCalled();
    // The rest of the upgrade still completed normally.
    expect(clack.note).toHaveBeenCalledWith(
      expect.anything(),
      "Upgrade result",
    );
  });

  it("never touches submodules for templates without an upstream block", async () => {
    const { managedFiles } = seedPluginProject();
    writeMetadata(metadataFixture(managedFiles, "plugin", PLUGIN_VALUES));

    await upgrade({});

    expect(updateGitSubmodule).not.toHaveBeenCalled();
    expect(hydrateGitSubmoduleWorkspace).not.toHaveBeenCalled();
  });
});
