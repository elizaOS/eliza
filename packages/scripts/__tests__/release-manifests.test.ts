/**
 * Drives release manifest replacement, byte-exact journal restoration, access
 * stamping, and fail-closed parse/target checks against real temporary files.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main as accessMain } from "../../../scripts/release-set-public-access.mjs";
import {
  replaceWorkspaceReferences,
  restoreWorkspaceReferences,
  setPublicAccess,
} from "../lib/release-manifests.mjs";
import { main as replaceMain } from "../replace-workspace-versions.js";
import { main as restoreMain } from "../restore-workspace-refs.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-manifests-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "packages/a"), { recursive: true });
  fs.mkdirSync(path.join(root, "packages/b"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
  );
  fs.writeFileSync(
    path.join(root, "lerna.json"),
    JSON.stringify({ packages: ["packages/*"] }),
  );
  fs.writeFileSync(
    path.join(root, "packages/a/package.json"),
    `${JSON.stringify(
      {
        name: "@elizaos/a",
        version: "1.2.3",
        dependencies: { "@elizaos/b": "workspace:^" },
      },
      null,
      4,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(root, "packages/b/package.json"),
    `${JSON.stringify({ name: "@elizaos/b", version: "1.2.3" }, null, 2)}\n`,
  );
  return root;
}

describe("release manifest transactions", () => {
  test("replaces with the target exact version and restores original bytes from the journal", () => {
    const root = makeRepo();
    const manifestPath = path.join(root, "packages/a/package.json");
    const original = fs.readFileSync(manifestPath, "utf8");
    const journalPath = path.join(root, "artifacts/journal.json");
    expect(
      replaceWorkspaceReferences({ repoRoot: root, journalPath }).changedFiles,
    ).toBe(1);
    expect(
      JSON.parse(fs.readFileSync(manifestPath, "utf8")).dependencies[
        "@elizaos/b"
      ],
    ).toBe("1.2.3");
    expect(fs.existsSync(journalPath)).toBe(true);
    expect(
      restoreWorkspaceReferences({ repoRoot: root, journalPath }).changedFiles,
    ).toBe(1);
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(original);
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  test("refuses to restore over a changed manifest", () => {
    const root = makeRepo();
    const journalPath = path.join(root, "journal.json");
    replaceWorkspaceReferences({ repoRoot: root, journalPath });
    fs.appendFileSync(path.join(root, "packages/a/package.json"), " ");
    expect(() =>
      restoreWorkspaceReferences({ repoRoot: root, journalPath }),
    ).toThrow("changed after workspace replacement");
  });

  test("malformed intended manifests abort before any earlier manifest changes", () => {
    const root = makeRepo();
    const aPath = path.join(root, "packages/a/package.json");
    const original = fs.readFileSync(aPath, "utf8");
    fs.writeFileSync(path.join(root, "packages/b/package.json"), "{invalid");
    expect(() =>
      replaceWorkspaceReferences({
        repoRoot: root,
        journalPath: path.join(root, "journal.json"),
      }),
    ).toThrow("Invalid JSON");
    expect(fs.readFileSync(aPath, "utf8")).toBe(original);
  });

  test("journal directory failures roll back every completed rewrite", () => {
    const root = makeRepo();
    const manifestPath = path.join(root, "packages/a/package.json");
    const original = fs.readFileSync(manifestPath, "utf8");
    const nonDirectory = path.join(root, "not-a-directory");
    fs.writeFileSync(nonDirectory, "occupied");
    expect(() =>
      replaceWorkspaceReferences({
        repoRoot: root,
        journalPath: path.join(nonDirectory, "journal.json"),
      }),
    ).toThrow();
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(original);
  });

  test("unresolved workspace targets fail instead of remaining in publish output", () => {
    const root = makeRepo();
    const aPath = path.join(root, "packages/a/package.json");
    const manifest = JSON.parse(fs.readFileSync(aPath, "utf8"));
    manifest.dependencies = { "@elizaos/missing": "workspace:*" };
    fs.writeFileSync(aPath, JSON.stringify(manifest));
    expect(() =>
      replaceWorkspaceReferences({
        repoRoot: root,
        journalPath: path.join(root, "journal.json"),
      }),
    ).toThrow("target is not a workspace");
  });

  test("sets public access transactionally and rejects unknown explicit packages", () => {
    const root = makeRepo();
    expect(
      setPublicAccess({ repoRoot: root, packageNames: ["@elizaos/a"] })
        .changedFiles,
    ).toBe(1);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(root, "packages/a/package.json"), "utf8"),
      ),
    ).toMatchObject({
      publishConfig: { access: "public" },
    });
    expect(() =>
      setPublicAccess({ repoRoot: root, packageNames: ["@elizaos/nope"] }),
    ).toThrow("Unknown access-rewrite packages");
  });

  test("the three process helpers execute the fail-closed shared implementation", () => {
    const root = makeRepo();
    const journalPath = path.join(root, "journal.json");
    expect(
      replaceMain(["--repo-root", root, "--journal", journalPath]),
    ).toMatchObject({ changedFiles: 1 });
    expect(
      restoreMain(["--repo-root", root, "--journal", journalPath]),
    ).toMatchObject({ changedFiles: 1 });
    const cohortPath = path.join(root, "cohort.json");
    fs.writeFileSync(
      cohortPath,
      JSON.stringify({ schemaVersion: 1, packages: ["@elizaos/a"] }),
    );
    expect(
      accessMain(["--repo-root", root, "--cohort", cohortPath]),
    ).toMatchObject({ changedFiles: 1 });
  });

  test("release workflow finalizes access before reference journaling and pack verification", () => {
    const workflow = fs.readFileSync(
      path.resolve(import.meta.dir, "../../../.github/workflows/release.yaml"),
      "utf8",
    );
    const access = workflow.indexOf(
      "node scripts/release-set-public-access.mjs",
    );
    const replace = workflow.indexOf(
      "node packages/scripts/replace-workspace-versions.js",
    );
    const pack = workflow.indexOf(
      "node packages/scripts/verify-npm-pack-dist.mjs --all-public-dist-packages --build",
    );
    expect(access).toBeGreaterThan(-1);
    expect(access).toBeLessThan(replace);
    expect(replace).toBeLessThan(pack);
    expect(
      workflow.indexOf(
        "node scripts/release-set-public-access.mjs",
        access + 1,
      ),
    ).toBe(-1);
  });
});
