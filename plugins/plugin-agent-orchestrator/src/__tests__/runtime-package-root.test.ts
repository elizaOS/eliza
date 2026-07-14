/**
 * Verifies resolveAgentOrchestratorPackageRoot against real on-disk module
 * graphs: the workspace install, synthetic node_modules trees (including the
 * symlinked store layout package managers produce), anchor precedence, and
 * the fail-closed error when no anchor reaches an installed package.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentOrchestratorPackageRoot } from "../services/runtime-package-root";

const PACKAGE_NAME = "@elizaos/plugin-agent-orchestrator";
const workspacePluginRoot = realpathSync(
  fileURLToPath(new URL("../..", import.meta.url)),
);

const temporaryDirectories: string[] = [];

function tempTree(): string {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-package-root-"));
  temporaryDirectories.push(root);
  return root;
}

/** Lays out <root>/node_modules/@elizaos/plugin-agent-orchestrator. */
function installPackage(root: string): string {
  const packageRoot = join(root, "node_modules", ...PACKAGE_NAME.split("/"));
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: PACKAGE_NAME, version: "0.0.0-test" }),
  );
  return packageRoot;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveAgentOrchestratorPackageRoot", () => {
  it("resolves the workspace-installed package from a repository anchor", () => {
    const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
    const resolved = resolveAgentOrchestratorPackageRoot([
      join(repoRoot, "package.json"),
    ]);
    expect(resolved).toBe(workspacePluginRoot);
  });

  it("resolves via the default anchors from the test process itself", () => {
    // process.argv[1] (the runner) and cwd both live inside the workspace, so
    // ordinary node_modules resolution must land on the installed plugin.
    expect(resolveAgentOrchestratorPackageRoot()).toBe(workspacePluginRoot);
  });

  it("resolves an installed package in a relocated tree far from any checkout", () => {
    const root = tempTree();
    const packageRoot = installPackage(root);
    const anchor = join(root, "app", "entry.js");
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(anchor, "");

    expect(resolveAgentOrchestratorPackageRoot([anchor])).toBe(
      realpathSync(packageRoot),
    );
  });

  it("returns the real path behind a symlinked node_modules entry", () => {
    // Package managers install a store directory and symlink it into
    // node_modules; consumers need the physical path for spawn cwds.
    const root = tempTree();
    const storeRoot = join(root, "store", "plugin-agent-orchestrator");
    mkdirSync(storeRoot, { recursive: true });
    writeFileSync(
      join(storeRoot, "package.json"),
      JSON.stringify({ name: PACKAGE_NAME, version: "0.0.0-test" }),
    );
    mkdirSync(join(root, "node_modules", "@elizaos"), { recursive: true });
    symlinkSync(
      storeRoot,
      join(root, "node_modules", ...PACKAGE_NAME.split("/")),
      "dir",
    );

    expect(resolveAgentOrchestratorPackageRoot([join(root, "x.js")])).toBe(
      realpathSync(storeRoot),
    );
  });

  it("prefers the first anchor whose graph reaches an installed package", () => {
    const first = tempTree();
    const second = tempTree();
    const firstPackage = installPackage(first);
    installPackage(second);

    expect(
      resolveAgentOrchestratorPackageRoot([
        join(first, "entry.js"),
        join(second, "entry.js"),
      ]),
    ).toBe(realpathSync(firstPackage));
  });

  it("fails closed with a typed error when no anchor resolves", () => {
    const root = tempTree();
    let caught: unknown;
    try {
      resolveAgentOrchestratorPackageRoot([join(root, "entry.js")]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe(
      "ORCHESTRATOR_PACKAGE_ROOT_UNRESOLVED",
    );
    expect(
      (caught as { context?: { anchors?: string[] } }).context?.anchors,
    ).toEqual([join(root, "entry.js")]);
  });
});
