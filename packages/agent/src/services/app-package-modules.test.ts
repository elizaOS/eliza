import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorkspacePackageDir } from "./app-package-modules.ts";

const ROOT_ENV = "ELIZA_WORKSPACE_ROOT";

let workspaceRoot: string;
let previousRoot: string | undefined;

beforeEach(() => {
  previousRoot = process.env[ROOT_ENV];
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-app-pkg-"));
  process.env[ROOT_ENV] = workspaceRoot;
});

afterEach(() => {
  if (previousRoot === undefined) {
    delete process.env[ROOT_ENV];
  } else {
    process.env[ROOT_ENV] = previousRoot;
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

function writePackage(packageDirName: string, manifestText: string): string {
  const packageDir = path.join(workspaceRoot, "packages", packageDirName);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), manifestText, "utf8");
  return packageDir;
}

describe("resolveWorkspacePackageDir", () => {
  it("resolves a workspace package whose manifest is readable", async () => {
    const packageDir = writePackage(
      "app-healthy",
      JSON.stringify({ name: "@elizaos/app-healthy" }),
    );

    await expect(
      resolveWorkspacePackageDir("@elizaos/app-healthy"),
    ).resolves.toBe(packageDir);
  });

  it("reports a corrupt manifest instead of claiming the package is not installed", async () => {
    const packageDir = writePackage("app-corrupt", '{"name": "@elizaos/app-co');

    const resolution = resolveWorkspacePackageDir("@elizaos/app-corrupt");

    await expect(resolution).rejects.toMatchObject({
      name: "ElizaError",
      code: "APP_MODULE_RESOLUTION_FAILED",
      context: {
        packageDir,
        manifestPath: path.join(packageDir, "package.json"),
      },
    });
  });

  it("keeps a package without any manifest out of the workspace matches", async () => {
    fs.mkdirSync(path.join(workspaceRoot, "packages", "app-absent"), {
      recursive: true,
    });

    await expect(
      resolveWorkspacePackageDir("@elizaos/app-absent"),
    ).resolves.toBeNull();
  });
});
