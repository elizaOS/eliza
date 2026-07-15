/**
 * Verifies publish manifests resolve dependency versions only from canonical
 * workspace roots and reject ambiguous canonical package identities.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  collectWorkspaceVersions,
  preparePackageDist,
} from "../prepare-package-dist.mjs";

const temporaryDirectories: string[] = [];

function temporaryRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), "eliza-package-dist-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeJson(root: string, relativePath: string, value: object): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("prepare-package-dist", () => {
  test("ignores a stale nested manifest that repeats a workspace name", () => {
    const root = temporaryRepository();
    writeJson(root, "package.json", {
      name: "workspace-fixture",
      private: true,
      workspaces: ["packages/*"],
    });
    writeJson(root, "packages/plugin-sql/package.json", {
      name: "@elizaos/plugin-sql",
      version: "2.0.3-beta.7",
    });
    writeJson(root, "packages/plugin-sql/src/package.json", {
      name: "@elizaos/plugin-sql",
      version: "2.0.0-beta.0",
    });
    writeJson(root, "packages/agent/package.json", {
      name: "@elizaos/agent",
      version: "2.0.3-beta.7",
      private: true,
      main: "./src/index.ts",
      dependencies: { "@elizaos/plugin-sql": "workspace:*" },
    });

    const prepared = preparePackageDist({
      repositoryRoot: root,
      packageDirectory: "packages/agent",
      optionalPluginFallbackVersions: new Map(),
    });

    expect(prepared.dependencies).toEqual({
      "@elizaos/plugin-sql": "^2.0.3-beta.7",
    });
    const written = JSON.parse(
      readFileSync(join(root, "packages/agent/dist/package.json"), "utf8"),
    );
    expect(written.dependencies).toEqual(prepared.dependencies);
  });

  test("rejects duplicate names selected by canonical workspace globs", () => {
    const root = temporaryRepository();
    writeJson(root, "package.json", {
      name: "workspace-fixture",
      private: true,
      workspaces: ["packages/*"],
    });
    for (const directory of ["first", "second"]) {
      writeJson(root, `packages/${directory}/package.json`, {
        name: "@fixture/duplicate",
        version: "1.0.0",
      });
    }

    expect(() => collectWorkspaceVersions(root)).toThrow(
      /Duplicate workspace package name @fixture\/duplicate/u,
    );
  });

  test("honors negated workspace globs when resolving package identities", () => {
    const root = temporaryRepository();
    writeJson(root, "package.json", {
      name: "workspace-fixture",
      private: true,
      workspaces: ["packages/*", "!packages/excluded"],
    });
    writeJson(root, "packages/canonical/package.json", {
      name: "@fixture/canonical",
      version: "1.2.3",
    });
    writeJson(root, "packages/excluded/package.json", {
      name: "@fixture/canonical",
      version: "9.9.9",
    });

    expect(collectWorkspaceVersions(root)).toEqual(
      new Map([["@fixture/canonical", "1.2.3"]]),
    );
  });

  test("surfaces malformed manifests selected by a workspace glob", () => {
    const root = temporaryRepository();
    writeJson(root, "package.json", {
      name: "workspace-fixture",
      private: true,
      workspaces: ["packages/*"],
    });
    const manifestPath = join(root, "packages/broken/package.json");
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, "{ not-json }\n");

    expect(() => collectWorkspaceVersions(root)).toThrow(
      new RegExp(`Invalid JSON in ${manifestPath}`, "u"),
    );
  });
});
