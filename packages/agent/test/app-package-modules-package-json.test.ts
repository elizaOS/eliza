/**
 * Workspace app-package discovery must read a `package.json` the same way the
 * rest of the codebase does: an absent file is "no package here" (null), but a
 * manifest that exists and is merely BOM-prefixed must still resolve, and one
 * that is corrupt/unreadable must not be reported as "not installed" — while a
 * damaged copy in one candidate directory must not abort the scan for a healthy
 * copy of the same package elsewhere.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { resolveWorkspacePackageDir } from "../src/services/app-package-modules.ts";

const PACKAGE_NAME = "@elizaos/plugin-manifest-probe";
const originalRoot = process.env.ELIZA_WORKSPACE_ROOT;
let workspaceRoot: string;
let probedPackageDir: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(path.join(tmpdir(), "eliza-app-manifest-"));
});

beforeEach(() => {
  // Every case starts from an empty workspace with only the env root set.
  rmSync(path.join(workspaceRoot, "plugins"), { recursive: true, force: true });
  rmSync(path.join(workspaceRoot, "apps"), { recursive: true, force: true });
  process.env.ELIZA_WORKSPACE_ROOT = workspaceRoot;
  probedPackageDir = path.join(
    workspaceRoot,
    "plugins",
    "plugin-manifest-probe",
  );
});

afterEach(() => {
  if (originalRoot === undefined) {
    delete process.env.ELIZA_WORKSPACE_ROOT;
  } else {
    process.env.ELIZA_WORKSPACE_ROOT = originalRoot;
  }
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function writeManifest(packageDir: string, contents: string): string {
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, "package.json"), contents, "utf8");
  return packageDir;
}

it("resolves a workspace plugin whose package.json starts with a UTF-8 BOM", async () => {
  const packageDir = writeManifest(
    probedPackageDir,
    `\uFEFF${JSON.stringify({ name: PACKAGE_NAME, version: "0.0.0" })}`,
  );

  await expect(resolveWorkspacePackageDir(PACKAGE_NAME)).resolves.toBe(
    packageDir,
  );
});

it("surfaces a corrupt package.json instead of reporting the package as missing", async () => {
  writeManifest(probedPackageDir, "{ this is not json");

  await expect(resolveWorkspacePackageDir(PACKAGE_NAME)).rejects.toThrow(
    /Failed to read an app package manifest/,
  );
});

it("keeps scanning when one candidate copy of the package is corrupt", async () => {
  // Same package dir name under two candidates: the first one is damaged, the
  // nested workspace copy is healthy. The scan must not abort on the damaged
  // copy before it has looked at the healthy one.
  writeManifest(probedPackageDir, "{ this is not json");
  const healthyDir = writeManifest(
    path.join(workspaceRoot, "apps", "plugins", "plugin-manifest-probe"),
    JSON.stringify({ name: PACKAGE_NAME, version: "0.0.0" }),
  );

  await expect(resolveWorkspacePackageDir(PACKAGE_NAME)).resolves.toBe(
    healthyDir,
  );
});

it("does not treat a non-string name as a match", async () => {
  // A readable manifest whose `name` is not a string cannot identify the
  // package, so discovery must keep looking rather than crash or match it.
  writeManifest(probedPackageDir, JSON.stringify({ name: 42 }));

  await expect(resolveWorkspacePackageDir(PACKAGE_NAME)).resolves.toBeNull();
});

it("still reports a genuinely absent package as not found", async () => {
  await expect(resolveWorkspacePackageDir(PACKAGE_NAME)).resolves.toBeNull();
});
