/** Proves local registry discovery isolates malformed metadata without hiding valid apps. */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyLocalWorkspaceApps,
  resolveWorkspaceRootsForDiscovery,
} from "./registry-client-local.ts";
import type { RegistryPluginInfo } from "./registry-client-types.ts";

const temporaryRoots: string[] = [];
const originalWorkspaceRoot = process.env.ELIZA_WORKSPACE_ROOT;
const originalStateDir = process.env.ELIZA_STATE_DIR;

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalWorkspaceRoot === undefined) {
    delete process.env.ELIZA_WORKSPACE_ROOT;
  } else {
    process.env.ELIZA_WORKSPACE_ROOT = originalWorkspaceRoot;
  }
  if (originalStateDir === undefined) {
    delete process.env.ELIZA_STATE_DIR;
  } else {
    process.env.ELIZA_STATE_DIR = originalStateDir;
  }
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("applyLocalWorkspaceApps", () => {
  it("does not treat an implicit hidden worktree container as a workspace", () => {
    const repoRoot = path.resolve(path.sep, "repo");
    const worktreeRoot = path.join(repoRoot, ".worktrees", "feature");
    const roots = resolveWorkspaceRootsForDiscovery({
      moduleDir: path.join(
        worktreeRoot,
        "packages",
        "agent",
        "src",
        "services",
      ),
      cwd: worktreeRoot,
    });

    expect(roots).toContain(worktreeRoot);
    expect(roots).not.toContain(path.join(repoRoot, ".worktrees"));
    expect(roots).toContain(repoRoot);
  });

  it("honors an explicitly configured hidden workspace root", () => {
    const repoRoot = path.resolve(path.sep, "repo");
    const hiddenRoot = path.join(repoRoot, ".workspaces");
    expect(
      resolveWorkspaceRootsForDiscovery({
        moduleDir: path.join(repoRoot, "packages", "agent", "src", "services"),
        cwd: repoRoot,
        envRoot: hiddenRoot,
      }),
    ).toEqual([hiddenRoot]);
  });

  it("reports and rejects one malformed candidate while preserving valid peers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-registry-"));
    temporaryRoots.push(root);
    process.env.ELIZA_WORKSPACE_ROOT = root;
    process.env.ELIZA_STATE_DIR = path.join(root, "state");

    const validDir = path.join(root, "plugins", "app-valid");
    const malformedDir = path.join(root, "plugins", "app-malformed");
    await fs.mkdir(validDir, { recursive: true });
    await fs.mkdir(malformedDir, { recursive: true });
    await fs.writeFile(
      path.join(validDir, "package.json"),
      JSON.stringify({
        name: "@test/app-valid",
        version: "1.0.0",
        elizaos: {
          kind: "app",
          app: { displayName: "Valid App", category: "productivity" },
        },
      }),
    );
    await fs.writeFile(
      path.join(malformedDir, "package.json"),
      "<html>not package metadata</html>",
    );
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const apps = new Map<string, RegistryPluginInfo>();

    await applyLocalWorkspaceApps(apps);

    expect([...apps.keys()]).toEqual(["@test/app-valid"]);
    expect(apps.get("@test/app-valid")?.appMeta?.displayName).toBe("Valid App");
    expect(warn).toHaveBeenCalledWith(
      {
        file: path.join(malformedDir, "package.json"),
        error: expect.any(String),
      },
      "[LocalRegistry] Ignoring malformed local package metadata",
    );
  });

  it("skips file symlinks and broken symlinks in a scanned root instead of aborting on ENOTDIR", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-registry-"));
    temporaryRoots.push(root);
    process.env.ELIZA_WORKSPACE_ROOT = root;
    process.env.ELIZA_STATE_DIR = path.join(root, "state");

    const validDir = path.join(root, "plugins", "app-valid");
    await fs.mkdir(validDir, { recursive: true });
    await fs.writeFile(
      path.join(validDir, "package.json"),
      JSON.stringify({
        name: "@test/app-valid",
        version: "1.0.0",
        elizaos: {
          kind: "app",
          app: { displayName: "Valid App", category: "productivity" },
        },
      }),
    );

    // A foreign checkout pattern: `packages/CLAUDE.md -> ../AGENTS.md`, a
    // symlink whose target is a FILE. Collecting it as a package candidate
    // makes `<candidate>/package.json` raise ENOTDIR, which used to abort
    // the entire listing.
    const scannedPackagesRoot = path.join(root, "packages");
    await fs.mkdir(scannedPackagesRoot, { recursive: true });
    const agentsFile = path.join(root, "AGENTS.md");
    await fs.writeFile(agentsFile, "# agents\n");
    await fs.symlink(agentsFile, path.join(scannedPackagesRoot, "CLAUDE.md"));
    // A dangling symlink must degrade to "not a package" the same way.
    await fs.symlink(
      path.join(root, "does-not-exist"),
      path.join(scannedPackagesRoot, "broken-link"),
    );

    const apps = new Map<string, RegistryPluginInfo>();
    await applyLocalWorkspaceApps(apps);

    expect([...apps.keys()]).toEqual(["@test/app-valid"]);
  });
});
